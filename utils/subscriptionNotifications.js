const Notification = require('../models/Notification');
const { sendPushNotification } = require('./pushNotification');
const i18next = require('../config/i18n.js');

/**
 * Sends a push notification AND persists an in-app Notification, in the user's
 * own language. Every subscription lifecycle event goes through here so the user
 * is always told why their access changed.
 *
 * Never throws: a notification failure must not roll back a webhook, or Stripe
 * will retry an event we have already applied.
 */
const notifyUser = async (user, { titleKey, messageKey, type, params = {} }) => {
    try {
        await i18next.changeLanguage(user.language || 'en');
        const heading = i18next.t(titleKey);
        const message = i18next.t(messageKey);

        if (user.deviceToken) {
            sendPushNotification(user.deviceToken, heading, message, type, params);
        }

        await new Notification({
            recipient: user._id,
            heading,
            message,
            params,
        }).save();
    } catch (error) {
        console.error(`[subscription] failed to notify ${user?._id}:`, error.message);
    }
};

const NOTIFICATIONS = {
    TRIAL_ENDING: {
        titleKey: 'subscriptionEvents.trialEndingTitle',
        messageKey: 'subscriptionEvents.trialEndingMessage',
        type: 'TRIAL_ENDING_NOTIFICATION',
    },
    TRIAL_ENDED: {
        titleKey: 'signup.trialEndedTitle',
        messageKey: 'signup.trialEndedMessage',
        type: 'TRIAL_END_NOTIFICATION',
    },
    SUBSCRIPTION_ACTIVATED: {
        titleKey: 'subscriptionEvents.activatedTitle',
        messageKey: 'subscriptionEvents.activatedMessage',
        type: 'SUBSCRIPTION_ACTIVATED',
    },
    SUBSCRIPTION_RENEWED: {
        titleKey: 'subscriptionEvents.renewedTitle',
        messageKey: 'subscriptionEvents.renewedMessage',
        type: 'SUBSCRIPTION_RENEWED',
    },
    PAYMENT_FAILED: {
        titleKey: 'subscriptionEvents.paymentFailedTitle',
        messageKey: 'subscriptionEvents.paymentFailedMessage',
        type: 'SUBSCRIPTION_PAYMENT_FAILED',
    },
    SUBSCRIPTION_CANCELED: {
        titleKey: 'subscriptionEvents.canceledTitle',
        messageKey: 'subscriptionEvents.canceledMessage',
        type: 'SUBSCRIPTION_CANCELED',
    },
    SUBSCRIPTION_ENDED: {
        titleKey: 'subscriptionEvents.endedTitle',
        messageKey: 'subscriptionEvents.endedMessage',
        type: 'SUBSCRIPTION_ENDED',
    },
};

module.exports = { notifyUser, NOTIFICATIONS };
