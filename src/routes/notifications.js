const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { query } = require('../config/database');
const { sendWhatsAppMessage, formatPhone, getProvider } = require('../services/whatsapp');
const { analyzeAndAlert, buildMessage } = require('../services/alertEngine');
const { triggerNow } = require('../services/scheduler');
const { logEvent } = require('../services/logger');

const router = express.Router();

// ── GET /api/notifications/status ───────────────────────────
// Get current user's notification settings + provider status
router.get('/status', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT whatsapp_number, whatsapp_enabled, notifications_config, monthly_goal
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    const user = result.rows[0];
    const provider = getProvider();

    // Count alerts sent this month
    const countResult = await query(
      `SELECT alert_type, status, COUNT(*) AS cnt
       FROM notification_alerts
       WHERE user_id = $1 AND sent_at > date_trunc('month', NOW())
       GROUP BY alert_type, status`,
      [req.user.id]
    );

    res.json({
      whatsappNumber:        user?.whatsapp_number || null,
      whatsappEnabled:       user?.whatsapp_enabled || false,
      notificationsConfig:   user?.notifications_config || {},
      monthlyGoal:           user?.monthly_goal || null,
      provider,
      providerConfigured:    provider !== 'mock',
      alertStats:            countResult.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/notifications/settings ─────────────────────────
// Update notification preferences
router.put('/settings', authenticate, [
  body('whatsappEnabled').optional().isBoolean(),
  body('whatsappNumber').optional().trim(),
  body('monthlyGoal').optional().isFloat({ min: 0 }),
  body('notificationsConfig').optional().isObject(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { whatsappEnabled, whatsappNumber, monthlyGoal, notificationsConfig } = req.body;

    // Validate phone if provided
    let formattedPhone = undefined;
    if (whatsappNumber !== undefined) {
      if (whatsappNumber === '' || whatsappNumber === null) {
        formattedPhone = null;
      } else {
        try {
          formattedPhone = formatPhone(whatsappNumber);
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
      }
    }

    const sets  = [];
    const vals  = [];
    let   idx   = 1;

    if (whatsappEnabled  !== undefined) { sets.push(`whatsapp_enabled = $${idx++}`);      vals.push(whatsappEnabled); }
    if (formattedPhone   !== undefined) { sets.push(`whatsapp_number = $${idx++}`);       vals.push(formattedPhone); }
    if (monthlyGoal      !== undefined) { sets.push(`monthly_goal = $${idx++}`);           vals.push(monthlyGoal || null); }
    if (notificationsConfig !== undefined) {
      sets.push(`notifications_config = $${idx++}`);
      vals.push(JSON.stringify(notificationsConfig));
    }
    sets.push(`updated_at = NOW()`);

    if (sets.length === 1) return res.status(400).json({ error: 'Nothing to update' });

    vals.push(req.user.id);
    const result = await query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}
       RETURNING whatsapp_number, whatsapp_enabled, notifications_config, monthly_goal`,
      vals
    );

    await logEvent('info', 'whatsapp',
      `Notification settings updated by user ${req.user.email}`,
      null, null, req.user.id
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/notifications/test ────────────────────────────
// Send a test message to the user's configured number
router.post('/test', authenticate, async (req, res) => {
  try {
    const userResult = await query(
      'SELECT whatsapp_number, name FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userResult.rows[0];

    // Allow override phone in body for testing before saving
    const rawPhone = req.body.phone || user?.whatsapp_number;

    if (!rawPhone) {
      return res.status(400).json({
        error: 'Nenhum número configurado. Salve um número no perfil primeiro.',
      });
    }

    // FIX #11: validate phone before sending — return clear 400 instead of raw throw
    let phone;
    try {
      phone = formatPhone(rawPhone);
    } catch (phoneErr) {
      return res.status(400).json({
        error: `Número inválido: ${phoneErr.message}. Use o formato +5511999999999.`,
      });
    }

    const message =
      `🏥 *Medwork Centro Médico*\n\n` +
      `✅ *Teste de Notificação*\n\n` +
      `Olá, ${user?.name || 'usuário'}! Suas notificações WhatsApp estão funcionando corretamente.\n\n` +
      `📊 Você receberá alertas sobre:\n` +
      `• Metas de receita\n` +
      `• Crescimento/queda do MRR\n` +
      `• Concentração de clientes\n` +
      `• Novos contratos criados\n\n` +
      `_Enviado por Medwork em ${new Date().toLocaleString('pt-BR')}_`;

    const result = await sendWhatsAppMessage(phone, message);

    await logEvent('info', 'whatsapp',
      `Test message sent to ${phone.slice(0, 7)}***`, null, null, req.user.id
    );

    res.json({
      success: true,
      provider: result.provider,
      messageId: result.messageId,
      phone: phone.slice(0, 7) + '***' + phone.slice(-2),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/notifications/trigger ─────────────────────────
// Manually run the full alert analysis for current user
router.post('/trigger', authenticate, async (req, res) => {
  try {
    const results = await analyzeAndAlert(req.user.id);
    res.json({ results, triggeredAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/notifications/trigger-all ─────────────────────
// Admin: run daily check for all users immediately
router.post('/trigger-all', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  try {
    // Run async, respond immediately
    triggerNow().catch(err =>
      logEvent('error', 'scheduler', `Manual trigger failed: ${err.message}`)
    );
    res.json({ message: 'Daily check triggered. Results will appear in logs.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/notifications/history ──────────────────────────
// Recent alert history for this user
router.get('/history', authenticate, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await query(
      `SELECT na.*, c.company_name
       FROM notification_alerts na
       LEFT JOIN contracts c ON na.contract_id = c.id
       WHERE na.user_id = $1
       ORDER BY na.sent_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, parseInt(limit), parseInt(offset)]
    );
    const count = await query(
      'SELECT COUNT(*) FROM notification_alerts WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ alerts: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/notifications/preview/:type ────────────────────
// Preview what a message would look like without sending
router.get('/preview/:type', authenticate, async (req, res) => {
  const { type } = req.params;
  const sampleData = {
    below_goal:       { mrr: 12500, goal: 20000, avgTicket: 1500, contractsNeeded: 5 },
    negative_growth:  { mrr: 10000, prevMrr: 13000, growth: -23.1 },
    strong_growth:    { mrr: 18000, prevMrr: 14000, growth: 28.6 },
    client_risk:      { concentration: 67, topCount: 2, mrr: 15000 },
    contract_created: { companyName: 'Empresa Exemplo Ltda', value: 2500, month: '2025-01', contaAzul: true, totalContracts: 12 },
  };

  if (!sampleData[type]) {
    return res.status(400).json({ error: `Unknown alert type: ${type}` });
  }

  const message = buildMessage(type, sampleData[type]);
  res.json({ type, message, sampleData: sampleData[type] });
});

module.exports = router;
