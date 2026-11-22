const { Bus, BusOwner, Subscription } = require('../models');
const { addDays } = require('../utils/helpers');
const { notifyOwner } = require('./notificationService');

/** Keep Bus.ownerVerified in sync whenever an owner is approved / rejected / suspended. */
async function syncOwnerVerified(ownerId) {
  const owner = await BusOwner.findById(ownerId);
  if (!owner) return;
  const verified = owner.verificationStatus === 'approved' && !owner.isSuspended;
  await Bus.updateMany({ owner: owner._id }, { $set: { ownerVerified: verified } });
}

/** Recompute bus.subscriptionExpiresAt from its active subscriptions. */
async function refreshBusExpiry(busId) {
  const latest = await Subscription.findOne({ bus: busId, status: 'active' }).sort({ endDate: -1 });
  await Bus.updateOne({ _id: busId }, { $set: { subscriptionExpiresAt: latest ? latest.endDate : null } });
  return latest ? latest.endDate : null;
}

/**
 * Start a paid subscription period. Periods stack: a renewal bought before expiry starts when the current one ends.
 */
async function activateSubscription(sub, now = new Date()) {
  const bus = await Bus.findById(sub.bus);
  const currentEnd = bus?.subscriptionExpiresAt && bus.subscriptionExpiresAt > now ? bus.subscriptionExpiresAt : now;
  sub.startDate = currentEnd;
  sub.endDate = addDays(currentEnd, sub.planSnapshot.durationDays + (sub.extendedDays || 0));
  sub.status = 'active';
  await sub.save();
  await refreshBusExpiry(sub.bus);
  return sub;
}

/**
 * After payment: if the listing is already approved the period starts immediately,
 * otherwise it waits for admin approval.
 */
async function onSubscriptionPaid(sub) {
  const bus = await Bus.findById(sub.bus);
  if (bus.approval.status === 'approved') {
    await activateSubscription(sub);
  } else {
    sub.status = 'pending_approval';
    await sub.save();
    if (bus.approval.status === 'draft' || bus.approval.status === 'rejected') {
      bus.approval.status = 'pending';
      bus.approval.submittedAt = new Date();
      bus.approval.reason = undefined;
      await bus.save();
    }
  }
  return sub;
}

/** When admin approves a listing, start any paid-but-waiting subscriptions. */
async function activatePendingForBus(busId) {
  const pending = await Subscription.find({ bus: busId, status: 'pending_approval' }).sort({ createdAt: 1 });
  for (const sub of pending) {
    // eslint-disable-next-line no-await-in-loop
    await activateSubscription(sub);
  }
  return pending.length;
}

/** Expire finished subscriptions and send reminders. Run by the scheduler. */
async function runExpiryJob(now = new Date(), reminderDays = 3) {
  const expired = await Subscription.find({ status: 'active', endDate: { $lte: now } });
  for (const sub of expired) {
    sub.status = 'expired';
    sub.expiredNotifiedAt = now;
    // eslint-disable-next-line no-await-in-loop
    await sub.save();
    // eslint-disable-next-line no-await-in-loop
    const bus = await Bus.findById(sub.bus).select('name owner');
    // eslint-disable-next-line no-await-in-loop
    const remaining = await refreshBusExpiry(sub.bus);
    if (!remaining && bus) {
      // eslint-disable-next-line no-await-in-loop
      await notifyOwner(bus.owner, 'subscription_expired', `Listing expired: ${bus.name}`, 'This bus is no longer visible to passengers. Renew the listing to show it again.', '/owner/subscriptions');
    }
  }

  const soon = await Subscription.find({
    status: 'active',
    endDate: { $gt: now, $lte: addDays(now, reminderDays) },
    reminderSentAt: null,
  });
  for (const sub of soon) {
    // Skip if a later subscription already covers the bus.
    // eslint-disable-next-line no-await-in-loop
    const later = await Subscription.findOne({ bus: sub.bus, status: 'active', endDate: { $gt: sub.endDate } });
    sub.reminderSentAt = now;
    // eslint-disable-next-line no-await-in-loop
    await sub.save();
    if (later) continue;
    // eslint-disable-next-line no-await-in-loop
    const bus = await Bus.findById(sub.bus).select('name owner');
    if (bus) {
      // eslint-disable-next-line no-await-in-loop
      await notifyOwner(bus.owner, 'subscription_expiring', `Listing expiring soon: ${bus.name}`, `Your listing expires on ${sub.endDate.toDateString()}. Renew now to stay visible.`, '/owner/subscriptions');
    }
  }

  const stale = await Subscription.updateMany(
    { status: 'pending_payment', createdAt: { $lt: addDays(now, -1) } },
    { $set: { status: 'cancelled', notes: 'Payment not completed within 24 hours' } }
  );

  return { expired: expired.length, reminders: soon.length, cancelledUnpaid: stale.modifiedCount || 0 };
}

module.exports = { syncOwnerVerified, refreshBusExpiry, activateSubscription, onSubscriptionPaid, activatePendingForBus, runExpiryJob };
