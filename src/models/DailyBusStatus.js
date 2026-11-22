const mongoose = require('mongoose');

const STATUSES = ['running', 'not_running', 'delayed', 'cancelled', 'suspended'];
const REASONS = ['mechanical_problem', 'weather_condition', 'driver_unavailable', 'maintenance', 'operational_issue', 'other'];

const historyEntrySchema = new mongoose.Schema(
  {
    status: { type: String, enum: STATUSES },
    reason: { type: String, enum: REASONS },
    message: String,
    delayMinutes: Number,
    updatedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'history.updatedByModel' },
    updatedByModel: { type: String, enum: ['User', 'AdminUser'], default: 'User' },
    updatedByName: String,
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * One document per bus per calendar date (platform timezone).
 * No document for today = "Status Not Updated" — we never assume a bus is running.
 * Every change within the day is appended to `history`, and earlier days are kept as-is.
 */
const dailyBusStatusSchema = new mongoose.Schema(
  {
    bus: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus', required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'BusOwner', required: true, index: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    status: { type: String, enum: STATUSES, required: true },
    reason: { type: String, enum: REASONS },
    message: { type: String, maxlength: 500 },
    delayMinutes: { type: Number, min: 0 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId },
    updatedByName: String,
    history: [historyEntrySchema],
  },
  { timestamps: true }
);

dailyBusStatusSchema.index({ bus: 1, date: 1 }, { unique: true });

dailyBusStatusSchema.statics.STATUSES = STATUSES;
dailyBusStatusSchema.statics.REASONS = REASONS;
dailyBusStatusSchema.statics.NEEDS_REASON = ['not_running', 'cancelled', 'suspended'];

module.exports = mongoose.model('DailyBusStatus', dailyBusStatusSchema);
