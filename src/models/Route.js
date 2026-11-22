const mongoose = require('mongoose');

/**
 * A route is one scheduled trip of a bus: an ordered list of stops with times.
 * A bus can have several routes (e.g. the onward and the return trip).
 * stops[0] is the starting point and the last stop is the destination.
 */
const routeStopSchema = new mongoose.Schema(
  {
    stop: { type: mongoose.Schema.Types.ObjectId, ref: 'Stop' }, // master stop (optional)
    city: { type: mongoose.Schema.Types.ObjectId, ref: 'City', required: true },
    cityName: { type: String, required: true },
    stopName: { type: String, required: true },
    sequence: { type: Number, required: true },
    arrivalTime: { type: String, match: /^\d{2}:\d{2}$/ }, // empty for origin
    departureTime: { type: String, match: /^\d{2}:\d{2}$/ }, // empty for destination
    dayOffset: { type: Number, default: 0, min: 0, max: 3 }, // +1 if the bus reaches this stop the next day
    distanceKm: { type: Number, min: 0 }, // from origin
    haltMinutes: { type: Number, min: 0 },
    fareFromOrigin: { type: Number, min: 0 }, // optional segment fares
    isMajor: { type: Boolean, default: true },
  },
  { _id: true }
);

const routeSchema = new mongoose.Schema(
  {
    bus: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus', required: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'BusOwner', required: true, index: true },
    name: { type: String, trim: true }, // e.g. "Morning Express"
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'RouteCategory' },
    stops: {
      type: [routeStopSchema],
      validate: { validator: (v) => v.length >= 2, message: 'A route needs at least a starting point and a destination' },
    },
    fromCity: { type: mongoose.Schema.Types.ObjectId, ref: 'City', index: true },
    toCity: { type: mongoose.Schema.Types.ObjectId, ref: 'City', index: true },
    stopCities: [{ type: mongoose.Schema.Types.ObjectId, ref: 'City', index: true }], // ordered, for segment search
    departureTime: String, // origin departure (denormalised)
    arrivalTime: String, // destination arrival (denormalised)
    totalDistanceKm: Number,
    operatingDays: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] }, // 0 = Sunday
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

routeSchema.pre('validate', function denormalise() {
  if (Array.isArray(this.stops) && this.stops.length) {
    this.stops.sort((a, b) => a.sequence - b.sequence);
    this.stops.forEach((s, i) => {
      s.sequence = i + 1;
    });
    const first = this.stops[0];
    const last = this.stops[this.stops.length - 1];
    this.fromCity = first.city;
    this.toCity = last.city;
    this.stopCities = this.stops.map((s) => s.city);
    this.departureTime = first.departureTime;
    this.arrivalTime = last.arrivalTime;
    this.totalDistanceKm = last.distanceKm;
  }
});

module.exports = mongoose.model('Route', routeSchema);
