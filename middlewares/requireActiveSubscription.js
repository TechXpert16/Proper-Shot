const { getAccessState } = require('../utils/subscriptionAccess');

/**
 * Blocks the request when the user's trial has expired, their payment failed, or
 * their subscription was canceled. Must run AFTER authorizationMiddleware, which
 * is what puts the user document on req.user.
 *
 * Responds 402 (Payment Required) rather than 401/403 so the app can tell
 * "log in again" apart from "show the paywall".
 */
const requireActiveSubscription = (req, res, next) => {
    const access = getAccessState(req.user);

    if (access.hasAccess) {
        req.access = access;
        return next();
    }

    return res.status(402).json({
        code: 'subscription_required',
        reason: access.reason,
        message:
            access.reason === 'payment_failed'
                ? 'Your last payment failed. Please update your payment method to continue.'
                : access.reason === 'trial_expired'
                ? 'Your free trial has ended. Subscribe to continue using the app.'
                : 'Your subscription is no longer active. Subscribe to continue using the app.',
        subscription: {
            status: access.status,
            trialEndsAt: access.trialEndsAt,
            subscriptionEndsAt: access.subscriptionEndsAt,
        },
    });
};

module.exports = requireActiveSubscription;
