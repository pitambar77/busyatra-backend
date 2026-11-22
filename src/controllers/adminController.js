const path = require('path');
const mongoose = require('mongoose');
const config = require('../config');
const {
  User, AdminUser, BusOwner, TeamMember, Bus, Route, City, Stop, RouteCategory, PopularRoute, DailyBusStatus,
  SubscriptionPlan, Subscription, Payment, Enquiry, SearchLog, Notification,
} = require('../models');
const { ApiError, dateKey, isValidDateKey, addDays, paginate, pageMeta, escapeRegex, slugify, pick } = require('../utils/helpers');
const { resolveStatus, statusMapFor, upsertStatus } = require('../services/statusService');
const { syncOwnerVerified, activatePendingForBus, refreshBusExpiry, activateSubscription } = require('../services/listingService');
const { notifyOwner } = require('../services/notificationService');
const { refund: refundPayment, markPaid } = require('../services/paymentService');
const { streamReceipt } = require('../services/receiptService');
const { _internal: ownerInternal } = require('./ownerController');

const oid = (id) => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid id');
  return id;
};

// ───────────────────────── Dashboard ─────────────────────────

exports.dashboard = async (req, res) => {
  const now = new Date();
  const today = dateKey();
  const publicFilter = Bus.publicFilter(now);
  const [owners, pendingOwners, buses, activeListings, pendingListings, expiredSubs, paidAgg, paymentsCount, enquiryAgg, publicIds] = await Promise.all([
    BusOwner.countDocuments(),
    BusOwner.countDocuments({ verificationStatus: 'pending' }),
    Bus.countDocuments({ deletedAt: null }),
    Bus.countDocuments(publicFilter),
    Bus.countDocuments({ deletedAt: null, 'approval.status': 'pending' }),
    Bus.countDocuments({ deletedAt: null, 'approval.status': 'approved', $or: [{ subscriptionExpiresAt: null }, { subscriptionExpiresAt: { $lte: now } }] }),
    Payment.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Payment.countDocuments(),
    Enquiry.aggregate([{ $group: { _id: '$type', count: { $sum: 1 } } }]),
    Bus.distinct('_id', publicFilter),
  ]);
  const statusDocs = await DailyBusStatus.find({ bus: { $in: publicIds }, date: today }).select('status').lean();
  const enq = Object.fromEntries(enquiryAgg.map((e) => [e._id, e.count]));
  const running = statusDocs.filter((s) => ['running', 'delayed'].includes(s.status)).length;
  const stopped = statusDocs.filter((s) => ['not_running', 'cancelled', 'suspended'].includes(s.status)).length;

  const since = addDays(now, -13);
  const [recentPayments, recentOwners, pendingQueue] = await Promise.all([
    Payment.find({ status: 'paid', paidAt: { $gte: since } }).select('amount paidAt').lean(),
    BusOwner.find().sort({ createdAt: -1 }).limit(5).select('companyName ownerName verificationStatus createdAt').lean(),
    Bus.find({ deletedAt: null, 'approval.status': 'pending' }).sort({ 'approval.submittedAt': 1 }).limit(5).populate('owner', 'companyName verificationStatus').select('name registrationNumber approval owner images').lean(),
  ]);
  const revenueTrend = [];
  for (let i = 13; i >= 0; i -= 1) {
    const key = dateKey(addDays(now, -i));
    revenueTrend.push({ date: key, amount: recentPayments.filter((p) => dateKey(p.paidAt) === key).reduce((s, p) => s + p.amount, 0) });
  }

  res.json({
    success: true,
    data: {
      stats: {
        totalOwners: owners,
        pendingOwners,
        totalBuses: buses,
        activeListings,
        pendingApprovals: pendingListings,
        expiredSubscriptions: expiredSubs,
        totalPayments: paymentsCount,
        paidPayments: await Payment.countDocuments({ status: 'paid' }),
        totalRevenue: paidAgg[0]?.total || 0,
        enquiries: enq.enquiry || 0,
        callClicks: enq.call_click || 0,
        whatsappClicks: enq.whatsapp_click || 0,
        contactMessages: enq.contact || 0,
        runningToday: running,
        stoppedToday: stopped,
        notUpdatedToday: publicIds.length - statusDocs.length,
      },
      revenueTrend,
      recentOwners,
      pendingQueue,
      today,
    },
  });
};

// ───────────────────────── Owners ─────────────────────────

exports.listOwners = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const filter = {};
  if (req.query.status === 'suspended') filter.isSuspended = true;
  else if (req.query.status) filter.verificationStatus = req.query.status;
  if (req.query.q) {
    const rx = { $regex: escapeRegex(req.query.q), $options: 'i' };
    filter.$or = [{ companyName: rx }, { ownerName: rx }, { email: rx }, { mobile: rx }];
  }
  const [total, owners] = await Promise.all([BusOwner.countDocuments(filter), BusOwner.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()]);
  const ownerBuses = await Bus.find({ owner: { $in: owners.map((o) => o._id) }, deletedAt: null }).select('owner images').sort({ createdAt: 1 }).lean();
  const byOwner = ownerBuses.reduce((m, b) => m.set(String(b.owner), [...(m.get(String(b.owner)) || []), b]), new Map());
  res.json({
    success: true,
    data: owners.map((o) => {
      const list = byOwner.get(String(o._id)) || [];
      return { ...o, busCount: list.length, busImages: list.map((b) => b.images?.[0]).filter(Boolean).slice(0, 3) };
    }),
    meta: pageMeta(total, { page, limit }),
  });
};

exports.getOwner = async (req, res) => {
  const owner = await BusOwner.findById(oid(req.params.id)).populate('user', 'name email mobile isMobileVerified lastLoginAt status createdAt');
  if (!owner) throw new ApiError(404, 'Owner not found');
  const [buses, payments, team] = await Promise.all([
    Bus.find({ owner: owner._id, deletedAt: null }).sort({ createdAt: -1 }),
    Payment.find({ owner: owner._id }).sort({ createdAt: -1 }).limit(20).populate('bus', 'name images').lean(),
    TeamMember.find({ owner: owner._id }).populate('user', 'name email mobile').lean(),
  ]);
  res.json({ success: true, data: { owner, buses: buses.map((b) => ({ ...b.toObject(), listingState: b.listingState() })), payments, team } });
};

exports.updateOwner = async (req, res) => {
  const owner = await BusOwner.findById(oid(req.params.id));
  if (!owner) throw new ApiError(404, 'Owner not found');
  Object.assign(owner, pick(req.body, ['ownerName', 'companyName', 'about', 'email', 'mobile']));
  if (req.body.businessAddress) owner.businessAddress = { ...owner.businessAddress?.toObject?.(), ...req.body.businessAddress };
  if (req.body.companyName) owner.slug = `${slugify(owner.companyName)}-${String(owner._id).slice(-4)}`;
  await owner.save();
  res.json({ success: true, data: owner });
};

exports.verifyOwner = async (req, res) => {
  const owner = await BusOwner.findById(oid(req.params.id));
  if (!owner) throw new ApiError(404, 'Owner not found');
  const { action, reason } = req.body;
  if (action === 'approve') {
    owner.verificationStatus = 'approved';
    owner.rejectionReason = undefined;
    owner.verifiedAt = new Date();
    owner.verifiedBy = req.admin._id;
    await owner.save();
    await notifyOwner(owner._id, 'owner_approved', 'Your operator account is verified', 'You can now publish bus listings.', '/owner');
  } else if (action === 'reject') {
    if (!reason) throw new ApiError(400, 'Give a reason so the operator can fix it');
    owner.verificationStatus = 'rejected';
    owner.rejectionReason = reason;
    await owner.save();
    await notifyOwner(owner._id, 'owner_rejected', 'Verification was not approved', reason, '/owner/profile');
  } else throw new ApiError(400, 'action must be approve or reject');
  await syncOwnerVerified(owner._id);
  res.json({ success: true, data: owner });
};

exports.verifyDocument = async (req, res) => {
  const owner = await BusOwner.findById(oid(req.params.id));
  if (!owner) throw new ApiError(404, 'Owner not found');
  const doc = owner.documents.id(req.params.docId);
  if (!doc) throw new ApiError(404, 'Document not found');
  doc.verified = !!req.body.verified;
  await owner.save();
  res.json({ success: true, data: owner });
};

exports.downloadDocument = async (req, res) => {
  const owner = await BusOwner.findById(oid(req.params.id));
  const doc = owner?.documents.id(req.params.docId);
  if (!doc) throw new ApiError(404, 'Document not found');
  res.type(doc.mimeType || 'application/octet-stream');
  res.sendFile(path.join(config.uploads.dir, 'docs', path.basename(doc.fileName)));
};

exports.suspendOwner = async (req, res) => {
  const owner = await BusOwner.findById(oid(req.params.id));
  if (!owner) throw new ApiError(404, 'Owner not found');
  owner.isSuspended = !!req.body.suspend;
  owner.suspensionReason = owner.isSuspended ? req.body.reason || 'Policy violation' : undefined;
  await owner.save();
  await User.updateOne({ _id: owner.user }, { $set: { status: owner.isSuspended ? 'suspended' : 'active' } });
  await syncOwnerVerified(owner._id);
  if (owner.isSuspended) await notifyOwner(owner._id, 'owner_suspended', 'Your account has been suspended', owner.suspensionReason, '/owner');
  res.json({ success: true, data: owner });
};

// ───────────────────────── Listings ─────────────────────────

exports.listBuses = async (req, res) => {
  const now = new Date();
  const { page, limit, skip } = paginate(req.query);
  const filter = { deletedAt: null };
  if (req.query.approval) filter['approval.status'] = req.query.approval;
  if (req.query.owner && mongoose.isValidObjectId(req.query.owner)) filter.owner = req.query.owner;
  if (req.query.q) {
    const rx = { $regex: escapeRegex(req.query.q), $options: 'i' };
    filter.$or = [{ name: rx }, { registrationNumber: rx }];
  }
  const state = req.query.state;
  if (state === 'active') Object.assign(filter, Bus.publicFilter(now));
  if (state === 'expired') Object.assign(filter, { 'approval.status': 'approved', $or: [{ subscriptionExpiresAt: null }, { subscriptionExpiresAt: { $lte: now } }] });
  if (state === 'disabled') filter.adminDisabled = true;
  if (state === 'inactive') filter.isActive = false;

  const [total, buses] = await Promise.all([Bus.countDocuments(filter), Bus.find(filter).populate('owner', 'companyName verificationStatus isSuspended').sort({ updatedAt: -1 }).skip(skip).limit(limit)]);
  const date = isValidDateKey(req.query.date) ? req.query.date : dateKey();
  const statusMap = await statusMapFor(buses.map((b) => b._id), date);
  res.json({
    success: true,
    data: buses.map((b) => ({ ...b.toObject(), listingState: b.listingState(now), todayStatus: resolveStatus(b, statusMap.get(String(b._id)), date) })),
    meta: pageMeta(total, { page, limit }),
  });
};

exports.getBus = async (req, res) => {
  const bus = await Bus.findById(oid(req.params.id)).populate('owner');
  if (!bus) throw new ApiError(404, 'Bus not found');
  const [routes, subs, history] = await Promise.all([
    Route.find({ bus: bus._id }).lean(),
    Subscription.find({ bus: bus._id }).populate('payment', 'status amount receiptNumber').sort({ createdAt: -1 }).lean(),
    DailyBusStatus.find({ bus: bus._id }).sort({ date: -1 }).limit(30).lean(),
  ]);
  res.json({ success: true, data: { ...bus.toObject(), listingState: bus.listingState(), routes, subscriptions: subs, statusHistory: history, todayStatus: resolveStatus(bus, history.find((h) => h.date === dateKey()), dateKey()) } });
};

exports.updateBus = async (req, res) => {
  const bus = await Bus.findById(oid(req.params.id));
  if (!bus) throw new ApiError(404, 'Bus not found');
  const fields = pick(req.body, ['name', 'registrationNumber', 'seatingCapacity', 'contactNumber', 'alternateNumber', 'whatsappNumber', 'ticketPrice', 'description', 'busTypes', 'facilities']);
  Object.assign(bus, fields);
  if (fields.name) bus.slug = `${slugify(bus.name)}-${String(bus._id).slice(-6)}`;
  await bus.save();
  res.json({ success: true, data: bus });
};

exports.reviewBus = async (req, res) => {
  const bus = await Bus.findById(oid(req.params.id)).populate('owner');
  if (!bus) throw new ApiError(404, 'Bus not found');
  const { action, reason } = req.body;
  if (action === 'approve') {
    if (bus.owner.verificationStatus !== 'approved') throw new ApiError(400, 'Verify the operator before approving their listings');
    if (bus.owner.isSuspended) throw new ApiError(400, 'Operator is suspended');
    bus.approval = { ...bus.approval.toObject(), status: 'approved', reason: undefined, reviewedAt: new Date(), reviewedBy: req.admin._id };
    bus.ownerVerified = true;
    await bus.save();
    const started = await activatePendingForBus(bus._id);
    const fresh = await Bus.findById(bus._id);
    await notifyOwner(bus.owner._id, 'listing_approved', `Listing approved: ${bus.name}`, fresh.subscriptionExpiresAt ? `Visible to passengers until ${fresh.subscriptionExpiresAt.toDateString()}.` : 'Purchase a listing plan to make it visible.', `/owner/buses/${bus._id}`);
    return res.json({ success: true, message: started ? 'Approved and subscription activated' : 'Approved', data: fresh });
  }
  if (action === 'reject') {
    if (!reason) throw new ApiError(400, 'Give a reason for rejection');
    bus.approval = { ...bus.approval.toObject(), status: 'rejected', reason, reviewedAt: new Date(), reviewedBy: req.admin._id };
    await bus.save();
    await notifyOwner(bus.owner._id, 'listing_rejected', `Listing needs changes: ${bus.name}`, reason, `/owner/buses/${bus._id}`);
    return res.json({ success: true, data: bus });
  }
  throw new ApiError(400, 'action must be approve or reject');
};

exports.disableBus = async (req, res) => {
  const bus = await Bus.findById(oid(req.params.id));
  if (!bus) throw new ApiError(404, 'Bus not found');
  bus.adminDisabled = !!req.body.disabled;
  bus.adminDisabledReason = bus.adminDisabled ? req.body.reason || 'Disabled by admin' : undefined;
  await bus.save();
  if (bus.adminDisabled) await notifyOwner(bus.owner, 'listing_disabled', `Listing disabled: ${bus.name}`, bus.adminDisabledReason, `/owner/buses/${bus._id}`);
  res.json({ success: true, data: bus });
};

exports.removeBus = async (req, res) => {
  const bus = await Bus.findById(oid(req.params.id));
  if (!bus) throw new ApiError(404, 'Bus not found');
  bus.deletedAt = new Date();
  bus.isActive = false;
  bus.adminDisabled = true;
  bus.adminDisabledReason = req.body?.reason || 'Removed by admin';
  bus.registrationNumber = `${bus.registrationNumber}-DEL-${Date.now().toString(36)}`;
  await bus.save();
  await Route.updateMany({ bus: bus._id }, { $set: { isActive: false } });
  await notifyOwner(bus.owner, 'listing_disabled', `Listing removed: ${bus.name}`, bus.adminDisabledReason);
  res.json({ success: true, message: 'Listing removed' });
};

exports.setBusStatus = async (req, res) => {
  const bus = await Bus.findById(oid(req.params.id));
  if (!bus) throw new ApiError(404, 'Bus not found');
  const body = ownerInternal.validateStatusBody(req.body);
  const doc = await upsertStatus({ bus, ...body, actor: { _id: req.admin._id, name: `${req.admin.name} (admin)` }, actorModel: 'AdminUser' });
  res.json({ success: true, data: { record: doc, status: resolveStatus(bus, doc, body.date) } });
};

exports.statusBoard = async (req, res) => {
  const date = isValidDateKey(req.query.date) ? req.query.date : dateKey();
  const { page, limit, skip } = paginate({ ...req.query, limit: req.query.limit || 25 });
  const filter = Bus.publicFilter();
  const [total, buses] = await Promise.all([Bus.countDocuments(filter), Bus.find(filter).populate('owner', 'companyName').sort({ name: 1 }).skip(skip).limit(limit)]);
  const statusMap = await statusMapFor(buses.map((b) => b._id), date);
  let data = buses.map((b) => ({ _id: b._id, name: b.name, registrationNumber: b.registrationNumber, images: b.images.slice(0, 1), busTypes: b.busTypes, owner: b.owner, status: resolveStatus(b, statusMap.get(String(b._id)), date), record: statusMap.get(String(b._id)) || null }));
  if (req.query.code) data = data.filter((d) => d.status.code === req.query.code);
  res.json({ success: true, data, meta: { ...pageMeta(total, { page, limit }), date } });
};

// ───────────────────────── Plans, subscriptions, payments ─────────────────────────

exports.listPlans = async (req, res) => {
  const plans = await SubscriptionPlan.find().sort({ sortOrder: 1, durationDays: 1 }).lean();
  const counts = await Subscription.aggregate([{ $match: { status: { $in: ['active', 'expired', 'pending_approval'] } } }, { $group: { _id: '$plan', count: { $sum: 1 }, revenue: { $sum: '$planSnapshot.price' } } }]);
  const cm = new Map(counts.map((c) => [String(c._id), c]));
  res.json({ success: true, data: plans.map((p) => ({ ...p, sold: cm.get(String(p._id))?.count || 0, revenue: cm.get(String(p._id))?.revenue || 0 })) });
};

const PLAN_FIELDS = ['name', 'code', 'durationDays', 'price', 'description', 'features', 'isPopular', 'isActive', 'sortOrder'];

exports.createPlan = async (req, res) => {
  const plan = await SubscriptionPlan.create(pick(req.body, PLAN_FIELDS));
  res.status(201).json({ success: true, data: plan });
};

exports.updatePlan = async (req, res) => {
  const plan = await SubscriptionPlan.findByIdAndUpdate(oid(req.params.id), pick(req.body, PLAN_FIELDS), { new: true, runValidators: true });
  if (!plan) throw new ApiError(404, 'Plan not found');
  res.json({ success: true, data: plan });
};

exports.deletePlan = async (req, res) => {
  const used = await Subscription.countDocuments({ plan: oid(req.params.id) });
  if (used) {
    await SubscriptionPlan.updateOne({ _id: req.params.id }, { $set: { isActive: false } });
    return res.json({ success: true, message: 'Plan has been used before, so it was deactivated instead of deleted' });
  }
  await SubscriptionPlan.deleteOne({ _id: req.params.id });
  return res.json({ success: true, message: 'Plan deleted' });
};

exports.listSubscriptions = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.expiring === 'true') Object.assign(filter, { status: 'active', endDate: { $lte: addDays(new Date(), 7) } });
  const [total, items] = await Promise.all([
    Subscription.countDocuments(filter),
    Subscription.find(filter).populate('bus', 'name registrationNumber images').populate('owner', 'companyName').populate('payment', 'status amount receiptNumber').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({ success: true, data: items, meta: pageMeta(total, { page, limit }) });
};

exports.extendSubscription = async (req, res) => {
  const days = Number(req.body.days);
  if (!days || days < 1 || days > 365) throw new ApiError(400, 'Days must be between 1 and 365');
  const sub = await Subscription.findById(oid(req.params.id));
  if (!sub) throw new ApiError(404, 'Subscription not found');
  if (sub.status === 'active') {
    sub.endDate = addDays(sub.endDate, days);
    sub.extendedDays += days;
    sub.reminderSentAt = undefined;
    await sub.save();
  } else if (sub.status === 'expired') {
    // Reopen an expired subscription from today.
    sub.status = 'active';
    sub.startDate = new Date();
    sub.endDate = addDays(new Date(), days);
    sub.extendedDays += days;
    sub.reminderSentAt = undefined;
    await sub.save();
  } else if (sub.status === 'pending_approval') {
    sub.extendedDays += days;
    await sub.save();
  } else throw new ApiError(400, `Cannot extend a ${sub.status} subscription`);
  await refreshBusExpiry(sub.bus);
  await notifyOwner(sub.owner, 'subscription_extended', `Listing extended by ${days} days`, sub.endDate ? `New expiry: ${sub.endDate.toDateString()}` : 'Added to your plan once approved', '/owner/subscriptions');
  res.json({ success: true, data: sub });
};

/** Grant a complimentary subscription (no payment) e.g. for promotions. */
exports.grantSubscription = async (req, res) => {
  const bus = await Bus.findById(oid(req.body.busId));
  const plan = await SubscriptionPlan.findById(oid(req.body.planId));
  if (!bus || !plan) throw new ApiError(404, 'Bus or plan not found');
  const sub = await Subscription.create({ owner: bus.owner, bus: bus._id, plan: plan._id, planSnapshot: { name: `${plan.name} (complimentary)`, durationDays: plan.durationDays, price: 0 }, notes: req.body.notes || 'Granted by admin' });
  if (bus.approval.status === 'approved') await activateSubscription(sub);
  else {
    sub.status = 'pending_approval';
    await sub.save();
  }
  res.status(201).json({ success: true, data: sub });
};

exports.cancelSubscription = async (req, res) => {
  const sub = await Subscription.findById(oid(req.params.id));
  if (!sub) throw new ApiError(404, 'Subscription not found');
  sub.status = 'cancelled';
  sub.notes = req.body.reason || 'Cancelled by admin';
  await sub.save();
  await refreshBusExpiry(sub.bus);
  res.json({ success: true, data: sub });
};

exports.listPayments = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.q) {
    const rx = { $regex: escapeRegex(req.query.q), $options: 'i' };
    filter.$or = [{ receiptNumber: rx }, { razorpayOrderId: rx }, { razorpayPaymentId: rx }];
  }
  const [total, items, sums] = await Promise.all([
    Payment.countDocuments(filter),
    Payment.find(filter).populate('owner', 'companyName').populate('bus', 'name registrationNumber images').populate('subscription', 'planSnapshot status').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Payment.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
  ]);
  res.json({ success: true, data: items, meta: { ...pageMeta(total, { page, limit }), byStatus: Object.fromEntries(sums.map((s) => [s._id, { count: s.count, amount: s.amount }])) } });
};

exports.refund = async (req, res) => {
  const payment = await Payment.findById(oid(req.params.id));
  if (!payment) throw new ApiError(404, 'Payment not found');
  await refundPayment(payment, { amount: req.body.amount, reason: req.body.reason || 'Refund by admin' });
  res.json({ success: true, data: payment });
};

/** Resolve a failed/created payment manually (e.g. money captured but callback lost). */
exports.markPaymentPaid = async (req, res) => {
  const payment = await Payment.findById(oid(req.params.id));
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.status === 'paid') throw new ApiError(400, 'Already paid');
  if (!req.body.reference) throw new ApiError(400, 'Enter the gateway payment ID or bank reference');
  payment.gateway = payment.gateway === 'mock' ? 'mock' : 'manual';
  await markPaid(payment, { razorpayPaymentId: req.body.reference });
  res.json({ success: true, data: payment });
};

exports.receipt = async (req, res) => {
  const payment = await Payment.findById(oid(req.params.id)).populate('owner bus subscription');
  if (!payment || !['paid', 'refunded'].includes(payment.status)) throw new ApiError(404, 'Receipt not available');
  streamReceipt(res, payment);
};

// ───────────────────────── Locations ─────────────────────────

exports.listCities = async (req, res) => {
  const filter = {};
  if (req.query.q) filter.name = { $regex: escapeRegex(req.query.q), $options: 'i' };
  const cities = await City.find(filter).sort({ name: 1 }).lean();
  const stopCounts = await Stop.find().select('city').lean();
  const sc = stopCounts.reduce((m, s) => m.set(String(s.city), (m.get(String(s.city)) || 0) + 1), new Map());
  res.json({ success: true, data: cities.map((c) => ({ ...c, stopCount: sc.get(String(c._id)) || 0 })) });
};

exports.createCity = async (req, res) => {
  const b = pick(req.body, ['name', 'state', 'image', 'imageCredit', 'description', 'isPopularDestination', 'isActive']);
  if (!b.name) throw new ApiError(400, 'City name is required');
  const city = await City.create({ ...b, slug: slugify(b.name) });
  // Every city gets a default stop so owners can select it straight away.
  await Stop.create({ name: `${city.name} Bus Stand`, city: city._id, isMajor: true }).catch(() => {});
  res.status(201).json({ success: true, data: city });
};

exports.updateCity = async (req, res) => {
  const b = pick(req.body, ['name', 'state', 'image', 'imageCredit', 'description', 'isPopularDestination', 'isActive']);
  if (b.name) b.slug = slugify(b.name);
  const city = await City.findByIdAndUpdate(oid(req.params.id), b, { new: true, runValidators: true });
  if (!city) throw new ApiError(404, 'City not found');
  if (b.name) await Route.updateMany({ 'stops.city': city._id }, { $set: { 'stops.$[s].cityName': city.name } }, { arrayFilters: [{ 's.city': city._id }] }).catch(() => {});
  res.json({ success: true, data: city });
};

exports.uploadCityImage = async (req, res) => {
  if (!req.file) throw new ApiError(400, 'Choose an image to upload');
  const { imageUrl, removeUploadedImage } = require('../middleware/upload');
  const city = await City.findById(oid(req.params.id));
  if (!city) throw new ApiError(404, 'City not found');
  removeUploadedImage(city.image);
  city.image = imageUrl(req.file.filename);
  city.imageCredit = req.body.imageCredit || undefined;
  await city.save();
  res.json({ success: true, data: city });
};

exports.deleteCity = async (req, res) => {
  const used = await Route.countDocuments({ stopCities: oid(req.params.id) });
  if (used) throw new ApiError(409, `This city is used by ${used} route(s). Deactivate it instead.`);
  await Stop.deleteMany({ city: req.params.id });
  await PopularRoute.deleteMany({ $or: [{ fromCity: req.params.id }, { toCity: req.params.id }] });
  await City.deleteOne({ _id: req.params.id });
  res.json({ success: true, message: 'City deleted' });
};

exports.listStops = async (req, res) => {
  const filter = {};
  if (req.query.city && mongoose.isValidObjectId(req.query.city)) filter.city = req.query.city;
  if (req.query.q) filter.name = { $regex: escapeRegex(req.query.q), $options: 'i' };
  const stops = await Stop.find(filter).populate('city', 'name').sort({ name: 1 }).lean();
  res.json({ success: true, data: stops });
};

exports.createStop = async (req, res) => {
  const b = pick(req.body, ['name', 'city', 'landmark', 'address', 'location', 'isMajor', 'isActive']);
  if (!b.name || !mongoose.isValidObjectId(b.city)) throw new ApiError(400, 'Stop name and city are required');
  const stop = await Stop.create(b);
  res.status(201).json({ success: true, data: await stop.populate('city', 'name') });
};

exports.updateStop = async (req, res) => {
  const stop = await Stop.findByIdAndUpdate(oid(req.params.id), pick(req.body, ['name', 'city', 'landmark', 'address', 'location', 'isMajor', 'isActive']), { new: true, runValidators: true }).populate('city', 'name');
  if (!stop) throw new ApiError(404, 'Stop not found');
  res.json({ success: true, data: stop });
};

exports.deleteStop = async (req, res) => {
  await Stop.deleteOne({ _id: oid(req.params.id) });
  res.json({ success: true, message: 'Stop deleted (existing routes keep their stop names)' });
};

exports.listCategories = async (req, res) => res.json({ success: true, data: await RouteCategory.find().sort({ name: 1 }).lean() });
exports.createCategory = async (req, res) => res.status(201).json({ success: true, data: await RouteCategory.create(pick(req.body, ['name', 'description', 'isActive'])) });
exports.updateCategory = async (req, res) => {
  const c = await RouteCategory.findByIdAndUpdate(oid(req.params.id), pick(req.body, ['name', 'description', 'isActive']), { new: true, runValidators: true });
  if (!c) throw new ApiError(404, 'Category not found');
  res.json({ success: true, data: c });
};
exports.deleteCategory = async (req, res) => {
  await RouteCategory.deleteOne({ _id: oid(req.params.id) });
  await Route.updateMany({ category: req.params.id }, { $unset: { category: 1 } });
  await PopularRoute.updateMany({ category: req.params.id }, { $unset: { category: 1 } });
  res.json({ success: true });
};

exports.listPopularRoutes = async (req, res) => res.json({ success: true, data: await PopularRoute.find().populate('fromCity toCity category').sort({ sortOrder: 1 }).lean() });
exports.createPopularRoute = async (req, res) => {
  const b = pick(req.body, ['fromCity', 'toCity', 'category', 'sortOrder', 'isActive']);
  if (!b.category) delete b.category;
  if (String(b.fromCity) === String(b.toCity)) throw new ApiError(400, 'From and To must be different');
  const p = await PopularRoute.create(b);
  res.status(201).json({ success: true, data: await p.populate('fromCity toCity category') });
};
exports.updatePopularRoute = async (req, res) => {
  const b = pick(req.body, ['fromCity', 'toCity', 'category', 'sortOrder', 'isActive']);
  if (b.category === '') b.category = null;
  const p = await PopularRoute.findByIdAndUpdate(oid(req.params.id), b, { new: true }).populate('fromCity toCity category');
  if (!p) throw new ApiError(404, 'Not found');
  res.json({ success: true, data: p });
};
exports.deletePopularRoute = async (req, res) => {
  await PopularRoute.deleteOne({ _id: oid(req.params.id) });
  res.json({ success: true });
};

// ───────────────────────── Enquiries ─────────────────────────

exports.listEnquiries = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const filter = {};
  if (req.query.type) filter.type = req.query.type;
  if (req.query.status) filter.status = req.query.status;
  const [total, items] = await Promise.all([
    Enquiry.countDocuments(filter),
    Enquiry.find(filter).populate('bus', 'name registrationNumber images').populate('owner', 'companyName').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({ success: true, data: items, meta: pageMeta(total, { page, limit }) });
};

exports.updateEnquiry = async (req, res) => {
  const e = await Enquiry.findByIdAndUpdate(oid(req.params.id), pick(req.body, ['status']), { new: true });
  if (!e) throw new ApiError(404, 'Enquiry not found');
  res.json({ success: true, data: e });
};

// ───────────────────────── Reports ─────────────────────────

function bucket(items, field, keyFn) {
  return items.reduce((m, it) => {
    const k = keyFn(it[field]);
    m.set(k, (m.get(k) || 0) + 1);
    return m;
  }, new Map());
}

exports.reports = async (req, res) => {
  const now = new Date();
  const days = Math.min(180, Number(req.query.days) || 30);
  const since = addDays(now, -days + 1);
  const yearAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

  const [owners, users, payments, searches, topViewed, allBuses, subs, enquiries] = await Promise.all([
    BusOwner.find({ createdAt: { $gte: since } }).select('createdAt').lean(),
    User.find({ createdAt: { $gte: since }, role: 'passenger' }).select('createdAt').lean(),
    Payment.find({ status: { $in: ['paid', 'refunded'] }, paidAt: { $gte: yearAgo } }).select('amount paidAt status refundedAmount').lean(),
    SearchLog.find({ createdAt: { $gte: since } }).select('fromName toName resultCount').lean(),
    Bus.find({ deletedAt: null }).sort({ viewCount: -1 }).limit(10).populate('owner', 'companyName').select('name registrationNumber viewCount callClicks whatsappClicks owner images').lean(),
    Bus.find({ deletedAt: null }),
    Subscription.find({ createdAt: { $gte: yearAgo }, status: { $in: ['active', 'expired', 'pending_approval', 'refunded'] } }).select('planSnapshot isRenewal status createdAt').lean(),
    Enquiry.find({ createdAt: { $gte: since } }).select('type createdAt').lean(),
  ]);

  const daily = [];
  const ob = bucket(owners, 'createdAt', (d) => dateKey(d));
  const ub = bucket(users, 'createdAt', (d) => dateKey(d));
  const eb = enquiries.reduce((m, e) => {
    const k = dateKey(e.createdAt);
    const v = m.get(k) || { enquiry: 0, call_click: 0, whatsapp_click: 0, contact: 0 };
    v[e.type] += 1;
    return m.set(k, v);
  }, new Map());
  for (let i = days - 1; i >= 0; i -= 1) {
    const k = dateKey(addDays(now, -i));
    daily.push({ date: k, owners: ob.get(k) || 0, passengers: ub.get(k) || 0, ...(eb.get(k) || { enquiry: 0, call_click: 0, whatsapp_click: 0, contact: 0 }) });
  }

  const monthly = [];
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const inMonth = payments.filter((p) => dateKey(p.paidAt).slice(0, 7) === key);
    monthly.push({
      month: key,
      revenue: inMonth.reduce((s, p) => s + p.amount - (p.status === 'refunded' ? p.refundedAmount || 0 : 0), 0),
      payments: inMonth.length,
    });
  }

  const searchMap = searches.reduce((m, s) => {
    if (!s.fromName && !s.toName) return m;
    const k = `${s.fromName || 'Any'} → ${s.toName || 'Any'}`;
    const v = m.get(k) || { route: k, searches: 0, zeroResults: 0 };
    v.searches += 1;
    if (!s.resultCount) v.zeroResults += 1;
    return m.set(k, v);
  }, new Map());
  const mostSearched = [...searchMap.values()].sort((a, b) => b.searches - a.searches).slice(0, 10);

  const listingStates = allBuses.reduce((m, b) => {
    const s = b.listingState(now);
    m[s] = (m[s] || 0) + 1;
    return m;
  }, {});

  const planPerf = subs.reduce((m, s) => {
    const k = (s.planSnapshot?.name || 'Unknown').replace(' (complimentary)', '');
    const v = m.get(k) || { plan: k, sold: 0, renewals: 0, revenue: 0, refunded: 0 };
    v.sold += 1;
    if (s.isRenewal) v.renewals += 1;
    v.revenue += s.planSnapshot?.price || 0;
    if (s.status === 'refunded') v.refunded += 1;
    return m.set(k, v);
  }, new Map());

  res.json({
    success: true,
    data: {
      range: { days, since: dateKey(since), until: dateKey(now) },
      dailyRegistrations: daily,
      monthlyRevenue: monthly,
      mostSearchedRoutes: mostSearched,
      mostViewedBuses: topViewed,
      listingStates,
      subscriptionPerformance: [...planPerf.values()].sort((a, b) => b.revenue - a.revenue),
      totals: {
        searches: searches.length,
        enquiries: enquiries.filter((e) => e.type === 'enquiry').length,
        callClicks: enquiries.filter((e) => e.type === 'call_click').length,
        whatsappClicks: enquiries.filter((e) => e.type === 'whatsapp_click').length,
      },
    },
  });
};

// ───────────────────────── Admin users & notifications ─────────────────────────

exports.listAdmins = async (req, res) => res.json({ success: true, data: await AdminUser.find().sort({ createdAt: 1 }).lean() });

exports.createAdmin = async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || password.length < 8) throw new ApiError(400, 'Name, email and an 8+ character password are required');
  const admin = await AdminUser.create({ name, email, password, role: ['admin', 'moderator', 'super_admin'].includes(role) ? role : 'admin' });
  res.status(201).json({ success: true, data: admin });
};

exports.updateAdmin = async (req, res) => {
  const admin = await AdminUser.findById(oid(req.params.id)).select('+password');
  if (!admin) throw new ApiError(404, 'Admin not found');
  if (String(admin._id) === String(req.admin._id) && req.body.isActive === false) throw new ApiError(400, 'You cannot disable yourself');
  ['name', 'role', 'isActive'].forEach((k) => {
    if (req.body[k] !== undefined) admin[k] = req.body[k];
  });
  if (req.body.password) admin.password = req.body.password;
  await admin.save();
  res.json({ success: true, data: admin });
};

exports.notifications = async (req, res) => {
  const items = await Notification.find({ audience: 'admin' }).sort({ createdAt: -1 }).limit(50).lean();
  const unread = await Notification.countDocuments({ audience: 'admin', readAt: null });
  res.json({ success: true, data: items, meta: { unread } });
};

exports.readNotifications = async (req, res) => {
  await Notification.updateMany({ audience: 'admin', readAt: null }, { $set: { readAt: new Date() } });
  res.json({ success: true });
};

exports.runJobs = async (req, res) => {
  const { runExpiryJob } = require('../services/listingService');
  res.json({ success: true, data: await runExpiryJob(new Date(), config.expiryReminderDays) });
};

// ───────────────────────── Homepage banner ─────────────────────────

exports.getHero = async (req, res) => {
  const heroService = require('../services/heroService');
  const publicFilter = Bus.publicFilter();
  const [hero, buses, operators, cities, publicIds] = await Promise.all([
    heroService.getHero({ includeInactive: true }),
    Bus.countDocuments(publicFilter),
    Bus.distinct('owner', publicFilter),
    City.countDocuments({ isActive: true }),
    Bus.distinct('_id', publicFilter),
  ]);
  const runningToday = await DailyBusStatus.countDocuments({ bus: { $in: publicIds }, date: dateKey(), status: { $in: ['running', 'delayed'] } });
  res.json({ success: true, data: { ...hero, stats: { buses, operators: operators.length, cities, runningToday } } });
};

exports.updateHeroSettings = async (req, res) => {
  const heroService = require('../services/heroService');
  res.json({ success: true, data: await heroService.saveSettings(req.body) });
};

exports.createHeroSlide = async (req, res) => {
  const { HeroSlide } = require('../models');
  const { slidePayload } = require('../services/heroService');
  const data = slidePayload(req.body);
  if (data.sortOrder === undefined) {
    const last = await HeroSlide.findOne().sort({ sortOrder: -1 }).select('sortOrder').lean();
    data.sortOrder = (last?.sortOrder || 0) + 1;
  }
  const slide = await HeroSlide.create(data);
  res.status(201).json({ success: true, data: slide });
};

exports.updateHeroSlide = async (req, res) => {
  const { HeroSlide } = require('../models');
  const { slidePayload } = require('../services/heroService');
  const { removeUploadedImage } = require('../middleware/upload');
  const slide = await HeroSlide.findById(oid(req.params.id));
  if (!slide) throw new ApiError(404, 'Slide not found');
  const data = slidePayload(req.body, { partial: true });
  const oldImage = slide.image;
  Object.entries(data).forEach(([k, v]) => slide.set(k, v));
  await slide.save();
  if (data.image && data.image !== oldImage) removeUploadedImage(oldImage);
  res.json({ success: true, data: slide });
};

exports.reorderHeroSlides = async (req, res) => {
  const { HeroSlide } = require('../models');
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length) throw new ApiError(400, 'Send the slide ids in their new order');
  await Promise.all(ids.map((id, i) => HeroSlide.updateOne({ _id: oid(id) }, { $set: { sortOrder: i + 1 } })));
  res.json({ success: true });
};

exports.deleteHeroSlide = async (req, res) => {
  const { HeroSlide } = require('../models');
  const { removeUploadedImage } = require('../middleware/upload');
  const slide = await HeroSlide.findByIdAndDelete(oid(req.params.id));
  if (!slide) throw new ApiError(404, 'Slide not found');
  removeUploadedImage(slide.image);
  res.json({ success: true });
};

/** Generic public image upload for admin content (banner slides etc.). Returns the image URL. */
exports.uploadImage = async (req, res) => {
  const { imageUrl } = require('../middleware/upload');
  if (!req.file) throw new ApiError(400, 'Choose an image to upload');
  res.status(201).json({ success: true, data: { url: imageUrl(req.file.filename) } });
};
