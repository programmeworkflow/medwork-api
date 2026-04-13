#!/usr/bin/env node
/**
 * validate-env.js
 * Run: node src/config/validate-env.js
 * Checks all required environment variables before server start.
 */

require('dotenv').config();

const REQUIRED = [
  { key: 'DATABASE_URL',              example: 'postgresql://user:pass@host:5432/medwork' },
  { key: 'JWT_SECRET',                example: 'a-very-long-random-secret-string' },
];

const OPTIONAL_WITH_WARNING = [
  { key: 'CONTA_AZUL_CLIENT_ID',      warn: 'Conta Azul integration will be disabled' },
  { key: 'CONTA_AZUL_CLIENT_SECRET',  warn: 'Conta Azul integration will be disabled' },
  { key: 'ANTHROPIC_API_KEY',         warn: 'AI fallback parser will be disabled' },
  { key: 'FRONTEND_URL',              warn: 'CORS will only allow localhost' },
];

let hasErrors = false;

console.log('\n🔍 Medwork — Environment Validation\n');

// Check required
for (const { key, example } of REQUIRED) {
  if (!process.env[key]) {
    console.error(`  ❌ MISSING (required): ${key}`);
    console.error(`     Example: ${key}=${example}`);
    hasErrors = true;
  } else {
    const val = process.env[key];
    const masked = val.length > 12
      ? val.slice(0, 6) + '***' + val.slice(-4)
      : '***';
    console.log(`  ✅ ${key} = ${masked}`);
  }
}

// Check optional
console.log('');
for (const { key, warn } of OPTIONAL_WITH_WARNING) {
  if (!process.env[key]) {
    console.warn(`  ⚠️  MISSING (optional): ${key}`);
    console.warn(`     → ${warn}`);
  } else {
    console.log(`  ✅ ${key} = ***`);
  }
}

// Check DB connection
console.log('\n🔌 Testing database connection...');
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 5000,
});

pool.query('SELECT 1')
  .then(() => {
    console.log('  ✅ Database connection successful\n');
    pool.end();
    if (hasErrors) {
      console.error('❌ Validation FAILED — fix the errors above before starting\n');
      process.exit(1);
    } else {
      console.log('✅ All checks passed — ready to start!\n');
    }
  })
  .catch((err) => {
    console.error(`  ❌ Database connection FAILED: ${err.message}`);
    console.error('     Check your DATABASE_URL and ensure PostgreSQL is running.\n');
    pool.end();
    process.exit(1);
  });
