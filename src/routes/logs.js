const express = require('express');
const { authenticate } = require('../middleware/auth');
const { query }        = require('../config/database');

const router = express.Router();

// ── GET /api/logs ────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { level, category, contractId, limit = 100, offset = 0 } = req.query;

    const conditions = [];
    const params     = [];
    let   idx        = 1;

    if (level)      { conditions.push(`l.level = $${idx++}`);       params.push(level); }
    if (category)   { conditions.push(`l.category = $${idx++}`);    params.push(category); }
    if (contractId) { conditions.push(`l.contract_id = $${idx++}`); params.push(contractId); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [listResult, countResult] = await Promise.all([
      query(
        `SELECT l.*, c.company_name, pf.original_name AS file_name
         FROM logs l
         LEFT JOIN contracts c      ON l.contract_id = c.id
         LEFT JOIN processed_files pf ON l.file_id   = pf.id
         ${where}
         ORDER BY l.created_at DESC
         LIMIT $${idx++} OFFSET $${idx++}`,
        [...params, parseInt(limit), parseInt(offset)]
      ),
      query(`SELECT COUNT(*) FROM logs l ${where}`, params),
    ]);

    res.json({
      logs:  listResult.rows,
      total: parseInt(countResult.rows[0].count),
    });
  } catch (err) {
    console.error('GET /logs error:', err.message);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// ── DELETE /api/logs/clear ───────────────────────────────────
// FIX #7: parameterised INTERVAL — no string interpolation
router.delete('/clear', authenticate, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.body?.days ?? 30) || 30));
    const result = await query(
      `DELETE FROM logs WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`,
      [days]
    );
    res.json({ message: `${result.rowCount} logs apagados (mais antigos que ${days} dias)` });
  } catch (err) {
    console.error('DELETE /logs/clear error:', err.message);
    res.status(500).json({ error: 'Failed to clear logs' });
  }
});

module.exports = router;
