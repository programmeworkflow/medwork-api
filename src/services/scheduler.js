const { query } = require('../config/database');
const { analyzeAndAlert } = require('./alertEngine');
const { logEvent } = require('./logger');

let schedulerStarted = false;
let dailyTimer = null;

/**
 * Calculate ms until next target hour (default: 08:00 Brasília = UTC-3 → 11:00 UTC)
 */
function msUntilNextRun(targetHourUTC = 11) {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(targetHourUTC, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

/**
 * Run daily check for all users with WhatsApp enabled
 */
async function runDailyCheck() {
  await logEvent('info', 'scheduler', '🕗 Running daily WhatsApp alert check...');

  try {
    const usersResult = await query(
      `SELECT id FROM users WHERE whatsapp_enabled = true AND whatsapp_number IS NOT NULL`
    );

    const users = usersResult.rows;
    await logEvent('info', 'scheduler', `Found ${users.length} users with WhatsApp enabled`);

    let totalSent = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    for (const user of users) {
      try {
        const results = await analyzeAndAlert(user.id);
        for (const r of results) {
          if (r.sent)    totalSent++;
          if (r.skipped) totalSkipped++;
          if (r.failed)  totalFailed++;
        }
      } catch (err) {
        await logEvent('error', 'scheduler', `Failed for user ${user.id}: ${err.message}`);
        totalFailed++;
      }
    }

    await logEvent('info', 'scheduler',
      `Daily check complete: ${totalSent} sent, ${totalSkipped} skipped, ${totalFailed} failed`,
      null, null, null, { totalSent, totalSkipped, totalFailed, usersChecked: users.length }
    );
  } catch (err) {
    await logEvent('error', 'scheduler', `Daily check crashed: ${err.message}`);
  }

  // Schedule next run
  scheduleNext();
}

function scheduleNext() {
  const delay = msUntilNextRun(parseInt(process.env.ALERT_HOUR_UTC || '11'));
  const hours = (delay / 1000 / 60 / 60).toFixed(1);
  console.log(`⏰ Next alert check in ${hours}h`);
  dailyTimer = setTimeout(runDailyCheck, delay);
}

/**
 * Start the scheduler — call once on server boot
 */
function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  // Only run in production or if explicitly enabled
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.WHATSAPP_SCHEDULER === 'false') {
    console.log('⏸  WhatsApp scheduler disabled (WHATSAPP_SCHEDULER=false)');
    return;
  }

  console.log('🔔 WhatsApp alert scheduler started');
  scheduleNext();
}

/**
 * Stop the scheduler (for graceful shutdown)
 */
function stopScheduler() {
  if (dailyTimer) clearTimeout(dailyTimer);
  schedulerStarted = false;
}

/**
 * Trigger immediate check (for testing / manual trigger)
 */
async function triggerNow() {
  return runDailyCheck();
}

module.exports = { startScheduler, stopScheduler, triggerNow };
