const express = require('express');
const multer  = require('multer');

const { authenticate } = require('../middleware/auth');
const { query }        = require('../config/database');
const {
  encryptCertificate,
  parseCertificateInfo,
} = require('../services/esocialCert');

const router = express.Router();

// Require admin OR financeiro role
function requireAdminOrFinanceiro(req, res, next) {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'financeiro') {
    return res.status(403).json({ error: 'Acesso restrito a admin ou financeiro' });
  }
  next();
}

// Certificate upload: in-memory (small file, never written to disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB is plenty for .pfx
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    if (name.endsWith('.pfx') || name.endsWith('.p12')) return cb(null, true);
    cb(new Error('Apenas arquivos .pfx ou .p12 são aceitos'));
  },
});

// ──────────────────────────────────────────────────────────────
// POST /api/esocial/upload-certificate
// Body: multipart — `cert` (file) + `password` (field)
// ──────────────────────────────────────────────────────────────
router.post(
  '/upload-certificate',
  authenticate,
  requireAdminOrFinanceiro,
  upload.single('cert'),
  async (req, res) => {
    try {
      const file = req.file;
      const password = req.body?.password;

      if (!file)     return res.status(400).json({ error: 'Arquivo do certificado obrigatório (.pfx/.p12)' });
      if (!password) return res.status(400).json({ error: 'Senha do certificado obrigatória' });

      // 1. Parse certificate (validates the password as a side effect)
      let info;
      try {
        info = parseCertificateInfo(file.buffer, password);
      } catch (err) {
        return res.status(422).json({ error: err.message });
      }

      if (!info.cnpj) {
        return res.status(422).json({
          error: 'Não foi possível extrair o CNPJ do certificado. Verifique se é um certificado ICP-Brasil válido.',
          subject: info.subject,
        });
      }

      // 2. Warn if already expired
      if (info.validUntil && info.validUntil < new Date()) {
        return res.status(422).json({
          error: `Certificado vencido em ${info.validUntil.toISOString().slice(0, 10)}`,
        });
      }

      // 3. Encrypt
      const enc = encryptCertificate(file.buffer, password);

      // 4. Deactivate any previous certificate (only one active at a time)
      await query(`UPDATE esocial_config SET active = false WHERE active = true`);

      // 5. Insert new active certificate
      const result = await query(
        `INSERT INTO esocial_config
           (cnpj_titular, nome_titular, certificate_encrypted, password_encrypted, iv, valid_until, active)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         RETURNING id, cnpj_titular, nome_titular, valid_until, uploaded_at, active`,
        [
          info.cnpj,
          info.nome,
          enc.certificateEncrypted,
          enc.passwordEncrypted,
          enc.iv,
          info.validUntil || null,
        ]
      );

      return res.json({
        success: true,
        config: result.rows[0],
        parsed: {
          cnpj: info.cnpj,
          nome: info.nome,
          validFrom: info.validFrom,
          validUntil: info.validUntil,
          subject: info.subject,
        },
      });
    } catch (err) {
      console.error('[esocial/upload-certificate]', err);
      return res.status(500).json({ error: err.message || 'Erro interno' });
    }
  }
);

// ──────────────────────────────────────────────────────────────
// GET /api/esocial/config
// Returns the active config (no certificate bytes)
// ──────────────────────────────────────────────────────────────
router.get('/config', authenticate, requireAdminOrFinanceiro, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, cnpj_titular, nome_titular, valid_until, uploaded_at, active
         FROM esocial_config
        WHERE active = true
        ORDER BY uploaded_at DESC
        LIMIT 1`
    );
    return res.json({ config: result.rows[0] || null });
  } catch (err) {
    console.error('[esocial/config]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// DELETE /api/esocial/config/:id
// ──────────────────────────────────────────────────────────────
router.delete('/config/:id', authenticate, requireAdminOrFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(`DELETE FROM esocial_config WHERE id = $1 RETURNING id`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Configuração não encontrada' });
    }
    return res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('[esocial/config/:id DELETE]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/esocial/empresas
// ──────────────────────────────────────────────────────────────
router.get('/empresas', authenticate, requireAdminOrFinanceiro, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, cnpj, razao_social, sincronizado_em, procuracao_ativa, created_at
         FROM esocial_empresas
        ORDER BY razao_social NULLS LAST, cnpj`
    );
    return res.json({ empresas: result.rows });
  } catch (err) {
    console.error('[esocial/empresas]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/esocial/funcionarios?empresa_id=X&situacao=Y
// ──────────────────────────────────────────────────────────────
router.get('/funcionarios', authenticate, requireAdminOrFinanceiro, async (req, res) => {
  try {
    const { empresa_id, situacao } = req.query;
    const conds = [];
    const params = [];
    if (empresa_id) { params.push(empresa_id); conds.push(`empresa_id = $${params.length}`); }
    if (situacao)   { params.push(situacao);   conds.push(`situacao = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const result = await query(
      `SELECT id, empresa_id, cnpj_empresa, cpf, nome, matricula,
              data_admissao, data_desligamento, situacao, cargo,
              ultimo_evento_id, ultima_sync
         FROM esocial_funcionarios
         ${where}
         ORDER BY nome
         LIMIT 1000`,
      params
    );
    return res.json({ funcionarios: result.rows });
  } catch (err) {
    console.error('[esocial/funcionarios]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
