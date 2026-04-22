const express = require('express');
const multer  = require('multer');
const axios   = require('axios');

const { authenticate } = require('../middleware/auth');
const { query }        = require('../config/database');
const {
  encryptCertificate,
  decryptCertificate,
  parseCertificateInfo,
} = require('../services/esocialCert');
const { resetAgentCache } = require('../services/esocialClient');
const { syncEmpresa }     = require('../services/esocialSync');

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

      // Invalidate cached https.Agent so next sync uses the new cert
      resetAgentCache();

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
    resetAgentCache();
    return res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('[esocial/config/:id DELETE]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/esocial/empresas
// Returns each empresa with a count of funcionários.
// ──────────────────────────────────────────────────────────────
router.get('/empresas', authenticate, requireAdminOrFinanceiro, async (req, res) => {
  try {
    const result = await query(
      `SELECT em.id, em.cnpj, em.razao_social, em.sincronizado_em,
              em.procuracao_ativa, em.created_at,
              COALESCE(cnt.total, 0)::int       AS total_funcionarios,
              COALESCE(cnt.ativos, 0)::int      AS funcionarios_ativos,
              COALESCE(cnt.desligados, 0)::int  AS funcionarios_desligados
         FROM esocial_empresas em
         LEFT JOIN (
           SELECT empresa_id,
                  COUNT(*)                                   AS total,
                  COUNT(*) FILTER (WHERE situacao='ativo')    AS ativos,
                  COUNT(*) FILTER (WHERE situacao='desligado')AS desligados
             FROM esocial_funcionarios
            GROUP BY empresa_id
         ) cnt ON cnt.empresa_id = em.id
        ORDER BY em.razao_social NULLS LAST, em.cnpj`
    );
    return res.json({ empresas: result.rows });
  } catch (err) {
    console.error('[esocial/empresas]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// POST /api/esocial/empresas
// Body: { cnpj: string, razao_social?: string }
// Upserts by CNPJ.
// ──────────────────────────────────────────────────────────────
router.post('/empresas', authenticate, requireAdminOrFinanceiro, async (req, res) => {
  try {
    const rawCnpj = String(req.body?.cnpj || '').replace(/\D/g, '');
    const razaoSocial = (req.body?.razao_social || '').toString().trim();

    if (rawCnpj.length !== 14) {
      return res.status(400).json({ error: 'CNPJ inválido (precisa ter 14 dígitos)' });
    }

    const result = await query(
      `INSERT INTO esocial_empresas (cnpj, razao_social, procuracao_ativa)
       VALUES ($1, $2, true)
       ON CONFLICT (cnpj) DO UPDATE SET
         razao_social = COALESCE(EXCLUDED.razao_social, esocial_empresas.razao_social),
         procuracao_ativa = true
       RETURNING id, cnpj, razao_social, sincronizado_em, procuracao_ativa, created_at`,
      [rawCnpj, razaoSocial || null]
    );

    return res.json({ empresa: result.rows[0] });
  } catch (err) {
    console.error('[esocial/empresas POST]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// DELETE /api/esocial/empresas/:id
// ──────────────────────────────────────────────────────────────
router.delete('/empresas/:id', authenticate, requireAdminOrFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      `DELETE FROM esocial_empresas WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Empresa não encontrada' });
    }
    return res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('[esocial/empresas/:id DELETE]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// POST /api/esocial/test-login
// Calls the Playwright microservice to verify the stored A1
// certificate can actually authenticate against login.esocial.gov.br.
// Requires env var ESOCIAL_PLAYWRIGHT_URL.
// ──────────────────────────────────────────────────────────────
router.post('/test-login', authenticate, requireAdminOrFinanceiro, async (req, res) => {
  try {
    const playwrightUrl = process.env.ESOCIAL_PLAYWRIGHT_URL;
    if (!playwrightUrl) {
      return res.status(500).json({
        error: 'ESOCIAL_PLAYWRIGHT_URL não configurado no backend',
      });
    }

    // Load active certificate
    const cfg = await query(
      `SELECT certificate_encrypted, password_encrypted, iv
         FROM esocial_config WHERE active = true LIMIT 1`
    );
    if (!cfg.rows.length) {
      return res.status(422).json({
        error: 'Nenhum certificado ativo configurado. Faça upload do certificado A1 antes de testar.',
      });
    }

    const { certificate_encrypted, password_encrypted, iv } = cfg.rows[0];

    let certificate, password;
    try {
      const dec = decryptCertificate(certificate_encrypted, password_encrypted, iv);
      certificate = dec.certificate;
      password = dec.password;
    } catch (err) {
      return res.status(500).json({ error: `Falha ao descriptografar certificado: ${err.message}` });
    }

    // Call the Playwright service
    const url = playwrightUrl.replace(/\/+$/, '') + '/login-test';
    const resp = await axios.post(
      url,
      {
        certificate: certificate.toString('base64'),
        password,
      },
      {
        timeout: 90_000, // login flow budget + network
        validateStatus: () => true, // we propagate the error ourselves
      }
    );

    return res.status(resp.status || 200).json(resp.data);
  } catch (err) {
    console.error('[esocial/test-login]', err);
    return res.status(500).json({
      error: err.message || 'Erro ao testar login no eSocial via Playwright',
    });
  }
});

// ──────────────────────────────────────────────────────────────
// POST /api/esocial/sst/funcionarios
// Calls the Playwright microservice to list active workers of a
// given CNPJ via the eSocial SST portal (Procurador de PJ flow).
// Body: { cnpj, cpfList? }
// ──────────────────────────────────────────────────────────────
router.post('/sst/funcionarios', authenticate, requireAdminOrFinanceiro, async (req, res) => {
  const { cnpj, cpfList } = req.body || {};
  if (!cnpj) return res.status(400).json({ error: 'cnpj é obrigatório' });

  const playwrightUrl = process.env.ESOCIAL_PLAYWRIGHT_URL;
  if (!playwrightUrl) {
    return res.status(500).json({ error: 'ESOCIAL_PLAYWRIGHT_URL não configurado' });
  }

  try {
    const cfg = await query(
      `SELECT certificate_encrypted, password_encrypted, iv
         FROM esocial_config
        WHERE active = true
        ORDER BY uploaded_at DESC
        LIMIT 1`
    );
    if (!cfg.rows.length) {
      return res.status(422).json({ error: 'Nenhum certificado ativo configurado' });
    }

    const { certificate_encrypted, password_encrypted, iv } = cfg.rows[0];
    let certificate, password;
    try {
      const dec = decryptCertificate(certificate_encrypted, password_encrypted, iv);
      certificate = dec.certificate;
      password = dec.password;
    } catch (err) {
      return res.status(500).json({ error: `Falha ao descriptografar certificado: ${err.message}` });
    }

    const url = playwrightUrl.replace(/\/+$/, '') + '/fetch-funcionarios';
    const resp = await axios.post(
      url,
      {
        certificate: certificate.toString('base64'),
        password,
        cnpj: String(cnpj).replace(/\D/g, ''),
        cpfList: Array.isArray(cpfList) ? cpfList : undefined,
      },
      {
        timeout: 10 * 60_000,
        validateStatus: () => true,
      }
    );
    return res.status(resp.status || 200).json(resp.data);
  } catch (err) {
    console.error('[esocial/sst/funcionarios]', err);
    return res.status(500).json({ error: err.message || 'Erro ao consultar funcionários via Playwright' });
  }
});

// ──────────────────────────────────────────────────────────────
// POST /api/esocial/sync/:empresaId
// Triggers an immediate sync for one empresa. Returns the summary.
// ──────────────────────────────────────────────────────────────
router.post('/sync/:empresaId', authenticate, requireAdminOrFinanceiro, async (req, res) => {
  const { empresaId } = req.params;
  try {
    // Ensure we have a certificate first — fail fast with a clear error
    const cfg = await query(`SELECT id FROM esocial_config WHERE active = true LIMIT 1`);
    if (!cfg.rows.length) {
      return res.status(422).json({ error: 'Nenhum certificado ativo configurado. Faça upload do certificado A1 antes de sincronizar.' });
    }

    const summary = await syncEmpresa(empresaId);
    return res.json({ success: true, summary });
  } catch (err) {
    console.error('[esocial/sync/:empresaId]', err);
    return res.status(500).json({ error: err.message || 'Erro ao sincronizar' });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/esocial/funcionarios
// Query: empresa_id, situacao, page (1-based), pageSize (default 25)
// Returns { funcionarios, page, pageSize, total, totalPages }
// ──────────────────────────────────────────────────────────────
router.get('/funcionarios', authenticate, requireAdminOrFinanceiro, async (req, res) => {
  try {
    const { empresa_id, situacao } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 200);

    const conds = [];
    const params = [];
    if (empresa_id) { params.push(empresa_id); conds.push(`f.empresa_id = $${params.length}`); }
    if (situacao)   { params.push(situacao);   conds.push(`f.situacao = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const countRes = await query(
      `SELECT COUNT(*)::int AS total FROM esocial_funcionarios f ${where}`,
      params
    );
    const total = countRes.rows[0]?.total || 0;

    const offset = (page - 1) * pageSize;
    params.push(pageSize);
    params.push(offset);

    const result = await query(
      `SELECT f.id, f.empresa_id, f.cnpj_empresa, f.cpf, f.nome, f.matricula,
              f.data_admissao, f.data_desligamento, f.situacao, f.cargo,
              f.ultimo_evento_id, f.ultima_sync,
              em.razao_social AS empresa_razao_social
         FROM esocial_funcionarios f
         LEFT JOIN esocial_empresas em ON em.id = f.empresa_id
         ${where}
         ORDER BY f.nome
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({
      funcionarios: result.rows,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize) || 0,
    });
  } catch (err) {
    console.error('[esocial/funcionarios]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/esocial/stats
// Dashboard stats: totals and last sync.
// ──────────────────────────────────────────────────────────────
router.get('/stats', authenticate, requireAdminOrFinanceiro, async (req, res) => {
  try {
    const r = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM esocial_empresas WHERE procuracao_ativa = true) AS empresas_ativas,
         (SELECT COUNT(*)::int FROM esocial_empresas) AS empresas_total,
         (SELECT COUNT(*)::int FROM esocial_funcionarios WHERE situacao='ativo') AS func_ativos,
         (SELECT COUNT(*)::int FROM esocial_funcionarios WHERE situacao='desligado') AS func_desligados,
         (SELECT COUNT(*)::int FROM esocial_funcionarios) AS func_total,
         (SELECT MAX(sincronizado_em) FROM esocial_empresas) AS ultima_sync`
    );
    return res.json({ stats: r.rows[0] });
  } catch (err) {
    console.error('[esocial/stats]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
