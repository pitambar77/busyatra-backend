const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/** Platform administrators. Kept in a separate collection from owners/passengers. */
const adminUserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    password: { type: String, required: true, minlength: 8, select: false },
    role: { type: String, enum: ['super_admin', 'admin', 'moderator'], default: 'admin' },
    isActive: { type: Boolean, default: true },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

adminUserSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

adminUserSchema.methods.comparePassword = function comparePassword(plain) {
  return bcrypt.compare(plain, this.password);
};

adminUserSchema.methods.toJSON = function toJSON() {
  const o = this.toObject();
  delete o.password;
  return o;
};

module.exports = mongoose.model('AdminUser', adminUserSchema);
