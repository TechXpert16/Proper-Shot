const mongoose = require('mongoose');

/**
 * Webhook idempotency ledger. Stripe retries a webhook until it gets a 2xx and
 * can deliver the same event more than once, so every event id is recorded here
 * before it is processed and skipped if it is already present.
 */
const StripeEventSchema = new mongoose.Schema(
    {
        eventId: { type: String, required: true, unique: true, index: true },
        type: { type: String, required: true },
        processedAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

// Stripe only replays events for a few days; keep the ledger from growing forever.
StripeEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

module.exports = mongoose.model('StripeEvent', StripeEventSchema);
