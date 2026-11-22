/* End-to-end API test of the core business rules.
 * Needs a MongoDB-compatible server. Uses TEST_MONGODB_URI or mongodb://127.0.0.1:27017/busyatra_test (wiped).
 *   npm test
 */
process.env.NODE_ENV = 'test';
process.env.OTP_EXPOSE_IN_RESPONSE = 'true';
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connectDB } = require('../src/config/db');
const app = require('../src/app');
const { seed } = require('../src/seed/seed');
const { runExpiryJob } = require('../src/services/listingService');
const { Bus, Subscription } = require('../src/models');
const { dateKey, addDays } = require('../src/utils/helpers');

let server;
let base;
const ctx = {};

async function call(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}/api${path}`, { method, headers, body: payload });
  const json = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  return { status: res.status, json, res };
}

before(async () => {
  await connectDB(process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/busyatra_test');
  await seed({ silent: true });
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test('admin login', async () => {
  const r = await call('POST', '/admin/auth/login', { body: { email: 'admin@busyatra.in', password: 'Admin@123' } });
  assert.equal(r.status, 200);
  ctx.admin = r.json.data.token;
  const bad = await call('POST', '/admin/auth/login', { body: { email: 'admin@busyatra.in', password: 'nope' } });
  assert.equal(bad.status, 401);
});

test('owner registers with documents and verifies OTP', async () => {
  const form = new FormData();
  Object.entries({ ownerName: 'Test Owner', companyName: 'Test Travels', email: 'test@owner.in', mobile: '9000000001', password: 'secret12', addressLine1: 'Road 1', city: 'Puri', state: 'Odisha', docTypes: 'id_proof' }).forEach(([k, v]) => form.append(k, v));
  form.append('documents', new Blob(['%PDF-1.1 test'], { type: 'application/pdf' }), 'id.pdf');
  const r = await call('POST', '/auth/register-owner', { form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.match(r.json.data.devOtp, /^\d{6}$/);

  const login = await call('POST', '/auth/login', { body: { identifier: 'test@owner.in', password: 'secret12' } });
  assert.equal(login.status, 403);
  assert.equal(login.json.code, 'OTP_REQUIRED');

  const wrong = await call('POST', '/auth/verify-otp', { body: { mobile: '9000000001', otp: '000000' } });
  assert.equal(wrong.status, 400);
  const ok = await call('POST', '/auth/verify-otp', { body: { mobile: '9000000001', otp: login.json.data.devOtp } });
  assert.equal(ok.status, 200);
  ctx.owner = ok.json.data.token;
  ctx.ownerId = ok.json.data.owner._id;
  assert.equal(ok.json.data.owner.verificationStatus, 'pending');
  assert.equal(ok.json.data.owner.documents.length, 1);
});

test('duplicate registration is rejected', async () => {
  const r = await call('POST', '/auth/register', { body: { name: 'Xavier', email: 'test@owner.in', mobile: '9000000099', password: 'secret12' } });
  assert.equal(r.status, 409);
});

test('owner creates a bus and a route; validation rules hold', async () => {
  const lookups = await call('GET', '/owner/lookups', { token: ctx.owner });
  const city = (n) => lookups.json.data.cities.find((c) => c.name === n)._id;
  ctx.cities = { puri: city('Puri'), bbsr: city('Bhubaneswar'), ctc: city('Cuttack'), konark: city('Konark') };

  const badReg = new FormData();
  Object.entries({ name: 'Bad', registrationNumber: 'XYZ', contactNumber: '9437012345', ticketPrice: '100', busTypes: 'AC,Seater' }).forEach(([k, v]) => badReg.append(k, v));
  assert.equal((await call('POST', '/owner/buses', { token: ctx.owner, form: badReg })).status, 400);

  const form = new FormData();
  Object.entries({ name: 'Test Coastal', registrationNumber: 'OD 33 TT 4321', contactNumber: '9437012345', ticketPrice: '120', busTypes: 'AC,Seater', facilities: 'WiFi,CCTV', seatingCapacity: '40' }).forEach(([k, v]) => form.append(k, v));
  form.append('images', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'bus.png');
  const r = await call('POST', '/owner/buses', { token: ctx.owner, form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.data.registrationNumber, 'OD33TT4321');
  assert.equal(r.json.data.listingState, 'draft');
  assert.equal(r.json.data.images.length, 1);
  ctx.busId = r.json.data._id;

  // Times going backwards are rejected
  const backwards = await call('POST', '/owner/routes', {
    token: ctx.owner,
    body: { bus: ctx.busId, stops: [{ city: ctx.cities.puri, departureTime: '10:00' }, { city: ctx.cities.ctc, arrivalTime: '09:00' }] },
  });
  assert.equal(backwards.status, 400);

  const route = await call('POST', '/owner/routes', {
    token: ctx.owner,
    body: {
      bus: ctx.busId,
      name: 'Test run',
      stops: [
        { city: ctx.cities.puri, departureTime: '06:00', fareFromOrigin: 0 },
        { city: ctx.cities.bbsr, arrivalTime: '07:15', departureTime: '07:25', fareFromOrigin: 80 },
        { city: ctx.cities.ctc, arrivalTime: '08:20', fareFromOrigin: 120 },
      ],
    },
  });
  assert.equal(route.status, 201, JSON.stringify(route.json));
  ctx.routeId = route.json.data._id;
  assert.equal(route.json.data.stops[1].haltMinutes, 10);

  // Reorder / edit stops via PUT (insert Konark between Puri and Bhubaneswar)
  const upd = await call('PUT', `/owner/routes/${ctx.routeId}`, {
    token: ctx.owner,
    body: {
      stops: [
        { city: ctx.cities.puri, departureTime: '06:00', fareFromOrigin: 0 },
        { city: ctx.cities.konark, arrivalTime: '06:45', departureTime: '06:50', fareFromOrigin: 40 },
        { city: ctx.cities.bbsr, arrivalTime: '08:00', departureTime: '08:10', fareFromOrigin: 90 },
        { city: ctx.cities.ctc, arrivalTime: '09:00', fareFromOrigin: 130 },
      ],
    },
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.data.stops.length, 4);
  assert.equal(upd.json.data.arrivalTime, '09:00');
});

test('unverified owner cannot submit; payment moves listing to pending approval', async () => {
  const submit = await call('POST', `/owner/buses/${ctx.busId}/submit`, { token: ctx.owner });
  assert.equal(submit.status, 400);

  const plans = await call('GET', '/owner/plans', { token: ctx.owner });
  assert.equal(plans.json.meta.paymentMode, 'mock');
  const plan30 = plans.json.data.find((p) => p.durationDays === 30);
  const co = await call('POST', '/owner/subscriptions/checkout', { token: ctx.owner, body: { busId: ctx.busId, planId: plan30._id } });
  assert.equal(co.status, 201, JSON.stringify(co.json));

  const fail = await call('POST', `/owner/payments/${co.json.data.paymentId}/mock-complete`, { token: ctx.owner, body: { outcome: 'failure' } });
  assert.equal(fail.status, 400);

  const co2 = await call('POST', '/owner/subscriptions/checkout', { token: ctx.owner, body: { busId: ctx.busId, planId: plan30._id } });
  const paid = await call('POST', `/owner/payments/${co2.json.data.paymentId}/mock-complete`, { token: ctx.owner, body: { outcome: 'success' } });
  assert.equal(paid.status, 200);
  assert.equal(paid.json.data.subscription.status, 'pending_approval');
  ctx.paymentId = co2.json.data.paymentId;

  const receipt = await call('GET', `/owner/payments/${ctx.paymentId}/receipt`, { token: ctx.owner });
  assert.equal(receipt.status, 200);
  assert.equal(receipt.res.headers.get('content-type'), 'application/pdf');

  const bus = await call('GET', `/owner/buses/${ctx.busId}`, { token: ctx.owner });
  assert.equal(bus.json.data.listingState, 'pending');
});

test('listing is not public until owner and listing are approved', async () => {
  const before1 = await call('GET', `/public/buses/${ctx.busId}`);
  assert.equal(before1.status, 404);

  const early = await call('PATCH', `/admin/buses/${ctx.busId}/review`, { token: ctx.admin, body: { action: 'approve' } });
  assert.equal(early.status, 400, 'cannot approve listing of unverified owner');

  assert.equal((await call('PATCH', `/admin/owners/${ctx.ownerId}/verify`, { token: ctx.admin, body: { action: 'approve' } })).status, 200);
  const ok = await call('PATCH', `/admin/buses/${ctx.busId}/review`, { token: ctx.admin, body: { action: 'approve' } });
  assert.equal(ok.status, 200);
  const exp = new Date(ok.json.data.subscriptionExpiresAt);
  const days = Math.round((exp - Date.now()) / 86400000);
  assert.ok(days >= 29 && days <= 30, `subscription should run ~30 days, got ${days}`);

  const pub = await call('GET', `/public/buses/${ctx.busId}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.json.data.status.code, 'not_updated', 'no status submitted → Status Not Updated');
});

test('segment search finds the bus with segment fare', async () => {
  const r = await call('GET', '/public/search?from=konark&to=cuttack');
  const trip = r.json.data.items.find((t) => t.bus._id === ctx.busId);
  assert.ok(trip, 'bus should appear for an intermediate segment');
  assert.equal(trip.fare, 90);
  assert.equal(trip.from.time, '06:50');
  assert.equal(trip.durationMinutes, 130);
  assert.equal(trip.bus.registrationMasked, 'OD33••••21');

  const reverse = await call('GET', '/public/search?from=cuttack&to=konark');
  assert.ok(!reverse.json.data.items.find((t) => t.bus._id === ctx.busId), 'wrong direction must not match');
});

test('daily status: reasons required, date-specific, history kept', async () => {
  const noReason = await call('PUT', `/owner/status/${ctx.busId}`, { token: ctx.owner, body: { status: 'not_running' } });
  assert.equal(noReason.status, 400);
  const otherNoMsg = await call('PUT', `/owner/status/${ctx.busId}`, { token: ctx.owner, body: { status: 'cancelled', reason: 'other' } });
  assert.equal(otherNoMsg.status, 400);
  const past = await call('PUT', `/owner/status/${ctx.busId}`, { token: ctx.owner, body: { status: 'running', date: dateKey(addDays(new Date(), -1)) } });
  assert.equal(past.status, 400);

  await call('PUT', `/owner/status/${ctx.busId}`, { token: ctx.owner, body: { status: 'running' } });
  const r = await call('PUT', `/owner/status/${ctx.busId}`, { token: ctx.owner, body: { status: 'not_running', reason: 'weather_condition', message: 'Cyclone alert' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.record.history.length, 2);

  const pub = await call('GET', `/public/buses/${ctx.busId}`);
  assert.equal(pub.json.data.status.code, 'not_running');
  assert.match(pub.json.data.status.notice, /not operating today due to weather condition/i);
  assert.ok(pub.json.data.status.updatedAt);

  // Tomorrow has no status yet
  const tomorrow = dateKey(addDays(new Date(), 1));
  const pubTomorrow = await call('GET', `/public/buses/${ctx.busId}?date=${tomorrow}`);
  assert.equal(pubTomorrow.json.data.status.code, 'not_updated');

  const hist = await call('GET', `/owner/status/${ctx.busId}/history`, { token: ctx.owner });
  assert.equal(hist.json.data.records.length, 1);
});

test('temporary suspension overrides daily status', async () => {
  const r = await call('PUT', `/owner/buses/${ctx.busId}/suspension`, { token: ctx.owner, body: { active: true, until: dateKey(addDays(new Date(), 2)), reason: 'engine overhaul' } });
  assert.equal(r.status, 200);
  const pub = await call('GET', `/public/buses/${ctx.busId}`);
  assert.equal(pub.json.data.status.code, 'suspended');
  await call('PUT', `/owner/buses/${ctx.busId}/suspension`, { token: ctx.owner, body: { active: false } });
});

test('staff permissions are enforced', async () => {
  const add = await call('POST', '/owner/team', { token: ctx.owner, body: { name: 'Staffer', email: 'st@owner.in', mobile: '9000000002', password: 'secret12', role: 'status_updater' } });
  assert.equal(add.status, 201, JSON.stringify(add.json));
  const login = await call('POST', '/auth/login', { body: { identifier: '9000000002', password: 'secret12' } });
  assert.equal(login.status, 200);
  const staff = login.json.data.token;
  assert.equal((await call('PUT', `/owner/status/${ctx.busId}`, { token: staff, body: { status: 'running' } })).status, 200);
  assert.equal((await call('GET', '/owner/payments', { token: staff })).status, 403);
  assert.equal((await call('PUT', `/owner/buses/${ctx.busId}`, { token: staff, body: { name: 'Hack' } })).status, 403);
  assert.equal((await call('GET', '/owner/team', { token: staff })).status, 403);

  // Status entry records who made it
  const hist = await call('GET', `/owner/status/${ctx.busId}/history`, { token: ctx.owner });
  assert.equal(hist.json.data.records[0].updatedByName, 'Staffer');
});

test('owners cannot touch other owners\' buses', async () => {
  const other = await Bus.findOne({ registrationNumber: 'OD05AA1111' });
  assert.equal((await call('PUT', `/owner/status/${other._id}`, { token: ctx.owner, body: { status: 'running' } })).status, 404);
  assert.equal((await call('GET', '/admin/dashboard', { token: ctx.owner })).status, 403);
});

test('tracking calls and enquiries', async () => {
  assert.equal((await call('POST', '/public/track', { body: { busId: ctx.busId, type: 'call_click' } })).status, 200);
  assert.equal((await call('POST', '/public/enquiries', { body: { busId: ctx.busId, name: 'P', mobile: '9876543210', message: 'Seats?' } })).status, 201);
  const list = await call('GET', '/owner/enquiries', { token: ctx.owner });
  assert.equal(list.json.meta.total, 2);
});

test('expiry job hides expired listings; renewal stacks; admin extend works', async () => {
  // Pretend the subscription ended yesterday.
  await Subscription.updateMany({ bus: ctx.busId, status: 'active' }, { $set: { endDate: addDays(new Date(), -1) } });
  const r = await runExpiryJob(new Date());
  assert.ok(r.expired >= 1);
  assert.equal((await call('GET', `/public/buses/${ctx.busId}`)).status, 404);
  const ownerView = await call('GET', `/owner/buses/${ctx.busId}`, { token: ctx.owner });
  assert.equal(ownerView.json.data.listingState, 'expired');

  // Renew: approved listing activates immediately on payment
  const plans = await call('GET', '/owner/plans', { token: ctx.owner });
  const plan7 = plans.json.data.find((p) => p.durationDays === 7);
  const co = await call('POST', '/owner/subscriptions/checkout', { token: ctx.owner, body: { busId: ctx.busId, planId: plan7._id } });
  const paid = await call('POST', `/owner/payments/${co.json.data.paymentId}/mock-complete`, { token: ctx.owner, body: {} });
  assert.equal(paid.json.data.subscription.status, 'active');
  assert.equal((await call('GET', `/public/buses/${ctx.busId}`)).status, 200);

  // Second renewal stacks after the first
  const co2 = await call('POST', '/owner/subscriptions/checkout', { token: ctx.owner, body: { busId: ctx.busId, planId: plan7._id } });
  const paid2 = await call('POST', `/owner/payments/${co2.json.data.paymentId}/mock-complete`, { token: ctx.owner, body: {} });
  assert.equal(new Date(paid2.json.data.subscription.startDate).getTime(), new Date(paid.json.data.subscription.endDate).getTime());

  const ext = await call('PATCH', `/admin/subscriptions/${paid2.json.data.subscription._id}/extend`, { token: ctx.admin, body: { days: 5 } });
  assert.equal(ext.status, 200);
  const bus = await Bus.findById(ctx.busId);
  const days = Math.round((bus.subscriptionExpiresAt - Date.now()) / 86400000);
  assert.ok(days >= 18 && days <= 19, `7+7+5 days expected, got ${days}`);
});

test('admin can disable a fake listing and suspend an operator', async () => {
  await call('PATCH', `/admin/buses/${ctx.busId}/disable`, { token: ctx.admin, body: { disabled: true, reason: 'Fake listing' } });
  assert.equal((await call('GET', `/public/buses/${ctx.busId}`)).status, 404);
  await call('PATCH', `/admin/buses/${ctx.busId}/disable`, { token: ctx.admin, body: { disabled: false } });
  assert.equal((await call('GET', `/public/buses/${ctx.busId}`)).status, 200);

  await call('PATCH', `/admin/owners/${ctx.ownerId}/suspend`, { token: ctx.admin, body: { suspend: true, reason: 'Complaints' } });
  assert.equal((await call('GET', `/public/buses/${ctx.busId}`)).status, 404);
  assert.equal((await call('GET', '/owner/dashboard', { token: ctx.owner })).status, 403);
  await call('PATCH', `/admin/owners/${ctx.ownerId}/suspend`, { token: ctx.admin, body: { suspend: false } });
  assert.equal((await call('GET', `/public/buses/${ctx.busId}`)).status, 200);
});

test('refund ends the paid period', async () => {
  const pays = await call('GET', '/admin/payments?status=paid&limit=100', { token: ctx.admin });
  assert.ok(pays.json.meta.total > 0);
  const r = await call('POST', `/admin/payments/${ctx.paymentId}/refund`, { token: ctx.admin, body: { reason: 'Duplicate' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.status, 'refunded');
});

test('razorpay signature verification', () => {
  process.env.RAZORPAY_KEY_SECRET = 'test_secret';
  const config = require('../src/config');
  config.razorpay.keySecret = 'test_secret';
  const { verifySignature, expectedSignature } = require('../src/services/paymentService');
  const sig = expectedSignature('order_1', 'pay_1');
  assert.ok(verifySignature('order_1', 'pay_1', sig));
  assert.ok(!verifySignature('order_1', 'pay_2', sig));
  config.razorpay.keySecret = '';
});

test('admin dashboard and reports respond', async () => {
  const d = await call('GET', '/admin/dashboard', { token: ctx.admin });
  assert.equal(d.status, 200);
  assert.ok(d.json.data.stats.totalRevenue > 0);
  const rep = await call('GET', '/admin/reports?days=30', { token: ctx.admin });
  assert.equal(rep.status, 200);
  assert.equal(rep.json.data.dailyRegistrations.length, 30);
  assert.equal(rep.json.data.monthlyRevenue.length, 12);
  assert.ok(rep.json.data.mostSearchedRoutes.length > 0);
  const mod = await call('POST', '/admin/auth/login', { body: { email: 'moderator@busyatra.in', password: 'Moderator@123' } });
  assert.equal((await call('POST', '/admin/plans', { token: mod.json.data.token, body: { name: 'X', code: 'X', durationDays: 1, price: 1 } })).status, 403);
});

test('homepage banner: defaults, admin edits, validation and order', async () => {
  const home = await call('GET', '/public/home');
  assert.equal(home.status, 200);
  assert.ok(home.json.data.hero.slides.length >= 1, 'default slides are created on first load');
  assert.equal(home.json.data.hero.settings.autoplay, true);

  const created = await call('POST', '/admin/hero/slides', { token: ctx.admin, body: { image: 'https://example.com/bus.jpg', heading: 'Ride {daily|#38BDF8} with {us}', primaryCta: { label: 'Go', href: '/routes' } } });
  assert.equal(created.status, 201);
  const id = created.json.data._id;

  assert.equal((await call('POST', '/admin/hero/slides', { token: ctx.admin, body: { image: 'https://x.com/a.jpg', heading: 'Broken {colour' } })).status, 400);
  assert.equal((await call('PUT', `/admin/hero/slides/${id}`, { token: ctx.admin, body: { primaryCta: { label: 'x', href: 'javascript:alert(1)' } } })).status, 400);
  assert.equal((await call('PUT', `/admin/hero/slides/${id}`, { token: ctx.admin, body: { highlightColor: 'orange' } })).status, 400);

  const hidden = await call('PUT', `/admin/hero/slides/${id}`, { token: ctx.admin, body: { isActive: false } });
  assert.equal(hidden.json.data.isActive, false);
  const pub = await call('GET', '/public/home');
  assert.ok(!pub.json.data.hero.slides.some((s) => s._id === id), 'hidden slides are not public');

  const all = await call('GET', '/admin/hero', { token: ctx.admin });
  const ids = all.json.data.slides.map((s) => s._id).reverse();
  assert.equal((await call('PUT', '/admin/hero/slides/order', { token: ctx.admin, body: { ids } })).status, 200);
  const after = await call('GET', '/admin/hero', { token: ctx.admin });
  assert.deepEqual(after.json.data.slides.map((s) => s._id), ids);

  assert.equal((await call('PUT', '/admin/hero/settings', { token: ctx.admin, body: { intervalSeconds: 1 } })).status, 400);
  const saved = await call('PUT', '/admin/hero/settings', { token: ctx.admin, body: { intervalSeconds: 9, transition: 'slide' } });
  assert.equal(saved.json.data.intervalSeconds, 9);

  const mod = await call('POST', '/admin/auth/login', { body: { email: 'moderator@busyatra.in', password: 'Moderator@123' } });
  assert.equal((await call('DELETE', `/admin/hero/slides/${id}`, { token: mod.json.data.token })).status, 403);
  assert.equal((await call('DELETE', `/admin/hero/slides/${id}`, { token: ctx.admin })).status, 200);
});
