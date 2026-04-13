const express = require('express');
const { authenticate }                    = require('../middleware/auth');
const { query }                           = require('../config/database');
const { generateInsights, generateForecast } = require('../services/aiInsights');

const router = express.Router();

// ── Helper: get stable prev-month string ─────────────────────
// FIX #8: avoid Date.setMonth() boundary mutation bug
function getPrevMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - 1, 1)
    .toISOString()
    .slice(0, 7);
}

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7);
}

// ── GET /api/dashboard/metrics ───────────────────────────────
router.get('/metrics', authenticate, async (req, res) => {
  try {
    const currentMonth = getCurrentMonth();
    const prevMonth    = getPrevMonth();

    const [mrrResult, prevMrrResult, totalResult, revenueHistory, contractsByMonth] =
      await Promise.all([
        query(`
          SELECT COUNT(*)                     AS active_contracts,
                 COALESCE(SUM(net_value), 0)  AS mrr,
                 COALESCE(AVG(net_value), 0)  AS avg_ticket
          FROM contracts
          WHERE status = 'success' AND month = $1`, [currentMonth]),

        query(`
          SELECT COALESCE(SUM(net_value), 0) AS prev_mrr
          FROM contracts
          WHERE status = 'success' AND month = $1`, [prevMonth]),

        query(`
          SELECT COALESCE(SUM(net_value), 0) AS total
          FROM contracts WHERE status = 'success'`),

        query(`
          SELECT month,
                 COALESCE(SUM(net_value), 0) AS revenue,
                 COUNT(*)                     AS contract_count
          FROM contracts
          WHERE status = 'success'
          GROUP BY month ORDER BY month ASC LIMIT 12`),

        query(`
          SELECT month,
                 COUNT(*)                                              AS total,
                 COUNT(*) FILTER (WHERE status = 'success')           AS success,
                 COUNT(*) FILTER (WHERE status = 'error')             AS error,
                 COUNT(*) FILTER (WHERE status = 'ca_error')          AS ca_error
          FROM contracts
          GROUP BY month ORDER BY month ASC LIMIT 12`),
      ]);

    const mrr     = parseFloat(mrrResult.rows[0].mrr)           || 0;
    const prevMrr = parseFloat(prevMrrResult.rows[0].prev_mrr)  || 0;

    res.json({
      mrr,
      arr:             mrr * 12,
      prevMrr,
      momGrowth:       prevMrr > 0 ? ((mrr - prevMrr) / prevMrr) * 100 : 0,
      totalRevenue:    parseFloat(totalResult.rows[0].total)              || 0,
      activeContracts: parseInt(mrrResult.rows[0].active_contracts)       || 0,
      averageTicket:   parseFloat(mrrResult.rows[0].avg_ticket)           || 0,
      revenueHistory:  revenueHistory.rows,
      contractsByMonth: contractsByMonth.rows,
    });
  } catch (err) {
    console.error('GET /metrics error:', err.message);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// ── GET /api/dashboard/forecast ──────────────────────────────
router.get('/forecast', authenticate, async (req, res) => {
  try {
    const months = Math.min(24, Math.max(1, parseInt(req.query.months) || 12));

    const revenueHistory = await query(`
      SELECT month, COALESCE(SUM(net_value), 0) AS revenue
      FROM contracts WHERE status = 'success'
      GROUP BY month ORDER BY month ASC LIMIT 24`);

    const forecast = generateForecast(revenueHistory.rows, months);
    res.json({ forecast, historical: revenueHistory.rows });
  } catch (err) {
    console.error('GET /forecast error:', err.message);
    res.status(500).json({ error: 'Failed to generate forecast' });
  }
});

// ── GET /api/dashboard/insights ──────────────────────────────
router.get('/insights', authenticate, async (req, res) => {
  try {
    const currentMonth = getCurrentMonth();
    const prevMonth    = getPrevMonth();

    const [mrrResult, prevResult] = await Promise.all([
      query(`SELECT COALESCE(SUM(net_value),0) AS mrr,
                    COUNT(*) AS contracts,
                    COALESCE(AVG(net_value),0) AS avg_ticket
             FROM contracts WHERE status='success' AND month=$1`, [currentMonth]),
      query(`SELECT COALESCE(SUM(net_value),0) AS prev_mrr
             FROM contracts WHERE status='success' AND month=$1`, [prevMonth]),
    ]);

    const mrr     = parseFloat(mrrResult.rows[0].mrr)          || 0;
    const prevMrr = parseFloat(prevResult.rows[0].prev_mrr)    || 0;

    const metrics = {
      mrr,
      arr:            mrr * 12,
      activeContracts: parseInt(mrrResult.rows[0].contracts)   || 0,
      averageTicket:  parseFloat(mrrResult.rows[0].avg_ticket) || 0,
      momGrowth:      prevMrr > 0 ? ((mrr - prevMrr) / prevMrr) * 100 : 0,
      monthlyGoal:    parseFloat(req.query.goal) || null,
    };

    const insights = await generateInsights(metrics);
    res.json({ insights, metrics });
  } catch (err) {
    console.error('GET /insights error:', err.message);
    res.status(500).json({ error: 'Failed to generate insights' });
  }
});

// ── POST /api/dashboard/simulate ─────────────────────────────
router.post('/simulate', authenticate, async (req, res) => {
  try {
    const { contracts, averageValue, months = 12 } = req.body;
    if (!contracts || !averageValue) {
      return res.status(400).json({ error: 'contracts and averageValue are required' });
    }

    const n   = Math.max(1, parseInt(contracts));
    const v   = Math.max(0, parseFloat(averageValue));
    const m   = Math.min(60, Math.max(1, parseInt(months)));
    const mrr = n * v;

    const projection = [];
    for (let i = 1; i <= m; i++) {
      const d = new Date();
      d.setMonth(d.getMonth() + i);
      projection.push({
        month:    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        contracts: n,
        revenue:  parseFloat((mrr * Math.pow(1.05, i - 1)).toFixed(2)),
      });
    }

    res.json({
      mrr,
      arr:           mrr * 12,
      monthlyRevenue: mrr,
      projection,
      summary: { contracts: n, averageValue: v, totalYear: mrr * 12 },
    });
  } catch (err) {
    console.error('POST /simulate error:', err.message);
    res.status(500).json({ error: 'Simulation failed' });
  }
});

module.exports = router;
