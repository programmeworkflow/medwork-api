const express = require('express');
const { authenticate } = require('../middleware/auth');
const { query } = require('../config/database');

const router = express.Router();

// GET /api/contracts - list all contracts with filters
router.get('/', authenticate, async (req, res) => {
  try {
    const { month, status, search, limit = 50, offset = 0 } = req.query;
    
    let conditions = [];
    let params = [];
    let idx = 1;

    if (month) { conditions.push(`month = $${idx++}`); params.push(month); }
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (search) {
      conditions.push(`(company_name ILIKE $${idx} OR cnpj ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    
    const result = await query(
      `SELECT c.*, u.name as created_by_name
       FROM contracts c
       LEFT JOIN users u ON c.created_by = u.id
       ${where}
       ORDER BY c.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM contracts ${where}`,
      params
    );

    res.json({
      contracts: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Contracts list error:', error);
    res.status(500).json({ error: 'Failed to fetch contracts' });
  }
});

// GET /api/contracts/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT c.*, u.name as created_by_name,
       pf.original_name as file_name, pf.status as file_status
       FROM contracts c
       LEFT JOIN users u ON c.created_by = u.id
       LEFT JOIN processed_files pf ON pf.contract_id = c.id
       WHERE c.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contract not found' });
    }

    // Get contract logs
    const logs = await query(
      'SELECT * FROM logs WHERE contract_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );

    res.json({ ...result.rows[0], logs: logs.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch contract' });
  }
});

// DELETE /api/contracts/:id
router.delete('/:id', authenticate, async (req, res) => {
  try {
    await query('DELETE FROM logs WHERE contract_id = $1', [req.params.id]);
    await query('UPDATE processed_files SET contract_id = NULL WHERE contract_id = $1', [req.params.id]);
    const result = await query('DELETE FROM contracts WHERE id = $1 RETURNING id', [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contract not found' });
    }
    res.json({ message: 'Contract deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete contract' });
  }
});

module.exports = router;
