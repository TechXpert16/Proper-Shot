const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const userModel = require('../models/userModel');
const User = require('../models/userModel');

const stripeSubscriptionWebhook = async (req, res) => {
    try {
        console.log('Headers:', req.headers);

        const sig = req.headers['stripe-signature'];
        if (!sig) {
            console.error('Missing Stripe signature header.');
            return res.status(400).send('Webhook Error: Missing stripe-signature header.');
        }
        console.log('Raw Body:', req.body);
        let event;
        try {
            event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
            console.log('Stripe Event:', event);
        } catch (err) {
            console.error(`Webhook Signature Verification Error: ${err.message}`);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        // Handle different event types
        switch (event.type) {
            case 'customer.created': {
                const customer = event.data.object;
                try {
                    const user = await User.findOne({ email: customer.email });
                    if (user) {
                        user.stripeAccountId = customer.id;
                        await user.save();
                        console.log(`Stripe customer ID saved for user: ${user.email}`);
                    } else {
                        console.log('No user found for the given email.');
                    }
                } catch (error) {
                    console.error(`Error handling customer.created: ${error.message}`);
                }
                break;
            }

            case 'customer.subscription.created': {
                const subscription = event.data.object;
                try {
                    const user = await User.findOne({ stripeAccountId: subscription.customer });
                    if (user) {
                        user.subscription_id = subscription.id;
                        user.subscription_status = subscription.status;
                        await user.save();
                        console.log(`Subscription created for user: ${user.email}`);
                    } else {
                        console.log('No user found for the given Stripe customer ID.');
                    }
                } catch (error) {
                    console.error(`Error handling customer.subscription.created: ${error.message}`);
                }
                break;
            }

            default:
                console.log(`Unhandled event type: ${event.type}`);
        }

        // Respond with a 200 to acknowledge receipt of the event
        res.status(200).end();
    } catch (err) {
        console.error('Unexpected Error:', err.message);
        res.status(500).send('Internal Server Error');
    }
};
const createSubscription = async (req, res) => {
    try {
        const { userId } = req.body;
        const priceId = 'price_1UH6XORt6g1B7np6tnu99FpH';

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (user.subscription_id && user.stripeAccountId) {
            return res.status(403).json({ error: 'You already have an active subscription.' });
        }
        let customerId = user.stripeAccountId;

        let stripeCustomer;

        try {
            stripeCustomer = await stripe.customers.retrieve(customerId);
        } catch (error) {
            console.log('error :', error);
        }

        if (!stripeCustomer) {
            const customer = await stripe.customers.create({
                name: user.username,
                email: user.email,
                metadata: { userId },
            });
            customerId = customer.id;
            user.stripeAccountId = customerId;
            await user.save();
        }

        const priceDetails = await stripe.prices.retrieve(priceId);
        if (!priceDetails) {
            return res.status(400).json({ error: 'Invalid price ID.' });
        }

        const amount = 699; // $6.99 in cents
        const currency = priceDetails.currency;

        const paymentIntent = await stripe.paymentIntents.create({
            customer: customerId,
            amount,
            currency,
            metadata: { userId, priceId },
            setup_future_usage: 'off_session',
        });

        const startDate = new Date();
        const endDate = new Date();
        endDate.setDate(startDate.getDate() + 30);

        // user.subscription_status = "pending";
        user.subscriptionstartin = startDate;
        user.subscriptionendin = endDate;

        await user.save();

        res.status(200).json({
            clientSecret: paymentIntent.client_secret,
            customerId,
            subscriptionStart: startDate,
            subscriptionEnd: endDate,
        });
    } catch (error) {
        console.error('Error creating PaymentIntent:', error.message);
        res.status(500).json({ error: 'Failed to create PaymentIntent' });
    }
};
// cnfrm payment
const confirmPayment = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({
                code: 'failed',
                message: 'User not found.',
                intent: null,
            });
        }

        const { paymentIntentId } = req.body;
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (!paymentIntent) {
            return res.status(404).json({
                code: 'failed',
                message: 'PaymentIntent not found.',
                intent: null,
            });
        }

        user.subscription_status = 'active';
        user.subscription_id = paymentIntent.id;
        // user.lastIntent = paymentIntent;
        await user.save();

        res.status(200).json({
            code: 'success',
            message: 'Payment confirmed, subscription activated.',
            intent: paymentIntent,
        });
    } catch (error) {
        console.error('Error confirming payment:', error?.message);
        res.status(500).json({
            code: 'failed',
            message: 'Failed to confirm payment.',
            intent: null,
        });
    }
};
// get payment intent
// export const getPaymentIntent = async (req, res) => {
//   try {
//     const { paymentIntentId } = req.query;
//     if (!paymentIntentId) {
//       return res.status(400).json({ message: 'Payment Intent ID is required.' });
//     }
//     const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
//     res.status(200).json(paymentIntent);
//   }
//   catch (error) {
//     console.error(`Error getting payment intent: ${error.message}`);
//     res.status(500).json({
//       message: 'Payment intent retrieval failed',
//       error: error.message,
//       stack: error.stack,
//     });
//   }
// }
// cancel subscription
const cancelSubscription = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ code: 'failed', message: 'User not found.' });
        }

        if (!user.subscription_status == 'canceled') {
            return res.status(400).json({ code: 'failed', message: 'No active subscription found.' });
        }

        // Cancel payment intent if it exists
        // await stripe.paymentIntents.cancel(user.subscId);

        // Update user's subscription status
        user.subscription_status = 'canceled';
        user.subscId = null;
        await user.save();

        res.status(200).json({ code: 'success', message: 'Subscription canceled successfully.' });
    } catch (error) {
        console.error('Error canceling subscription:', error.message);
        res.status(500).json({ code: 'failed', message: 'Failed to cancel subscription.' });
    }
};

module.exports = {
    stripeSubscriptionWebhook,
    createSubscription,
    cancelSubscription,
    confirmPayment,
};
