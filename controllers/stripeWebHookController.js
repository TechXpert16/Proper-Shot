const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const User = require('../models/userModel');
const StripeEvent = require('../models/StripeEvent');
const { getAccessState } = require('../utils/subscriptionAccess');
const { notifyUser, NOTIFICATIONS } = require('../utils/subscriptionNotifications');

const PRICE_ID = process.env.STRIPE_PRICE_ID;

const toDate = (unixSeconds) =>
    typeof unixSeconds === 'number' ? new Date(unixSeconds * 1000) : null;

/** Stripe nests the period on the subscription item from API 2025-03 onwards. */
const periodEndOf = (subscription) =>
    toDate(
        subscription.current_period_end ??
            subscription.items?.data?.[0]?.current_period_end
    );

/**
 * Resolves the local user for a Stripe object. Prefers the customer id we stored
 * at signup, then the userId we put in metadata, then email as a last resort —
 * so an event still lands even if a user record was created out of order.
 */
const findUserForStripeObject = async (object) => {
    const customerId =
        typeof object.customer === 'string' ? object.customer : object.customer?.id;

    if (customerId) {
        const byCustomer = await User.findOne({ stripeAccountId: customerId });
        if (byCustomer) return byCustomer;
    }

    const metadataUserId = object.metadata?.userId;
    if (metadataUserId) {
        const byId = await User.findById(metadataUserId).catch(() => null);
        if (byId) return byId;
    }

    const email = object.customer_email || object.email;
    if (email) {
        const byEmail = await User.findOne({ email: email.toLowerCase() });
        if (byEmail) return byEmail;
    }

    return null;
};

/** Mirrors a Stripe subscription object onto the user document. */
const applySubscription = async (user, subscription) => {
    const periodEnd = periodEndOf(subscription);

    user.subscription_id = subscription.id;
    user.subscription_status = subscription.status;
    user.cancel_at_period_end = !!subscription.cancel_at_period_end;
    user.plan_id = subscription.items?.data?.[0]?.price?.id || user.plan_id;
    user.account_plan = subscription.items?.data?.[0]?.price?.nickname || user.account_plan;
    user.subscriptionstartin = toDate(subscription.start_date) || user.subscriptionstartin;
    user.subscriptionendin = periodEnd;
    user.subscription_canceled_at = toDate(subscription.canceled_at);

    if (subscription.status === 'active' || subscription.status === 'trialing') {
        user.payment_failed_at = null;
    }

    await user.save();
    return user;
};

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

const handlers = {
    'customer.created': async (customer) => {
        if (!customer.email) return 'customer has no email';
        const user = await User.findOne({ email: customer.email.toLowerCase() });
        if (!user) return 'no local user for email';
        user.stripeAccountId = customer.id;
        await user.save();
        return `linked customer ${customer.id} to ${user.email}`;
    },

    'customer.deleted': async (customer) => {
        const user = await User.findOne({ stripeAccountId: customer.id });
        if (!user) return 'no local user';
        // The customer is gone from Stripe, so no further billing can happen.
        user.stripeAccountId = '';
        user.subscription_id = '';
        user.subscription_status = 'canceled';
        user.subscriptionendin = new Date();
        user.cancel_at_period_end = false;
        await user.save();
        await notifyUser(user, NOTIFICATIONS.SUBSCRIPTION_ENDED);
        return `customer deleted, access revoked for ${user.email}`;
    },

    'customer.subscription.created': async (subscription) => {
        const user = await findUserForStripeObject(subscription);
        if (!user) return 'no local user';
        const wasEntitled = getAccessState(user).subscriptionActive;
        await applySubscription(user, subscription);
        if (!wasEntitled && ['active', 'trialing'].includes(subscription.status)) {
            await notifyUser(user, NOTIFICATIONS.SUBSCRIPTION_ACTIVATED);
        }
        return `subscription ${subscription.id} (${subscription.status}) for ${user.email}`;
    },

    // Fires on renewal, plan change, cancel-at-period-end, and every status
    // transition (trialing -> active, active -> past_due, past_due -> canceled).
    'customer.subscription.updated': async (subscription, event) => {
        const user = await findUserForStripeObject(subscription);
        if (!user) return 'no local user';

        const previous = event?.data?.previous_attributes || {};
        const hadAccess = getAccessState(user).hasAccess;

        await applySubscription(user, subscription);

        const nowHasAccess = getAccessState(user).hasAccess;

        if (previous.status && previous.status !== subscription.status) {
            if (subscription.status === 'past_due' || subscription.status === 'unpaid') {
                await notifyUser(user, NOTIFICATIONS.PAYMENT_FAILED);
            } else if (!hadAccess && nowHasAccess) {
                await notifyUser(user, NOTIFICATIONS.SUBSCRIPTION_ACTIVATED);
            }
        }

        // User pressed cancel: still paid until period end, warn them once.
        if (previous.cancel_at_period_end === false && subscription.cancel_at_period_end) {
            await notifyUser(user, {
                ...NOTIFICATIONS.SUBSCRIPTION_CANCELED,
                params: { endsAt: user.subscriptionendin },
            });
        }

        return `subscription ${subscription.id} -> ${subscription.status} for ${user.email}`;
    },

    // The subscription is over: no more invoices, access must stop now.
    'customer.subscription.deleted': async (subscription) => {
        const user = await findUserForStripeObject(subscription);
        if (!user) return 'no local user';

        user.subscription_status = 'canceled';
        user.subscription_id = '';
        user.cancel_at_period_end = false;
        user.subscription_canceled_at = toDate(subscription.canceled_at) || new Date();
        // End the entitlement window now rather than leaving a future date behind,
        // which is exactly what let canceled users keep using the app.
        user.subscriptionendin = new Date();
        await user.save();

        await notifyUser(user, NOTIFICATIONS.SUBSCRIPTION_ENDED);
        return `subscription ended, access revoked for ${user.email}`;
    },

    // NOTE: currently unreachable. The 3-day trial is app-side (trialendin in
    // Mongo, expired by jobs/subscriptionSweep.js) and createSubscription does
    // NOT pass trial_period_days, so Stripe never runs a trial and never emits
    // this event. Kept wired up so that adding trial_period_days later is a
    // one-line change rather than a new integration.
    'customer.subscription.trial_will_end': async (subscription) => {
        const user = await findUserForStripeObject(subscription);
        if (!user) return 'no local user';
        user.trialendin = toDate(subscription.trial_end) || user.trialendin;
        user.trial_end_notified_at = new Date();
        await user.save();
        await notifyUser(user, {
            ...NOTIFICATIONS.TRIAL_ENDING,
            params: { trialEndsAt: user.trialendin },
        });
        return `trial ending warning sent to ${user.email}`;
    },

    'invoice.paid': async (invoice) => {
        const user = await findUserForStripeObject(invoice);
        if (!user) return 'no local user';

        const subscriptionId =
            typeof invoice.subscription === 'string'
                ? invoice.subscription
                : invoice.subscription?.id;

        if (subscriptionId) {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            await applySubscription(user, subscription);
        } else {
            user.subscription_status = 'active';
            user.payment_failed_at = null;
            await user.save();
        }

        user.amount = invoice.amount_paid;
        user.currency = invoice.currency;
        user.last_invoice_id = invoice.id;
        user.payment_failed_at = null;
        await user.save();

        // billing_reason distinguishes the first payment from a renewal.
        const isRenewal = invoice.billing_reason === 'subscription_cycle';
        await notifyUser(
            user,
            isRenewal ? NOTIFICATIONS.SUBSCRIPTION_RENEWED : NOTIFICATIONS.SUBSCRIPTION_ACTIVATED
        );
        return `invoice ${invoice.id} paid by ${user.email}`;
    },

    'invoice.payment_failed': async (invoice) => {
        const user = await findUserForStripeObject(invoice);
        if (!user) return 'no local user';

        user.payment_failed_at = new Date();
        user.last_invoice_id = invoice.id;

        const subscriptionId =
            typeof invoice.subscription === 'string'
                ? invoice.subscription
                : invoice.subscription?.id;

        if (subscriptionId) {
            // Trust Stripe's own status (past_due / unpaid) over guessing.
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            await applySubscription(user, subscription);
            user.payment_failed_at = new Date();
        } else {
            user.subscription_status = 'past_due';
        }
        await user.save();

        await notifyUser(user, NOTIFICATIONS.PAYMENT_FAILED);
        return `payment failed for ${user.email} (status ${user.subscription_status})`;
    },

    // One-off PaymentIntent flow (the legacy path kept for older app builds).
    'payment_intent.payment_failed': async (paymentIntent) => {
        const user = await findUserForStripeObject(paymentIntent);
        if (!user) return 'no local user';
        // Only downgrade if this intent is the one backing their access.
        if (user.subscription_id && user.subscription_id !== paymentIntent.id) {
            return 'intent not tied to current entitlement';
        }
        user.payment_failed_at = new Date();
        user.subscription_status = 'past_due';
        await user.save();
        await notifyUser(user, NOTIFICATIONS.PAYMENT_FAILED);
        return `payment intent failed for ${user.email}`;
    },

    'charge.refunded': async (charge) => {
        const user = await findUserForStripeObject(charge);
        if (!user) return 'no local user';
        if (!charge.refunded) return 'partial refund, entitlement unchanged';
        user.subscription_status = 'canceled';
        user.subscriptionendin = new Date();
        await user.save();
        await notifyUser(user, NOTIFICATIONS.SUBSCRIPTION_ENDED);
        return `fully refunded, access revoked for ${user.email}`;
    },
};

// invoice.payment_succeeded carries the same meaning as invoice.paid; handle
// both so the endpoint works whichever one the dashboard is subscribed to.
handlers['invoice.payment_succeeded'] = handlers['invoice.paid'];

const stripeSubscriptionWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    if (!sig) {
        console.error('[stripe-webhook] missing stripe-signature header');
        return res.status(400).send('Webhook Error: Missing stripe-signature header.');
    }

    if (!Buffer.isBuffer(req.body)) {
        // express.json() ran first and destroyed the raw bytes, so the HMAC can
        // never match. Fail loudly instead of silently dropping every event.
        console.error(
            '[stripe-webhook] req.body is not a Buffer — mount this route with express.raw() BEFORE express.json()'
        );
        return res.status(500).send('Webhook Error: raw body unavailable.');
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`[stripe-webhook] signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Acknowledge duplicates without reprocessing. The unique index makes this
    // safe even when Stripe delivers the same event to two workers at once.
    try {
        await StripeEvent.create({ eventId: event.id, type: event.type });
    } catch (err) {
        if (err.code === 11000) {
            console.log(`[stripe-webhook] duplicate ${event.type} (${event.id}) ignored`);
            return res.status(200).json({ received: true, duplicate: true });
        }
        console.error(`[stripe-webhook] idempotency write failed: ${err.message}`);
        return res.status(500).send('Webhook Error: could not record event.');
    }

    const handler = handlers[event.type];
    if (!handler) {
        console.log(`[stripe-webhook] unhandled event type: ${event.type}`);
        return res.status(200).json({ received: true, handled: false });
    }

    try {
        const result = await handler(event.data.object, event);
        console.log(`[stripe-webhook] ${event.type}: ${result}`);
        return res.status(200).json({ received: true, handled: true });
    } catch (error) {
        console.error(`[stripe-webhook] error handling ${event.type}:`, error);
        // Drop the ledger row so Stripe's retry can actually reprocess the event.
        await StripeEvent.deleteOne({ eventId: event.id }).catch(() => {});
        return res.status(500).send('Webhook handler failed.');
    }
};

// ---------------------------------------------------------------------------
// Customer-facing endpoints
// ---------------------------------------------------------------------------

// Falls back to the id the app shipped with so nothing breaks before the env var
// is set, but STRIPE_PRICE_ID should be the real source going forward.
const resolvePriceId = () => PRICE_ID || 'price_1UH6XORt6g1B7np6tnu99FpH';

/** Creates (or reuses) the Stripe customer for a user. */
const ensureStripeCustomer = async (user) => {
    if (user.stripeAccountId) {
        try {
            const existing = await stripe.customers.retrieve(user.stripeAccountId);
            if (existing && !existing.deleted) return existing.id;
        } catch (error) {
            console.warn(
                `[subscription] stored customer ${user.stripeAccountId} unusable: ${error.message}`
            );
        }
    }

    const customer = await stripe.customers.create({
        name: user.name || user.username,
        email: user.email,
        metadata: { userId: user._id.toString() },
    });
    user.stripeAccountId = customer.id;
    await user.save();
    return customer.id;
};

/**
 * Starts a real recurring Stripe subscription.
 *
 * The old implementation created a bare PaymentIntent, which is why no
 * customer.subscription.* / invoice.* events ever arrived: there was no
 * subscription object in Stripe to emit them. This keeps the same response shape
 * (clientSecret + customerId) so the mobile confirmation flow is unchanged.
 */
const createSubscription = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(404).json({ code: 'failed', error: 'User not found' });
        }

        // Only a genuinely live subscription blocks a new one. A canceled or
        // expired one must be allowed to resubscribe.
        if (user.subscription_id) {
            const current = await stripe.subscriptions
                .retrieve(user.subscription_id)
                .catch(() => null);

            if (current && ['active', 'trialing'].includes(current.status)) {
                return res
                    .status(409)
                    .json({ code: 'failed', error: 'You already have an active subscription.' });
            }

            if (current && ['incomplete', 'past_due'].includes(current.status)) {
                // Hand back the outstanding invoice's intent instead of stacking
                // a second subscription onto the same customer.
                const invoice = await stripe.invoices.retrieve(current.latest_invoice, {
                    expand: ['payment_intent'],
                });
                if (invoice?.payment_intent?.client_secret) {
                    return res.status(200).json({
                        code: 'success',
                        clientSecret: invoice.payment_intent.client_secret,
                        customerId: user.stripeAccountId,
                        subscriptionId: current.id,
                        reused: true,
                    });
                }
            }
        }

        const customerId = await ensureStripeCustomer(user);
        const priceId = resolvePriceId();

        const priceDetails = await stripe.prices.retrieve(priceId).catch(() => null);
        if (!priceDetails || !priceDetails.recurring) {
            return res
                .status(400)
                .json({ code: 'failed', error: 'Configured price is missing or not recurring.' });
        }

        // No trial_period_days on purpose: the free 3 days are granted at signup
        // without a card and tracked in Mongo. By the time a user reaches this
        // endpoint their trial is over, so the first invoice is charged now.
        const subscription = await stripe.subscriptions.create({
            customer: customerId,
            items: [{ price: priceId }],
            // Leaves the subscription "incomplete" until the first payment is
            // confirmed on the device, so an unpaid card never grants access.
            payment_behavior: 'default_incomplete',
            payment_settings: { save_default_payment_method: 'on_subscription' },
            metadata: { userId: user._id.toString() },
            expand: ['latest_invoice.payment_intent'],
        });

        const clientSecret = subscription.latest_invoice?.payment_intent?.client_secret;
        if (!clientSecret) {
            return res
                .status(500)
                .json({ code: 'failed', error: 'Stripe did not return a payment intent.' });
        }

        user.subscription_id = subscription.id;
        user.subscription_status = subscription.status; // 'incomplete' until paid
        user.plan_id = priceId;
        user.amount = priceDetails.unit_amount;
        user.currency = priceDetails.currency;
        user.subscriptionstartin = toDate(subscription.start_date) || new Date();
        user.subscriptionendin = periodEndOf(subscription);
        await user.save();

        return res.status(200).json({
            code: 'success',
            clientSecret,
            customerId,
            subscriptionId: subscription.id,
            subscriptionStart: user.subscriptionstartin,
            subscriptionEnd: user.subscriptionendin,
        });
    } catch (error) {
        console.error('[subscription] create failed:', error.message);
        return res
            .status(500)
            .json({ code: 'failed', error: 'Failed to create subscription' });
    }
};

/**
 * Confirms the first payment from the app.
 *
 * The webhook is still the authority; this exists so the app does not have to
 * poll. It refuses to grant access unless the intent actually succeeded AND
 * belongs to this user's Stripe customer — previously any authenticated caller
 * could pass any PaymentIntent id and be marked active.
 */
const confirmPayment = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) {
            return res
                .status(404)
                .json({ code: 'failed', message: 'User not found.', intent: null });
        }

        const { paymentIntentId } = req.body;
        if (!paymentIntentId) {
            return res
                .status(400)
                .json({ code: 'failed', message: 'paymentIntentId is required.', intent: null });
        }

        const paymentIntent = await stripe.paymentIntents
            .retrieve(paymentIntentId)
            .catch(() => null);

        if (!paymentIntent) {
            return res
                .status(404)
                .json({ code: 'failed', message: 'PaymentIntent not found.', intent: null });
        }

        const intentCustomer =
            typeof paymentIntent.customer === 'string'
                ? paymentIntent.customer
                : paymentIntent.customer?.id;

        if (!intentCustomer || intentCustomer !== user.stripeAccountId) {
            console.warn(
                `[subscription] user ${user._id} tried to confirm intent ${paymentIntentId} belonging to ${intentCustomer}`
            );
            return res
                .status(403)
                .json({ code: 'failed', message: 'This payment does not belong to you.', intent: null });
        }

        if (paymentIntent.status !== 'succeeded') {
            return res.status(402).json({
                code: 'failed',
                message: `Payment not successful (status: ${paymentIntent.status}).`,
                intent: paymentIntent,
            });
        }

        // Re-read the subscription so status and period end come from Stripe,
        // not from an assumption that the payment implies 30 days of access.
        if (user.subscription_id && user.subscription_id.startsWith('sub_')) {
            const subscription = await stripe.subscriptions
                .retrieve(user.subscription_id)
                .catch(() => null);
            if (subscription) {
                await applySubscription(user, subscription);
            }
        } else {
            user.subscription_status = 'active';
            user.payment_failed_at = null;
            await user.save();
        }

        return res.status(200).json({
            code: 'success',
            message: 'Payment confirmed, subscription activated.',
            intent: paymentIntent,
            subscription: getAccessState(user),
        });
    } catch (error) {
        console.error('[subscription] confirm failed:', error?.message);
        return res
            .status(500)
            .json({ code: 'failed', message: 'Failed to confirm payment.', intent: null });
    }
};

/**
 * Cancels at period end by default, so the user keeps the time they paid for.
 * Pass { immediate: true } to revoke access straight away.
 */
const cancelSubscription = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(404).json({ code: 'failed', message: 'User not found.' });
        }

        // NOTE: the previous guard read `!user.subscription_status == 'canceled'`,
        // which evaluates to `false == 'canceled'` — always false, so it never
        // fired and cancel always "succeeded" without touching Stripe.
        if (!user.subscription_id || user.subscription_status === 'canceled') {
            return res
                .status(400)
                .json({ code: 'failed', message: 'No active subscription found.' });
        }

        const immediate = req.body?.immediate === true;

        if (user.subscription_id.startsWith('sub_')) {
            const subscription = immediate
                ? await stripe.subscriptions.cancel(user.subscription_id)
                : await stripe.subscriptions.update(user.subscription_id, {
                      cancel_at_period_end: true,
                  });
            await applySubscription(user, subscription);
            if (immediate) {
                user.subscriptionendin = new Date();
                user.subscription_status = 'canceled';
                await user.save();
            }
        } else {
            // Legacy one-off PaymentIntent entitlement: nothing recurring to stop.
            user.subscription_status = 'canceled';
            user.subscriptionendin = new Date();
            user.cancel_at_period_end = false;
            await user.save();
        }

        // The resulting customer.subscription.updated/deleted webhook sends the
        // notification, so cancelling from the dashboard is announced too and the
        // user is never told twice.

        return res.status(200).json({
            code: 'success',
            message: immediate
                ? 'Subscription canceled. Access has ended.'
                : 'Subscription canceled. Access continues until the end of the paid period.',
            subscription: getAccessState(user),
        });
    } catch (error) {
        console.error('[subscription] cancel failed:', error.message);
        return res
            .status(500)
            .json({ code: 'failed', message: 'Failed to cancel subscription.' });
    }
};

/** Undoes a pending cancel-at-period-end while the period is still running. */
const resumeSubscription = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(404).json({ code: 'failed', message: 'User not found.' });
        }
        if (!user.subscription_id?.startsWith('sub_') || !user.cancel_at_period_end) {
            return res
                .status(400)
                .json({ code: 'failed', message: 'No subscription pending cancellation.' });
        }

        const subscription = await stripe.subscriptions.update(user.subscription_id, {
            cancel_at_period_end: false,
        });
        await applySubscription(user, subscription);

        return res.status(200).json({
            code: 'success',
            message: 'Subscription resumed.',
            subscription: getAccessState(user),
        });
    } catch (error) {
        console.error('[subscription] resume failed:', error.message);
        return res.status(500).json({ code: 'failed', message: 'Failed to resume subscription.' });
    }
};

/**
 * What the app should call on launch to decide between the paywall and the
 * normal UI. Reconciles against Stripe so a missed webhook cannot leave a
 * canceled user looking active forever.
 */
const subscriptionStatus = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(404).json({ code: 'failed', message: 'User not found.' });
        }

        if (user.subscription_id?.startsWith('sub_')) {
            const subscription = await stripe.subscriptions
                .retrieve(user.subscription_id)
                .catch(() => null);
            if (subscription && subscription.status !== user.subscription_status) {
                console.log(
                    `[subscription] reconciling ${user.email}: ${user.subscription_status} -> ${subscription.status}`
                );
                await applySubscription(user, subscription);
            }
        }

        return res.status(200).json({ code: 'success', subscription: getAccessState(user) });
    } catch (error) {
        console.error('[subscription] status failed:', error.message);
        return res.status(500).json({ code: 'failed', message: 'Failed to load subscription.' });
    }
};

module.exports = {
    stripeSubscriptionWebhook,
    createSubscription,
    cancelSubscription,
    resumeSubscription,
    confirmPayment,
    subscriptionStatus,
    // exported for tests / scripts
    handlers,
    findUserForStripeObject,
    applySubscription,
    periodEndOf,
    ensureStripeCustomer,
};
