const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.NODE_ENV !== 'test') {
  console.error('❌ DATABASE_URL is not set. Copy backend/.env.example to backend/.env');
}

// Supabase and Railway both require SSL in production
// Allow disabling via DATABASE_SSL=false for local dev without SSL
const useSSL = process.env.DATABASE_SSL !== 'false' && (
  process.env.NODE_ENV === 'production' ||
  (connectionString || '').includes('supabase') ||
  (connectionString || '').includes('railway') ||
  (connectionString || '').includes('sslmode=require')
);

const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', (client) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log('✅ DB connection acquired');
  }
});

pool.on('error', (err) => {
  console.error('❌ Idle DB client error:', err.message);
});

/**
 * Execute a parameterised query
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    if (process.env.NODE_ENV === 'development' && process.env.LOG_QUERIES === 'true') {
      console.log(`[DB] ${Date.now() - start}ms | ${text.substring(0, 80).replace(/\s+/g, ' ')}`);
    }
    return res;
  } catch (error) {
    console.error('[DB ERROR]', error.message, '\n  Query:', text.substring(0, 120));
    throw error;
  }
}

const getClient = () => pool.connect();

module.exports = { query, getClient, pool };
