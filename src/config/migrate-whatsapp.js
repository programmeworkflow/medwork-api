require('dotenv').config();
const { pool } = require('./database');
const fs = require('fs');
const path = require('path');

async function migrateWhatsApp() {
  const client = await pool.connect();
  try {
    console.log('🔄 Running WhatsApp extension migration...');

    const sql = fs.readFileSync(
      path.join(__dirname, '../../../../database/schema_whatsapp.sql'),
      'utf8'
    );

    await client.query(sql);
    console.log('✅ WhatsApp migration complete');
  } catch (err) {
    console.error('❌ WhatsApp migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    pool.end();
  }
}

migrateWhatsApp();
