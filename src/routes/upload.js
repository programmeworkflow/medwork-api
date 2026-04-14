const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

const { authenticate }         = require('../middleware/auth');
const { parsePDF }             = require('../services/pdfParser');
const { processContaAzul }     = require('../services/contaAzul');
const { processContaAzulMock } = require('../services/contaAzulMock');
const { moveToFaturado }       = require('../services/fileManager');
const { logEvent }             = require('../services/logger');
const { alertContractCreated } = require('../services/alertEngine');
const { sendContractEmail }    = require('../services/emailNotifier');
const { query }                = require('../config/database');

const router     = express.Router();
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, 'pending');
    fs.ensureDirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => { cb(null, uuidv4() + '.pdf'); },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Apenas PDFs são aceitos'));
    cb(null, true);
  },
});

// ── Process a single file (extracted for reuse in bulk) ──────
async function processSingleFile(file, month, companyName, userId) {
  let fileId = null, contractId = null;

  // 1. Record file
  const fr = await query(
    `INSERT INTO processed_files (original_name, stored_name, file_path, file_size, status, created_by)
     VALUES ($1,$2,$3,$4,'processing',$5) RETURNING id`,
    [file.originalname, file.filename, file.path, file.size, userId]
  );
  fileId = fr.rows[0].id;
  await logEvent('info', 'upload', `Arquivo recebido: ${file.originalname}`, null, fileId, userId, { month, companyName });

  // 2. Parse PDF
  const pdfBuffer  = await fs.readFile(file.path);
  const parsedData = await parsePDF(pdfBuffer, fileId);

  // Use parsed company name as fallback if not provided
  const resolvedCompany = companyName?.trim() || parsedData.companyName || null;
  if (!resolvedCompany) {
    throw new Error('Nome da empresa não fornecido e não encontrado no PDF');
  }

  // 3. Create contract record
  const netValue = Math.max(0, (parsedData.monthlyValue || 0) - (parsedData.discount || 0));
  const cr = await query(
    `INSERT INTO contracts (company_name,cnpj,email,services,monthly_value,discount,net_value,observations,month,status,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'processing',$10) RETURNING *`,
    [resolvedCompany, parsedData.cnpj, parsedData.email, JSON.stringify(parsedData.services||[]),
     parsedData.monthlyValue, parsedData.discount||0, netValue, parsedData.observations, month, userId]
  );
  contractId = cr.rows[0].id;
  await query('UPDATE processed_files SET contract_id=$1 WHERE id=$2', [contractId, fileId]);
  await logEvent('info', 'parse', `Dados extraídos: ${resolvedCompany}`, contractId, fileId, userId,
    { cnpj: parsedData.cnpj, monthlyValue: parsedData.monthlyValue, netValue, services: parsedData.services?.length||0 });

  // 4. Conta Azul — create/find customer, save as pendente_ca
  const caFn = process.env.CONTA_AZUL_CLIENT_ID ? processContaAzul : processContaAzulMock;
  let caResult = null;
  let finalStatus = 'processing';
  try {
    caResult = await caFn({ companyName: resolvedCompany, cnpj: parsedData.cnpj, email: parsedData.email,
      month, monthlyValue: parsedData.monthlyValue, discount: parsedData.discount,
      services: parsedData.services, observations: parsedData.observations }, contractId);
    finalStatus = caResult.contractId ? 'success' : 'pendente_ca';
    await query(
      `UPDATE contracts SET status=$1, conta_azul_customer_id=$2, conta_azul_contract_id=$3, start_date=$4, updated_at=NOW() WHERE id=$5`,
      [finalStatus, caResult.customerId, caResult.contractId, `${month}-01`, contractId]
    );
  } catch (caErr) {
    finalStatus = 'ca_error';
    await logEvent('error', 'contaazul', `Conta Azul falhou: ${caErr.message}`, contractId, fileId, userId);
    await query("UPDATE contracts SET status='ca_error', updated_at=NOW() WHERE id=$1", [contractId]);
  }

  // 5. Move file
  await moveToFaturado(file.filename, month, fileId);
  await query("UPDATE processed_files SET status='done', processed_at=NOW() WHERE id=$1", [fileId]);
  await logEvent('info', 'upload', `Concluído: ${resolvedCompany}`, contractId, fileId, userId);

  // 6. Send WhatsApp alert (fire-and-forget)
  alertContractCreated({
    userId,
    companyName: resolvedCompany,
    value: netValue,
    month,
    contaAzul: !!caResult,
    contractId,
  }).catch(err => console.error('WhatsApp alert failed:', err.message));

  // 7. Send email notification (fire-and-forget)
  sendContractEmail({
    companyName: resolvedCompany,
    cnpj: parsedData.cnpj,
    monthlyValue: parsedData.monthlyValue,
    discount: parsedData.discount || 0,
    netValue,
    services: parsedData.services || [],
    month,
    status: finalStatus,
  }).catch(err => console.error('Email notification failed:', err.message));

  // 8. Return result
  const final = await query('SELECT * FROM contracts WHERE id=$1', [contractId]);
  return {
    success: true,
    contract: final.rows[0],
    parsed: { cnpj: parsedData.cnpj, email: parsedData.email, services: parsedData.services, monthlyValue: parsedData.monthlyValue, discount: parsedData.discount, netValue },
    contaAzul: caResult ? { customerId: caResult.customerId, contractId: caResult.contractId } : null,
  };
}

router.post('/process', authenticate, upload.array('pdf', 20), async (req, res) => {
  const { month, companyName } = req.body;

  // Support both single file and multiple files
  const files = req.files || (req.file ? [req.file] : []);
  if (!files.length)                           return res.status(400).json({ error: 'Arquivo PDF obrigatório' });
  if (!month || !/^\d{4}-\d{2}$/.test(month))  return res.status(400).json({ error: 'Mês obrigatório (YYYY-MM)' });

  // For single file upload, require companyName (unless PDF has it)
  // For bulk upload, companyName is optional (extracted from each PDF)
  if (files.length === 1 && !companyName?.trim()) {
    // Will try to extract from PDF — validated inside processSingleFile
  }

  // Single file — return single result (backward compatible)
  if (files.length === 1) {
    try {
      const result = await processSingleFile(files[0], month, companyName, req.user.id);
      return res.json(result);
    } catch (error) {
      await logEvent('error', 'upload', `Falha: ${error.message}`, null, null, req.user.id, { stack: error.stack });
      return res.status(422).json({ error: error.message });
    }
  }

  // Bulk upload — process each file independently
  const results = [];
  for (const file of files) {
    try {
      const result = await processSingleFile(file, month, companyName, req.user.id);
      results.push(result);
    } catch (error) {
      await logEvent('error', 'upload', `Falha (${file.originalname}): ${error.message}`, null, null, req.user.id);
      results.push({ success: false, error: error.message, file: file.originalname });
    }
  }

  const succeeded = results.filter(r => r.success).length;
  const failed    = results.filter(r => !r.success).length;
  res.json({ success: failed === 0, total: files.length, succeeded, failed, results });
});

router.get('/files', authenticate, async (req, res) => {
  try {
    const { listPending, listFaturado } = require('../services/fileManager');
    const [pending, faturado] = await Promise.all([listPending(), listFaturado()]);
    res.json({ pending, faturado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
