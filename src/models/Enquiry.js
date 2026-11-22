const mongoose = require('mongoose');

/**
 * Passenger interactions with a listing.
 * type: enquiry (form message) | call_click | whatsapp_click | contact (site contact form)
 */
const enquirySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['enquiry', 'call_click', 'whatsapp_click', 'contact'], required: true, index: true },
    bus: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus', index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'BusOwner', index: true },
    route: { type: mongoose.Schema.Types.ObjectId, ref: 'Route' },
    name: { type: String, trim: true, maxlength: 120 },
    mobile: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    subject: String,
    message: { type: String, maxlength: 2000 },
    travelDate: String,
    status: { type: String, enum: ['new', 'responded', 'closed'], default: 'new' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    meta: { ip: String, userAgent: String, page: String },
  },
  { timestamps: true }
);
enquirySchema.index({ createdAt: -1 });

/** Search log for "most searched routes". */
const searchLogSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'City' },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'City' },
    fromName: String,
    toName: String,
    travelDate: String,
    resultCount: Number,
  },
  { timestamps: true }
);
searchLogSchema.index({ createdAt: -1 });

module.exports = {
  Enquiry: mongoose.model('Enquiry', enquirySchema),
  SearchLog: mongoose.model('SearchLog', searchLogSchema),
};
