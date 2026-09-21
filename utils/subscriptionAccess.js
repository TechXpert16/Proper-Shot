/**
 * Single source of truth for "is this user allowed to use the app right now?".
 *
 * Every gate (middleware, login response, /status endpoint) goes through this so
 * there is exactly one definition of entitlement. Nothing else should compare
 * subscription_status strings by hand.
 */

// Statuses Stripe reports for a subscription that is being paid for normally.
const ENTITLED_SUBSCRIPTION_STATUSES = ['active', 'trialing'];

// Statuses that mean Stripe has stopped collecting money for this subscription.
const DEAD_SUBSCRIPTION_STATUSES = [
    'canceled',
    'unpaid',
    'incomplete_expired',
    'paused',
];

// How long a user keeps access after a failed renewal, while Stripe retries the
// invoice. 0 = cut off immediately on the first failure.
const PAST_DUE_GRACE_DAYS = Number(process.env.SUBSCRIPTION_PAST_DUE_GRACE_DAYS || 0);

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 3);

const isFuture = (date) => !!date && new Date(date).getTime() > Date.now();

/**
 * Returns {trialstartin, trialendin} for a brand new account. Every signup path
 * (email, Google, Apple) must spread this into the user document — the social
 * paths originally left both fields unset, which with entitlement gating in
 * place would lock those users out on day one.
 */
const newTrialWindow = (from = new Date()) => {
    const trialendin = new Date(from);
    trialendin.setDate(trialendin.getDate() + TRIAL_DAYS);
    return { trialstartin: from, trialendin };
};

/**
 * When trialendin was never written (accounts created through the old social
 * login paths), derive it from when the account was created so those users get
 * the trial they were entitled to instead of being blocked outright. Saves a
 * migration; new signups always store the real date.
 */
const effectiveTrialEnd = (user) => {
    if (user.trialendin) return new Date(user.trialendin);
    const start = user.trialstartin || user.createdAt;
    if (!start) return null;
    return newTrialWindow(new Date(start)).trialendin;
};

/**
 * @returns {{
 *   hasAccess: boolean,
 *   reason: string,          // machine-readable code for the client
 *   status: string,          // raw subscription_status
 *   trialActive: boolean,
 *   trialEndsAt: Date|null,
 *   subscriptionActive: boolean,
 *   subscriptionEndsAt: Date|null,
 *   cancelAtPeriodEnd: boolean
 * }}
 */
const getAccessState = (user) => {
    const trialEndsAt = user ? effectiveTrialEnd(user) : null;
    const base = {
        status: user?.subscription_status || 'unknown',
        trialEndsAt,
        subscriptionEndsAt: user?.subscriptionendin || null,
        cancelAtPeriodEnd: !!user?.cancel_at_period_end,
        trialActive: false,
        subscriptionActive: false,
    };

    if (!user) {
        return { ...base, hasAccess: false, reason: 'user_not_found' };
    }

    // Admins are staff accounts, not billed customers.
    if (user.isAdmin) {
        return { ...base, hasAccess: true, reason: 'admin' };
    }

    const status = user.subscription_status;

    // A paid subscription is authoritative and outranks the trial clock: a user
    // who subscribed on day 1 must not lose access when their trial date passes.
    if (ENTITLED_SUBSCRIPTION_STATUSES.includes(status)) {
        // subscriptionendin mirrors Stripe's current_period_end. If it is in the
        // past our webhook is behind (missed/late event) rather than the user
        // being unpaid, so we keep access and let the next event correct it.
        return {
            ...base,
            hasAccess: true,
            subscriptionActive: true,
            reason: user.cancel_at_period_end ? 'active_canceling' : 'active',
        };
    }

    if (status === 'past_due' || status === 'incomplete') {
        const graceUntil = user.payment_failed_at
            ? new Date(
                  new Date(user.payment_failed_at).getTime() +
                      PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000
              )
            : null;

        if (PAST_DUE_GRACE_DAYS > 0 && isFuture(graceUntil)) {
            return { ...base, hasAccess: true, reason: 'payment_failed_grace' };
        }
        return { ...base, hasAccess: false, reason: 'payment_failed' };
    }

    if (DEAD_SUBSCRIPTION_STATUSES.includes(status)) {
        return { ...base, hasAccess: false, reason: `subscription_${status}` };
    }

    // No subscription yet — fall back to the free trial window.
    if (isFuture(trialEndsAt)) {
        return { ...base, hasAccess: true, trialActive: true, reason: 'trial' };
    }

    return { ...base, hasAccess: false, reason: 'trial_expired' };
};

const hasAppAccess = (user) => getAccessState(user).hasAccess;

module.exports = {
    getAccessState,
    hasAppAccess,
    newTrialWindow,
    effectiveTrialEnd,
    ENTITLED_SUBSCRIPTION_STATUSES,
    DEAD_SUBSCRIPTION_STATUSES,
    PAST_DUE_GRACE_DAYS,
    TRIAL_DAYS,
};
