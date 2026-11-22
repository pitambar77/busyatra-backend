const mongoose = require('mongoose');

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ctaSchema = new mongoose.Schema({ label: { type: String, trim: true, maxlength: 40 }, href: { type: String, trim: true, maxlength: 300 } }, { _id: false });

/**
 * One slide of the homepage banner, managed from Admin → Homepage banner.
 *
 * `heading` supports coloured words: wrap them in curly braces.
 *   "Know your bus {before} you reach the stand."      → "before" uses highlightColor
 *   "Daily buses {across Odisha|#38BDF8}"               → "across Odisha" in sky blue
 * `badge` and `subheading` support live counters: {running}, {buses}, {operators}, {cities}.
 */
const heroSlideSchema = new mongoose.Schema(
  {
    image: { type: String, required: true, trim: true }, // https://… or /uploads/images/…
    imageCredit: { type: String, trim: true, maxlength: 120 },
    imagePosition: { type: String, enum: ['left', 'center', 'right'], default: 'center' },
    overlay: { type: Number, min: 0, max: 100, default: 70 }, // darkness of the left-side shade
    badge: { type: String, trim: true, maxlength: 120 },
    heading: { type: String, required: true, trim: true, maxlength: 200 },
    headingColor: { type: String, default: '#FFFFFF', match: HEX },
    highlightColor: { type: String, default: '#FB923C', match: HEX },
    subheading: { type: String, trim: true, maxlength: 400 },
    primaryCta: ctaSchema,
    secondaryCta: ctaSchema,
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/** Small key/value store for site-wide settings (e.g. key "hero"). */
const siteSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false }
);

const HeroSlide = mongoose.models.HeroSlide || mongoose.model('HeroSlide', heroSlideSchema);
const SiteSetting = mongoose.models.SiteSetting || mongoose.model('SiteSetting', siteSettingSchema);

module.exports = { HeroSlide, SiteSetting, HEX };
