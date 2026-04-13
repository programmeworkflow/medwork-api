const { query } = require('../config/database');

/**
 * Log an event to the database
 * @param {string} level - 'info' | 'warn' | 'error' | 'debug'
 * @param {string} category - 'auth' | 'parse' | 'contaazul' | 'upload' | 'system'
 * @param {string} message
 * @param {string|null} contractId
 * @param {string|null} fileId
 * @param {string|null} userId
 * @param {object|null} details
 */
async function logEvent(level, category, message, contractId = null, fileId = null, userId = null, details = null) {
  try {
    await query(
      `INSERT INTO logs (level, category, message, details, contract_id, file_id, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [level, category, message, details ? JSON.stringify(details) : null, contractId, fileId, userId]
    );
  } catch (err) {
    // Never throw from logger - just console
    console.error('Logger failed:', err.message);
  }
  
  // Also log to console
  const prefix = {
    info: '📋',
    warn: '⚠️',
    error: '❌',
    debug: '🔍'
  }[level] || '📋';
  
  console.log(`${prefix} [${category?.toUpperCase()}] ${message}`);
  if (details) console.log('  Details:', JSON.stringify(details, null, 2));
}

module.exports = { logEvent };
