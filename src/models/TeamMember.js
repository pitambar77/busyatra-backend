const mongoose = require('mongoose');

const ROLE_PRESETS = {
  manager: { manageBuses: true, manageRoutes: true, updateStatus: true, viewPayments: true, managePayments: false, manageTeam: false },
  status_updater: { manageBuses: false, manageRoutes: false, updateStatus: true, viewPayments: false, managePayments: false, manageTeam: false },
  accountant: { manageBuses: false, manageRoutes: false, updateStatus: false, viewPayments: true, managePayments: true, manageTeam: false },
  custom: {},
};

/** A staff login that acts on behalf of a bus owner, scoped by permissions. */
const teamMemberSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'BusOwner', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    role: { type: String, enum: Object.keys(ROLE_PRESETS), default: 'status_updater' },
    permissions: {
      manageBuses: { type: Boolean, default: false },
      manageRoutes: { type: Boolean, default: false },
      updateStatus: { type: Boolean, default: true },
      viewPayments: { type: Boolean, default: false },
      managePayments: { type: Boolean, default: false },
      manageTeam: { type: Boolean, default: false },
    },
    // Empty = all buses of the owner.
    assignedBuses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Bus' }],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

teamMemberSchema.statics.ROLE_PRESETS = ROLE_PRESETS;

module.exports = mongoose.model('TeamMember', teamMemberSchema);
