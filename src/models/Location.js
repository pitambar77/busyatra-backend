const mongoose = require('mongoose');

/** Cities / towns / destinations, managed by admin. */
const citySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true },
    state: { type: String, trim: true, default: 'Odisha' },
    image: String, // URL (https://… or /uploads/images/…)
    imageCredit: String,
    description: String,
    isPopularDestination: { type: Boolean, default: false, index: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);
citySchema.index({ name: 1, state: 1 }, { unique: true });

/** Route categories e.g. Intercity, Interstate, Express, Pilgrimage. */
const routeCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    description: String,
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/** Admin-curated popular routes shown on the homepage. */
const popularRouteSchema = new mongoose.Schema(
  {
    fromCity: { type: mongoose.Schema.Types.ObjectId, ref: 'City', required: true },
    toCity: { type: mongoose.Schema.Types.ObjectId, ref: 'City', required: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'RouteCategory' },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);
popularRouteSchema.index({ fromCity: 1, toCity: 1 }, { unique: true });

module.exports = {
  City: mongoose.model('City', citySchema),
  RouteCategory: mongoose.model('RouteCategory', routeCategorySchema),
  PopularRoute: mongoose.model('PopularRoute', popularRouteSchema),
};
