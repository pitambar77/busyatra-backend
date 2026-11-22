const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    // Either an owner (all their team sees it) or the admin audience.
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'BusOwner', index: true },
    audience: { type: String, enum: ['owner', 'admin'], default: 'owner', index: true },
    type: {
      type: String,
      enum: [
        'owner_approved',
        'owner_rejected',
        'owner_suspended',
        'listing_approved',
        'listing_rejected',
        'listing_disabled',
        'payment_success',
        'payment_failed',
        'payment_refunded',
        'subscription_expiring',
        'subscription_expired',
        'subscription_extended',
        'new_owner',
        'listing_submitted',
        'enquiry',
        'general',
      ],
      default: 'general',
    },
    title: { type: String, required: true },
    message: String,
    link: String,
    readAt: Date,
  },
  { timestamps: true }
);
notificationSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
