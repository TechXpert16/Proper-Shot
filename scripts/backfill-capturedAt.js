/**
 * One-time backfill: set `capturedAt` on photos that predate the field.
 *
 * WHY THIS IS REQUIRED, not optional:
 * The list endpoints now sort by `{capturedAt: -1, createdAt: -1}`. MongoDB treats a MISSING
 * field as null, and null sorts lowest in a descending sort — so every photo uploaded before
 * this field existed would drop below every new photo, regardless of its actual date. The
 * mongoose `default: Date.now` only applies to newly created documents; it does not touch
 * rows already in the database.
 *
 * Copying `createdAt` into `capturedAt` is the best available approximation for historic rows:
 * capture time was never transmitted, so upload time is the only timestamp that exists. New
 * uploads carry the device's real capture time.
 *
 * Safe to re-run: it only matches documents where `capturedAt` is absent or null.
 *
 *   node scripts/backfill-capturedAt.js            # apply
 *   node scripts/backfill-capturedAt.js --dry-run  # count only, no writes
 */

require('dotenv').config();
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  if (!process.env.DB_URL) {
    console.error('DB_URL is not set. Aborting without connecting.');
    process.exit(1);
  }

  await mongoose.connect(process.env.DB_URL);
  console.log('Connected.');

  // Query the collection directly rather than through the model, so the schema default
  // cannot mask which documents are genuinely missing the field.
  const photos = mongoose.connection.db.collection('photos');

  const filter = {$or: [{capturedAt: {$exists: false}}, {capturedAt: null}]};

  const total = await photos.countDocuments({});
  const pending = await photos.countDocuments(filter);

  console.log(`photos total:            ${total}`);
  console.log(`missing capturedAt:      ${pending}`);

  if (pending === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  if (DRY_RUN) {
    console.log('--dry-run given, no writes performed.');
    return;
  }

  // Aggregation-pipeline update so capturedAt can reference this document's own createdAt.
  // Requires MongoDB 4.2+. `$ifNull` guards the (unexpected) case of a row with no createdAt.
  const result = await photos.updateMany(filter, [
    {$set: {capturedAt: {$ifNull: ['$createdAt', '$$NOW']}}},
  ]);

  console.log(`matched:                 ${result.matchedCount}`);
  console.log(`modified:                ${result.modifiedCount}`);

  const remaining = await photos.countDocuments(filter);
  console.log(`still missing:           ${remaining}`);

  if (remaining > 0) {
    console.warn('Some documents were not backfilled — re-run and investigate if this persists.');
    process.exitCode = 1;
  } else {
    console.log('Backfill complete.');
  }
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
