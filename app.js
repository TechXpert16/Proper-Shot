// Must come first: several modules read process.env at require time (the Stripe
// client reads STRIPE_SECRET_KEY as it is constructed). Previously dotenv loaded
// after the routers, and only worked because photoRouter happened to call
// dotenv.config() on its own.
require('dotenv').config();

const express = require('express');
const cors = require("cors");
const userRouter = require('./routers/userRouter.js');
const profileRouter = require('./routers/profileRouter.js');
const photoRouter = require('./routers/photoRouter.js');
const stripewebhook = require("./routers/stripeWebhookRouter.js");
const notificationRouter = require('./routers/notification.js');
const i18next = require('./config/i18n.js');
const { startSubscriptionSweep } = require('./jobs/subscriptionSweep.js');

const app = express();
require('./config/db.js');

app.use(cors());

// Stripe signs the exact bytes it sent, so the webhook needs the unparsed body.
// These raw mounts MUST stay above express.json(): previously express.json() ran
// first, so req.body arrived as a parsed object and constructEvent() rejected
// every single event — which is why no subscription events were ever handled.
// Both paths are registered because the app has historically posted to
// /api/createwebhook/webhook as well as /api/stripe/webhook.
app.use('/api/stripe/webhook', express.raw({ type: '*/*' }));
app.use('/api/createwebhook/webhook', express.raw({ type: '*/*' }));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Routes
app.use('/auth/user/', userRouter);
app.use('/auth/user/', profileRouter);
app.use('/api/photos', photoRouter);
app.use('/api/stripe', stripewebhook);
app.use('/api/createwebhook', stripewebhook); // legacy webhook URL
app.use('/api/notification', notificationRouter);

// Example Route Using Translation
app.get('/api/greeting', (req, res) => {
  res.json({ message: req.t ? req.t('welcome') : i18next.t('welcome.title') });
});

const port = process.env.PORT || 8888;
app.listen(port, () => {
  console.log(`Server is listening on port: ${port}`);
  // Expires trials and reconciles subscriptions on a schedule, replacing the
  // in-memory setTimeout that was lost on every restart.
  startSubscriptionSweep();
});
