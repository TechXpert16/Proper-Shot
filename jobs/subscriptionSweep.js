const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const User = require('../models/userModel');
const { notifyUser, NOTIFICATIONS } = require('../utils/subscriptionNotifications');
const { applySubscription } = require('../controllers/stripeWebHookController');

/**
 * Durable replacement for the `setTimeout(..., 3 days)` that used to schedule the
 * trial-ended notification at signup. That timer lived only in process memory:
 * any restart, deploy or crash silently dropped it, and it never actually
 * revoked access — it only sent a push.
 *
 * This sweep is idempotent, so running it more often than needed is harmless.
 */

const HOUR = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = Number(process.env.SUBSCRIPTION_SWEEP_INTERVAL_MINUTES || 60) * 60 * 1000;

/** Warns users whose trial ends within the next 24h, once. */
const warnEndingTrials = async () => {
    const now = new Date();
    const soon = new Date(now.getTime() + 24 * HOUR);

    const users = await User.find({
        subscription_status: 'trial',
        trialendin: { $gt: now, $lte: soon },
        trial_end_notified_at: null,
    });

    for (const user of users) {
        user.trial_end_notified_at = new Date();
        await user.save();
        await notifyUser(user, {
            ...NOTIFICATIONS.TRIAL_ENDING,
            params: { trialEndsAt: user.trialendin },
        });
    }
    return users.length;
};

/**
 * Flips expired trials to `trial_expired` and notifies. The status change is
 * what actually closes the app: getAccessState() stops returning hasAccess once
 * the trial window has passed, regardless of this flag, but persisting it makes
 * the state visible in the DB and in admin screens.
 */
const expireFinishedTrials = async () => {
    const now = new Date();

    const users = await User.find({
        subscription_status: 'trial',
        trialendin: { $ne: null, $lte: now },
    });

    for (const user of users) {
        user.subscription_status = 'trial_expired';
        const alreadyNotified = !!user.trial_expired_notified_at;
        user.trial_expired_notified_at = user.trial_expired_notified_at || new Date();
        await user.save();
        if (!alreadyNotified) {
            await notifyUser(user, NOTIFICATIONS.TRIAL_ENDED);
        }
    }
    return users.length;
};

/**
 * Safety net for missed webhooks: if a user still looks active locally but their
 * paid period ended over an hour ago, ask Stripe what the truth is. Without this
 * a single dropped `customer.subscription.deleted` leaves a canceled user with
 * permanent access.
 */
const reconcileStaleSubscriptions = async () => {
    const staleBefore = new Date(Date.now() - HOUR);

    const users = await User.find({
        subscription_status: { $in: ['active', 'trialing', 'past_due'] },
        subscriptionendin: { $ne: null, $lt: staleBefore },
        subscription_id: { $regex: '^sub_' },
    }).limit(200);

    let changed = 0;
    for (const user of users) {
        try {
            const subscription = await stripe.subscriptions.retrieve(user.subscription_id);
            const before = user.subscription_status;
            await applySubscription(user, subscription);
            if (before !== user.subscription_status) {
                changed += 1;
                console.log(
                    `[sweep] reconciled ${user.email}: ${before} -> ${user.subscription_status}`
                );
            }
        } catch (error) {
            if (error?.statusCode === 404 || error?.code === 'resource_missing') {
                // The subscription no longer exists in Stripe: revoke.
                user.subscription_status = 'canceled';
                user.subscription_id = '';
                user.subscriptionendin = new Date();
                await user.save();
                await notifyUser(user, NOTIFICATIONS.SUBSCRIPTION_ENDED);
                changed += 1;
            } else {
                console.error(`[sweep] could not reconcile ${user.email}: ${error.message}`);
            }
        }
    }
    return changed;
};

const runSubscriptionSweep = async () => {
    try {
        const [warned, expired, reconciled] = [
            await warnEndingTrials(),
            await expireFinishedTrials(),
            await reconcileStaleSubscriptions(),
        ];
        console.log(
            `[sweep] trial warnings: ${warned}, trials expired: ${expired}, subscriptions reconciled: ${reconciled}`
        );
        return { warned, expired, reconciled };
    } catch (error) {
        console.error('[sweep] failed:', error.message);
        return null;
    }
};

const startSubscriptionSweep = () => {
    if (process.env.SUBSCRIPTION_SWEEP_ENABLED === 'false') {
        console.log('[sweep] disabled via SUBSCRIPTION_SWEEP_ENABLED=false');
        return null;
    }
    // Run shortly after boot to catch anything that expired while we were down.
    setTimeout(runSubscriptionSweep, 10_000).unref();
    const timer = setInterval(runSubscriptionSweep, SWEEP_INTERVAL_MS);
    timer.unref();
    console.log(`[sweep] scheduled every ${SWEEP_INTERVAL_MS / 60000} minutes`);
    return timer;
};

module.exports = {
    startSubscriptionSweep,
    runSubscriptionSweep,
    warnEndingTrials,
    expireFinishedTrials,
    reconcileStaleSubscriptions,
};
