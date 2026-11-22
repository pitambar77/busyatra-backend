/**
 * Puts the demo photos on the already-seeded demo buses, without touching any other data.
 * Only buses that still have the old drawn placeholder images (or no images) are changed,
 * so photos uploaded by operators are never overwritten.
 *
 *   npm run photos
 */
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const { Bus, City } = require('../models');
const { BUS_PHOTOS, CITY_PHOTOS } = require('./photos');

(async () => {
  await connectDB();
  let updated = 0;
  let skipped = 0;
  for (const [reg, images] of Object.entries(BUS_PHOTOS)) {
    // eslint-disable-next-line no-await-in-loop
    const bus = await Bus.findOne({ registrationNumber: reg });
    if (!bus) continue;
    if (JSON.stringify(bus.images) === JSON.stringify(images)) continue; // already has these photos
    const onlyPlaceholders = bus.images.every((u) => u.includes('/uploads/images/seed-'));
    if (!onlyPlaceholders) {
      skipped += 1;
      console.log(`  skipped ${bus.name} (has operator-uploaded photos)`);
      continue;
    }
    bus.images = images;
    // eslint-disable-next-line no-await-in-loop
    await bus.save();
    updated += 1;
    console.log(`  ✓ ${bus.name}`);
  }
  console.log(`Buses: ${updated} updated, ${skipped} skipped.`);

  // City landmark photos: only fills cities that don't have a photo yet.
  let cities = 0;
  for (const [name, photo] of Object.entries(CITY_PHOTOS)) {
    // eslint-disable-next-line no-await-in-loop
    const res = await City.updateOne({ name, $or: [{ image: null }, { image: '' }, { image: { $exists: false } }] }, { $set: photo });
    if (res.modifiedCount) {
      cities += 1;
      console.log(`  ✓ ${name}`);
    }
  }
  console.log(`Cities: ${cities} updated.`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
