/**
 * Self-contained proof that trial expiry, payment failure and cancellation
 * actually revoke access, and that Stripe webhooks are received at all.
 *
 * Runs entirely in-process against in-memory fakes for Mongo, Stripe's REST API
 * and push notifications — it never touches the real database or Stripe account.
 * Webhook signature verification uses the genuine Stripe SDK implementation.
 *
 *   node scripts/verify-subscription.js
 */

process.env.STRIPE_SECRET_KEY = 'sk_test_verify';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_verify_secret';
process.env.SUBSCRIPTION_SWEEP_ENABLED = 'false';

const assert = require('assert');
const express = require('express');
const http = require('http');

// --- Real Stripe, used only for signing/verifying webhook payloads ----------
const Stripe = require('stripe');
const realStripe = Stripe('sk_test_verify');

// --- Test bookkeeping -------------------------------------------------------
let passed = 0;
const failures = [];
const check = (name, fn) => {
    try {
        fn();
        passed += 1;
        console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    } catch (error) {
        failures.push({ name, error });
        console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${error.message}`);
    }
};
const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

// ---------------------------------------------------------------------------
// In-memory fakes, installed into the require cache before the app code loads.
// ---------------------------------------------------------------------------
const store = new Map();
let idSeq = 0;

class FakeUser {
    constructor(doc = {}) {
        Object.assign(
            this,
            {
                _id: `user_${++idSeq}`,
                email: '',
                name: 'Test User',
                language: 'en',
                isAdmin: false,
                deviceToken: 'tok',
                stripeAccountId: '',
                subscription_id: '',
                subscription_status: 'trial',
                plan_id: '',
                account_plan: '',
                trialstartin: new Date(),
                trialendin: null,
                subscriptionstartin: new Date(),
                subscriptionendin: null,
                cancel_at_period_end: false,
                subscription_canceled_at: null,
                payment_failed_at: null,
                last_invoice_id: '',
                trial_end_notified_at: null,
                trial_expired_notified_at: null,
            },
            doc
        );
    }
    async save() {
        store.set(String(this._id), this);
        return this;
    }
    static async findById(id) {
        return store.get(String(id)) || null;
    }
    static async findOne(query) {
        return [...store.values()].find((u) => matches(u, query)) || null;
    }
    static find(query) {
        const results = [...store.values()].filter((u) => matches(u, query));
        // mimic the chainable Query that mongoose returns
        return Object.assign(Promise.resolve(results), { limit: () => Promise.resolve(results) });
    }
}

/** Minimal Mongo query-operator support, enough to run the sweep's real queries. */
const matches = (doc, query) =>
    Object.entries(query).every(([field, condition]) => {
        const value = doc[field];
        if (condition === null) return value === null || value === undefined;
        if (condition instanceof Date || typeof condition !== 'object') {
            return String(value) === String(condition);
        }
        return Object.entries(condition).every(([op, operand]) => {
            switch (op) {
                case '$gt': return value != null && new Date(value) > new Date(operand);
                case '$gte': return value != null && new Date(value) >= new Date(operand);
                case '$lt': return value != null && new Date(value) < new Date(operand);
                case '$lte': return value != null && new Date(value) <= new Date(operand);
                case '$ne': return operand === null ? value != null : String(value) !== String(operand);
                case '$in': return operand.map(String).includes(String(value));
                case '$regex': return new RegExp(operand).test(String(value ?? ''));
                default: throw new Error(`unsupported query operator ${op}`);
            }
        });
    });

const stripeState = {
    subscriptions: new Map(),
    invoices: new Map(),
    paymentIntents: new Map(),
};

const fakeStripeClient = {
    webhooks: {
        // Genuine implementation: this is the behaviour under test.
        constructEvent: (...args) => realStripe.webhooks.constructEvent(...args),
    },
    subscriptions: {
        retrieve: async (id) => {
            const sub = stripeState.subscriptions.get(id);
            if (!sub) {
                const err = new Error('No such subscription');
                err.statusCode = 404;
                err.code = 'resource_missing';
                throw err;
            }
            return sub;
        },
        update: async (id, params) =>
            Object.assign(stripeState.subscriptions.get(id), params),
        cancel: async (id) =>
            Object.assign(stripeState.subscriptions.get(id), {
                status: 'canceled',
                canceled_at: Math.floor(Date.now() / 1000),
                cancel_at_period_end: false,
            }),
    },
    invoices: { retrieve: async (id) => stripeState.invoices.get(id) },
    paymentIntents: { retrieve: async (id) => stripeState.paymentIntents.get(id) },
    customers: { retrieve: async () => ({ id: 'cus_test', deleted: false }) },
    prices: { retrieve: async () => ({ id: 'price_x', currency: 'usd', unit_amount: 699, recurring: { interval: 'month' } }) },
};

const notifications = [];

const stub = (modulePath, exports) => {
    const resolved = require.resolve(modulePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

stub('../models/userModel', FakeUser);
stub('../models/StripeEvent', {
    seen: new Set(),
    async create({ eventId, type }) {
        if (this.seen.has(eventId)) {
            const err = new Error('duplicate');
            err.code = 11000;
            throw err;
        }
        this.seen.add(eventId);
        return { eventId, type };
    },
    async deleteOne({ eventId }) {
        this.seen.delete(eventId);
    },
});
stub('../utils/subscriptionNotifications', {
    notifyUser: async (user, spec) => {
        notifications.push({ userId: String(user._id), type: spec.type });
    },
    NOTIFICATIONS: new Proxy({}, { get: (_, key) => ({ type: String(key) }) }),
});
// `stripe` is required as require('stripe')(key)
{
    const resolved = require.resolve('stripe');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: () => fakeStripeClient,
    };
}

// Now load the code under test, which picks up the fakes above.
const { getAccessState, newTrialWindow, effectiveTrialEnd } = require('../utils/subscriptionAccess');
const requireActiveSubscription = require('../middlewares/requireActiveSubscription');
const controller = require('../controllers/stripeWebHookController');
const sweep = require('../jobs/subscriptionSweep');

const daysFromNow = (d) => new Date(Date.now() + d * 24 * 60 * 60 * 1000);
const unix = (date) => Math.floor(date.getTime() / 1000);


// ===========================================================================
(async () => {
    section('1. Entitlement truth table (utils/subscriptionAccess.js)');

    const cases = [
        ['active trial',                { subscription_status: 'trial', trialendin: daysFromNow(2) },   true,  'trial'],
        ['expired trial',               { subscription_status: 'trial', trialendin: daysFromNow(-1) },  false, 'trial_expired'],
        ['no end date, just signed up', { subscription_status: 'trial', trialendin: null },             true,  'trial'],
        ['no end date, signed up 10d ago', { subscription_status: 'trial', trialendin: null, trialstartin: daysFromNow(-10) }, false, 'trial_expired'],
        ['trial marked expired',        { subscription_status: 'trial_expired', trialendin: daysFromNow(-5) }, false, 'trial_expired'],
        ['active subscription',         { subscription_status: 'active', subscriptionendin: daysFromNow(20) }, true, 'active'],
        ['subscription past trial end', { subscription_status: 'active', trialendin: daysFromNow(-30), subscriptionendin: daysFromNow(10) }, true, 'active'],
        ['canceling at period end',     { subscription_status: 'active', cancel_at_period_end: true, subscriptionendin: daysFromNow(5) }, true, 'active_canceling'],
        ['past_due (payment failed)',   { subscription_status: 'past_due', subscriptionendin: daysFromNow(10), payment_failed_at: new Date() }, false, 'payment_failed'],
        ['unpaid',                      { subscription_status: 'unpaid', subscriptionendin: daysFromNow(10) }, false, 'subscription_unpaid'],
        ['canceled',                    { subscription_status: 'canceled', subscriptionendin: daysFromNow(10) }, false, 'subscription_canceled'],
        ['incomplete (never paid)',     { subscription_status: 'incomplete', trialendin: daysFromNow(-1) }, false, 'payment_failed'],
        ['incomplete_expired',          { subscription_status: 'incomplete_expired' },                  false, 'subscription_incomplete_expired'],
        ['admin',                       { subscription_status: 'canceled', isAdmin: true },             true,  'admin'],
    ];

    for (const [label, doc, expectedAccess, expectedReason] of cases) {
        check(`${label} -> ${expectedAccess ? 'access' : 'BLOCKED'} (${expectedReason})`, () => {
            const state = getAccessState(new FakeUser(doc));
            assert.strictEqual(state.hasAccess, expectedAccess, `hasAccess was ${state.hasAccess}`);
            assert.strictEqual(state.reason, expectedReason, `reason was "${state.reason}"`);
        });
    }
    check('missing user is blocked', () => {
        assert.strictEqual(getAccessState(null).hasAccess, false);
    });
    check('user with no trial dates at all is blocked', () => {
        const u = new FakeUser({ subscription_status: 'trial', trialendin: null });
        u.trialstartin = undefined;
        u.createdAt = undefined;
        assert.strictEqual(getAccessState(u).hasAccess, false);
    });

    // -----------------------------------------------------------------------
    section('1b. Every signup path grants the 3-day trial');

    {
        const window = newTrialWindow();
        const days = (window.trialendin - window.trialstartin) / (24 * 60 * 60 * 1000);
        check('newTrialWindow() spans 3 days', () => {
            assert.strictEqual(Math.round(days), 3, `spanned ${days} days`);
        });

        // Mirrors what each signup path now writes into the user document.
        for (const path of ['email', 'google', 'apple']) {
            const user = new FakeUser({ account_type: path, subscription_status: 'trial', ...newTrialWindow() });
            check(`${path} signup starts with an active trial`, () => {
                const state = getAccessState(user);
                assert.strictEqual(state.hasAccess, true, `${path} user blocked at signup`);
                assert.strictEqual(state.reason, 'trial');
            });
        }

        // Regression: Google/Apple accounts created before this change stored no
        // trial dates at all, so a naive gate would lock them out permanently.
        const legacyFresh = new FakeUser({ account_type: 'google', subscription_status: 'trial', trialstartin: undefined, trialendin: null, createdAt: new Date() });
        legacyFresh.trialstartin = undefined;
        check('legacy social account with no trial dates still gets its trial', () => {
            const state = getAccessState(legacyFresh);
            assert.strictEqual(state.hasAccess, true, 'legacy social user was locked out');
            assert.ok(state.trialEndsAt, 'no trial end derived');
        });

        const legacyOld = new FakeUser({ account_type: 'google', subscription_status: 'trial', trialendin: null, createdAt: daysFromNow(-10) });
        legacyOld.trialstartin = undefined;
        check('legacy social account created 10 days ago is correctly expired', () => {
            assert.strictEqual(getAccessState(legacyOld).hasAccess, false);
        });

        check('derived trial end is 3 days after account creation', () => {
            const created = daysFromNow(-1);
            const u = new FakeUser({ trialendin: null, createdAt: created });
            u.trialstartin = undefined;
            const end = effectiveTrialEnd(u);
            assert.strictEqual(Math.round((end - created) / (24 * 60 * 60 * 1000)), 3);
        });
    }

    // -----------------------------------------------------------------------
    section('2. Route gating over real HTTP (middlewares/requireActiveSubscription.js)');

    let currentUser = null;
    const gateApp = express();
    gateApp.use(express.json());
    gateApp.use((req, _res, next) => {
        req.user = currentUser;
        next();
    });
    gateApp.get('/api/photos/gallery', requireActiveSubscription, (_req, res) =>
        res.status(200).json({ photos: [] })
    );
    const gateServer = await new Promise((resolve) => {
        const s = gateApp.listen(0, () => resolve(s));
    });
    const gatePort = gateServer.address().port;

    const get = (path) =>
        new Promise((resolve, reject) => {
            http.get({ port: gatePort, path }, (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }));
            }).on('error', reject);
        });

    const gateCases = [
        ['trialing user can list photos', { subscription_status: 'trial', trialendin: daysFromNow(1) }, 200, null],
        ['expired trial is blocked', { subscription_status: 'trial', trialendin: daysFromNow(-1) }, 402, 'trial_expired'],
        ['failed payment is blocked', { subscription_status: 'past_due', payment_failed_at: new Date() }, 402, 'payment_failed'],
        ['canceled subscription is blocked', { subscription_status: 'canceled' }, 402, 'subscription_canceled'],
        ['paying user is allowed', { subscription_status: 'active', subscriptionendin: daysFromNow(15) }, 200, null],
    ];
    for (const [label, doc, expectedStatus, expectedReason] of gateCases) {
        currentUser = new FakeUser(doc);
        const res = await get('/api/photos/gallery');
        check(`${label} -> HTTP ${expectedStatus}`, () => {
            assert.strictEqual(res.status, expectedStatus, `got HTTP ${res.status}`);
            if (expectedReason) assert.strictEqual(res.body.reason, expectedReason);
        });
    }
    gateServer.close();

    // -----------------------------------------------------------------------
    section('3. Webhook delivery: body-parser ordering and signature');

    const buildWebhookApp = (jsonFirst) => {
        const app = express();
        if (jsonFirst) app.use(express.json());           // the old, broken order
        app.use('/webhook', express.raw({ type: '*/*' }));
        if (!jsonFirst) app.use(express.json());          // the fixed order
        app.post('/webhook', controller.stripeSubscriptionWebhook);
        return app;
    };

    const postEvent = (port, event, { sign = true } = {}) =>
        new Promise((resolve, reject) => {
            const payload = JSON.stringify(event);
            const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
            if (sign) {
                headers['stripe-signature'] = realStripe.webhooks.generateTestHeaderString({
                    payload,
                    secret: process.env.STRIPE_WEBHOOK_SECRET,
                });
            }
            const req = http.request({ port, path: '/webhook', method: 'POST', headers }, (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => resolve({ status: res.statusCode, body }));
            });
            req.on('error', reject);
            req.write(payload);
            req.end();
        });

    const listen = (app) => new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });

    const makeEvent = (type, object, extra = {}) => ({
        id: `evt_${Math.random().toString(36).slice(2)}`,
        type,
        data: { object, ...extra },
    });

    const brokenServer = await listen(buildWebhookApp(true));
    const fixedServer = await listen(buildWebhookApp(false));
    const brokenPort = brokenServer.address().port;
    const fixedPort = fixedServer.address().port;

    const probe = makeEvent('customer.created', { id: 'cus_probe', email: 'nobody@example.com' });

    const brokenRes = await postEvent(brokenPort, probe);
    check('OLD ordering (express.json first) rejects every event — the original bug', () => {
        assert.notStrictEqual(brokenRes.status, 200, `expected non-200, got ${brokenRes.status}`);
    });

    const fixedRes = await postEvent(fixedPort, probe);
    check('NEW ordering accepts a correctly signed event', () => {
        assert.strictEqual(fixedRes.status, 200, `got ${fixedRes.status}: ${fixedRes.body}`);
    });

    const unsigned = await postEvent(fixedPort, makeEvent('customer.created', { id: 'cus_x', email: 'a@b.c' }), { sign: false });
    check('unsigned request is rejected with 400', () => {
        assert.strictEqual(unsigned.status, 400);
    });

    const forged = makeEvent('customer.subscription.created', { id: 'sub_forged' });
    const forgedRes = await new Promise((resolve) => {
        const payload = JSON.stringify(forged);
        const req = http.request({ port: fixedPort, path: '/webhook', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef', 'Content-Length': Buffer.byteLength(payload) } },
            (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode })); });
        req.write(payload); req.end();
    });
    check('forged signature is rejected with 400', () => {
        assert.strictEqual(forgedRes.status, 400);
    });

    const dupe = makeEvent('customer.created', { id: 'cus_dupe', email: 'dupe@example.com' });
    await postEvent(fixedPort, dupe);
    const second = await postEvent(fixedPort, dupe);
    check('replayed event is acknowledged but not reprocessed (idempotent)', () => {
        assert.strictEqual(second.status, 200);
        assert.ok(JSON.parse(second.body).duplicate, 'expected duplicate:true');
    });

    brokenServer.close();
    fixedServer.close();

    // -----------------------------------------------------------------------
    section('4. Lifecycle events change entitlement (controllers/stripeWebHookController.js)');

    const newUser = async (doc) => {
        const u = new FakeUser(doc);
        await u.save();
        return u;
    };
    const notifiedTypes = (user) =>
        notifications.filter((n) => n.userId === String(user._id)).map((n) => n.type);

    const makeSub = (id, customer, status, overrides = {}) => {
        const sub = {
            id,
            customer,
            status,
            start_date: unix(new Date()),
            current_period_end: unix(daysFromNow(30)),
            cancel_at_period_end: false,
            canceled_at: null,
            items: { data: [{ price: { id: 'price_x', nickname: 'Monthly' } }] },
            metadata: {},
            ...overrides,
        };
        stripeState.subscriptions.set(id, sub);
        return sub;
    };

    // 4a. subscription created -> access
    {
        const user = await newUser({ email: 'a@example.com', stripeAccountId: 'cus_a', subscription_status: 'trial', trialendin: daysFromNow(-1) });
        const sub = makeSub('sub_a', 'cus_a', 'active');
        await controller.handlers['customer.subscription.created'](sub, makeEvent('customer.subscription.created', sub));
        check('customer.subscription.created grants access to an expired-trial user', () => {
            assert.strictEqual(user.subscription_status, 'active');
            assert.strictEqual(getAccessState(user).hasAccess, true);
            assert.ok(notifiedTypes(user).includes('SUBSCRIPTION_ACTIVATED'), 'no activation notification');
        });
    }

    // 4b. payment failed -> no access
    {
        const user = await newUser({ email: 'b@example.com', stripeAccountId: 'cus_b', subscription_id: 'sub_b', subscription_status: 'active', subscriptionendin: daysFromNow(20) });
        makeSub('sub_b', 'cus_b', 'past_due');
        assert.strictEqual(getAccessState(user).hasAccess, true, 'precondition: user starts with access');
        await controller.handlers['invoice.payment_failed']({ id: 'in_b', customer: 'cus_b', subscription: 'sub_b' }, null);
        check('invoice.payment_failed revokes access immediately', () => {
            assert.strictEqual(user.subscription_status, 'past_due');
            assert.strictEqual(getAccessState(user).hasAccess, false);
            assert.strictEqual(getAccessState(user).reason, 'payment_failed');
            assert.ok(notifiedTypes(user).includes('PAYMENT_FAILED'), 'user was not told payment failed');
        });
    }

    // 4c. recovery -> access restored
    {
        const user = await FakeUser.findOne({ email: 'b@example.com' });
        makeSub('sub_b', 'cus_b', 'active');
        stripeState.invoices.set('in_b2', { id: 'in_b2', customer: 'cus_b', subscription: 'sub_b' });
        await controller.handlers['invoice.paid']({ id: 'in_b2', customer: 'cus_b', subscription: 'sub_b', amount_paid: 699, currency: 'usd', billing_reason: 'subscription_cycle' }, null);
        check('invoice.paid after a failure restores access and clears payment_failed_at', () => {
            assert.strictEqual(user.subscription_status, 'active');
            assert.strictEqual(user.payment_failed_at, null);
            assert.strictEqual(getAccessState(user).hasAccess, true);
            assert.ok(notifiedTypes(user).includes('SUBSCRIPTION_RENEWED'));
        });
    }

    // 4d. cancel at period end -> keeps access until period end
    {
        const user = await newUser({ email: 'c@example.com', stripeAccountId: 'cus_c', subscription_id: 'sub_c', subscription_status: 'active', subscriptionendin: daysFromNow(10) });
        const sub = makeSub('sub_c', 'cus_c', 'active', { cancel_at_period_end: true, current_period_end: unix(daysFromNow(10)) });
        await controller.handlers['customer.subscription.updated'](sub, { data: { object: sub, previous_attributes: { cancel_at_period_end: false } } });
        check('cancel-at-period-end keeps access until the paid period ends', () => {
            assert.strictEqual(user.cancel_at_period_end, true);
            assert.strictEqual(getAccessState(user).hasAccess, true);
            assert.strictEqual(getAccessState(user).reason, 'active_canceling');
            assert.ok(notifiedTypes(user).includes('SUBSCRIPTION_CANCELED'));
        });
    }

    // 4e. subscription deleted -> access revoked now
    {
        const user = await FakeUser.findOne({ email: 'c@example.com' });
        const sub = makeSub('sub_c', 'cus_c', 'canceled', { canceled_at: unix(new Date()) });
        await controller.handlers['customer.subscription.deleted'](sub, makeEvent('customer.subscription.deleted', sub));
        check('customer.subscription.deleted revokes access and clears the future end date', () => {
            assert.strictEqual(user.subscription_status, 'canceled');
            assert.ok(user.subscriptionendin <= new Date(), 'subscriptionendin still in the future');
            assert.strictEqual(getAccessState(user).hasAccess, false);
            assert.ok(notifiedTypes(user).includes('SUBSCRIPTION_ENDED'));
        });
    }

    // 4f. trial_will_end
    {
        const user = await newUser({ email: 'd@example.com', stripeAccountId: 'cus_d', subscription_id: 'sub_d', subscription_status: 'trialing' });
        const sub = makeSub('sub_d', 'cus_d', 'trialing', { trial_end: unix(daysFromNow(3)) });
        await controller.handlers['customer.subscription.trial_will_end'](sub, makeEvent('customer.subscription.trial_will_end', sub));
        check('customer.subscription.trial_will_end warns the user before conversion', () => {
            assert.ok(notifiedTypes(user).includes('TRIAL_ENDING'));
            assert.ok(user.trial_end_notified_at);
        });
    }

    // 4g. status transition active -> unpaid via subscription.updated
    {
        const user = await newUser({ email: 'e@example.com', stripeAccountId: 'cus_e', subscription_id: 'sub_e', subscription_status: 'active', subscriptionendin: daysFromNow(10) });
        const sub = makeSub('sub_e', 'cus_e', 'unpaid');
        await controller.handlers['customer.subscription.updated'](sub, { data: { object: sub, previous_attributes: { status: 'past_due' } } });
        check('customer.subscription.updated to "unpaid" revokes access', () => {
            assert.strictEqual(getAccessState(user).hasAccess, false);
            assert.ok(notifiedTypes(user).includes('PAYMENT_FAILED'));
        });
    }

    // -----------------------------------------------------------------------
    section('5. Trial expiry sweep (jobs/subscriptionSweep.js)');

    {
        store.clear();
        notifications.length = 0;
        const expiring = await newUser({ email: 'soon@example.com', subscription_status: 'trial', trialendin: new Date(Date.now() + 6 * 60 * 60 * 1000) });
        const expired = await newUser({ email: 'over@example.com', subscription_status: 'trial', trialendin: daysFromNow(-1) });
        const healthy = await newUser({ email: 'ok@example.com', subscription_status: 'trial', trialendin: daysFromNow(2) });
        const paying = await newUser({ email: 'pay@example.com', subscription_status: 'active', trialendin: daysFromNow(-30), subscriptionendin: daysFromNow(10) });

        const warned = await sweep.warnEndingTrials();
        check('sweep warns exactly the trial ending within 24h', () => {
            assert.strictEqual(warned, 1, `warned ${warned} users`);
            assert.ok(expiring.trial_end_notified_at, 'expiring user not marked as warned');
            assert.deepStrictEqual(notifiedTypes(expiring), ['TRIAL_ENDING']);
            assert.deepStrictEqual(notifiedTypes(healthy), []);
        });

        const warnedAgain = await sweep.warnEndingTrials();
        check('second warning sweep is a no-op', () => {
            assert.strictEqual(warnedAgain, 0);
            assert.deepStrictEqual(notifiedTypes(expiring), ['TRIAL_ENDING']);
        });

        const expiredCount = await sweep.expireFinishedTrials();
        check('sweep expires the finished trial and revokes its access', () => {
            assert.strictEqual(expiredCount, 1, `expired ${expiredCount} users`);
            assert.strictEqual(expired.subscription_status, 'trial_expired');
            assert.strictEqual(getAccessState(expired).hasAccess, false);
            assert.ok(notifiedTypes(expired).includes('TRIAL_ENDED'), 'user not told the trial ended');
        });

        check('sweep leaves running trials and paying users alone', () => {
            assert.strictEqual(healthy.subscription_status, 'trial');
            assert.strictEqual(getAccessState(healthy).hasAccess, true);
            assert.strictEqual(paying.subscription_status, 'active');
            assert.strictEqual(getAccessState(paying).hasAccess, true, 'paying user lost access at trial end');
        });

        const expiredAgain = await sweep.expireFinishedTrials();
        check('re-running the expiry sweep sends no duplicate notification', () => {
            assert.strictEqual(expiredAgain, 0);
            assert.strictEqual(notifiedTypes(expired).filter((t) => t === 'TRIAL_ENDED').length, 1);
        });
    }

    // -----------------------------------------------------------------------
    section('5b. Missed-webhook reconciliation');

    {
        store.clear();
        notifications.length = 0;
        // Looks active locally, but Stripe says it was canceled: the exact state
        // a dropped customer.subscription.deleted leaves behind.
        const stale = await newUser({ email: 'stale@example.com', stripeAccountId: 'cus_s', subscription_id: 'sub_s', subscription_status: 'active', subscriptionendin: daysFromNow(-2) });
        makeSub('sub_s', 'cus_s', 'canceled', { current_period_end: unix(daysFromNow(-2)), canceled_at: unix(daysFromNow(-2)) });
        assert.strictEqual(getAccessState(stale).hasAccess, true, 'precondition: stale user still has access');

        const reconciled = await sweep.reconcileStaleSubscriptions();
        check('reconciliation catches a missed cancellation webhook', () => {
            assert.strictEqual(reconciled, 1, `reconciled ${reconciled}`);
            assert.strictEqual(stale.subscription_status, 'canceled');
            assert.strictEqual(getAccessState(stale).hasAccess, false);
        });

        // Subscription deleted outright in Stripe.
        const gone = await newUser({ email: 'gone@example.com', stripeAccountId: 'cus_g', subscription_id: 'sub_missing', subscription_status: 'active', subscriptionendin: daysFromNow(-3) });
        await sweep.reconcileStaleSubscriptions();
        check('a subscription that no longer exists in Stripe revokes access', () => {
            assert.strictEqual(gone.subscription_status, 'canceled');
            assert.strictEqual(getAccessState(gone).hasAccess, false);
            assert.ok(notifiedTypes(gone).includes('SUBSCRIPTION_ENDED'));
        });
    }

    // -----------------------------------------------------------------------
    section('6. Event coverage');

    const required = [
        'customer.created',
        'customer.deleted',
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'customer.subscription.trial_will_end',
        'invoice.paid',
        'invoice.payment_succeeded',
        'invoice.payment_failed',
        'payment_intent.payment_failed',
        'charge.refunded',
    ];
    check('no Stripe-side trial is configured (trial is app-side by design)', () => {
        const src = require('fs').readFileSync(require.resolve('../controllers/stripeWebHookController'), 'utf8');
        const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(
            !/trial_period_days\s*:/.test(withoutComments),
            'trial_period_days is being passed to Stripe — trial moved into Stripe?'
        );
    });

    for (const type of required) {
        check(`handler registered: ${type}`, () => {
            assert.strictEqual(typeof controller.handlers[type], 'function');
        });
    }

    // -----------------------------------------------------------------------
    console.log(`\n\x1b[1mResult:\x1b[0m ${passed} passed, ${failures.length} failed`);
    if (failures.length) {
        console.log('\nFailures:');
        failures.forEach((f) => console.log(`  - ${f.name}: ${f.error.message}`));
        process.exit(1);
    }
    process.exit(0);
})().catch((err) => {
    console.error('\nVerification crashed:', err);
    process.exit(1);
});
