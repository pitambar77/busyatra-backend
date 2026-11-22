const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { User, BusOwner, AdminUser, TeamMember } = require('../models');
const { ApiError, slugify } = require('../utils/helpers');
const { signToken } = require('../middleware/auth');
const { sendSms } = require('../utils/sms');
const { notifyAdmin } = require('../services/notificationService');

const MOBILE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseMobile(m = '') {
  const digits = String(m).replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

async function issueOtp(user, purpose = 'verify') {
  const otp = String(crypto.randomInt(100000, 1000000));
  user.otpHash = await bcrypt.hash(otp, 8);
  user.otpExpires = new Date(Date.now() + config.otp.ttlMinutes * 60 * 1000);
  user.otpAttempts = 0;
  await user.save();
  await sendSms(user.mobile, `${otp} is your ${config.company.name} ${purpose === 'reset' ? 'password reset' : 'verification'} code. Valid for ${config.otp.ttlMinutes} minutes.`);
  return config.otp.exposeInResponse ? { devOtp: otp } : {};
}

async function checkOtp(user, otp) {
  if (!user.otpHash || !user.otpExpires || user.otpExpires < new Date()) throw new ApiError(400, 'OTP expired. Please request a new one.');
  if (user.otpAttempts >= 5) throw new ApiError(429, 'Too many attempts. Please request a new OTP.');
  const ok = await bcrypt.compare(String(otp || ''), user.otpHash);
  if (!ok) {
    user.otpAttempts += 1;
    await user.save();
    throw new ApiError(400, 'Incorrect OTP');
  }
  user.otpHash = undefined;
  user.otpExpires = undefined;
  user.otpAttempts = 0;
}

async function sessionPayload(user) {
  const data = { token: signToken({ sub: user._id, kind: 'user', role: user.role }), user };
  if (user.role === 'owner') data.owner = await BusOwner.findOne({ user: user._id });
  if (user.role === 'staff') {
    const member = await TeamMember.findOne({ user: user._id }).populate('owner');
    data.owner = member?.owner;
    data.teamMember = member;
  }
  return data;
}

function validateBasics({ name, email, mobile, password }) {
  if (!name || name.trim().length < 2) throw new ApiError(400, 'Name is required');
  if (!EMAIL_RE.test(email || '')) throw new ApiError(400, 'A valid email is required');
  if (!MOBILE_RE.test(mobile)) throw new ApiError(400, 'Enter a valid 10-digit Indian mobile number');
  if (!password || password.length < 6) throw new ApiError(400, 'Password must be at least 6 characters');
}

async function ensureUnique(email, mobile) {
  const existing = await User.findOne({ $or: [{ email: email.toLowerCase() }, { mobile }] });
  if (existing) throw new ApiError(409, existing.email === email.toLowerCase() ? 'Email is already registered' : 'Mobile number is already registered');
}

/** POST /api/auth/register — passenger account */
exports.register = async (req, res) => {
  const mobile = normaliseMobile(req.body.mobile);
  const { name, email, password } = req.body;
  validateBasics({ name, email, mobile, password });
  await ensureUnique(email, mobile);
  const user = await User.create({ name, email, mobile, password, role: 'passenger' });
  const otp = await issueOtp(user);
  res.status(201).json({ success: true, message: 'Account created. Verify the OTP sent to your mobile.', data: { userId: user._id, mobile, ...otp } });
};

/** POST /api/auth/register-owner — multipart: owner fields + documents[] */
exports.registerOwner = async (req, res) => {
  const b = req.body;
  const mobile = normaliseMobile(b.mobile);
  validateBasics({ name: b.ownerName, email: b.email, mobile, password: b.password });
  if (!b.companyName || b.companyName.trim().length < 2) throw new ApiError(400, 'Company name is required');
  if (!b.addressLine1 || !b.city || !b.state) throw new ApiError(400, 'Business address (address, city, state) is required');
  await ensureUnique(b.email, mobile);

  const user = await User.create({ name: b.ownerName, email: b.email, mobile, password: b.password, role: 'owner' });
  const docTypes = [].concat(b.docTypes || []);
  const owner = await BusOwner.create({
    user: user._id,
    ownerName: b.ownerName,
    companyName: b.companyName,
    email: b.email,
    mobile,
    businessAddress: { line1: b.addressLine1, city: b.city, state: b.state, pincode: b.pincode },
    documents: (req.files || []).map((f, i) => ({ docType: docTypes[i] || 'other', fileName: f.filename, originalName: f.originalname, mimeType: f.mimetype })),
  });
  owner.slug = `${slugify(owner.companyName)}-${String(owner._id).slice(-4)}`;
  await owner.save();
  await notifyAdmin('new_owner', `New operator registered: ${owner.companyName}`, `${owner.ownerName} · ${mobile}`, `/admin/owners/${owner._id}`);

  const otp = await issueOtp(user);
  res.status(201).json({ success: true, message: 'Registration received. Verify the OTP sent to your mobile.', data: { userId: user._id, mobile, ...otp } });
};

/** POST /api/auth/send-otp {mobile, purpose} */
exports.sendOtp = async (req, res) => {
  const mobile = normaliseMobile(req.body.mobile);
  const purpose = req.body.purpose === 'reset' ? 'reset' : 'verify';
  const user = await User.findOne({ mobile });
  // Same response whether or not the account exists, to avoid account enumeration.
  if (!user) return res.json({ success: true, message: 'If this number is registered, an OTP has been sent.' });
  const otp = await issueOtp(user, purpose);
  return res.json({ success: true, message: 'OTP sent', data: otp });
};

/** POST /api/auth/verify-otp {mobile, otp} — verifies the mobile and logs the user in */
exports.verifyOtp = async (req, res) => {
  const mobile = normaliseMobile(req.body.mobile);
  const user = await User.findOne({ mobile }).select('+otpHash +otpExpires +otpAttempts');
  if (!user) throw new ApiError(400, 'Incorrect OTP');
  await checkOtp(user, req.body.otp);
  user.isMobileVerified = true;
  user.lastLoginAt = new Date();
  await user.save();
  res.json({ success: true, message: 'Mobile verified', data: await sessionPayload(user) });
};

/** POST /api/auth/login {identifier, password} — identifier = email or mobile */
exports.login = async (req, res) => {
  const { identifier = '', password } = req.body;
  const id = identifier.trim().toLowerCase();
  const query = id.includes('@') ? { email: id } : { mobile: normaliseMobile(id) };
  const user = await User.findOne(query).select('+password');
  if (!user || !(await user.comparePassword(password || ''))) throw new ApiError(401, 'Invalid credentials');
  if (user.status === 'suspended') throw new ApiError(403, 'Your account is suspended. Contact support.');
  if (!user.isMobileVerified) {
    const otp = await issueOtp(user);
    return res.status(403).json({ success: false, code: 'OTP_REQUIRED', message: 'Please verify your mobile number first. We have sent a new OTP.', data: { mobile: user.mobile, ...otp } });
  }
  if (user.role === 'staff') {
    const member = await TeamMember.findOne({ user: user._id });
    if (!member || !member.isActive) throw new ApiError(403, 'Your team access has been revoked');
  }
  user.lastLoginAt = new Date();
  await user.save();
  return res.json({ success: true, data: await sessionPayload(user) });
};

/** POST /api/auth/reset-password {mobile, otp, password} */
exports.resetPassword = async (req, res) => {
  const mobile = normaliseMobile(req.body.mobile);
  const user = await User.findOne({ mobile }).select('+otpHash +otpExpires +otpAttempts +password');
  if (!user) throw new ApiError(400, 'Incorrect OTP');
  if (!req.body.password || req.body.password.length < 6) throw new ApiError(400, 'Password must be at least 6 characters');
  await checkOtp(user, req.body.otp);
  user.password = req.body.password;
  user.isMobileVerified = true;
  await user.save();
  res.json({ success: true, message: 'Password updated. You can log in now.' });
};

/** GET /api/auth/me */
exports.me = async (req, res) => {
  if (req.admin) return res.json({ success: true, data: { admin: req.admin } });
  const data = await sessionPayload(req.user);
  delete data.token;
  data.permissions = req.permissions || null;
  return res.json({ success: true, data });
};

/** POST /api/auth/change-password {currentPassword, newPassword} */
exports.changePassword = async (req, res) => {
  const Model = req.admin ? AdminUser : User;
  const account = await Model.findById((req.admin || req.user)._id).select('+password');
  if (!(await account.comparePassword(req.body.currentPassword || ''))) throw new ApiError(400, 'Current password is incorrect');
  if (!req.body.newPassword || req.body.newPassword.length < (req.admin ? 8 : 6)) throw new ApiError(400, 'New password is too short');
  account.password = req.body.newPassword;
  await account.save();
  res.json({ success: true, message: 'Password changed' });
};

/** POST /api/admin/auth/login */
exports.adminLogin = async (req, res) => {
  const admin = await AdminUser.findOne({ email: String(req.body.email || '').toLowerCase().trim() }).select('+password');
  if (!admin || !admin.isActive || !(await admin.comparePassword(req.body.password || ''))) throw new ApiError(401, 'Invalid credentials');
  admin.lastLoginAt = new Date();
  await admin.save();
  res.json({ success: true, data: { token: signToken({ sub: admin._id, kind: 'admin', role: admin.role }), admin } });
};

exports.normaliseMobile = normaliseMobile;
exports.MOBILE_RE = MOBILE_RE;
