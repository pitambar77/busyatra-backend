const jwt = require('jsonwebtoken');
const config = require('../config');
const { ApiError } = require('../utils/helpers');
const { User, AdminUser, BusOwner, TeamMember } = require('../models');

const ALL_PERMISSIONS = {
  manageBuses: true,
  manageRoutes: true,
  updateStatus: true,
  viewPayments: true,
  managePayments: true,
  manageTeam: true,
};

function signToken(payload) {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
}

function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

/** Loads the caller into req.user / req.admin and, for owners & staff, req.owner + req.permissions. */
async function resolveIdentity(req) {
  const token = readToken(req);
  if (!token) return false;
  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret);
  } catch {
    throw new ApiError(401, 'Session expired. Please log in again.');
  }

  if (payload.kind === 'admin') {
    const admin = await AdminUser.findById(payload.sub);
    if (!admin || !admin.isActive) throw new ApiError(401, 'Admin account not found or disabled');
    req.admin = admin;
    return true;
  }

  const user = await User.findById(payload.sub);
  if (!user) throw new ApiError(401, 'Account not found');
  if (user.status === 'suspended') throw new ApiError(403, 'Your account is suspended. Contact support.');
  req.user = user;

  if (user.role === 'owner') {
    req.owner = await BusOwner.findOne({ user: user._id });
    req.permissions = { ...ALL_PERMISSIONS };
    req.isOwnerAccount = true;
  } else if (user.role === 'staff') {
    const member = await TeamMember.findOne({ user: user._id, isActive: true });
    if (!member) throw new ApiError(403, 'Your team access has been revoked');
    req.teamMember = member;
    req.owner = await BusOwner.findById(member.owner);
    req.permissions = member.permissions.toObject ? member.permissions.toObject() : member.permissions;
    req.assignedBuses = (member.assignedBuses || []).map(String);
  }
  return true;
}

const optionalAuth = async (req, res, next) => {
  try {
    await resolveIdentity(req);
  } catch {
    /* ignore invalid tokens on public routes */
  }
  next();
};

const requireAuth = async (req, res, next) => {
  const ok = await resolveIdentity(req);
  if (!ok) throw new ApiError(401, 'Please log in to continue');
  next();
};

/** Owner or staff, optionally requiring a specific permission. */
const requireOwnerAccess = (permission) => async (req, res, next) => {
  const ok = await resolveIdentity(req);
  if (!ok || !req.user) throw new ApiError(401, 'Please log in to continue');
  if (!['owner', 'staff'].includes(req.user.role) || !req.owner) throw new ApiError(403, 'Bus owner access required');
  if (req.owner.isSuspended) throw new ApiError(403, `This operator account is suspended${req.owner.suspensionReason ? `: ${req.owner.suspensionReason}` : ''}`);
  if (permission && !req.permissions?.[permission]) throw new ApiError(403, 'You do not have permission for this action');
  next();
};

const requireOwnerOnly = async (req, res, next) => {
  const ok = await resolveIdentity(req);
  if (!ok || !req.user || req.user.role !== 'owner') throw new ApiError(403, 'Only the account owner can do this');
  next();
};

const requireAdmin = (...roles) => async (req, res, next) => {
  const ok = await resolveIdentity(req);
  if (!ok || !req.admin) throw new ApiError(403, 'Admin access required');
  if (roles.length && !roles.includes(req.admin.role)) throw new ApiError(403, 'Insufficient admin role');
  next();
};

/** True if the staff member may act on this bus (owners always can). */
function canAccessBus(req, busId) {
  if (!req.assignedBuses || req.assignedBuses.length === 0) return true;
  return req.assignedBuses.includes(String(busId));
}

module.exports = {
  signToken,
  optionalAuth,
  requireAuth,
  requireOwnerAccess,
  requireOwnerOnly,
  requireAdmin,
  canAccessBus,
  ALL_PERMISSIONS,
};
