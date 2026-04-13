const express = require('express');
const bcrypt  = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { query }        = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/users/profile ───────────────────────────────────
// FIX #3: return all new whatsapp/goal fields
router.get('/profile', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, email, phone, role,
              whatsapp_number, whatsapp_enabled, monthly_goal,
              notifications_config, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /profile error:', err.message);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ── PUT /api/users/profile ───────────────────────────────────
// FIX #2: use !== undefined so empty string clears the field;
//         check email uniqueness before updating
router.put('/profile', authenticate, [
  body('name').optional().trim().notEmpty().withMessage('Name cannot be blank'),
  body('phone').optional().trim(),
  body('email').optional().isEmail().normalizeEmail(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { name, phone, email } = req.body;

    // Duplicate email check
    if (email) {
      const clash = await query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [email, req.user.id]
      );
      if (clash.rows.length) {
        return res.status(409).json({ error: 'E-mail já utilizado por outro usuário' });
      }
    }

    const sets   = [];
    const values = [];
    let   idx    = 1;

    // FIX: use !== undefined (not truthy) so we can set phone to empty string
    if (name  !== undefined) { sets.push(`name  = $${idx++}`); values.push(name); }
    if (phone !== undefined) { sets.push(`phone = $${idx++}`); values.push(phone || null); }
    if (email !== undefined) { sets.push(`email = $${idx++}`); values.push(email); }
    sets.push('updated_at = NOW()');

    if (sets.length === 1) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.user.id);
    const result = await query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}
       RETURNING id, name, email, phone, role, whatsapp_number, whatsapp_enabled, monthly_goal`,
      values
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /profile error:', err.message);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ── PUT /api/users/password ──────────────────────────────────
router.put('/password', authenticate, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { currentPassword, newPassword } = req.body;
    const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Senha atual incorreta' });

    const newHash = await bcrypt.hash(newPassword, 10);
    await query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, req.user.id]
    );
    res.json({ message: 'Senha alterada com sucesso' });
  } catch (err) {
    console.error('PUT /password error:', err.message);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

module.exports = router;
