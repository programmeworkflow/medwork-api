require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs-extra');

// ── Route imports ─────────────────────────────────────────────
const authRoutes          = require('./routes/auth');
const contractRoutes      = require('./routes/contracts');
const uploadRoutes        = require('./routes/upload');
const dashboardRoutes     = require('./routes/dashboard');
const logRoutes           = require('./routes/logs');
const notificationRoutes  = require('./routes/notifications');
const userRoutes          = require('./routes/users');
const contaAzulRoutes     = require('./routes/contaazul');
const { authLimiter, uploadLimiter, apiLimiter } = require('./middleware/rateLimit');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Upload directories ────────────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
fs.ensureDirSync(path.join(UPLOAD_DIR, 'pending'));
fs.ensureDirSync(path.join(UPLOAD_DIR, 'faturado'));

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / server-to-server
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (/\.vercel\.app$/.test(origin))   return cb(null, true);
    if (/\.railway\.app$/.test(origin))  return cb(null, true);
    if (/\.onrender\.com$/.test(origin)) return cb(null, true);
    cb(new Error('CORS blocked: ' + origin));
  },
  credentials: true,
}));

// ── Core middleware ───────────────────────────────────────────
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Health check ──────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const { pool } = require('./config/database');
  let dbOk = false;
  try { await pool.query('SELECT 1'); dbOk = true; } catch (_) {}
  res.status(dbOk ? 200 : 503).json({
    status:    dbOk ? 'ok' : 'degraded',
    db:        dbOk ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
    service:   'medwork-api',
    version:   '1.0.0',
    contaAzul: process.env.CONTA_AZUL_CLIENT_ID  ? 'configured' : 'mock',
    ai:        process.env.ANTHROPIC_API_KEY       ? 'configured' : 'disabled',
    whatsapp:  (process.env.TWILIO_ACCOUNT_SID || process.env.WHATSAPP_CLOUD_TOKEN) ? 'configured' : 'mock',
  });
});

// ── Routes ────────────────────────────────────────────────────
app.use('/api/auth',          authLimiter,   authRoutes);
app.use('/api/users',         apiLimiter,    userRoutes);
app.use('/api/upload',        uploadLimiter, uploadRoutes);
app.use('/api/contracts',     apiLimiter,    contractRoutes);
app.use('/api/dashboard',     apiLimiter,    dashboardRoutes);
app.use('/api/logs',          apiLimiter,    logRoutes);
app.use('/api/notifications', apiLimiter,    notificationRoutes);
app.use('/api/contaazul',                    contaAzulRoutes);

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Global error handler ──────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  if (err.message?.startsWith('CORS blocked')) {
    return res.status(403).json({ error: err.message });
  }
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🏥 Medwork API running');
  console.log(`   URL      : http://localhost:${PORT}`);
  console.log(`   Env      : ${process.env.NODE_ENV || 'development'}`);
  console.log(`   DB       : ${process.env.DATABASE_URL ? '✅ configured' : '❌ DATABASE_URL missing'}`);
  console.log(`   ContaAzul: ${process.env.CONTA_AZUL_CLIENT_ID  ? '✅ configured' : '⚠️  mock mode'}`);
  console.log(`   AI       : ${process.env.ANTHROPIC_API_KEY      ? '✅ configured' : '⚠️  regex only'}`);
  console.log(`   WhatsApp : ${(process.env.TWILIO_ACCOUNT_SID || process.env.WHATSAPP_CLOUD_TOKEN) ? '✅ configured' : '⚠️  mock mode'}\n`);

  // Start WhatsApp daily scheduler
  const { startScheduler } = require('./services/scheduler');
  startScheduler();
});

module.exports = app;
