const { query } = require('../config/database');

// ─── Users ──────────────────────────────────────────────────

async function findUserByEmail(email) {
  const r = await query('SELECT * FROM users WHERE email = $1', [email]);
  return r.rows[0] || null;
}

async function findUserById(id) {
  const r = await query('SELECT id, name, email, phone, role, created_at FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// ─── Contracts ──────────────────────────────────────────────

async function createContract(fields) {
  const { companyName, cnpj, email, services, monthlyValue, discount, netValue, observations, month, createdBy } = fields;
  const r = await query(
    `INSERT INTO contracts
       (company_name, cnpj, email, services, monthly_value, discount, net_value, observations, month, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'processing',$10)
     RETURNING *`,
    [companyName, cnpj, email, JSON.stringify(services || []), monthlyValue, discount || 0, netValue, observations, month, createdBy]
  );
  return r.rows[0];
}

async function updateContractStatus(id, status, extra = {}) {
  const sets = ['status = $1', 'updated_at = NOW()'];
  const vals = [status];
  let idx = 2;
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = $${idx++}`);
    vals.push(v);
  }
  vals.push(id);
  await query(`UPDATE contracts SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
}

async function getContractById(id) {
  const r = await query('SELECT * FROM contracts WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// ─── Files ──────────────────────────────────────────────────

async function createProcessedFile(fields) {
  const { originalName, storedName, filePath, fileSize, createdBy } = fields;
  const r = await query(
    `INSERT INTO processed_files (original_name, stored_name, file_path, file_size, status, created_by)
     VALUES ($1,$2,$3,$4,'processing',$5) RETURNING id`,
    [originalName, storedName, filePath, fileSize, createdBy]
  );
  return r.rows[0].id;
}

async function updateFileStatus(id, status, extra = {}) {
  const sets = ['status = $1'];
  const vals = [status];
  let idx = 2;
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = $${idx++}`);
    vals.push(v);
  }
  vals.push(id);
  await query(`UPDATE processed_files SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
}

module.exports = {
  findUserByEmail, findUserById,
  createContract, updateContractStatus, getContractById,
  createProcessedFile, updateFileStatus
};
