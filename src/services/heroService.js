const { HeroSlide, SiteSetting, HEX } = require('../models/Hero');
const { ApiError } = require('../utils/helpers');

const u = (id, w = 2200) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=80`;

const DEFAULT_SETTINGS = {
  autoplay: true,
  intervalSeconds: 6,
  transition: 'fade', // fade | slide
  showSearch: true,
  showTrustBadges: true,
  showArrows: true,
};

// Created once, the first time the banner is requested, so the homepage looks the same as before.
const DEFAULT_SLIDES = [
  {
    image: u('photo-1544620347-c4fd4a3d5957'),
    imageCredit: 'Juan Encalada / Unsplash',
    imagePosition: 'right',
    overlay: 75,
    badge: '{running} buses confirmed running today',
    heading: 'Know your bus {before} you reach the stand.',
    subheading: 'Daily timings, stop-by-stop schedules, fares and today’s running status — updated by the operators themselves. Call the operator in one tap.',
    sortOrder: 1,
  },
  {
    image: u('photo-1631769061480-baac95ff4b29'),
    imageCredit: 'Nicholas Ng / Unsplash',
    imagePosition: 'center',
    overlay: 70,
    badge: '{buses} buses · {cities} cities & towns',
    heading: 'Every daily bus, {every stop|#FBBF24}, one search.',
    subheading: 'See where each bus stops, when it gets there and what the ticket costs — before you leave home.',
    primaryCta: { label: 'Browse all routes', href: '/routes' },
    sortOrder: 2,
  },
  {
    image: u('photo-1698465358843-5f5a24271bfd'),
    imageCredit: 'Karthick Gislen / Unsplash',
    imagePosition: 'center',
    overlay: 75,
    badge: 'For bus owners & operators',
    heading: 'Run a bus? {List it on BusYatra} today.',
    subheading: 'Reach thousands of daily travellers. Post today’s running status from your phone in seconds.',
    primaryCta: { label: 'List your bus', href: '/list-your-bus' },
    secondaryCta: { label: 'View operators', href: '/operators' },
    sortOrder: 3,
  },
];

async function ensureHero() {
  const existing = await SiteSetting.findOne({ key: 'hero' }).lean();
  if (existing) return { ...DEFAULT_SETTINGS, ...existing.value };
  // First run: store settings and, if no slides exist yet, the default slides.
  if ((await HeroSlide.countDocuments()) === 0) await HeroSlide.insertMany(DEFAULT_SLIDES);
  try {
    await SiteSetting.create({ key: 'hero', value: DEFAULT_SETTINGS });
  } catch (e) {
    if (e.code !== 11000) throw e; // created by a parallel request
  }
  return { ...DEFAULT_SETTINGS };
}

async function getHero({ includeInactive = false } = {}) {
  const settings = await ensureHero();
  const slides = await HeroSlide.find(includeInactive ? {} : { isActive: true }).sort({ sortOrder: 1, createdAt: 1 }).lean();
  return { settings, slides };
}

async function saveSettings(body = {}) {
  const current = await ensureHero();
  const next = { ...current };
  ['autoplay', 'showSearch', 'showTrustBadges', 'showArrows'].forEach((k) => {
    if (k in body) next[k] = Boolean(body[k]);
  });
  if ('intervalSeconds' in body) {
    const n = Number(body.intervalSeconds);
    if (!Number.isFinite(n) || n < 2 || n > 30) throw new ApiError(400, 'Slide duration must be between 2 and 30 seconds');
    next.intervalSeconds = Math.round(n);
  }
  if ('transition' in body) {
    if (!['fade', 'slide'].includes(body.transition)) throw new ApiError(400, 'Transition must be fade or slide');
    next.transition = body.transition;
  }
  await SiteSetting.updateOne({ key: 'hero' }, { $set: { value: next } }, { upsert: true });
  return next;
}

const cleanCta = (c) => {
  if (!c || !c.label?.trim() || !c.href?.trim()) return undefined;
  const href = c.href.trim();
  if (!/^(\/|https?:\/\/|#|tel:|mailto:)/i.test(href)) throw new ApiError(400, `Button link “${href}” must start with /, https://, tel: or mailto:`);
  return { label: c.label.trim(), href };
};

/** Validate and normalise a slide body coming from the admin form. */
function slidePayload(b = {}, { partial = false } = {}) {
  const out = {};
  const str = (k) => {
    if (k in b) out[k] = typeof b[k] === 'string' ? b[k].trim() : b[k];
  };
  ['image', 'imageCredit', 'badge', 'heading', 'subheading'].forEach(str);
  if (!partial || 'image' in b) {
    if (!out.image) throw new ApiError(400, 'Choose a background image for the slide');
    if (!/^(https?:\/\/|\/uploads\/images\/)/i.test(out.image)) throw new ApiError(400, 'Image must be an https:// address or an uploaded image');
  }
  if (!partial || 'heading' in b) {
    if (!out.heading) throw new ApiError(400, 'Heading is required');
    const opens = (out.heading.match(/\{/g) || []).length;
    const closes = (out.heading.match(/\}/g) || []).length;
    if (opens !== closes) throw new ApiError(400, 'Heading has an unclosed { } colour block');
  }
  ['headingColor', 'highlightColor'].forEach((k) => {
    if (k in b && b[k]) {
      if (!HEX.test(b[k])) throw new ApiError(400, `${k === 'headingColor' ? 'Heading' : 'Highlight'} colour must be a hex value like #FB923C`);
      out[k] = b[k];
    }
  });
  if ('imagePosition' in b) out.imagePosition = ['left', 'center', 'right'].includes(b.imagePosition) ? b.imagePosition : 'center';
  if ('overlay' in b) out.overlay = Math.min(100, Math.max(0, Number(b.overlay) || 0));
  if ('isActive' in b) out.isActive = Boolean(b.isActive);
  if ('sortOrder' in b) out.sortOrder = Number(b.sortOrder) || 0;
  if ('primaryCta' in b) out.primaryCta = cleanCta(b.primaryCta);
  if ('secondaryCta' in b) out.secondaryCta = cleanCta(b.secondaryCta);
  return out;
}

module.exports = { getHero, ensureHero, saveSettings, slidePayload, DEFAULT_SETTINGS, DEFAULT_SLIDES };
