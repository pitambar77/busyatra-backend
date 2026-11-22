const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'BusOwner', required: true, index: true },
    bus: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus', required: true },
    subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', required: true },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan' },
    amount: { type: Number, required: true }, // INR
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: ['created', 'paid', 'failed', 'refunded', 'refund_pending'], default: 'created', index: true },
    gateway: { type: String, enum: ['razorpay', 'mock', 'manual'], default: 'razorpay' },
    razorpayOrderId: { type: String, index: true },
    razorpayPaymentId: String,
    razorpaySignature: String,
    refundId: String,
    refundedAmount: Number,
    refundReason: String,
    failureReason: String,
    receiptNumber: { type: String, unique: true, sparse: true },
    paidAt: Date,
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payment', paymentSchema);
