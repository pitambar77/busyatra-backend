const mongoose = require('mongoose');

const BUS_TYPES = ['AC', 'Non-AC', 'Sleeper', 'Seater', 'Luxury'];
const FACILITIES = [
  'WiFi',
  'Charging Point',
  'Water Bottle',
  'Blanket',
  'Reading Light',
  'CCTV',
  'GPS Tracking',
  'Emergency Exit',
  'First Aid',
  'TV / Entertainment',
  'Pushback Seats',
  'Washroom',
  'Luggage Space',
  'Fire Extinguisher',
];

const busSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'BusOwner', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, index: true },
    registrationNumber: { type: String, required: true, uppercase: true, trim: true, unique: true },
    busTypes: { type: [{ type: String, enum: BUS_TYPES }], validate: (v) => v.length > 0 },
    seatingCapacity: { type: Number, min: 1, max: 100 },
    facilities: [{ type: String, enum: FACILITIES }],
    images: [String],
    contactNumber: { type: String, required: true },
    alternateNumber: String,
    whatsappNumber: String,
    ticketPrice: { type: Number, required: true, min: 0 }, // base fare for the full route
    description: { type: String, maxlength: 2000 },

    // Listing lifecycle
    approval: {
      status: { type: String, enum: ['draft', 'pending', 'approved', 'rejected'], default: 'draft', index: true },
      reason: String,
      reviewedAt: Date,
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
      submittedAt: Date,
    },
    isActive: { type: Boolean, default: true }, // owner can deactivate
    adminDisabled: { type: Boolean, default: false }, // admin can force-hide (e.g. fake listing)
    adminDisabledReason: String,
    subscriptionExpiresAt: { type: Date, index: true }, // denormalised from active Subscription
    ownerVerified: { type: Boolean, default: false, index: true }, // denormalised from BusOwner

    // Temporary suspension spanning multiple days (owner or admin)
    suspension: {
      active: { type: Boolean, default: false },
      from: String, // YYYY-MM-DD
      until: String, // YYYY-MM-DD (inclusive) — empty means until lifted
      reason: String,
    },

    // Analytics counters
    viewCount: { type: Number, default: 0 },
    callClicks: { type: Number, default: 0 },
    whatsappClicks: { type: Number, default: 0 },

    deletedAt: Date,
  },
  { timestamps: true }
);

/** Filter for listings that may appear on the public website. */
busSchema.statics.publicFilter = function publicFilter(now = new Date()) {
  return {
    'approval.status': 'approved',
    isActive: true,
    adminDisabled: false,
    ownerVerified: true,
    deletedAt: null,
    subscriptionExpiresAt: { $gt: now },
  };
};

busSchema.methods.listingState = function listingState(now = new Date()) {
  if (this.deletedAt) return 'deleted';
  if (this.adminDisabled) return 'disabled';
  if (!this.isActive) return 'inactive';
  if (this.approval.status === 'rejected') return 'rejected';
  if (this.approval.status === 'pending') return 'pending';
  if (this.approval.status === 'draft') return 'draft';
  if (!this.subscriptionExpiresAt || this.subscriptionExpiresAt <= now) return 'expired';
  return 'active';
};

busSchema.statics.BUS_TYPES = BUS_TYPES;
busSchema.statics.FACILITIES = FACILITIES;

module.exports = mongoose.model('Bus', busSchema);
