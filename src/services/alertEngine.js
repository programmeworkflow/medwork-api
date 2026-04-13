const { query } = require('../config/database');
const { sendWhatsAppMessage } = require('./whatsapp');
const { logEvent } = require('./logger');

// ── Safe number formatter ─────────────────────────────────────
function fmt(n, decimals = 2) {
  return Number(n || 0).toFixed(decimals);
}

function fmtBRL(n) {
  return `R$ ${fmt(n, 2)}`;
}


// ── Cooldown: 1 message per alert type per user per day ─────
const COOLDOWN_HOURS = 24;

async function isOnCooldown(userId, alertType) {
  const result = await query(
    `SELECT id FROM notification_alerts
     WHERE user_id   = $1
       AND alert_type = $2
       AND status    != 'failed'
       AND sent_at   > NOW() - INTERVAL '${COOLDOWN_HOURS} hours'
     LIMIT 1`,
    [userId, alertType]
  );
  return result.rows.length > 0;
}

async function recordAlert({ userId, alertType, phone, message, status, error, contractId }) {
  await query(
    `INSERT INTO notification_alerts
       (user_id, alert_type, phone_number, message, status, error, contract_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, alertType, phone, message, status, error || null, contractId || null]
  );
}

// ── Message templates ────────────────────────────────────────
function buildMessage(type, data) {
  const header = '🏥 *Medwork Centro Médico*\n';

  switch (type) {
    case 'below_goal':
      return (
        header +
        `📊 *Alerta: Abaixo da Meta*\n\n` +
        `Sua receita atual é de *${fmtBRL(data.mrr)}*.\n` +
        `Você precisa de mais *${data.contractsNeeded} contratos* ` +
        `(ticket médio ${fmtBRL(data.avgTicket)}) ` +
        `para atingir sua meta de *${fmtBRL(data.goal)}*.\n\n` +
        `💡 Hora de prospectar! Acesse o sistema para detalhes.`
      );

    case 'negative_growth':
      return (
        header +
        `📉 *Alerta: Queda na Receita*\n\n` +
        `Sua receita caiu *${fmt(Math.abs(data.growth || 0), 1)}%* este mês.\n` +
        `MRR atual: *${fmtBRL(data.mrr)}* ` +
        `(era ${fmtBRL(data.prevMrr)} no mês anterior).\n\n` +
        `⚠️ Verifique cancelamentos e inadimplências no sistema.`
      );

    case 'strong_growth':
      return (
        header +
        `📈 *Parabéns! Crescimento Forte*\n\n` +
        `Sua receita cresceu *${fmt(data.growth, 1)}%* este mês! 🎉\n` +
        `MRR atual: *${fmtBRL(data.mrr)}*\n` +
        `ARR projetado: *R$ ${fmt((data.mrr || 0) * 12, 2)}*\n\n` +
        `🚀 Continue assim! Ótimo momento para expandir.`
      );

    case 'client_risk':
      return (
        header +
        `⚠️ *Alerta: Concentração de Clientes*\n\n` +
        `Os *${data.topCount} maiores clientes* representam ` +
        `*${fmt(data.concentration, 0)}%* da sua receita.\n\n` +
        `📌 Alta concentração é um risco. Diversifique sua carteira.`
      );

    case 'contract_created':
      return (
        header +
        `✅ *Novo Contrato Criado!*\n\n` +
        `Empresa: *${data.companyName}*\n` +
        `Valor: *${fmtBRL(data.value)}/mês*\n` +
        `Mês de referência: *${data.month}*\n` +
        (data.contaAzul ? `Conta Azul: ✅ Sincronizado\n` : `Conta Azul: ⏳ Pendente\n`) +
        `\n💼 Total de contratos este mês: *${data.totalContracts}*`
      );

    default:
      return header + `Notificação: ${type}`;
  }
}

// ── Core: send one alert to one user ────────────────────────
async function sendAlert({ userId, alertType, data, contractId }) {
  try {
    // 1. Load user preferences
    const userResult = await query(
      `SELECT whatsapp_number, whatsapp_enabled, notifications_config, monthly_goal, name
       FROM users WHERE id = $1`,
      [userId]
    );

    if (!userResult.rows.length) return { skipped: 'user_not_found' };
    const user = userResult.rows[0];

    // 2. Check if notifications are enabled globally
    if (!user.whatsapp_enabled) {
      return { skipped: 'notifications_disabled' };
    }

    // 3. Check if this specific alert type is enabled
    const config = user.notifications_config || {};
    if (config[alertType] === false) {
      return { skipped: `alert_type_disabled:${alertType}` };
    }

    // 4. Check phone number
    if (!user.whatsapp_number) {
      return { skipped: 'no_phone_number' };
    }

    // 5. Cooldown check
    const cooled = await isOnCooldown(userId, alertType);
    if (cooled) {
      await logEvent('info', 'whatsapp',
        `Cooldown active for ${alertType} → skipping`, null, null, userId
      );
      await recordAlert({
        userId, alertType, phone: user.whatsapp_number,
        message: '[COOLDOWN]', status: 'skipped_cooldown', contractId,
      });
      return { skipped: 'cooldown' };
    }

    // 6. Build and send
    const enriched = { ...data, goal: data.goal ?? user.monthly_goal };
    const message = buildMessage(alertType, enriched);

    await sendWhatsAppMessage(user.whatsapp_number, message);

    await recordAlert({
      userId, alertType, phone: user.whatsapp_number,
      message, status: 'sent', contractId,
    });

    await logEvent('info', 'whatsapp',
      `Alert sent: ${alertType} to user ${userId}`, null, null, userId
    );

    return { sent: true, alertType, phone: user.whatsapp_number };

  } catch (err) {
    await logEvent('error', 'whatsapp',
      `Alert failed [${alertType}]: ${err.message}`, null, null, userId
    );

    // Record failure (but don't block cooldown — allow retry)
    await query(
      `INSERT INTO notification_alerts (user_id, alert_type, phone_number, message, status, error, contract_id)
       VALUES ($1, $2, $3, $4, 'failed', $5, $6)`,
      [userId, alertType, null, buildMessage(alertType, data), err.message, contractId || null]
    ).catch(() => {}); // swallow logger errors

    return { failed: true, error: err.message };
  }
}

// ── Financial analysis for daily check ──────────────────────
async function analyzeAndAlert(userId) {
  const results = [];

  try {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const prevDate = new Date();
    prevDate.setMonth(prevDate.getMonth() - 1);
    const prevMonth = prevDate.toISOString().slice(0, 7);

    // Fetch MRR data
    const [currResult, prevResult, userResult] = await Promise.all([
      query(`SELECT COALESCE(SUM(net_value),0) AS mrr, COUNT(*) AS cnt, COALESCE(AVG(net_value),0) AS avg_ticket
             FROM contracts WHERE status='success' AND month=$1`, [currentMonth]),
      query(`SELECT COALESCE(SUM(net_value),0) AS mrr FROM contracts WHERE status='success' AND month=$1`, [prevMonth]),
      query(`SELECT monthly_goal, whatsapp_enabled FROM users WHERE id=$1`, [userId]),
    ]);

    const mrr        = parseFloat(currResult.rows[0].mrr)  || 0;
    const prevMrr    = parseFloat(prevResult.rows[0].mrr)  || 0;
    const avgTicket  = parseFloat(currResult.rows[0].avg_ticket) || 0;
    const totalContr = parseInt(currResult.rows[0].cnt) || 0;
    const goal       = parseFloat(userResult.rows[0]?.monthly_goal) || 0;
    const growth     = prevMrr > 0 ? ((mrr - prevMrr) / prevMrr) * 100 : 0;

    // ALERT 1: Below goal
    if (goal > 0 && mrr < goal) {
      const contractsNeeded = Math.ceil((goal - mrr) / (avgTicket || 1));
      const r = await sendAlert({
        userId, alertType: 'below_goal',
        data: { mrr, goal, avgTicket, contractsNeeded },
      });
      results.push({ type: 'below_goal', ...r });
    }

    // ALERT 2: Negative growth (> -5%)
    if (prevMrr > 0 && growth < -5) {
      const r = await sendAlert({
        userId, alertType: 'negative_growth',
        data: { mrr, prevMrr, growth },
      });
      results.push({ type: 'negative_growth', ...r });
    }

    // ALERT 3: Strong growth (> +15%)
    if (prevMrr > 0 && growth > 15) {
      const r = await sendAlert({
        userId, alertType: 'strong_growth',
        data: { mrr, prevMrr, growth },
      });
      results.push({ type: 'strong_growth', ...r });
    }

    // ALERT 4: Client risk — top 3 clients > 50% of revenue
    const topResult = await query(
      `SELECT company_name, SUM(net_value) AS rev
       FROM contracts WHERE status='success' AND month=$1
       GROUP BY company_name ORDER BY rev DESC LIMIT 3`,
      [currentMonth]
    );
    if (mrr > 0 && topResult.rows.length > 0) {
      const topRevenue    = topResult.rows.reduce((a, r) => a + parseFloat(r.rev), 0);
      const concentration = (topRevenue / mrr) * 100;
      if (concentration > 50) {
        const r = await sendAlert({
          userId, alertType: 'client_risk',
          data: { concentration, topCount: topResult.rows.length, mrr },
        });
        results.push({ type: 'client_risk', ...r });
      }
    }

    return results;
  } catch (err) {
    await logEvent('error', 'whatsapp', `analyzeAndAlert failed: ${err.message}`, null, null, userId);
    return [{ failed: true, error: err.message }];
  }
}

// ── On contract creation ─────────────────────────────────────
async function alertContractCreated({ userId, companyName, value, month, contaAzul, contractId }) {
  try {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const countResult = await query(
      `SELECT COUNT(*) AS cnt FROM contracts WHERE status='success' AND month=$1`,
      [currentMonth]
    );
    const totalContracts = parseInt(countResult.rows[0].cnt) || 1;

    return await sendAlert({
      userId,
      alertType: 'contract_created',
      data: { companyName, value, month, contaAzul, totalContracts },
      contractId,
    });
  } catch (err) {
    await logEvent('error', 'whatsapp', `alertContractCreated failed: ${err.message}`);
    return { failed: true, error: err.message };
  }
}

module.exports = {
  sendAlert,
  analyzeAndAlert,
  alertContractCreated,
  buildMessage,
};
