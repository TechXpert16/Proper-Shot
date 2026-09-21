const express = require('express');
const {
    stripeSubscriptionWebhook,
    createSubscription,
    cancelSubscription,
    resumeSubscription,
    confirmPayment,
    subscriptionStatus,
} = require('../controllers/stripeWebHookController');
const authorizationMiddleware = require('../middlewares/myAuth');

const stripeRouter = express.Router();

// Stripe signs the raw bytes, so this route needs express.raw() and must be
// mounted before any JSON body parser. See app.js.
stripeRouter.post('/webhook', express.raw({ type: '*/*' }), stripeSubscriptionWebhook);

// create-subscription previously took `userId` from the request body with no
// auth, letting anyone start a subscription against another account. The user
// now comes from the bearer token.
stripeRouter.post('/create-subscription', authorizationMiddleware, createSubscription);
stripeRouter.post('/confirmpayment', authorizationMiddleware, confirmPayment);
stripeRouter.post('/cancel', authorizationMiddleware, cancelSubscription);
stripeRouter.post('/resume', authorizationMiddleware, resumeSubscription);
stripeRouter.get('/status', authorizationMiddleware, subscriptionStatus);

module.exports = stripeRouter;
