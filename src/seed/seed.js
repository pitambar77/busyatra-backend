/* eslint-disable no-await-in-loop */
/**
 * Demo data: Odisha-centred cities, stops, operators, buses, routes, daily statuses,
 * subscriptions, payments, enquiries and search logs.
 *
 *   npm run seed            → wipes the configured database and loads demo data
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../config');
const { connectDB } = require('../config/db');
const M = require('../models');
const { dateKey, addDays, slugify } = require('../utils/helpers');
const { BUS_PHOTOS, CITY_PHOTOS } = require('./photos');

const CITIES = {
  bbsr: { name: 'Bhubaneswar', state: 'Odisha', popular: true, stops: ['Baramunda Bus Stand', 'Master Canteen Square', 'Khandagiri Square'], description: 'The Temple City and capital of Odisha.' },
  ctc: { name: 'Cuttack', state: 'Odisha', popular: true, stops: ['Badambadi Bus Stand', 'Link Road'], description: 'The Silver City on the Mahanadi.' },
  puri: { name: 'Puri', state: 'Odisha', popular: true, stops: ['Puri Bus Stand', 'Gundicha Temple'], description: 'Home of Lord Jagannath and golden beaches.' },
  konark: { name: 'Konark', state: 'Odisha', popular: true, stops: ['Konark Bus Stand'], description: 'The Sun Temple, a UNESCO World Heritage Site.' },
  khurda: { name: 'Khurda', state: 'Odisha', stops: ['Khurda Bus Stand'] },
  bam: { name: 'Berhampur', state: 'Odisha', popular: true, stops: ['Berhampur New Bus Stand'], description: 'The Silk City of southern Odisha.' },
  sbp: { name: 'Sambalpur', state: 'Odisha', popular: true, stops: ['Ainthapali Bus Stand'], description: 'Gateway to western Odisha and Hirakud Dam.' },
  rkl: { name: 'Rourkela', state: 'Odisha', stops: ['Rourkela Bus Stand'] },
  bls: { name: 'Balasore', state: 'Odisha', stops: ['Balasore Bus Stand'] },
  angul: { name: 'Angul', state: 'Odisha', stops: ['Angul Bus Stand'] },
  dkl: { name: 'Dhenkanal', state: 'Odisha', stops: ['Dhenkanal Bus Stand'] },
  jajpur: { name: 'Jajpur', state: 'Odisha', stops: ['Jajpur Road Bus Stand'] },
  bhadrak: { name: 'Bhadrak', state: 'Odisha', stops: ['Bhadrak Bus Stand'] },
  keonjhar: { name: 'Keonjhar', state: 'Odisha', stops: ['Keonjhar Bus Stand'] },
  jsg: { name: 'Jharsuguda', state: 'Odisha', stops: ['Jharsuguda Bus Stand'] },
  baripada: { name: 'Baripada', state: 'Odisha', stops: ['Baripada Bus Stand'] },
  kol: { name: 'Kolkata', state: 'West Bengal', popular: true, stops: ['Esplanade Bus Terminus', 'Karunamoyee'], description: 'The City of Joy.' },
  vizag: { name: 'Visakhapatnam', state: 'Andhra Pradesh', popular: true, stops: ['Dwaraka Bus Station'], description: 'Port city with beaches and hills.' },
};

const PLANS = [
  { name: '7-Day Listing', code: 'LIST7', durationDays: 7, price: 199, sortOrder: 1, description: 'Try the platform for a week', features: ['Public listing', 'Daily status updates', 'Call & WhatsApp leads'] },
  { name: '30-Day Listing', code: 'LIST30', durationDays: 30, price: 599, sortOrder: 2, isPopular: true, description: 'Most operators start here', features: ['Everything in 7-Day', 'Enquiry inbox', 'Payment receipts'] },
  { name: '90-Day Listing', code: 'LIST90', durationDays: 90, price: 1499, sortOrder: 3, description: 'Save 17% vs monthly', features: ['Everything in 30-Day', 'Priority approval'] },
  { name: '365-Day Listing', code: 'LIST365', durationDays: 365, price: 4999, sortOrder: 4, description: 'Best value — save 30%', features: ['Everything in 90-Day', 'Featured on operator page'] },
];

const OWNERS = [
  { key: 'A', ownerName: 'Suresh Mohanty', companyName: 'Maa Tarini Travels', email: 'owner@demo.in', mobile: '9876500001', password: 'Owner@123', city: 'Bhubaneswar', status: 'approved', about: 'Family-run operator serving Puri, Bhubaneswar and Cuttack since 2004.' },
  { key: 'B', ownerName: 'Pradeep Sahoo', companyName: 'Kalinga Roadways', email: 'kalinga@demo.in', mobile: '9876500002', password: 'Owner@123', city: 'Bhubaneswar', status: 'approved', about: 'Premium AC and sleeper services to western and southern Odisha.' },
  { key: 'C', ownerName: 'Ananya Patnaik', companyName: 'Jagannath Express', email: 'jagannath@demo.in', mobile: '9876500003', password: 'Owner@123', city: 'Berhampur', status: 'approved', about: 'Berhampur-based operator with interstate services to Andhra Pradesh.' },
  { key: 'D', ownerName: 'Bikash Das', companyName: 'Odisha Comfort Lines', email: 'comfort@demo.in', mobile: '9876500004', password: 'Owner@123', city: 'Cuttack', status: 'approved', about: 'Daily services across coastal and northern Odisha.' },
  { key: 'E', ownerName: 'Rakesh Nayak', companyName: 'Sai Baba Travels', email: 'saibaba@demo.in', mobile: '9876500005', password: 'Owner@123', city: 'Sambalpur', status: 'pending' },
  { key: 'F', ownerName: 'Manas Behera', companyName: 'Quick Ride Bus Service', email: 'quickride@demo.in', mobile: '9876500006', password: 'Owner@123', city: 'Cuttack', status: 'rejected', rejectionReason: 'Business registration document is unreadable. Please upload a clear copy.' },
];

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
// stop tuple: [cityKey, stopIndex, arrival, departure, distanceKm, fareFromOrigin, dayOffset]
const BUSES = [
  {
    owner: 'A', name: 'Maa Tarini Express', reg: 'OD02AB1234', types: ['AC', 'Seater'], capacity: 40, price: 140, img: 'navy', contact: '9437000101', alt: '9437000102',
    facilities: ['Charging Point', 'Water Bottle', 'CCTV', 'GPS Tracking', 'Pushback Seats', 'First Aid'], plan: 'LIST90', daysLeft: 54, today: { status: 'running' },
    routes: [
      { name: 'Morning Express', stops: [['puri', 0, null, '06:00', 0, 0], ['bbsr', 0, '07:20', '07:35', 62, 90], ['ctc', 0, '08:30', null, 90, 140]] },
      { name: 'Evening Return', stops: [['ctc', 0, null, '17:00', 0, 0], ['bbsr', 0, '17:55', '18:05', 28, 60], ['puri', 0, '19:30', null, 90, 140]] },
    ],
  },
  {
    owner: 'A', name: 'Maa Tarini Sleeper', reg: 'OD02CD5678', types: ['AC', 'Sleeper'], capacity: 30, price: 1150, img: 'orange', contact: '9437000103',
    facilities: ['WiFi', 'Charging Point', 'Blanket', 'Reading Light', 'Water Bottle', 'CCTV', 'GPS Tracking', 'Emergency Exit'], plan: 'LIST365', daysLeft: 220, today: { status: 'delayed', reason: 'operational_issue', delayMinutes: 30, message: 'Late departure due to traffic at Rasulgarh' },
    routes: [{ name: 'Kolkata Night Sleeper', stops: [['bbsr', 0, null, '21:00', 0, 0], ['ctc', 0, '21:50', '22:00', 28, 100], ['bls', 0, '01:30', '01:45', 210, 550, 1], ['kol', 0, '06:30', null, 440, 1150, 1]] }],
  },
  {
    owner: 'A', name: 'Tarini Shuttle', reg: 'OD02EF9012', types: ['Non-AC', 'Seater'], capacity: 50, price: 50, img: 'teal', contact: '9437000104',
    facilities: ['Luggage Space', 'First Aid'], plan: 'LIST30', daysLeft: 2, today: { status: 'not_running', reason: 'mechanical_problem', message: 'Gearbox repair in progress, back tomorrow' },
    routes: [
      { name: 'Shuttle 1', stops: [['bbsr', 0, null, '07:00', 0, 0], ['ctc', 0, '07:50', null, 28, 50]] },
      { name: 'Shuttle 2', stops: [['ctc', 0, null, '09:00', 0, 0], ['bbsr', 0, '09:50', null, 28, 50]] },
    ],
  },
  {
    owner: 'A', name: 'Tarini Konark Special', reg: 'OD02GH3456', types: ['AC', 'Luxury'], capacity: 35, price: 180, img: 'purple', contact: '9437000105',
    facilities: ['WiFi', 'Charging Point', 'TV / Entertainment', 'Pushback Seats', 'Water Bottle'], plan: 'LIST30', expired: true,
    routes: [{ name: 'Golden Triangle', stops: [['bbsr', 0, null, '08:00', 0, 0], ['konark', 0, '09:20', '10:30', 65, 120], ['puri', 0, '11:15', null, 100, 180]] }],
  },
  { owner: 'A', name: 'Tarini Mini', reg: 'OD02JK7788', types: ['Non-AC', 'Seater'], capacity: 26, price: 40, img: 'slate', contact: '9437000106', facilities: ['First Aid'], draft: true, routes: [] },

  {
    owner: 'B', name: 'Kalinga Volvo Premium', reg: 'OD05AA1111', types: ['AC', 'Seater', 'Luxury'], capacity: 45, price: 650, img: 'blue', contact: '9437000201', alt: '9437000202',
    facilities: ['WiFi', 'Charging Point', 'Water Bottle', 'Reading Light', 'CCTV', 'GPS Tracking', 'Pushback Seats', 'Washroom'], plan: 'LIST90', daysLeft: 40, today: { status: 'running' },
    routes: [{ name: 'Sambalpur Day Volvo', stops: [['bbsr', 0, null, '06:30', 0, 0], ['dkl', 0, '08:00', '08:05', 75, 180], ['angul', 0, '09:00', '09:10', 140, 320], ['sbp', 0, '11:45', null, 300, 650]] }],
  },
  {
    owner: 'B', name: 'Kalinga Night Rider', reg: 'OD05BB2222', types: ['AC', 'Sleeper'], capacity: 32, price: 990, img: 'red', contact: '9437000203',
    facilities: ['Blanket', 'Charging Point', 'Reading Light', 'Water Bottle', 'GPS Tracking', 'Emergency Exit'], plan: 'LIST30', daysLeft: 18, today: null,
    routes: [{ name: 'Rourkela Night', stops: [['bbsr', 0, null, '22:00', 0, 0], ['sbp', 0, '03:30', '03:40', 300, 700, 1], ['jsg', 0, '04:40', '04:45', 350, 800, 1], ['rkl', 0, '06:15', null, 440, 990, 1]] }],
  },
  {
    owner: 'B', name: 'Kalinga Coastal', reg: 'OD05CC3333', types: ['Non-AC', 'Seater'], capacity: 52, price: 260, img: 'green', contact: '9437000204',
    facilities: ['Luggage Space', 'First Aid', 'Fire Extinguisher'], plan: 'LIST30', daysLeft: 25, today: { status: 'cancelled', reason: 'weather_condition', message: 'Heavy rain warning on NH-16' },
    routes: [{ name: 'Berhampur Morning', stops: [['bbsr', 0, null, '05:45', 0, 0], ['khurda', 0, '06:30', '06:35', 25, 40], ['bam', 0, '10:15', null, 170, 260]] }],
  },

  {
    owner: 'C', name: 'Jagannath Express', reg: 'OD13PQ4444', types: ['AC', 'Seater'], capacity: 42, price: 380, img: 'orange', contact: '9437000301', alt: '9437000302',
    facilities: ['Charging Point', 'Water Bottle', 'CCTV', 'Pushback Seats'], plan: 'LIST365', daysLeft: 300, today: { status: 'running' },
    routes: [{ name: 'Berhampur – Cuttack', stops: [['bam', 0, null, '06:00', 0, 0], ['khurda', 0, '09:30', '09:35', 145, 260], ['bbsr', 0, '10:20', '10:30', 170, 320], ['ctc', 0, '11:20', null, 198, 380]] }],
  },
  {
    owner: 'C', name: 'Jagannath Vizag Sleeper', reg: 'OD13RS5555', types: ['AC', 'Sleeper'], capacity: 30, price: 1400, img: 'navy', contact: '9437000303',
    facilities: ['WiFi', 'Blanket', 'Charging Point', 'Reading Light', 'Water Bottle', 'CCTV', 'GPS Tracking', 'Washroom'], plan: 'LIST90', daysLeft: 70, today: { status: 'running' },
    routes: [{ name: 'Vizag Overnight', stops: [['bbsr', 0, null, '18:00', 0, 0], ['khurda', 0, '18:45', '18:50', 25, 120], ['bam', 0, '22:00', '22:15', 170, 500], ['vizag', 0, '05:00', null, 440, 1400, 1]] }],
  },
  {
    owner: 'C', name: 'Jagannath Pilgrim', reg: 'OD13TU6666', types: ['Non-AC', 'Seater'], capacity: 48, price: 110, img: 'green', contact: '9437000304',
    facilities: ['Luggage Space', 'First Aid'], plan: 'LIST30', daysLeft: 12, suspended: { reason: 'scheduled maintenance', untilDays: 3 },
    routes: [{ name: 'Puri Pilgrim', stops: [['ctc', 0, null, '05:30', 0, 0], ['bbsr', 0, '06:20', '06:30', 28, 50], ['puri', 0, '08:00', null, 90, 110]] }],
  },

  {
    owner: 'D', name: 'Comfort Lines Balasore', reg: 'OD01XY7777', types: ['AC', 'Seater'], capacity: 40, price: 420, img: 'teal', contact: '9437000401',
    facilities: ['Charging Point', 'Water Bottle', 'GPS Tracking', 'Pushback Seats', 'CCTV'], plan: 'LIST90', daysLeft: 80, today: { status: 'running' },
    routes: [{ name: 'Balasore Express', stops: [['bbsr', 0, null, '07:30', 0, 0], ['ctc', 0, '08:20', '08:30', 28, 70], ['jajpur', 0, '09:45', '09:50', 90, 180], ['bhadrak', 0, '10:45', '10:50', 140, 280], ['bls', 0, '12:00', null, 210, 420]] }],
  },
  {
    owner: 'D', name: 'Comfort Lines Keonjhar', reg: 'OD01ZZ8888', types: ['Non-AC', 'Seater'], capacity: 50, price: 260, img: 'slate', contact: '9437000402',
    facilities: ['Luggage Space', 'First Aid', 'Fire Extinguisher'], plan: 'LIST30', daysLeft: 9, today: null,
    routes: [{ name: 'Keonjhar Day', stops: [['bbsr', 0, null, '08:00', 0, 0], ['ctc', 0, '08:50', '09:00', 28, 60], ['jajpur', 0, '10:15', '10:20', 90, 140], ['keonjhar', 0, '13:00', null, 190, 260]] }],
  },
  {
    owner: 'D', name: 'Comfort Lines Baripada', reg: 'OD01PP9999', types: ['AC', 'Seater'], capacity: 40, price: 480, img: 'blue', contact: '9437000403',
    facilities: ['Charging Point', 'Water Bottle', 'GPS Tracking'], plan: 'LIST30', pendingApproval: true,
    routes: [{ name: 'Baripada Express', stops: [['bbsr', 0, null, '09:00', 0, 0], ['ctc', 0, '09:50', '10:00', 28, 70], ['bls', 0, '13:00', '13:10', 210, 380], ['baripada', 0, '14:40', null, 270, 480]] }],
  },
  { owner: 'E', name: 'Sai Baba Travels', reg: 'OD07SB1010', types: ['Non-AC', 'Seater'], capacity: 45, price: 300, img: 'red', contact: '9437000501', facilities: ['First Aid'], draft: true,
    routes: [{ name: 'Sambalpur – Bhubaneswar', stops: [['sbp', 0, null, '07:00', 0, 0], ['angul', 0, '09:30', '09:40', 160, 150], ['bbsr', 0, '12:30', null, 300, 300]] }] },
];

const POPULAR = [['bbsr', 'ctc'], ['puri', 'bbsr'], ['bbsr', 'kol'], ['bbsr', 'sbp'], ['bbsr', 'bam'], ['bbsr', 'vizag'], ['bbsr', 'bls'], ['ctc', 'puri']];

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function seed({ silent = false, withImages = true } = {}) {
  const log = (...a) => !silent && console.log(...a);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(M).map((Model) => Model.syncIndexes().catch(() => {})));

  // Images
  const imgDir = path.join(config.uploads.dir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const assets = path.join(__dirname, 'assets');
  if (withImages) {
    fs.readdirSync(assets).forEach((f) => fs.copyFileSync(path.join(assets, f), path.join(imgDir, `seed-${f}`)));
  }
  const imagesFor = (key) => [`/uploads/images/seed-bus-${key}-1.svg`, `/uploads/images/seed-bus-${key}-2.svg`];

  // Admins
  await M.AdminUser.create([
    { name: 'Super Admin', email: 'admin@busyatra.in', password: 'Admin@123', role: 'super_admin' },
    { name: 'Content Moderator', email: 'moderator@busyatra.in', password: 'Moderator@123', role: 'moderator' },
  ]);

  // Plans & categories
  const plans = Object.fromEntries((await M.SubscriptionPlan.create(PLANS)).map((p) => [p.code, p]));
  const cats = Object.fromEntries((await M.RouteCategory.create([{ name: 'Intercity' }, { name: 'Interstate' }, { name: 'Pilgrimage' }, { name: 'Express' }])).map((c) => [c.name, c]));

  // Cities & stops
  const city = {};
  const stops = {};
  for (const [key, c] of Object.entries(CITIES)) {
    city[key] = await M.City.create({ name: c.name, slug: slugify(c.name), state: c.state, isPopularDestination: !!c.popular, description: c.description, ...(CITY_PHOTOS[c.name] || {}) });
    stops[key] = await M.Stop.create(c.stops.map((s, i) => ({ name: s, city: city[key]._id, isMajor: i === 0 })));
  }
  await M.PopularRoute.create(POPULAR.map(([f, t], i) => ({ fromCity: city[f]._id, toCity: city[t]._id, sortOrder: i, category: ['kol', 'vizag'].includes(t) ? cats.Interstate._id : f === 'puri' || t === 'puri' ? cats.Pilgrimage._id : cats.Intercity._id })));

  // Owners
  const owners = {};
  for (const o of OWNERS) {
    const user = await M.User.create({ name: o.ownerName, email: o.email, mobile: o.mobile, password: o.password, role: 'owner', isMobileVerified: true });
    const owner = await M.BusOwner.create({
      user: user._id,
      ownerName: o.ownerName,
      companyName: o.companyName,
      email: o.email,
      mobile: o.mobile,
      about: o.about,
      businessAddress: { line1: 'Plot 12, Main Road', city: o.city, state: 'Odisha', pincode: '751001' },
      verificationStatus: o.status,
      rejectionReason: o.rejectionReason,
      verifiedAt: o.status === 'approved' ? addDays(new Date(), -120) : undefined,
      documents: [{ docType: 'business_registration', fileName: 'sample.pdf', originalName: 'registration-certificate.pdf', mimeType: 'application/pdf', verified: o.status === 'approved' }],
    });
    owner.slug = `${slugify(owner.companyName)}-${String(owner._id).slice(-4)}`;
    await owner.save();
    await M.BusOwner.collection.updateOne({ _id: owner._id }, { $set: { createdAt: o.key === 'E' || o.key === 'F' ? addDays(new Date(), -2) : addDays(new Date(), -Math.floor(Math.random() * 150) - 30) } });
    owners[o.key] = owner;
  }
  // placeholder document so the admin "view document" link works
  const docsDir = path.join(config.uploads.dir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'sample.pdf'), '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 55>>stream\nBT /F1 14 Tf 30 70 Td (Sample registration document) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

  // Buses, routes, subscriptions, payments, statuses
  const now = new Date();
  const today = dateKey(now);
  const createdBuses = [];
  let receipt = 1;
  for (const b of BUSES) {
    const owner = owners[b.owner];
    const verified = owner.verificationStatus === 'approved';
    const bus = new M.Bus({
      owner: owner._id,
      name: b.name,
      registrationNumber: b.reg,
      busTypes: b.types,
      seatingCapacity: b.capacity,
      facilities: b.facilities,
      images: BUS_PHOTOS[b.reg] || imagesFor(b.img),
      contactNumber: b.contact,
      alternateNumber: b.alt,
      whatsappNumber: b.contact,
      ticketPrice: b.price,
      description: `${b.name} is operated by ${owner.companyName}. ${b.types.join(' ')} coach with ${b.capacity} seats.`,
      ownerVerified: verified,
      approval: { status: b.draft ? 'draft' : b.pendingApproval ? 'pending' : 'approved', submittedAt: addDays(now, -30), reviewedAt: b.draft || b.pendingApproval ? undefined : addDays(now, -29) },
      viewCount: b.draft ? 0 : 40 + Math.floor(Math.random() * 400),
    });
    bus.slug = `${slugify(bus.name)}-${String(bus._id).slice(-6)}`;
    if (b.suspended) bus.suspension = { active: true, from: dateKey(addDays(now, -1)), until: dateKey(addDays(now, b.suspended.untilDays)), reason: b.suspended.reason };

    for (const r of b.routes) {
      await M.Route.create({
        bus: bus._id,
        owner: owner._id,
        name: r.name,
        category: r.stops.some((s) => ['kol', 'vizag'].includes(s[0])) ? cats.Interstate._id : r.stops.some((s) => s[0] === 'puri') ? cats.Pilgrimage._id : cats.Intercity._id,
        operatingDays: ALL_DAYS,
        stops: r.stops.map(([ck, si, arr, dep, dist, fare, day], i) => ({
          stop: stops[ck][si]._id,
          city: city[ck]._id,
          cityName: city[ck].name,
          stopName: stops[ck][si].name,
          sequence: i + 1,
          arrivalTime: arr || undefined,
          departureTime: dep || undefined,
          distanceKm: dist,
          fareFromOrigin: fare,
          dayOffset: day || 0,
        })),
      });
    }

    if (b.plan && !b.draft) {
      const plan = plans[b.plan];
      let start;
      let end;
      let status;
      if (b.expired) {
        end = addDays(now, -5);
        start = addDays(end, -plan.durationDays);
        status = 'expired';
      } else if (b.pendingApproval) {
        status = 'pending_approval';
      } else {
        end = addDays(now, b.daysLeft);
        start = addDays(end, -plan.durationDays);
        status = 'active';
      }
      const sub = await M.Subscription.create({ owner: owner._id, bus: bus._id, plan: plan._id, planSnapshot: { name: plan.name, durationDays: plan.durationDays, price: plan.price }, status, startDate: start, endDate: end });
      const paidAt = start || addDays(now, -1);
      const pay = await M.Payment.create({
        owner: owner._id,
        bus: bus._id,
        subscription: sub._id,
        plan: plan._id,
        amount: plan.price,
        status: 'paid',
        gateway: 'mock',
        razorpayOrderId: `order_seed_${receipt}`,
        razorpayPaymentId: `pay_seed_${receipt}`,
        receiptNumber: `BY-SEED-${String(receipt).padStart(5, '0')}`,
        paidAt,
      });
      receipt += 1;
      sub.payment = pay._id;
      await sub.save();
      if (status === 'active') bus.subscriptionExpiresAt = end;
      if (b.expired) bus.subscriptionExpiresAt = end;
    }
    await bus.save();
    createdBuses.push({ bus, def: b });

    // Status history (last 14 days) + today
    if (!b.draft && !b.pendingApproval) {
      for (let d = 14; d >= 1; d -= 1) {
        const key = dateKey(addDays(now, -d));
        const roll = Math.random();
        const status = roll < 0.8 ? 'running' : roll < 0.9 ? 'delayed' : 'not_running';
        if (Math.random() < 0.1) continue; // some days not updated
        await M.DailyBusStatus.create({
          bus: bus._id,
          owner: owner._id,
          date: key,
          status,
          reason: status === 'not_running' ? rand(['maintenance', 'driver_unavailable', 'mechanical_problem']) : status === 'delayed' ? 'operational_issue' : undefined,
          delayMinutes: status === 'delayed' ? rand([15, 20, 30, 45]) : undefined,
          updatedByName: owner.ownerName,
          history: [{ status, updatedByName: owner.ownerName, at: addDays(now, -d) }],
        });
      }
      if (b.today) {
        await M.DailyBusStatus.create({ bus: bus._id, owner: owner._id, date: today, ...b.today, updatedByName: owner.ownerName, history: [{ ...b.today, updatedByName: owner.ownerName }] });
      }
    }
  }

  // Older payments for revenue reports (renewals over the past year)
  for (let m = 1; m <= 10; m += 1) {
    const count = 2 + Math.floor(Math.random() * 4);
    for (let k = 0; k < count; k += 1) {
      const { bus } = rand(createdBuses.filter((x) => !x.def.draft));
      const plan = rand(Object.values(plans));
      const paidAt = addDays(now, -(m * 30 + Math.floor(Math.random() * 25)));
      const sub = await M.Subscription.create({ owner: bus.owner, bus: bus._id, plan: plan._id, planSnapshot: { name: plan.name, durationDays: plan.durationDays, price: plan.price }, status: 'expired', isRenewal: Math.random() < 0.5, startDate: paidAt, endDate: addDays(paidAt, plan.durationDays) });
      const pay = await M.Payment.create({ owner: bus.owner, bus: bus._id, subscription: sub._id, plan: plan._id, amount: plan.price, status: 'paid', gateway: 'mock', razorpayOrderId: `order_seed_${receipt}`, razorpayPaymentId: `pay_seed_${receipt}`, receiptNumber: `BY-SEED-${String(receipt).padStart(5, '0')}`, paidAt });
      receipt += 1;
      sub.payment = pay._id;
      await sub.save();
      await M.Subscription.collection.updateOne({ _id: sub._id }, { $set: { createdAt: paidAt } });
    }
  }
  // One failed payment for the admin "failed payments" view
  {
    const { bus } = createdBuses.find((x) => x.def.reg === 'OD05BB2222');
    const plan = plans.LIST30;
    const sub = await M.Subscription.create({ owner: bus.owner, bus: bus._id, plan: plan._id, planSnapshot: { name: plan.name, durationDays: 30, price: plan.price }, status: 'pending_payment' });
    await M.Payment.create({ owner: bus.owner, bus: bus._id, subscription: sub._id, plan: plan._id, amount: plan.price, status: 'failed', gateway: 'mock', razorpayOrderId: 'order_seed_failed', failureReason: 'Card declined by bank' });
  }

  // Team member for Maa Tarini Travels
  const staffUser = await M.User.create({ name: 'Ravi Kumar', email: 'staff@demo.in', mobile: '9876500010', password: 'Staff@123', role: 'staff', isMobileVerified: true });
  await M.TeamMember.create({
    owner: owners.A._id,
    user: staffUser._id,
    role: 'status_updater',
    permissions: { updateStatus: true },
    assignedBuses: createdBuses.filter((x) => x.def.owner === 'A' && !x.def.draft && !x.def.expired).map((x) => x.bus._id),
  });
  await M.User.create({ name: 'Demo Passenger', email: 'passenger@demo.in', mobile: '9876500020', password: 'Pass@123', role: 'passenger', isMobileVerified: true });

  // Enquiries & clicks
  const publicBuses = createdBuses.filter((x) => !x.def.draft && !x.def.pendingApproval && !x.def.expired).map((x) => x.bus);
  const names = ['Amit', 'Priya', 'Sanjay', 'Lipsa', 'Deepak', 'Sneha', 'Rohit', 'Itishree', 'Manoj', 'Sasmita'];
  const msgs = ['Is there a seat available tomorrow morning?', 'Can I carry a bicycle?', 'Do you stop at Rasulgarh?', 'Is this bus running on Sunday?', 'What is the fare for a child?', 'Do you have a ladies seat reserved?'];
  for (let i = 0; i < 120; i += 1) {
    const bus = rand(publicBuses);
    const type = rand(['call_click', 'call_click', 'call_click', 'whatsapp_click', 'whatsapp_click', 'enquiry']);
    const e = await M.Enquiry.create({
      type,
      bus: bus._id,
      owner: bus.owner,
      ...(type === 'enquiry' ? { name: rand(names), mobile: `98${Math.floor(10000000 + Math.random() * 89999999)}`, message: rand(msgs), status: rand(['new', 'new', 'responded']) } : {}),
    });
    if (type !== 'enquiry') await M.Bus.updateOne({ _id: bus._id }, { $inc: { [type === 'call_click' ? 'callClicks' : 'whatsappClicks']: 1 } });
    await M.Enquiry.collection.updateOne({ _id: e._id }, { $set: { createdAt: addDays(now, -Math.floor(Math.random() * 30)) } });
  }
  await M.Enquiry.create({ type: 'contact', name: 'Laxmi Prasad', email: 'laxmi@example.com', subject: 'Listing my 3 buses', message: 'I run 3 buses from Angul. How do I list them?' });

  for (let i = 0; i < 240; i += 1) {
    const [f, t] = Math.random() < 0.85 ? rand(POPULAR) : [rand(Object.keys(CITIES)), rand(Object.keys(CITIES))];
    if (f === t) continue;
    const s = await M.SearchLog.create({ from: city[f]._id, to: city[t]._id, fromName: city[f].name, toName: city[t].name, travelDate: today, resultCount: Math.random() < 0.9 ? 1 + Math.floor(Math.random() * 4) : 0 });
    await M.SearchLog.collection.updateOne({ _id: s._id }, { $set: { createdAt: addDays(now, -Math.floor(Math.random() * 30)) } });
  }

  // Notifications
  await M.Notification.create([
    { owner: owners.A._id, type: 'subscription_expiring', title: 'Listing expiring soon: Tarini Shuttle', message: 'Renew now to stay visible.', link: '/owner/subscriptions' },
    { owner: owners.A._id, type: 'subscription_expired', title: 'Listing expired: Tarini Konark Special', message: 'This bus is no longer visible to passengers.', link: '/owner/subscriptions' },
    { audience: 'admin', type: 'new_owner', title: 'New operator registered: Sai Baba Travels', message: 'Rakesh Nayak · 9876500005', link: `/admin/owners/${owners.E._id}` },
    { audience: 'admin', type: 'listing_submitted', title: 'Listing awaiting approval: Comfort Lines Baripada', message: 'Payment received; review the listing.', link: '/admin/listings?approval=pending' },
  ]);

  log('Seed complete:');
  log(`  ${Object.keys(CITIES).length} cities, ${createdBuses.length} buses, ${OWNERS.length} operators`);
  log('  Admin       admin@busyatra.in / Admin@123');
  log('  Owner       owner@demo.in / Owner@123   (Maa Tarini Travels)');
  log('  Staff       staff@demo.in / Staff@123   (status updates only)');
  log('  Pending     saibaba@demo.in / Owner@123 (awaiting verification)');
  return { owners, city, plans };
}

module.exports = { seed };

if (require.main === module) {
  connectDB()
    .then(() => seed())
    .then(() => mongoose.disconnect())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
