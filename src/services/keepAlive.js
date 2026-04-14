const { query } = require('../config/database');

const SIX_DAYS = 6 * 24 * 60 * 60 * 1000; // 518400000 ms

/**
 * Ping the database to keep the Supabase connection alive.
 */
async function pingDatabase() {
  try {
    await query('SELECT 1');
    console.log('[KEEP-ALIVE] DB keep-alive ping');
  } catch (err) {
    console.error('[KEEP-ALIVE] Ping failed:', err.message);
  }
}

/**
 * Start the keep-alive scheduler — pings every 6 days.
 */
function startKeepAlive() {
  if (process.env.NODE_ENV === 'test') return;

  console.log('[KEEP-ALIVE] Scheduler started (every 6 days)');
  setInterval(pingDatabase, SIX_DAYS);

  // Initial ping on startup
  pingDatabase();
}

module.exports = { startKeepAlive, pingDatabase };
