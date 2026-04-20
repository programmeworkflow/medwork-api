/**
 * eSocial client — thin HTTP wrapper around the PHP microservice.
 *
 * The actual SOAP + XML-DSIG work is delegated to a small PHP service that
 * uses nfephp-org/sped-esocial. This module just:
 *  1. Loads the active A1 certificate from esocial_config and decrypts it.
 *  2. Sends {certificate, password, cnpj, ...params} as JSON to PHP.
 *  3. Returns the parsed response (event identifiers / event XML).
 *
 * The certificate buffer is cached in memory for 5 minutes to avoid
 * decrypting on every call, but we never persist it to disk.
 *
 * IMPORTANT:
 *  - Callers should handle rejected promises — a single failed empresa
 *    should not stop a batch sync.
 *  - Function signatures match the old implementation so esocialSync.js
 *    keeps working unchanged.
 */

const axios = require('axios');

const { query } = require('../config/database');
const { decryptCertificate } = require('./esocialCert');

// ──────────────────────────────────────────────────────────────
// PHP microservice URL
// ──────────────────────────────────────────────────────────────
const PHP_URL = (
  process.env.ESOCIAL_PHP_URL || 'https://esocial-php.onrender.com'
).replace(/\/+$/, '');

const AMBIENTE =
  process.env.ESOCIAL_ENV === 'production' ? 'production' : 'homolog';

const PHP_TIMEOUT_MS = 90_000;

// ──────────────────────────────────────────────────────────────
// Certificate loading (cached ~5 min in memory)
// ──────────────────────────────────────────────────────────────
let cachedCert = null;
let cachedCertAt = 0;
const CERT_CACHE_MS = 5 * 60 * 1000;

async function getCertBuffer() {
  if (cachedCert && Date.now() - cachedCertAt < CERT_CACHE_MS) {
    return cachedCert;
  }

  const result = await query(
    `SELECT certificate_encrypted, password_encrypted, iv
       FROM esocial_config
      WHERE active = true
      ORDER BY uploaded_at DESC
      LIMIT 1`
  );

  if (!result.rows.length) {
    throw new Error('Nenhum certificado eSocial ativo configurado');
  }

  const row = result.rows[0];
  const { certificate, password } = decryptCertificate(
    row.certificate_encrypted,
    row.password_encrypted,
    row.iv
  );

  cachedCert = { buffer: certificate, password };
  cachedCertAt = Date.now();
  return cachedCert;
}

/**
 * Clear the cached certificate — call when the certificate is replaced.
 */
function resetAgentCache() {
  cachedCert = null;
  cachedCertAt = 0;
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function normalizeCnpj(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function cnpjRaiz(cnpj) {
  const digits = normalizeCnpj(cnpj);
  if (digits.length < 8) {
    throw new Error(`CNPJ inválido: ${cnpj}`);
  }
  return digits.slice(0, 8);
}

/**
 * Map the legacy tpEvt values used by syncService to the S-xxxx codes the
 * sped-esocial library expects.
 */
function toSCode(tpEvt) {
  const map = {
    evtAdmissao: 'S-2200',
    evtDeslig: 'S-2299',
    evtAltContratual: 'S-2206',
    evtAltCadastral: 'S-2205',
    evtTSVInicio: 'S-2300',
    evtTSVTermino: 'S-2399',
  };
  return map[tpEvt] || tpEvt;
}

/**
 * Map the evt* names returned by the PHP service (e.g. "evtAdmissao") back
 * to themselves — we keep tpEvt in that format throughout the codebase.
 */
function fromPhpTpEvt(phpTpEvt, fallback) {
  if (!phpTpEvt) return fallback;
  // PHP service returns evtAdmissao/evtDeslig etc already in the node code.
  return phpTpEvt;
}

async function callPhp(endpoint, payload) {
  const url = `${PHP_URL}${endpoint}`;
  try {
    const res = await axios.post(url, payload, {
      timeout: PHP_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    });

    if (res.status >= 500) {
      const err =
        res.data && res.data.error
          ? res.data.error
          : `HTTP ${res.status}`;
      throw new Error(`esocial-php ${endpoint}: ${err}`);
    }
    if (res.status >= 400) {
      const err =
        res.data && res.data.error
          ? res.data.error
          : `HTTP ${res.status}`;
      throw new Error(`esocial-php ${endpoint} (${res.status}): ${err}`);
    }
    if (!res.data || res.data.ok !== true) {
      const err = res.data && res.data.error ? res.data.error : 'resposta inválida';
      throw new Error(`esocial-php ${endpoint}: ${err}`);
    }
    return res.data;
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      throw new Error(`esocial-php ${endpoint}: timeout após ${PHP_TIMEOUT_MS}ms`);
    }
    if (err.response) {
      throw new Error(
        `esocial-php ${endpoint}: HTTP ${err.response.status} ${
          err.response.data && err.response.data.error
            ? err.response.data.error
            : ''
        }`.trim()
      );
    }
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────
// consultarEventos
// ──────────────────────────────────────────────────────────────
/**
 * Consulta identificadores de eventos no eSocial (via PHP microservice).
 *
 * @param {string} cnpj     CNPJ completo (14 dígitos) da empresa
 * @param {string} tpEvt    'evtAdmissao' | 'evtDeslig' | ... OR already an 'S-2200' code
 * @param {string} perApur  'YYYY-MM'
 * @returns {Promise<Array<{id: string, tpEvt: string, nrRecArqBase?: string}>>}
 */
async function consultarEventos(cnpj, tpEvt, perApur) {
  if (!cnpj) throw new Error('CNPJ obrigatório');
  if (!tpEvt) throw new Error('tpEvt obrigatório');
  if (!perApur || !/^\d{4}-\d{2}$/.test(perApur)) {
    throw new Error("perApur deve ser no formato 'YYYY-MM'");
  }

  const cert = await getCertBuffer();

  const data = await callPhp('/consultar-eventos', {
    certificate: cert.buffer.toString('base64'),
    password: cert.password,
    cnpj: normalizeCnpj(cnpj),
    tpEvt: toSCode(tpEvt),
    perApur,
    ambiente: AMBIENTE,
  });

  const eventos = Array.isArray(data.eventos) ? data.eventos : [];
  return eventos.map((ev) => ({
    id: ev.id,
    // Keep the original evt* name so downstream code keeps working.
    tpEvt,
    nrRecArqBase: ev.nrRecArqBase || null,
    hash: ev.hash || null,
  }));
}

// ──────────────────────────────────────────────────────────────
// downloadEvento
// ──────────────────────────────────────────────────────────────
/**
 * Download a single event by its identifier (via PHP microservice).
 *
 * @param {string} cnpj       CNPJ completo da empresa
 * @param {string} eventoId   ID do evento (S-XXXX.....)
 * @returns {Promise<{id: string, tpEvt: string, raw: object, xml: string}>}
 */
async function downloadEvento(cnpj, eventoId) {
  if (!cnpj) throw new Error('CNPJ obrigatório');
  if (!eventoId) throw new Error('eventoId obrigatório');

  const cert = await getCertBuffer();

  const data = await callPhp('/download-evento', {
    certificate: cert.buffer.toString('base64'),
    password: cert.password,
    cnpj: normalizeCnpj(cnpj),
    eventoId,
  });

  const ev = data.evento || {};
  // The PHP service already flattens the interesting fields into `dados`.
  // We also expose them under `raw` so the extract* helpers below can keep
  // their previous signatures.
  return {
    id: ev.id || eventoId,
    tpEvt: fromPhpTpEvt(ev.tpEvt, 'desconhecido'),
    raw: { dados: ev.dados || {}, tpEvt: ev.tpEvt || null },
    xml: ev.xml || '',
  };
}

// ──────────────────────────────────────────────────────────────
// Field extractors — now trivial because PHP already parsed everything.
// Signatures kept identical so esocialSync.js is untouched.
// ──────────────────────────────────────────────────────────────
/**
 * Extract funcionário fields from a downloaded evtAdmissao (S-2200) event.
 *
 * @param {{dados: object, tpEvt: string}} eventoRaw
 */
function extractAdmissao(eventoRaw) {
  if (!eventoRaw || !eventoRaw.dados) return null;
  if (eventoRaw.tpEvt && eventoRaw.tpEvt !== 'evtAdmissao') return null;

  const d = eventoRaw.dados;
  if (!d.cpf) return null;

  return {
    cpf: d.cpf ? String(d.cpf).replace(/\D/g, '') : null,
    nome: d.nome ? String(d.nome).trim() : null,
    matricula: d.matricula ? String(d.matricula) : null,
    dataAdmissao: d.dataAdmissao || null,
    cargo: d.cargo ? String(d.cargo) : null,
  };
}

/**
 * Extract fields from a downloaded evtDeslig (S-2299) event.
 */
function extractDesligamento(eventoRaw) {
  if (!eventoRaw || !eventoRaw.dados) return null;
  if (eventoRaw.tpEvt && eventoRaw.tpEvt !== 'evtDeslig') return null;

  const d = eventoRaw.dados;
  if (!d.cpf) return null;

  return {
    cpf: d.cpf ? String(d.cpf).replace(/\D/g, '') : null,
    matricula: d.matricula ? String(d.matricula) : null,
    dataDesligamento: d.dataDesligamento || null,
  };
}

// ──────────────────────────────────────────────────────────────
// Misc utilities
// ──────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getEndpoints() {
  // Kept only for backwards compatibility with any code that imports it.
  return { phpUrl: PHP_URL, ambiente: AMBIENTE };
}

module.exports = {
  consultarEventos,
  downloadEvento,
  extractAdmissao,
  extractDesligamento,
  resetAgentCache,
  sleep,
  normalizeCnpj,
  cnpjRaiz,
  getEndpoints,
};
