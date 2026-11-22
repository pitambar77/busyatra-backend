const config = require('../config');

class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** YYYY-MM-DD for a date in the platform timezone (IST by default). Daily status is keyed on this. */
function dateKey(d = new Date(), tz = config.timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function isValidDateKey(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** Day of week (0=Sun) for a YYYY-MM-DD key. */
function weekdayOfKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(date, days) {
  const d = new Date(date);
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  return d;
}

function maskRegistration(reg = '') {
  const clean = String(reg).replace(/\s+/g, '').toUpperCase();
  if (clean.length <= 6) return clean.replace(/.(?=.{2})/g, '•');
  return clean.slice(0, 4) + '•'.repeat(clean.length - 6) + clean.slice(-2);
}

function paginate(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 12));
  return { page, limit, skip: (page - 1) * limit };
}

function pageMeta(total, { page, limit }) {
  return { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

function escapeRegex(s = '') {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slugify(s = '') {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function timeToMinutes(t) {
  if (!t || !/^\d{2}:\d{2}$/.test(t)) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function pick(obj, keys) {
  return keys.reduce((acc, k) => {
    if (obj[k] !== undefined) acc[k] = obj[k];
    return acc;
  }, {});
}

module.exports = {
  ApiError,
  asyncHandler,
  dateKey,
  isValidDateKey,
  weekdayOfKey,
  addDays,
  maskRegistration,
  paginate,
  pageMeta,
  escapeRegex,
  slugify,
  timeToMinutes,
  pick,
};
