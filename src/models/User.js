const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * Login identity for everyone except platform admins (who live in AdminUser).
 * role:
 *   passenger – public website user (optional account, for saved enquiries)
 *   owner     – bus owner; has a BusOwner profile
 *   staff     – owner's team member; has a TeamMember record with permissions
 */
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    mobile: { type: String, required: true, trim: true, unique: true },
    password: { type: String, required: true, minlength: 6, select: false },
    role: { type: String, enum: ['passenger', 'owner', 'staff'], default: 'passenger', index: true },
    isMobileVerified: { type: Boolean, default: false },
    otpHash: { type: String, select: false },
    otpExpires: { type: Date, select: false },
    otpAttempts: { type: Number, default: 0, select: false },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.comparePassword = function comparePassword(plain) {
  return bcrypt.compare(plain, this.password);
};

userSchema.methods.toJSON = function toJSON() {
  const o = this.toObject();
  delete o.password;
  delete o.otpHash;
  delete o.otpExpires;
  delete o.otpAttempts;
  return o;
};

module.exports = mongoose.model('User', userSchema);
