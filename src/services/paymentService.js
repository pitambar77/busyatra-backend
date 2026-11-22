const crypto = require('crypto');
const Razorpay = require('razorpay');
const config = require('../config');
const { Payment, Subscription, Bus } = require('../models');
const { ApiError } = require('../utils/helpers');
const { onSubscriptionPaid, refreshBusExpiry } = require('./listingService');
const { notifyOwner, notifyAdmin } = require('./notificationService');

let client = null;
function razorpay() {
  if (config.razorpay.mode !== 'live') return null;
  if (!client) client = new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret });
  return client;
}

async function createOrder({ amount, receipt, notes }) {
  const rp = razorpay();
  if (!rp) {
    return { id: `order_mock_${crypto.randomBytes(7).toString('hex')}`, amount: Math.round(amount * 100), currency: 'INR', mock: true };
  }
  return rp.orders.create({ amount: Math.round(amount * 100), currency: 'INR', receipt, notes });
}

function expectedSignature(orderId, paymentId) {
  return crypto.createHmac('sha256', config.razorpay.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
}

function verifySignature(orderId, paymentId, signature) {
  if (!signature || !config.razorpay.keySecret) return false;
  const expected = expectedSignature(orderId, paymentId);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyWebhook(rawBody, signature) {
  if (!config.razorpay.webhookSecret || !signature) return false;
  const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function nextReceiptNumber() {
  const d = new Date();
  const prefix = `BY-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}-`;
  const count = await Payment.countDocuments({ receiptNumber: { $regex: `^${prefix}` } });
  return `${prefix}${String(count + 1).padStart(5, '0')}`;
}

/** Idempotently mark a payment as paid and move its subscription forward. */
async function markPaid(payment, { razorpayPaymentId, razorpaySignature } = {}) {
  if (payment.status === 'paid') return payment;
  payment.status = 'paid';
  payment.paidAt = new Date();
  if (razorpayPaymentId) payment.razorpayPaymentId = razorpayPaymentId;
  if (razorpaySignature) payment.razorpaySignature = razorpaySignature;
  payment.receiptNumber = await nextReceiptNumber();
  await payment.save();

  const sub = await Subscription.findById(payment.subscription);
  await onSubscriptionPaid(sub);
  const bus = await Bus.findById(payment.bus).select('name');
  await notifyOwner(
    payment.owner,
    'payment_success',
    `Payment received — ₹${payment.amount}`,
    sub.status === 'active'
      ? `${bus.name}: listing active until ${sub.endDate.toDateString()}.`
      : `${bus.name}: your listing is now waiting for admin approval.`,
    '/owner/subscriptions'
  );
  if (sub.status === 'pending_approval') {
    await notifyAdmin('listing_submitted', `Listing awaiting approval: ${bus.name}`, 'Payment received; review the listing.', `/admin/listings?approval=pending`);
  }
  return payment;
}

async function markFailed(payment, reason) {
  if (payment.status === 'paid') return payment;
  payment.status = 'failed';
  payment.failureReason = reason || 'Payment failed';
  await payment.save();
  await notifyOwner(payment.owner, 'payment_failed', 'Payment failed', `${payment.failureReason}. You can retry from Subscriptions.`, '/owner/subscriptions');
  return payment;
}

async function refund(payment, { amount, reason }) {
  if (payment.status !== 'paid') throw new ApiError(400, 'Only paid payments can be refunded');
  const value = amount ? Math.min(Number(amount), payment.amount) : payment.amount;
  const rp = razorpay();
  if (rp && payment.gateway === 'razorpay' && payment.razorpayPaymentId) {
    const r = await rp.payments.refund(payment.razorpayPaymentId, { amount: Math.round(value * 100), notes: { reason } });
    payment.refundId = r.id;
  } else {
    payment.refundId = `rfnd_manual_${crypto.randomBytes(6).toString('hex')}`;
  }
  payment.status = 'refunded';
  payment.refundedAmount = value;
  payment.refundReason = reason;
  await payment.save();

  // A full refund ends the listing period it paid for.
  if (value >= payment.amount) {
    const sub = await Subscription.findById(payment.subscription);
    if (sub && ['active', 'pending_approval'].includes(sub.status)) {
      sub.status = 'refunded';
      await sub.save();
      await refreshBusExpiry(sub.bus);
    }
  }
  await notifyOwner(payment.owner, 'payment_refunded', `Refund processed — ₹${value}`, reason || '', '/owner/payments');
  return payment;
}

module.exports = { createOrder, verifySignature, verifyWebhook, expectedSignature, markPaid, markFailed, refund };
