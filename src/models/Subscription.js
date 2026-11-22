const mongoose = require('mongoose');

const subscriptionPlanSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, uppercase: true }, // e.g. LIST7
    durationDays: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 }, // INR, inclusive of tax
    description: String,
    features: [String],
    isPopular: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/**
 * A paid listing period for one bus.
 * pending_payment  → order created, not paid
 * pending_approval → paid, waiting for the bus listing to be approved (period starts on approval)
 * active           → running; bus.subscriptionExpiresAt mirrors endDate
 * expired / cancelled / refunded
 */
const subscriptionSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'BusOwner', required: true, index: true },
    bus: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus', required: true, index: true },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true },
    planSnapshot: { name: String, durationDays: Number, price: Number },
    status: {
      type: String,
      enum: ['pending_payment', 'pending_approval', 'active', 'expired', 'cancelled', 'refunded'],
      default: 'pending_payment',
      index: true,
    },
    startDate: Date,
    endDate: { type: Date, index: true },
    isRenewal: { type: Boolean, default: false },
    extendedDays: { type: Number, default: 0 },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    reminderSentAt: Date,
    expiredNotifiedAt: Date,
    notes: String,
  },
  { timestamps: true }
);

module.exports = {
  SubscriptionPlan: mongoose.model('SubscriptionPlan', subscriptionPlanSchema),
  Subscription: mongoose.model('Subscription', subscriptionSchema),
};
