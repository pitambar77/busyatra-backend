const mongoose = require('mongoose');
const { Bus, Route, City, PopularRoute, BusOwner, Enquiry, SearchLog, SubscriptionPlan, DailyBusStatus, Stop } = require('../models');
const { ApiError, dateKey, isValidDateKey, paginate, pageMeta, escapeRegex, maskRegistration } = require('../utils/helpers');
const { searchTrips, resolveCity, busCard } = require('../services/searchService');
const { resolveStatus, statusMapFor, STATUS_LABELS, REASON_LABELS } = require('../services/statusService');

function dateParam(q) {
  return isValidDateKey(q) ? q : dateKey();
}

/** GET /api/public/meta — enums used by forms & filters */
exports.meta = async (req, res) => {
  res.json({
    success: true,
    data: {
      busTypes: Bus.BUS_TYPES,
      facilities: Bus.FACILITIES,
      statuses: STATUS_LABELS,
      reasons: REASON_LABELS,
      today: dateKey(),
    },
  });
};

/** GET /api/public/cities?q= */
exports.cities = async (req, res) => {
  const filter = { isActive: true };
  if (req.query.q) filter.name = { $regex: `^${escapeRegex(req.query.q)}`, $options: 'i' };
  if (req.query.popular === 'true') filter.isPopularDestination = true;
  const cities = await City.find(filter).sort({ name: 1 }).limit(Number(req.query.limit) || 50).lean();
  res.json({ success: true, data: cities });
};

/** GET /api/public/cities/:cityId/stops */
exports.cityStops = async (req, res) => {
  const city = await resolveCity(req.params.city);
  if (!city) throw new ApiError(404, 'City not found');
  const stops = await Stop.find({ city: city._id, isActive: true }).sort({ name: 1 }).lean();
  res.json({ success: true, data: stops });
};

/** GET /api/public/home */
exports.home = async (req, res) => {
  const today = dateKey();
  const [popular, destinations, plans] = await Promise.all([
    PopularRoute.find({ isActive: true }).sort({ sortOrder: 1 }).limit(12).populate('fromCity toCity category').lean(),
    City.find({ isActive: true, isPopularDestination: true }).sort({ name: 1 }).limit(12).lean(),
    SubscriptionPlan.find({ isActive: true }).sort({ sortOrder: 1, durationDays: 1 }).lean(),
  ]);

  // Count public buses per popular route.
  const popularRoutes = await Promise.all(
    popular
      .filter((p) => p.fromCity && p.toCity)
      .map(async (p) => {
        const { items } = await searchTrips({ from: p.fromCity._id, to: p.toCity._id, date: today });
        const fares = items.map((t) => t.fare).filter((f) => f != null);
        return {
          _id: p._id,
          from: { _id: p.fromCity._id, name: p.fromCity.name, slug: p.fromCity.slug, image: p.fromCity.image || null },
          to: { _id: p.toCity._id, name: p.toCity.name, slug: p.toCity.slug, image: p.toCity.image || null },
          busImage: items.find((t) => t.bus.image)?.bus.image || null,
          category: p.category?.name || null,
          busCount: items.length,
          startingFare: fares.length ? Math.min(...fares) : null,
          firstDeparture: items[0]?.from.time || null,
        };
      })
  );

  const publicFilter = Bus.publicFilter();
  const [busCount, operatorIds] = await Promise.all([Bus.countDocuments(publicFilter), Bus.distinct('owner', publicFilter)]);
  const publicBusIds = await Bus.distinct('_id', publicFilter);
  const runningToday = await DailyBusStatus.countDocuments({ bus: { $in: publicBusIds }, date: today, status: { $in: ['running', 'delayed'] } });
  const cityCount = await City.countDocuments({ isActive: true });
  const hero = await require('../services/heroService').getHero();

  res.json({
    success: true,
    data: {
      hero,
      popularRoutes,
      destinations,
      plans,
      stats: { buses: busCount, operators: operatorIds.length, cities: cityCount, runningToday },
    },
  });
};

/** GET /api/public/search?from&to&date&busType&facilities&timeSlot&onlyRunning&sort&page&limit */
exports.search = async (req, res) => {
  const date = dateParam(req.query.date);
  const result = await searchTrips({ ...req.query, date });
  const { page, limit, skip } = paginate({ ...req.query, limit: req.query.limit || 10 });
  const total = result.items.length;

  if (req.query.from || req.query.to) {
    SearchLog.create({
      from: result.fromCity?._id,
      to: result.toCity?._id,
      fromName: result.fromCity?.name || req.query.from,
      toName: result.toCity?.name || req.query.to,
      travelDate: date,
      resultCount: total,
    }).catch(() => {});
  }

  res.json({
    success: true,
    data: {
      from: result.fromCity,
      to: result.toCity,
      date,
      items: result.items.slice(skip, skip + limit),
      summary: {
        running: result.items.filter((t) => ['running', 'delayed'].includes(t.status.code)).length,
        stopped: result.items.filter((t) => ['not_running', 'cancelled', 'suspended'].includes(t.status.code)).length,
        notUpdated: result.items.filter((t) => t.status.code === 'not_updated').length,
        lowestFare: total ? Math.min(...result.items.map((t) => t.fare)) : null,
      },
    },
    meta: pageMeta(total, { page, limit }),
  });
};

/** GET /api/public/routes/:from/:to — full timetable for a city pair (no pagination) */
exports.routeTimetable = async (req, res) => {
  const date = dateParam(req.query.date);
  const result = await searchTrips({ from: req.params.from, to: req.params.to, date, sort: 'departure' });
  if (!result.fromCity || !result.toCity) throw new ApiError(404, 'Route not found');
  res.json({ success: true, data: { from: result.fromCity, to: result.toCity, date, items: result.items } });
};

/** GET /api/public/routes — list of all city pairs that have at least one public bus */
exports.routesIndex = async (req, res) => {
  const busIds = await Bus.distinct('_id', Bus.publicFilter());
  const routes = await Route.find({ bus: { $in: busIds }, isActive: true }).select('fromCity toCity bus').populate('fromCity toCity', 'name slug image state').lean();
  const map = new Map();
  routes.forEach((r) => {
    if (!r.fromCity || !r.toCity) return;
    const key = `${r.fromCity.slug}__${r.toCity.slug}`;
    const entry = map.get(key) || { from: r.fromCity, to: r.toCity, buses: new Set() };
    entry.buses.add(String(r.bus));
    map.set(key, entry);
  });
  const data = [...map.values()].map((e) => ({ from: e.from, to: e.to, busCount: e.buses.size })).sort((a, b) => b.busCount - a.busCount || a.from.name.localeCompare(b.from.name));
  res.json({ success: true, data });
};

async function findPublicBus(idOrSlug) {
  const q = mongoose.isValidObjectId(idOrSlug) ? { _id: idOrSlug } : { slug: idOrSlug };
  return Bus.findOne({ ...q, ...Bus.publicFilter() }).populate('owner', 'companyName slug ownerName businessAddress about logo createdAt').lean();
}

/** GET /api/public/buses/:idOrSlug?date= */
exports.busDetails = async (req, res) => {
  const bus = await findPublicBus(req.params.id);
  if (!bus) throw new ApiError(404, 'This bus is not listed or its listing has expired');
  const date = dateParam(req.query.date);
  const [routes, statusDoc, recent] = await Promise.all([
    Route.find({ bus: bus._id, isActive: true }).sort({ departureTime: 1 }).lean(),
    DailyBusStatus.findOne({ bus: bus._id, date }).lean(),
    DailyBusStatus.find({ bus: bus._id }).sort({ date: -1 }).limit(7).select('date status reason message delayMinutes updatedAt').lean(),
  ]);
  Bus.updateOne({ _id: bus._id }, { $inc: { viewCount: 1 } }).catch(() => {});

  res.json({
    success: true,
    data: {
      ...busCard(bus),
      registrationNumber: bus.registrationNumber,
      registrationMasked: maskRegistration(bus.registrationNumber),
      description: bus.description,
      operator: bus.owner
        ? {
            _id: bus.owner._id,
            name: bus.owner.companyName,
            slug: bus.owner.slug,
            ownerName: bus.owner.ownerName,
            city: bus.owner.businessAddress?.city,
            state: bus.owner.businessAddress?.state,
            about: bus.owner.about,
            memberSince: bus.owner.createdAt,
          }
        : null,
      routes: routes.map((r) => ({
        _id: r._id,
        name: r.name,
        origin: r.stops[0]?.cityName,
        destination: r.stops[r.stops.length - 1]?.cityName,
        departureTime: r.departureTime,
        arrivalTime: r.arrivalTime,
        totalDistanceKm: r.totalDistanceKm,
        operatingDays: r.operatingDays,
        stops: r.stops,
        status: resolveStatus(bus, statusDoc, date, r),
      })),
      status: resolveStatus(bus, statusDoc, date),
      recentStatus: recent,
      lastUpdated: statusDoc?.updatedAt || bus.updatedAt,
      listingUpdatedAt: bus.updatedAt,
    },
  });
};

/** GET /api/public/operators?q&page */
exports.operators = async (req, res) => {
  const filter = Bus.publicFilter();
  const ownerIds = await Bus.distinct('owner', filter);
  const q = { _id: { $in: ownerIds } };
  if (req.query.q) q.companyName = { $regex: escapeRegex(req.query.q), $options: 'i' };
  const { page, limit, skip } = paginate({ ...req.query, limit: req.query.limit || 12 });
  const [total, owners] = await Promise.all([BusOwner.countDocuments(q), BusOwner.find(q).sort({ companyName: 1 }).skip(skip).limit(limit).select('companyName slug businessAddress about logo createdAt').lean()]);
  const counts = await Bus.find({ ...filter, owner: { $in: owners.map((o) => o._id) } }).select('owner images busTypes').lean();
  const countMap = counts.reduce((m, b) => m.set(String(b.owner), (m.get(String(b.owner)) || 0) + 1), new Map());
  const coverMap = counts.reduce((m, b) => (m.has(String(b.owner)) || !b.images?.length ? m : m.set(String(b.owner), b.images[0])), new Map());
  const typeMap = counts.reduce((m, b) => m.set(String(b.owner), [...new Set([...(m.get(String(b.owner)) || []), ...(b.busTypes || [])])]), new Map());
  res.json({
    success: true,
    data: owners.map((o) => ({ ...o, busCount: countMap.get(String(o._id)) || 0, coverImage: coverMap.get(String(o._id)) || null, busTypes: typeMap.get(String(o._id)) || [] })),
    meta: pageMeta(total, { page, limit }),
  });
};

/** GET /api/public/operators/:slug */
exports.operatorDetails = async (req, res) => {
  const owner = await BusOwner.findOne({ slug: req.params.slug, verificationStatus: 'approved', isSuspended: false }).select('companyName slug ownerName businessAddress about logo createdAt').lean();
  if (!owner) throw new ApiError(404, 'Operator not found');
  const date = dateParam(req.query.date);
  const buses = await Bus.find({ ...Bus.publicFilter(), owner: owner._id }).populate('owner', 'companyName slug').lean();
  const statuses = await statusMapFor(buses.map((b) => b._id), date);
  const routes = await Route.find({ bus: { $in: buses.map((b) => b._id) }, isActive: true }).lean();
  res.json({
    success: true,
    data: {
      ...owner,
      buses: buses.map((b) => ({
        ...busCard(b),
        status: resolveStatus(b, statuses.get(String(b._id)), date),
        routes: routes.filter((r) => String(r.bus) === String(b._id)).map((r) => ({ _id: r._id, origin: r.stops[0]?.cityName, destination: r.stops[r.stops.length - 1]?.cityName, departureTime: r.departureTime, arrivalTime: r.arrivalTime })),
      })),
    },
  });
};

/** POST /api/public/track {busId, type: call_click|whatsapp_click, routeId} */
exports.track = async (req, res) => {
  const { busId, type, routeId, page } = req.body;
  if (!['call_click', 'whatsapp_click'].includes(type)) throw new ApiError(400, 'Invalid event');
  if (!mongoose.isValidObjectId(busId)) throw new ApiError(400, 'Invalid bus');
  const bus = await Bus.findById(busId).select('owner');
  if (!bus) throw new ApiError(404, 'Bus not found');
  await Enquiry.create({
    type,
    bus: bus._id,
    owner: bus.owner,
    route: mongoose.isValidObjectId(routeId) ? routeId : undefined,
    user: req.user?._id,
    meta: { ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 200), page },
  });
  await Bus.updateOne({ _id: bus._id }, { $inc: { [type === 'call_click' ? 'callClicks' : 'whatsappClicks']: 1 } });
  res.json({ success: true });
};

/** POST /api/public/enquiries {busId, name, mobile, message, travelDate} */
exports.createEnquiry = async (req, res) => {
  const { busId, name, mobile, email, message, travelDate, routeId } = req.body;
  if (!name || !mobile || !message) throw new ApiError(400, 'Name, mobile and message are required');
  if (!/^[6-9]\d{9}$/.test(String(mobile).replace(/\D/g, '').slice(-10))) throw new ApiError(400, 'Enter a valid mobile number');
  const bus = mongoose.isValidObjectId(busId) ? await Bus.findById(busId).select('owner name') : null;
  if (!bus) throw new ApiError(404, 'Bus not found');
  const enquiry = await Enquiry.create({
    type: 'enquiry',
    bus: bus._id,
    owner: bus.owner,
    route: mongoose.isValidObjectId(routeId) ? routeId : undefined,
    name,
    mobile,
    email,
    message,
    travelDate,
    user: req.user?._id,
    meta: { ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 200) },
  });
  const { notifyOwner } = require('../services/notificationService');
  await notifyOwner(bus.owner, 'enquiry', `New enquiry for ${bus.name}`, `${name} (${mobile}): ${message.slice(0, 120)}`, '/owner/enquiries');
  res.status(201).json({ success: true, message: 'Enquiry sent to the operator', data: { _id: enquiry._id } });
};

/** POST /api/public/contact {name, email, mobile, subject, message} */
exports.contact = async (req, res) => {
  const { name, email, mobile, subject, message } = req.body;
  if (!name || !message || (!email && !mobile)) throw new ApiError(400, 'Name, message and an email or mobile are required');
  await Enquiry.create({ type: 'contact', name, email, mobile, subject, message, meta: { ip: req.ip } });
  res.status(201).json({ success: true, message: 'Thanks! Our team will get back to you shortly.' });
};

/** GET /api/public/plans */
exports.plans = async (req, res) => {
  const plans = await SubscriptionPlan.find({ isActive: true }).sort({ sortOrder: 1, durationDays: 1 }).lean();
  res.json({ success: true, data: plans });
};
