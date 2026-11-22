const mongoose = require('mongoose');
const { Bus, Route, City } = require('../models');
const { dateKey, maskRegistration, timeToMinutes, escapeRegex } = require('../utils/helpers');
const { resolveStatus, statusMapFor } = require('./statusService');

/** Accepts a City id, slug or name. */
async function resolveCity(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (mongoose.isValidObjectId(s)) {
    const c = await City.findById(s).lean();
    if (c) return c;
  }
  return City.findOne({ $or: [{ slug: s.toLowerCase() }, { name: { $regex: `^${escapeRegex(s)}$`, $options: 'i' } }] }).lean();
}

const TIME_SLOTS = {
  morning: [5 * 60, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  evening: [17 * 60, 21 * 60],
  night: [21 * 60, 29 * 60], // 21:00 → 05:00
};

function inSlot(minutes, slot) {
  const range = TIME_SLOTS[slot];
  if (!range || minutes == null) return true;
  const m = minutes < 5 * 60 ? minutes + 24 * 60 : minutes;
  return m >= range[0] && m < range[1];
}

function busCard(bus) {
  return {
    _id: bus._id,
    slug: bus.slug,
    name: bus.name,
    image: bus.images?.[0] || null,
    images: bus.images || [],
    busTypes: bus.busTypes,
    facilities: bus.facilities,
    seatingCapacity: bus.seatingCapacity,
    registrationMasked: maskRegistration(bus.registrationNumber),
    contactNumber: bus.contactNumber,
    alternateNumber: bus.alternateNumber,
    whatsappNumber: bus.whatsappNumber || bus.contactNumber,
    ticketPrice: bus.ticketPrice,
    operator: bus.owner ? { _id: bus.owner._id, name: bus.owner.companyName, slug: bus.owner.slug } : null,
  };
}

/** Works out the segment of `route` between two cities. Returns null if the route doesn't serve that direction. */
function segmentOf(route, fromId, toId) {
  const ids = route.stops.map((s) => String(s.city));
  let i = 0;
  let j = ids.length - 1;
  if (fromId) {
    i = ids.indexOf(String(fromId));
    if (i === -1 || i === ids.length - 1) return null;
  }
  if (toId) {
    j = ids.lastIndexOf(String(toId));
    if (j === -1 || j <= i) return null;
  }
  return { i, j };
}

function buildTrip(route, bus, statusDoc, date, fromId, toId) {
  const seg = segmentOf(route, fromId, toId);
  if (!seg) return null;
  const a = route.stops[seg.i];
  const b = route.stops[seg.j];
  const depTime = a.departureTime || a.arrivalTime;
  const arrTime = b.arrivalTime || b.departureTime;
  const depMin = timeToMinutes(depTime);
  const arrMin = timeToMinutes(arrTime);
  const duration = depMin != null && arrMin != null ? arrMin + 1440 * (b.dayOffset || 0) - (depMin + 1440 * (a.dayOffset || 0)) : null;

  const full = seg.i === 0 && seg.j === route.stops.length - 1;
  const fa = seg.i === 0 ? 0 : a.fareFromOrigin;
  const fb = b.fareFromOrigin;
  let fare = bus.ticketPrice;
  let fareIsSegment = false;
  if (!full && fa != null && fb != null && fb >= fa) {
    fare = fb - fa;
    fareIsSegment = true;
  } else if (full && fb != null && seg.j === route.stops.length - 1 && b.fareFromOrigin) {
    fare = b.fareFromOrigin;
  }

  return {
    routeId: route._id,
    routeName: route.name || null,
    bus: busCard(bus),
    origin: route.stops[0].cityName,
    destination: route.stops[route.stops.length - 1].cityName,
    from: { city: a.cityName, stop: a.stopName, time: depTime, dayOffset: a.dayOffset || 0 },
    to: { city: b.cityName, stop: b.stopName, time: arrTime, dayOffset: b.dayOffset || 0 },
    majorStops: route.stops.slice(seg.i + 1, seg.j).filter((s) => s.isMajor !== false).map((s) => s.cityName === s.stopName ? s.cityName : `${s.stopName}`),
    stopCount: seg.j - seg.i - 1,
    durationMinutes: duration != null && duration >= 0 ? duration : null,
    fare,
    fareIsSegment,
    isFullRoute: full,
    status: resolveStatus(bus, statusDoc, date, route),
    _depMin: depMin,
  };
}

/**
 * Public search across active, approved, paid listings.
 * Matches any route that passes `from` before `to`, so a Puri→Cuttack bus appears for Bhubaneswar→Cuttack.
 */
async function searchTrips({ from, to, date = dateKey(), busType, facilities, timeSlot, onlyRunning, sort = 'departure', ownerId, maxPrice, q } = {}) {
  const fromCity = from ? await resolveCity(from) : null;
  const toCity = to ? await resolveCity(to) : null;
  if ((from && !fromCity) || (to && !toCity)) return { fromCity, toCity, items: [], date };

  const routeQuery = { isActive: true };
  if (fromCity && toCity) routeQuery.stopCities = { $all: [fromCity._id, toCity._id] };
  else if (fromCity) routeQuery.stopCities = fromCity._id;
  else if (toCity) routeQuery.stopCities = toCity._id;
  if (ownerId) routeQuery.owner = ownerId;

  const routes = await Route.find(routeQuery).lean();
  if (!routes.length) return { fromCity, toCity, items: [], date };

  const busQuery = { ...Bus.publicFilter(), _id: { $in: [...new Set(routes.map((r) => String(r.bus)))] } };
  const types = [].concat(busType || []).flatMap((t) => String(t).split(',')).filter(Boolean);
  if (types.length) busQuery.busTypes = { $all: types };
  const facs = [].concat(facilities || []).flatMap((t) => String(t).split(',')).filter(Boolean);
  if (facs.length) busQuery.facilities = { $all: facs };
  if (q) busQuery.name = { $regex: escapeRegex(q), $options: 'i' };

  const buses = await Bus.find(busQuery).populate('owner', 'companyName slug').lean();
  const busMap = new Map(buses.map((b) => [String(b._id), b]));
  const statuses = await statusMapFor(buses.map((b) => b._id), date);

  let items = routes
    .filter((r) => busMap.has(String(r.bus)))
    .map((r) => buildTrip(r, busMap.get(String(r.bus)), statuses.get(String(r.bus)), date, fromCity?._id, toCity?._id))
    .filter(Boolean);

  if (timeSlot) items = items.filter((t) => inSlot(t._depMin, timeSlot));
  if (onlyRunning === 'true' || onlyRunning === true) items = items.filter((t) => ['running', 'delayed'].includes(t.status.code));
  if (maxPrice) items = items.filter((t) => t.fare <= Number(maxPrice));

  const sorters = {
    departure: (x, y) => (x._depMin ?? 9999) - (y._depMin ?? 9999),
    price_low: (x, y) => x.fare - y.fare,
    price_high: (x, y) => y.fare - x.fare,
    duration: (x, y) => (x.durationMinutes ?? 99999) - (y.durationMinutes ?? 99999),
  };
  items.sort(sorters[sort] || sorters.departure);
  items.forEach((t) => delete t._depMin);

  return { fromCity, toCity, items, date };
}

module.exports = { resolveCity, searchTrips, buildTrip, busCard, segmentOf };
