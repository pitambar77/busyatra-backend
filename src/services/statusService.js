const { DailyBusStatus } = require('../models');
const { dateKey, weekdayOfKey } = require('../utils/helpers');

const STATUS_LABELS = {
  running: 'Running Today',
  not_running: 'Not Running Today',
  delayed: 'Delayed',
  cancelled: 'Cancelled',
  suspended: 'Temporarily Suspended',
  not_updated: 'Status Not Updated',
  not_scheduled: 'Not Scheduled Today',
};

const REASON_LABELS = {
  mechanical_problem: 'Mechanical problem',
  weather_condition: 'Weather condition',
  driver_unavailable: 'Driver unavailable',
  maintenance: 'Maintenance',
  operational_issue: 'Operational issue',
  other: 'Other',
};

function labelFor(code, date) {
  const today = dateKey();
  const base = STATUS_LABELS[code] || code;
  if (date && date !== today) return base.replace(' Today', '');
  return base;
}

function inSuspension(bus, date) {
  const s = bus?.suspension;
  if (!s || !s.active) return false;
  if (s.from && date < s.from) return false;
  if (s.until && date > s.until) return false;
  return true;
}

/**
 * Resolve what passengers should see for a bus on a date.
 * Priority: temporary suspension → owner's status for that date → route not scheduled → "Status Not Updated".
 * We never assume a bus is running when nothing was submitted.
 */
function resolveStatus(bus, statusDoc, date = dateKey(), route = null) {
  const isToday = date === dateKey();
  const dayWord = isToday ? 'today' : `on ${date}`;

  if (inSuspension(bus, date)) {
    const reason = bus.suspension.reason || 'temporary suspension';
    return {
      code: 'suspended',
      label: labelFor('suspended', date),
      date,
      reason: 'other',
      reasonLabel: reason,
      message: bus.suspension.until ? `Suspended until ${bus.suspension.until}` : 'Suspended until further notice',
      isOperating: false,
      notice: `This bus is not operating ${dayWord} due to ${reason}.`,
      updatedAt: statusDoc?.updatedAt || null,
      updatedByName: statusDoc?.updatedByName || null,
    };
  }

  if (statusDoc) {
    const code = statusDoc.status;
    const reasonText = statusDoc.reason === 'other' && statusDoc.message ? statusDoc.message : REASON_LABELS[statusDoc.reason];
    const stopped = ['not_running', 'cancelled', 'suspended'].includes(code);
    let notice = null;
    if (stopped) notice = `This bus is not operating ${dayWord} due to ${(reasonText || 'operational reasons').toLowerCase()}.`;
    if (code === 'delayed') notice = `This bus is running late${statusDoc.delayMinutes ? ` by about ${statusDoc.delayMinutes} minutes` : ''}${reasonText ? ` due to ${reasonText.toLowerCase()}` : ''}.`;
    return {
      code,
      label: labelFor(code, date),
      date,
      reason: statusDoc.reason || null,
      reasonLabel: reasonText || null,
      message: statusDoc.message || null,
      delayMinutes: statusDoc.delayMinutes || null,
      isOperating: code === 'running' || code === 'delayed',
      notice,
      updatedAt: statusDoc.updatedAt,
      updatedByName: statusDoc.updatedByName || null,
    };
  }

  if (route && Array.isArray(route.operatingDays) && route.operatingDays.length && !route.operatingDays.includes(weekdayOfKey(date))) {
    return {
      code: 'not_scheduled',
      label: labelFor('not_scheduled', date),
      date,
      isOperating: false,
      notice: `This trip does not run on this day of the week.`,
      updatedAt: null,
    };
  }

  return {
    code: 'not_updated',
    label: labelFor('not_updated', date),
    date,
    isOperating: null,
    notice: `The operator has not updated this bus's status for ${isToday ? 'today' : date}. Please call before travelling.`,
    updatedAt: null,
  };
}

/** Map of busId -> DailyBusStatus for a date. */
async function statusMapFor(busIds, date = dateKey()) {
  const docs = await DailyBusStatus.find({ bus: { $in: busIds }, date }).lean();
  return new Map(docs.map((d) => [String(d.bus), d]));
}

/**
 * Create or update a bus's status for a date and append to its history.
 */
async function upsertStatus({ bus, date, status, reason, message, delayMinutes, actor, actorModel = 'User' }) {
  const entry = {
    status,
    reason: reason || undefined,
    message: message || undefined,
    delayMinutes: delayMinutes || undefined,
    updatedBy: actor?._id,
    updatedByModel: actorModel,
    updatedByName: actor?.name,
    at: new Date(),
  };
  let doc = await DailyBusStatus.findOne({ bus: bus._id, date });
  if (!doc) {
    doc = new DailyBusStatus({ bus: bus._id, owner: bus.owner, date, history: [] });
  }
  doc.status = status;
  doc.reason = reason || undefined;
  doc.message = message || undefined;
  doc.delayMinutes = status === 'delayed' ? delayMinutes || undefined : undefined;
  doc.updatedBy = actor?._id;
  doc.updatedByName = actor?.name;
  doc.history.push(entry);
  await doc.save();
  return doc;
}

module.exports = { resolveStatus, statusMapFor, upsertStatus, STATUS_LABELS, REASON_LABELS, inSuspension };
