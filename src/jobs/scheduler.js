const cron = require('node-cron');
const config = require('../config');
const { runExpiryJob } = require('../services/listingService');

/** Expires listings and sends renewal reminders. Runs hourly, plus once at startup. */
function startScheduler() {
  const run = async () => {
    try {
      const r = await runExpiryJob(new Date(), config.expiryReminderDays);
      if (r.expired || r.reminders || r.cancelledUnpaid) console.log('[jobs] expiry run', r);
    } catch (e) {
      console.error('[jobs] expiry job failed', e);
    }
  };
  run();
  return cron.schedule('5 * * * *', run, { timezone: config.timezone });
}

module.exports = { startScheduler };
