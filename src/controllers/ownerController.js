const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const config = require('../config');
const {
  Bus, Route, City, Stop, DailyBusStatus, TeamMember, User, SubscriptionPlan, Subscription, Payment, Enquiry, Notification, BusOwner,
} = require('../models');
const { ApiError, dateKey, isValidDateKey, addDays, paginate, pageMeta, slugify, pick, timeToMinutes, escapeRegex } = require('../utils/helpers');
const { canAccessBus } = require('../middleware/auth');
const { imageUrl, removeUploadedImage } = require('../middleware/upload');
const { resolveStatus, statusMapFor, upsertStatus } = require('../services/statusService');
const { createOrder, verifySignature, markPaid, markFailed } = require('../services/paymentService');
const { notifyAdmin } = require('../services/notificationService');
const { streamReceipt } = require('../services/receiptService');
const { normaliseMobile, MOBILE_RE } = require('./authController');

const OWNER_STATUSES = ['running', 'not_running', 'delayed', 'cancelled'];
const NEEDS_REASON = ['not_running', 'cancelled'];

function parseList(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.flatMap(parseList);
  const s = String(v).trim();
  if (s.startsWith('[')) {
    try {
      return JSON.parse(s);
    } catch {
      return [];
    }
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function ownerBusFilter(req, extra = {}) {
  const f = { owner: req.owner._id, deletedAt: null, ...extra };
  if (req.assignedBuses && req.assignedBuses.length) f._id = { $in: req.assignedBuses };
  return f;
}

async function loadOwnBus(req, id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid bus id');
  const bus = await Bus.findOne({ _id: id, owner: req.owner._id, deletedAt: null });
  if (!bus) throw new ApiError(404, 'Bus not found');
  if (!canAccessBus(req, bus._id)) throw new ApiError(403, 'This bus is not assigned to you');
  return bus;
}

function busView(bus, now = new Date()) {
  const doc = bus instanceof Bus ? bus : Bus.hydrate(bus);
  return { ...doc.toObject(), listingState: doc.listingState(now) };
}

// ───────────────────────── Dashboard ─────────────────────────

exports.dashboard = async (req, res) => {
  const now = new Date();
  const today = dateKey();
  const buses = await Bus.find(ownerBusFilter(req));
  const states = buses.map((b) => b.listingState(now));
  const statusMap = await statusMapFor(buses.map((b) => b._id), today);
  const resolved = buses.map((b) => resolveStatus(b, statusMap.get(String(b._id)), today));

  const ownerId = req.owner._id;
  const [enquiryCounts, activeSubs, notifications, recentEnquiries] = await Promise.all([
    Enquiry.aggregate([{ $match: { owner: ownerId } }, { $group: { _id: '$type', count: { $sum: 1 } } }]),
    Subscription.find({ owner: ownerId, status: { $in: ['active', 'pending_approval'] } }).populate('bus', 'name images').sort({ endDate: 1 }).lean(),
    Notification.find({ owner: ownerId }).sort({ createdAt: -1 }).limit(6).lean(),
    Enquiry.find({ owner: ownerId, type: 'enquiry' }).sort({ createdAt: -1 }).limit(5).populate('bus', 'name images').lean(),
  ]);
  const enq = Object.fromEntries(enquiryCounts.map((e) => [e._id, e.count]));
  const nextExpiry = activeSubs.filter((s) => s.status === 'active').sort((a, b) => a.endDate - b.endDate)[0];

  res.json({
    success: true,
    data: {
      owner: req.owner,
      stats: {
        totalBuses: buses.length,
        active: states.filter((s) => s === 'active').length,
        pending: states.filter((s) => s === 'pending').length,
        expired: states.filter((s) => s === 'expired').length,
        draft: states.filter((s) => s === 'draft').length,
        rejected: states.filter((s) => s === 'rejected').length,
        runningToday: resolved.filter((s) => ['running', 'delayed'].includes(s.code)).length,
        stoppedToday: resolved.filter((s) => ['not_running', 'cancelled', 'suspended'].includes(s.code)).length,
        notUpdatedToday: resolved.filter((s) => s.code === 'not_updated').length,
        enquiries: enq.enquiry || 0,
        callClicks: enq.call_click || 0,
        whatsappClicks: enq.whatsapp_click || 0,
      },
      subscription: {
        activeCount: activeSubs.filter((s) => s.status === 'active').length,
        awaitingApproval: activeSubs.filter((s) => s.status === 'pending_approval').length,
        nextExpiry: nextExpiry ? { bus: nextExpiry.bus, endDate: nextExpiry.endDate } : null,
      },
      todayBoard: buses.map((b, i) => ({ _id: b._id, name: b.name, registrationNumber: b.registrationNumber, image: b.images[0], listingState: states[i], status: resolved[i] })),
      notifications,
      recentEnquiries,
      permissions: req.permissions,
      today,
    },
  });
};

// ───────────────────────── Profile & documents ─────────────────────────

exports.getProfile = async (req, res) => {
  res.json({ success: true, data: { owner: req.owner, user: req.user, permissions: req.permissions, isOwnerAccount: !!req.isOwnerAccount } });
};

exports.updateProfile = async (req, res) => {
  if (!req.isOwnerAccount) throw new ApiError(403, 'Only the account owner can edit the business profile');
  const o = req.owner;
  const b = req.body;
  ['ownerName', 'companyName', 'about'].forEach((k) => {
    if (b[k] !== undefined) o[k] = b[k];
  });
  if (b.businessAddress) o.businessAddress = { ...o.businessAddress?.toObject?.(), ...b.businessAddress };
  if (b.companyName) o.slug = `${slugify(b.companyName)}-${String(o._id).slice(-4)}`;
  await o.save();
  res.json({ success: true, data: o });
};

exports.uploadDocuments = async (req, res) => {
  if (!req.isOwnerAccount) throw new ApiError(403, 'Only the account owner can upload documents');
  const types = parseList(req.body.docTypes);
  (req.files || []).forEach((f, i) => req.owner.documents.push({ docType: types[i] || 'other', fileName: f.filename, originalName: f.originalname, mimeType: f.mimetype }));
  if (req.owner.verificationStatus === 'rejected') {
    req.owner.verificationStatus = 'pending';
    req.owner.rejectionReason = undefined;
    await notifyAdmin('new_owner', `Operator re-submitted documents: ${req.owner.companyName}`, '', `/admin/owners/${req.owner._id}`);
  }
  await req.owner.save();
  res.json({ success: true, data: req.owner });
};

exports.deleteDocument = async (req, res) => {
  if (!req.isOwnerAccount) throw new ApiError(403, 'Only the account owner can remove documents');
  const doc = req.owner.documents.id(req.params.docId);
  if (!doc) throw new ApiError(404, 'Document not found');
  if (doc.verified) throw new ApiError(400, 'Verified documents cannot be removed');
  fs.promises.unlink(path.join(config.uploads.dir, 'docs', doc.fileName)).catch(() => {});
  doc.deleteOne();
  await req.owner.save();
  res.json({ success: true, data: req.owner });
};

exports.downloadDocument = async (req, res) => {
  const doc = req.owner.documents.id(req.params.docId);
  if (!doc) throw new ApiError(404, 'Document not found');
  res.type(doc.mimeType || 'application/octet-stream');
  res.sendFile(path.join(config.uploads.dir, 'docs', path.basename(doc.fileName)));
};

// ───────────────────────── Buses ─────────────────────────

const BUS_FIELDS = ['name', 'registrationNumber', 'seatingCapacity', 'contactNumber', 'alternateNumber', 'whatsappNumber', 'ticketPrice', 'description'];

function readBusBody(body) {
  const data = pick(body, BUS_FIELDS);
  if (body.busTypes !== undefined) data.busTypes = parseList(body.busTypes);
  if (body.facilities !== undefined) data.facilities = parseList(body.facilities);
  if (data.registrationNumber) data.registrationNumber = String(data.registrationNumber).replace(/\s+/g, '').toUpperCase();
  ['contactNumber', 'alternateNumber', 'whatsappNumber'].forEach((k) => {
    if (data[k] !== undefined) {
      data[k] = data[k] ? normaliseMobile(data[k]) : '';
      if (data[k] && !MOBILE_RE.test(data[k])) throw new ApiError(400, `Invalid ${k.replace('Number', ' number')}`);
    }
  });
  if (data.registrationNumber && !/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/.test(data.registrationNumber)) {
    throw new ApiError(400, 'Registration number should look like OD02AB1234');
  }
  return data;
}

exports.listBuses = async (req, res) => {
  const filter = ownerBusFilter(req);
  if (req.query.q) filter.$or = [{ name: { $regex: escapeRegex(req.query.q), $options: 'i' } }, { registrationNumber: { $regex: escapeRegex(req.query.q), $options: 'i' } }];
  const buses = await Bus.find(filter).sort({ createdAt: -1 });
  const routeCounts = await Route.find({ bus: { $in: buses.map((b) => b._id) } }).select('bus').lean();
  const rc = routeCounts.reduce((m, r) => m.set(String(r.bus), (m.get(String(r.bus)) || 0) + 1), new Map());
  let data = buses.map((b) => ({ ...busView(b), routeCount: rc.get(String(b._id)) || 0 }));
  if (req.query.state) data = data.filter((b) => b.listingState === req.query.state);
  res.json({ success: true, data });
};

exports.getBus = async (req, res) => {
  const bus = await loadOwnBus(req, req.params.id);
  const [routes, subscriptions] = await Promise.all([
    Route.find({ bus: bus._id }).sort({ departureTime: 1 }).lean(),
    req.permissions.viewPayments ? Subscription.find({ bus: bus._id }).sort({ createdAt: -1 }).limit(10).lean() : [],
  ]);
  res.json({ success: true, data: { ...busView(bus), routes, subscriptions } });
};

exports.createBus = async (req, res) => {
  const data = readBusBody(req.body);
  if (!data.name || !data.registrationNumber || !data.contactNumber || data.ticketPrice === undefined) {
    throw new ApiError(400, 'Name, registration number, contact number and ticket price are required');
  }
  const bus = new Bus({
    ...data,
    owner: req.owner._id,
    images: (req.files || []).map((f) => imageUrl(f.filename)),
    ownerVerified: req.owner.verificationStatus === 'approved' && !req.owner.isSuspended,
  });
  bus.slug = `${slugify(bus.name)}-${String(bus._id).slice(-6)}`;
  await bus.save();
  res.status(201).json({ success: true, data: busView(bus) });
};

exports.updateBus = async (req, res) => {
  const bus = await loadOwnBus(req, req.params.id);
  const data = readBusBody(req.body);
  const regChanged = data.registrationNumber && data.registrationNumber !== bus.registrationNumber;
  Object.assign(bus, data);
  if (data.name) bus.slug = `${slugify(bus.name)}-${String(bus._id).slice(-6)}`;
  // Changing the registration number of an approved listing sends it back for review.
  if (regChanged && bus.approval.status === 'approved') {
    bus.approval.status = 'pending';
    bus.approval.submittedAt = new Date();
    await notifyAdmin('listing_submitted', `Registration changed: ${bus.name}`, `New number ${bus.registrationNumber} needs re-approval`, `/admin/listings/${bus._id}`);
  }
  await bus.save();
  res.json({ success: true, data: busView(bus) });
};

exports.addBusImages = async (req, res) => {
  const bus = await loadOwnBus(req, req.params.id);
  const urls = (req.files || []).map((f) => imageUrl(f.filename));
  if (bus.images.length + urls.length > 10) throw new ApiError(400, 'A bus can have at most 10 photos');
  bus.images.push(...urls);
  await bus.save();
  res.json({ success: true, data: busView(bus) });
};

exports.removeBusImage = async (req, res) => {
  const bus = await loadOwnBus(req, req.params.id);
  const { url } = req.body;
  if (!bus.images.includes(url)) throw new ApiError(404, 'Image not found');
  bus.images = bus.images.filter((u) => u !== url);
  await bus.save();
  removeUploadedImage(url);
  res.json({ success: true, data: busView(bus) });
};

exports.reorderBusImages = async (req, res) => {
  const bus = await loadOwnBus(req, req.params.id);
  const order = parseList(req.body.images);
  if (order.length !== bus.images.length || !order.every((u) => bus.images.includes(u))) throw new ApiError(400, 'Image list does not match');
  bus.images = order;
  await bus.save();
  res.json({ success: true, data: busView(bus) });
};

exports.setBusActive = async (req, res) => {
  const bus = await loadOwnBus(req, req.params.id);
  bus.isActive = !!req.body.isActive;
  await bus.save();
  res.json({ success: true, data: busView(bus) });
};

exports.deleteBus = async (req, res) => {
  const bus = await loadOwnBus(req, req.params.id);
  const active = await Subscription.countDocuments({ bus: bus._id, status: { $in: ['active', 'pending_approval'] } });
  if (active && req.query.force !== 'true') throw new ApiError(409, 'This bus has an active or pending subscription. Deactivate it instead, or confirm deletion.');
  bus.deletedAt = new Date();
  bus.isActive = false;
  bus.registrationNumber = `${bus.registrationNumber}-DEL-${Date.now().toString(36)}`; // frees the number for re-use
  await bus.save();
  await Route.updateMany({ bus: bus._id }, { $set: { isActive: false } });
  res.json({ success: true, message: 'Bus deleted' });
};

/** Submit a draft/rejected listing for approval without paying (e.g. when a subscription is already active). */
exports.submitBus = async (req, res) => {
  const bus = await loadOwnBus(req, req.params.id);
  if (req.owner.verificationStatus !== 'approved') throw new ApiError(400, 'Your operator account must be verified before listings can be published');
  const routes = await Route.countDocuments({ bus: bus._id, isActive: true });
  if (!routes) throw new ApiError(400, 'Add at least one route before submitting');
  if (!bus.images.length) throw new ApiError(400, 'Add at least one bus photo before submitting');
  if (bus.approval.status === 'approved') throw new ApiError(400, 'Listing is already approved');
  bus.approval.status = 'pending';
  bus.approval.submittedAt = new Date();
  bus.approval.reason = undefined;
  await bus.save();
  await notifyAdmin('listing_submitted', `Listing submitted: ${bus.name}`, req.owner.companyName, `/admin/listings/${bus._id}`);
  res.json({ success: true, data: busView(bus) });
};

exports.setSuspension = async (req, res) => {
  const bus = await loadOwnBus(req, req.params.id);
  const { active, from, until, reason } = req.body;
  if (active) {
    const start = from || dateKey();
    if (!isValidDateKey(start) || (until && !isValidDateKey(until))) throw new ApiError(400, 'Invalid dates');
    if (until && until < start) throw new ApiError(400, '"Until" must be after "from"');
    if (!reason) throw new ApiError(400, 'Reason is required for a suspension');
    bus.suspension = { active: true, from: start, until: until || '', reason };
  } else {
    bus.suspension = { active: false };
  }
  await bus.save();
  res.json({ success: true, data: busView(bus) });
};

// ───────────────────────── Routes ─────────────────────────

async function normaliseStops(rawStops) {
  if (!Array.isArray(rawStops) || rawStops.length < 2) throw new ApiError(400, 'A route needs a starting point, a destination and optional stops in between');
  const stops = [];
  for (let i = 0; i < rawStops.length; i += 1) {
    const s = rawStops[i];
    let stopDoc = null;
    if (s.stop && mongoose.isValidObjectId(s.stop)) {
      // eslint-disable-next-line no-await-in-loop
      stopDoc = await Stop.findById(s.stop).populate('city').lean();
    }
    let city = stopDoc?.city || null;
    if (!city && s.city && mongoose.isValidObjectId(s.city)) {
      // eslint-disable-next-line no-await-in-loop
      city = await City.findById(s.city).lean();
    }
    if (!city) throw new ApiError(400, `Stop ${i + 1}: choose a city`);
    const isFirst = i === 0;
    const isLast = i === rawStops.length - 1;
    const arrivalTime = isFirst ? undefined : s.arrivalTime || undefined;
    const departureTime = isLast ? undefined : s.departureTime || s.arrivalTime || undefined;
    if (isFirst && !departureTime) throw new ApiError(400, 'Starting point needs a departure time');
    if (isLast && !arrivalTime) throw new ApiError(400, 'Destination needs an arrival time');
    if (!isFirst && !isLast && !arrivalTime) throw new ApiError(400, `Stop ${i + 1} (${city.name}) needs an arrival time`);
    [arrivalTime, departureTime].forEach((t) => {
      if (t && timeToMinutes(t) == null) throw new ApiError(400, `Stop ${i + 1}: time must be HH:MM`);
    });
    stops.push({
      stop: stopDoc?._id,
      city: city._id,
      cityName: city.name,
      stopName: (s.stopName || stopDoc?.name || city.name).trim(),
      sequence: i + 1,
      arrivalTime,
      departureTime,
      dayOffset: Number(s.dayOffset) || 0,
      distanceKm: s.distanceKm === '' || s.distanceKm == null ? undefined : Number(s.distanceKm),
      haltMinutes: s.haltMinutes === '' || s.haltMinutes == null ? undefined : Number(s.haltMinutes),
      fareFromOrigin: s.fareFromOrigin === '' || s.fareFromOrigin == null ? undefined : Number(s.fareFromOrigin),
      isMajor: s.isMajor !== false,
    });
  }

  // Times must move forward along the route (taking day offsets into account).
  let prev = -1;
  stops.forEach((s, i) => {
    const day = 1440 * (s.dayOffset || 0);
    const arr = s.arrivalTime ? timeToMinutes(s.arrivalTime) + day : null;
    const dep = s.departureTime ? timeToMinutes(s.departureTime) + day : null;
    if (arr != null && arr < prev) throw new ApiError(400, `Stop ${i + 1} (${s.cityName}) arrives before the previous stop. If it is the next day, set "+1 day".`);
    if (arr != null && dep != null && dep < arr) throw new ApiError(400, `Stop ${i + 1} (${s.cityName}) departs before it arrives`);
    prev = dep ?? arr ?? prev;
    if (s.arrivalTime && s.departureTime && s.haltMinutes == null) s.haltMinutes = dep - arr;
  });
  return stops;
}

exports.listRoutes = async (req, res) => {
  const busFilter = ownerBusFilter(req);
  const busIds = await Bus.distinct('_id', busFilter);
  const filter = { owner: req.owner._id, bus: { $in: busIds } };
  if (req.query.bus && mongoose.isValidObjectId(req.query.bus)) filter.bus = req.query.bus;
  const routes = await Route.find(filter).populate('bus', 'name registrationNumber images').populate('category', 'name').sort({ updatedAt: -1 }).lean();
  res.json({ success: true, data: routes });
};

exports.getRoute = async (req, res) => {
  const route = await Route.findOne({ _id: req.params.id, owner: req.owner._id }).populate('bus', 'name registrationNumber').lean();
  if (!route) throw new ApiError(404, 'Route not found');
  if (!canAccessBus(req, route.bus._id)) throw new ApiError(403, 'This bus is not assigned to you');
  res.json({ success: true, data: route });
};

exports.createRoute = async (req, res) => {
  const bus = await loadOwnBus(req, req.body.bus);
  const stops = await normaliseStops(req.body.stops);
  const route = await Route.create({
    bus: bus._id,
    owner: req.owner._id,
    name: req.body.name,
    category: mongoose.isValidObjectId(req.body.category) ? req.body.category : undefined,
    stops,
    operatingDays: Array.isArray(req.body.operatingDays) && req.body.operatingDays.length ? req.body.operatingDays.map(Number) : undefined,
    isActive: req.body.isActive !== false,
  });
  res.status(201).json({ success: true, data: route });
};

/** PUT replaces the whole stop list — this is how stops are added, edited, removed and reordered. */
exports.updateRoute = async (req, res) => {
  const route = await Route.findOne({ _id: req.params.id, owner: req.owner._id });
  if (!route) throw new ApiError(404, 'Route not found');
  if (!canAccessBus(req, route.bus)) throw new ApiError(403, 'This bus is not assigned to you');
  if (req.body.stops) route.stops = await normaliseStops(req.body.stops);
  if (req.body.name !== undefined) route.name = req.body.name;
  if (req.body.category !== undefined) route.category = mongoose.isValidObjectId(req.body.category) ? req.body.category : undefined;
  if (Array.isArray(req.body.operatingDays)) route.operatingDays = req.body.operatingDays.map(Number);
  if (req.body.isActive !== undefined) route.isActive = !!req.body.isActive;
  if (req.body.bus && String(req.body.bus) !== String(route.bus)) {
    const bus = await loadOwnBus(req, req.body.bus);
    route.bus = bus._id;
  }
  await route.save();
  res.json({ success: true, data: route });
};

exports.deleteRoute = async (req, res) => {
  const route = await Route.findOne({ _id: req.params.id, owner: req.owner._id });
  if (!route) throw new ApiError(404, 'Route not found');
  if (!canAccessBus(req, route.bus)) throw new ApiError(403, 'This bus is not assigned to you');
  await route.deleteOne();
  res.json({ success: true, message: 'Route deleted' });
};

// ───────────────────────── Daily status ─────────────────────────

function validateStatusBody(body) {
  const { status, reason, message } = body;
  if (!OWNER_STATUSES.includes(status)) throw new ApiError(400, 'Choose a valid status');
  if (NEEDS_REASON.includes(status) && !reason) throw new ApiError(400, 'A reason is required when the bus is not running');
  if (reason && !DailyBusStatus.REASONS.includes(reason)) throw new ApiError(400, 'Invalid reason');
  if (reason === 'other' && !message) throw new ApiError(400, 'Please describe the reason');
  if (message && message.length > 500) throw new ApiError(400, 'Message is too long');
  const date = body.date || dateKey();
  if (!isValidDateKey(date)) throw new ApiError(400, 'Invalid date');
  const today = dateKey();
  const maxDate = dateKey(addDays(new Date(), 7));
  if (date < today) throw new ApiError(400, 'Past dates cannot be changed — status history is kept as recorded');
  if (date > maxDate) throw new ApiError(400, 'You can plan statuses up to 7 days ahead');
  return { date, status, reason: reason || undefined, message: message || undefined, delayMinutes: status === 'delayed' ? Number(body.delayMinutes) || undefined : undefined };
}

exports.statusBoard = async (req, res) => {
  const date = isValidDateKey(req.query.date) ? req.query.date : dateKey();
  const buses = await Bus.find(ownerBusFilter(req)).sort({ name: 1 });
  const statusMap = await statusMapFor(buses.map((b) => b._id), date);
  const routes = await Route.find({ bus: { $in: buses.map((b) => b._id) }, isActive: true }).select('bus stops.cityName departureTime arrivalTime name').lean();
  res.json({
    success: true,
    data: {
      date,
      today: dateKey(),
      buses: buses.map((b) => {
        const doc = statusMap.get(String(b._id));
        return {
          _id: b._id,
          name: b.name,
          registrationNumber: b.registrationNumber,
          image: b.images[0],
          listingState: b.listingState(),
          suspension: b.suspension,
          status: resolveStatus(b, doc, date),
          record: doc || null,
          routes: routes.filter((r) => String(r.bus) === String(b._id)).map((r) => ({ _id: r._id, name: r.name, origin: r.stops[0]?.cityName, destination: r.stops[r.stops.length - 1]?.cityName, departureTime: r.departureTime })),
        };
      }),
    },
  });
};

exports.updateStatus = async (req, res) => {
  const bus = await loadOwnBus(req, req.params.busId);
  const body = validateStatusBody(req.body);
  const doc = await upsertStatus({ bus, ...body, actor: req.user });
  res.json({ success: true, message: 'Status updated', data: { record: doc, status: resolveStatus(bus, doc, body.date) } });
};

exports.bulkUpdateStatus = async (req, res) => {
  const ids = parseList(req.body.busIds);
  if (!ids.length) throw new ApiError(400, 'Select at least one bus');
  const body = validateStatusBody(req.body);
  const results = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const bus = await loadOwnBus(req, id);
    // eslint-disable-next-line no-await-in-loop
    await upsertStatus({ bus, ...body, actor: req.user });
    results.push(String(bus._id));
  }
  res.json({ success: true, message: `Updated ${results.length} bus(es)`, data: results });
};

exports.statusHistory = async (req, res) => {
  const bus = await loadOwnBus(req, req.params.busId);
  const days = Math.min(365, Number(req.query.days) || 30);
  const since = dateKey(addDays(new Date(), -days));
  const docs = await DailyBusStatus.find({ bus: bus._id, date: { $gte: since } }).sort({ date: -1 }).lean();
  res.json({ success: true, data: { bus: { _id: bus._id, name: bus.name }, records: docs } });
};

// ───────────────────────── Team ─────────────────────────

const PERM_KEYS = ['manageBuses', 'manageRoutes', 'updateStatus', 'viewPayments', 'managePayments', 'manageTeam'];

function readPermissions(req, role, perms) {
  const preset = TeamMember.ROLE_PRESETS[role] || {};
  const out = {};
  PERM_KEYS.forEach((k) => {
    out[k] = perms && perms[k] !== undefined ? !!perms[k] : !!preset[k];
  });
  if (!req.isOwnerAccount) out.manageTeam = false; // only the owner can create team admins
  return out;
}

exports.listTeam = async (req, res) => {
  const members = await TeamMember.find({ owner: req.owner._id }).populate('user', 'name email mobile lastLoginAt status').populate('assignedBuses', 'name registrationNumber').sort({ createdAt: -1 }).lean();
  res.json({ success: true, data: members, meta: { rolePresets: TeamMember.ROLE_PRESETS } });
};

exports.addTeamMember = async (req, res) => {
  const { name, email, password, role = 'status_updater', permissions, assignedBuses } = req.body;
  const mobile = normaliseMobile(req.body.mobile);
  if (!name || !email || !MOBILE_RE.test(mobile) || !password || password.length < 6) throw new ApiError(400, 'Name, email, valid mobile and a 6+ character password are required');
  const exists = await User.findOne({ $or: [{ email: email.toLowerCase() }, { mobile }] });
  if (exists) throw new ApiError(409, 'A user with this email or mobile already exists');
  const busIds = parseList(assignedBuses).filter((id) => mongoose.isValidObjectId(id));
  if (busIds.length) {
    const count = await Bus.countDocuments({ _id: { $in: busIds }, owner: req.owner._id });
    if (count !== busIds.length) throw new ApiError(400, 'Some assigned buses are invalid');
  }
  const user = await User.create({ name, email, mobile, password, role: 'staff', isMobileVerified: true });
  const member = await TeamMember.create({ owner: req.owner._id, user: user._id, role, permissions: readPermissions(req, role, permissions), assignedBuses: busIds });
  res.status(201).json({ success: true, data: await member.populate('user', 'name email mobile') });
};

exports.updateTeamMember = async (req, res) => {
  const member = await TeamMember.findOne({ _id: req.params.id, owner: req.owner._id });
  if (!member) throw new ApiError(404, 'Team member not found');
  if (String(member.user) === String(req.user._id)) throw new ApiError(400, 'You cannot change your own access');
  if (req.body.role) member.role = req.body.role;
  if (req.body.permissions || req.body.role) member.permissions = readPermissions(req, member.role, req.body.permissions);
  if (req.body.assignedBuses !== undefined) member.assignedBuses = parseList(req.body.assignedBuses).filter((id) => mongoose.isValidObjectId(id));
  if (req.body.isActive !== undefined) member.isActive = !!req.body.isActive;
  await member.save();
  const user = await User.findById(member.user);
  if (req.body.name) user.name = req.body.name;
  if (req.body.password) {
    if (req.body.password.length < 6) throw new ApiError(400, 'Password must be at least 6 characters');
    user.password = req.body.password;
  }
  await user.save();
  res.json({ success: true, data: await member.populate('user', 'name email mobile') });
};

exports.removeTeamMember = async (req, res) => {
  const member = await TeamMember.findOne({ _id: req.params.id, owner: req.owner._id });
  if (!member) throw new ApiError(404, 'Team member not found');
  if (String(member.user) === String(req.user._id)) throw new ApiError(400, 'You cannot remove yourself');
  await User.deleteOne({ _id: member.user });
  await member.deleteOne();
  res.json({ success: true, message: 'Team member removed' });
};

// ───────────────────────── Subscriptions & payments ─────────────────────────

exports.plans = async (req, res) => {
  const plans = await SubscriptionPlan.find({ isActive: true }).sort({ sortOrder: 1, durationDays: 1 }).lean();
  res.json({ success: true, data: plans, meta: { paymentMode: config.razorpay.mode, razorpayKeyId: config.razorpay.keyId || null } });
};

exports.listSubscriptions = async (req, res) => {
  const filter = { owner: req.owner._id };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.bus && mongoose.isValidObjectId(req.query.bus)) filter.bus = req.query.bus;
  const subs = await Subscription.find(filter).populate('bus', 'name registrationNumber images subscriptionExpiresAt approval').populate('payment', 'status amount receiptNumber').sort({ createdAt: -1 }).lean();
  res.json({ success: true, data: subs });
};

exports.checkout = async (req, res) => {
  const bus = await loadOwnBus(req, req.body.busId);
  const plan = await SubscriptionPlan.findOne({ _id: req.body.planId, isActive: true });
  if (!plan) throw new ApiError(400, 'Choose a valid plan');
  const routes = await Route.countDocuments({ bus: bus._id, isActive: true });
  if (!routes) throw new ApiError(400, 'Add at least one route to this bus before purchasing a listing');
  if (bus.adminDisabled) throw new ApiError(400, 'This listing has been disabled by the admin. Contact support.');

  const isRenewal = (await Subscription.countDocuments({ bus: bus._id, status: { $in: ['active', 'expired'] } })) > 0;
  const sub = await Subscription.create({
    owner: req.owner._id,
    bus: bus._id,
    plan: plan._id,
    planSnapshot: { name: plan.name, durationDays: plan.durationDays, price: plan.price },
    isRenewal,
  });
  const order = await createOrder({ amount: plan.price, receipt: String(sub._id), notes: { bus: bus.name, plan: plan.code, owner: req.owner.companyName } });
  const payment = await Payment.create({
    owner: req.owner._id,
    bus: bus._id,
    subscription: sub._id,
    plan: plan._id,
    amount: plan.price,
    gateway: config.razorpay.mode === 'live' ? 'razorpay' : 'mock',
    razorpayOrderId: order.id,
    paidBy: req.user._id,
  });
  sub.payment = payment._id;
  await sub.save();

  res.status(201).json({
    success: true,
    data: {
      paymentId: payment._id,
      subscriptionId: sub._id,
      mode: config.razorpay.mode,
      order: { id: order.id, amount: order.amount, currency: order.currency },
      razorpayKeyId: config.razorpay.keyId || null,
      prefill: { name: req.user.name, email: req.user.email, contact: req.user.mobile },
      description: `${plan.name} — ${bus.name}`,
    },
  });
};

async function loadOwnPayment(req, id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid payment');
  const payment = await Payment.findOne({ _id: id, owner: req.owner._id });
  if (!payment) throw new ApiError(404, 'Payment not found');
  return payment;
}

exports.verifyPayment = async (req, res) => {
  const { paymentId, razorpay_order_id: orderId, razorpay_payment_id: rpPaymentId, razorpay_signature: signature } = req.body;
  const payment = await loadOwnPayment(req, paymentId);
  if (payment.razorpayOrderId !== orderId) throw new ApiError(400, 'Order mismatch');
  if (!verifySignature(orderId, rpPaymentId, signature)) {
    await markFailed(payment, 'Signature verification failed');
    throw new ApiError(400, 'Payment verification failed');
  }
  await markPaid(payment, { razorpayPaymentId: rpPaymentId, razorpaySignature: signature });
  const sub = await Subscription.findById(payment.subscription).lean();
  res.json({ success: true, message: 'Payment successful', data: { payment, subscription: sub } });
};

/** Mock gateway (only when Razorpay keys are not configured). */
exports.mockComplete = async (req, res) => {
  if (config.razorpay.mode !== 'mock') throw new ApiError(400, 'Mock payments are disabled when Razorpay is configured');
  const payment = await loadOwnPayment(req, req.params.id);
  if (req.body.outcome === 'failure') {
    await markFailed(payment, 'Test payment declined');
    return res.status(400).json({ success: false, message: 'Payment failed (test)' });
  }
  await markPaid(payment, { razorpayPaymentId: `pay_mock_${Date.now().toString(36)}` });
  const sub = await Subscription.findById(payment.subscription).lean();
  return res.json({ success: true, message: 'Payment successful (test mode)', data: { payment, subscription: sub } });
};

exports.reportFailure = async (req, res) => {
  const payment = await loadOwnPayment(req, req.params.id);
  await markFailed(payment, req.body.reason || 'Payment cancelled or failed at gateway');
  res.json({ success: true });
};

exports.listPayments = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const filter = { owner: req.owner._id };
  if (req.query.status) filter.status = req.query.status;
  const [total, items] = await Promise.all([
    Payment.countDocuments(filter),
    Payment.find(filter).populate('bus', 'name registrationNumber images').populate('subscription', 'planSnapshot status startDate endDate').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({ success: true, data: items, meta: pageMeta(total, { page, limit }) });
};

exports.receipt = async (req, res) => {
  const payment = await Payment.findOne({ _id: req.params.id, owner: req.owner._id }).populate('owner bus subscription');
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (!['paid', 'refunded'].includes(payment.status)) throw new ApiError(400, 'Receipt is available only for successful payments');
  streamReceipt(res, payment);
};

// ───────────────────────── Enquiries & notifications ─────────────────────────

exports.listEnquiries = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const filter = { owner: req.owner._id };
  if (req.query.type) filter.type = req.query.type;
  if (req.query.bus && mongoose.isValidObjectId(req.query.bus)) filter.bus = req.query.bus;
  const [total, items] = await Promise.all([
    Enquiry.countDocuments(filter),
    Enquiry.find(filter).populate('bus', 'name registrationNumber images').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({ success: true, data: items, meta: pageMeta(total, { page, limit }) });
};

exports.updateEnquiry = async (req, res) => {
  const e = await Enquiry.findOne({ _id: req.params.id, owner: req.owner._id });
  if (!e) throw new ApiError(404, 'Enquiry not found');
  if (['new', 'responded', 'closed'].includes(req.body.status)) e.status = req.body.status;
  await e.save();
  res.json({ success: true, data: e });
};

exports.notifications = async (req, res) => {
  const items = await Notification.find({ owner: req.owner._id }).sort({ createdAt: -1 }).limit(50).lean();
  const unread = await Notification.countDocuments({ owner: req.owner._id, readAt: null });
  res.json({ success: true, data: items, meta: { unread } });
};

exports.readNotifications = async (req, res) => {
  await Notification.updateMany({ owner: req.owner._id, readAt: null }, { $set: { readAt: new Date() } });
  res.json({ success: true });
};

/** Lookups the dashboard forms need. */
exports.lookups = async (req, res) => {
  const [cities, stops, buses] = await Promise.all([
    City.find({ isActive: true }).sort({ name: 1 }).select('name slug state').lean(),
    Stop.find({ isActive: true }).sort({ name: 1 }).select('name city landmark').lean(),
    Bus.find(ownerBusFilter(req)).sort({ name: 1 }).select('name registrationNumber').lean(),
  ]);
  const { RouteCategory } = require('../models');
  const categories = await RouteCategory.find({ isActive: true }).sort({ name: 1 }).lean();
  res.json({ success: true, data: { cities, stops, buses, categories, busTypes: Bus.BUS_TYPES, facilities: Bus.FACILITIES, reasons: DailyBusStatus.REASONS } });
};

exports._internal = { normaliseStops, validateStatusBody, BusOwner };
