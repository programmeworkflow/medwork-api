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

router.post('/process', authenticate, upload.single('pdf'), async (req, res) => {
  const { month, companyName } = req.body;
  if (!req.file)                             return res.status(400).json({ error: 'Arquivo PDF obrigatório' });
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Mês obrigatório (YYYY-MM)' });
  if (!companyName?.trim())                  return res.status(400).json({ error: 'Nome da empresa obrigatório' });

  let fileId = null, contractId = null;

  try {
    // 1. Record file
    const fr = await query(
      `INSERT INTO processed_files (original_name, stored_name, file_path, file_size, status, created_by)
       VALUES ($1,$2,$3,$4,'processing',$5) RETURNING id`,
      [req.file.originalname, req.file.filename, req.file.path, req.file.size, req.user.id]
    );
    fileId = fr.rows[0].id;
    await logEvent('info', 'upload', `Arquivo recebido: ${req.file.originalname}`, null, fileId, req.user.id, { month, companyName });

    // 2. Parse PDF
    const pdfBuffer  = await fs.readFile(req.file.path);
    const parsedData = await parsePDF(pdfBuffer, fileId);

    // 3. Create contract record
    const netValue = Math.max(0, (parsedData.monthlyValue || 0) - (parsedData.discount || 0));
    const cr = await query(
      `INSERT INTO contracts (company_name,cnpj,email,services,monthly_value,discount,net_value,observations,month,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'processing',$10) RETURNING *`,
      [companyName.trim(), parsedData.cnpj, parsedData.email, JSON.stringify(parsedData.services||[]),
       parsedData.monthlyValue, parsedData.discount||0, netValue, parsedData.observations, month, req.user.id]
    );
    contractId = cr.rows[0].id;
    await query('UPDATE processed_files SET contract_id=$1 WHERE id=$2', [contractId, fileId]);
    await logEvent('info', 'parse', `Dados extraídos: ${companyName}`, contractId, fileId, req.user.id,
      { cnpj: parsedData.cnpj, monthlyValue: parsedData.monthlyValue, netValue, services: parsedData.services?.length||0 });

    // 4. Conta Azul (real or mock)
    const caFn = process.env.CONTA_AZUL_CLIENT_ID ? processContaAzul : processContaAzulMock;
    let caResult = null;
    try {
      caResult = await caFn({ companyName: companyName.trim(), cnpj: parsedData.cnpj, email: parsedData.email,
        month, monthlyValue: parsedData.monthlyValue, discount: parsedData.discount,
        services: parsedData.services, observations: parsedData.observations }, contractId);
      await query(
        `UPDATE contracts SET status='success', conta_azul_customer_id=$1, conta_azul_contract_id=$2, start_date=$3, updated_at=NOW() WHERE id=$4`,
        [caResult.customerId, caResult.contractId, `${month}-01`, contractId]
      );
    } catch (caErr) {
      await logEvent('error', 'contaazul', `Conta Azul falhou: ${caErr.message}`, contractId, fileId, req.user.id);
      await query("UPDATE contracts SET status='ca_error', updated_at=NOW() WHERE id=$1", [contractId]);
    }

    // 5. Move file
    await moveToFaturado(req.file.filename, month, fileId);
    await query("UPDATE processed_files SET status='done', processed_at=NOW() WHERE id=$1", [fileId]);
    await logEvent('info', 'upload', `Concluído: ${companyName}`, contractId, fileId, req.user.id);

    // 6. Send WhatsApp alert (fire-and-forget — never blocks the response)
    alertContractCreated({
      userId: req.user.id,
      companyName: companyName.trim(),
      value: netValue,
      month,
      contaAzul: !!caResult,
      contractId,
    }).catch(err => console.error('WhatsApp alert failed:', err.message));

    // 7. Return
    const final = await query('SELECT * FROM contracts WHERE id=$1', [contractId]);
    res.json({
      success: true,
      contract: final.rows[0],
      parsed: { cnpj: parsedData.cnpj, email: parsedData.email, services: parsedData.services, monthlyValue: parsedData.monthlyValue, discount: parsedData.discount, netValue },
      contaAzul: caResult ? { customerId: caResult.customerId, contractId: caResult.contractId } : null,
    });

  } catch (error) {
    await logEvent('error', 'upload', `Falha: ${error.message}`, contractId, fileId, req.user.id, { stack: error.stack });
    if (contractId) await query("UPDATE contracts SET status='error', updated_at=NOW() WHERE id=$1", [contractId]);
    if (fileId)     await query("UPDATE processed_files SET status='error' WHERE id=$1", [fileId]);
    res.status(422).json({ error: error.message, contractId });
  }
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
