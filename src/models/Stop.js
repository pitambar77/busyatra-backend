const mongoose = require('mongoose');

/** Master list of major bus stops / stands, each belonging to a city. Managed by admin. */
const stopSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    city: { type: mongoose.Schema.Types.ObjectId, ref: 'City', required: true, index: true },
    landmark: String,
    address: String,
    location: {
      lat: Number,
      lng: Number,
    },
    isMajor: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);
stopSchema.index({ city: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Stop', stopSchema);
