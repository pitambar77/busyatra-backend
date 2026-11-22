const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema(
  {
    docType: {
      type: String,
      enum: ['business_registration', 'gst_certificate', 'id_proof', 'permit', 'other'],
      default: 'other',
    },
    fileName: String,
    originalName: String,
    mimeType: String,
    uploadedAt: { type: Date, default: Date.now },
    verified: { type: Boolean, default: false },
  },
  { _id: true }
);

/** Business profile for a bus owner/operator. One per owner User. */
const busOwnerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    ownerName: { type: String, required: true, trim: true },
    companyName: { type: String, required: true, trim: true },
    slug: { type: String, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    mobile: { type: String, required: true, trim: true },
    businessAddress: {
      line1: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      pincode: { type: String, trim: true },
    },
    about: { type: String, maxlength: 1000 },
    logo: String,
    documents: [documentSchema],
    verificationStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    rejectionReason: String,
    verifiedAt: Date,
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
    isSuspended: { type: Boolean, default: false, index: true },
    suspensionReason: String,
  },
  { timestamps: true }
);

busOwnerSchema.virtual('isVerified').get(function isVerified() {
  return this.verificationStatus === 'approved' && !this.isSuspended;
});

busOwnerSchema.set('toJSON', { virtuals: true });
busOwnerSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('BusOwner', busOwnerSchema);
