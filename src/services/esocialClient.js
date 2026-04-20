/**
 * eSocial SOAP webservice client.
 *
 * Consults and downloads eSocial events using the empregador endpoints.
 * Requires mTLS (client certificate) for authentication — we load the
 * active A1 certificate from esocial_config, decrypt it, and pass it to
 * the https.Agent via pfx/passphrase.
 *
 * IMPORTANT:
 *  - We default to the homologation URL (producaorestrita). Production is
 *    enabled only when ESOCIAL_ENV=production.
 *  - We NEVER throw if the eSocial webservice is unreachable — callers
 *    should handle the rejected promise and continue with next empresa.
 */

const https = require('https');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

const { query } = require('../config/database');
const { decryptCertificate } = require('./esocialCert');
const { signEsocialXml } = require('./xmlSigner');

// ──────────────────────────────────────────────────────────────
// Endpoints
// ──────────────────────────────────────────────────────────────
const ENDPOINTS = {
  production: {
    consultar:
      'https://webservices.download.esocial.gov.br/servicos/empregador/dwlcirurgico/WsConsultarIdentificadoresEventos.svc',
    download:
      'https://webservices.download.esocial.gov.br/servicos/empregador/dwlcirurgico/WsSolicitarDownloadEventos.svc',
  },
  homolog: {
    consultar:
      'https://webservices.producaorestrita.esocial.gov.br/servicos/empregador/dwlcirurgico/WsConsultarIdentificadoresEventos.svc',
    download:
      'https://webservices.producaorestrita.esocial.gov.br/servicos/empregador/dwlcirurgico/WsSolicitarDownloadEventos.svc',
  },
};

const CONSULTA_NS =
  'http://www.esocial.gov.br/servicos/empregador/consulta/identificadores-eventos/v1_0_0';
const DOWNLOAD_NS =
  'http://www.esocial.gov.br/servicos/empregador/download/solicitacao/v1_0_0';

function getEndpoints() {
  return process.env.ESOCIAL_ENV === 'production'
    ? ENDPOINTS.production
    : ENDPOINTS.homolog;
}

// ──────────────────────────────────────────────────────────────
// Certificate loading (cached in memory for ~5 minutes)
// ──────────────────────────────────────────────────────────────
let cachedAgent = null;
let cachedAgentAt = 0;
const CERT_CACHE_MS = 5 * 60 * 1000;

let cachedCert = null;

async function getHttpsAgent() {
  if (cachedAgent && Date.now() - cachedAgentAt < CERT_CACHE_MS) {
    return cachedAgent;
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
  cachedAgent = new https.Agent({
    pfx: certificate,
    passphrase: password,
    rejectUnauthorized: false,
    keepAlive: true,
  });
  cachedAgentAt = Date.now();
  return cachedAgent;
}

async function getCertBuffer() {
  await getHttpsAgent(); // triggers cache
  return cachedCert;
}

/**
 * Clear the cached https agent — call when the certificate is replaced.
 */
function resetAgentCache() {
  cachedAgent = null;
  cachedAgentAt = 0;
  cachedCert = null;
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

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
});

function findAll(obj, key, results = []) {
  if (!obj || typeof obj !== 'object') return results;
  if (Array.isArray(obj)) {
    for (const item of obj) findAll(item, key, results);
    return results;
  }
  for (const k of Object.keys(obj)) {
    if (k === key) {
      const v = obj[k];
      if (Array.isArray(v)) results.push(...v);
      else results.push(v);
    }
    findAll(obj[k], key, results);
  }
  return results;
}

function findFirst(obj, key) {
  const all = findAll(obj, key);
  return all.length ? all[0] : null;
}

// ──────────────────────────────────────────────────────────────
// SOAP: consultarEventos
// ──────────────────────────────────────────────────────────────
/**
 * Consulta identificadores de eventos no eSocial.
 *
 * @param {string} cnpj      CNPJ completo (14 dígitos) ou apenas a raiz (8)
 * @param {string} tpEvt     'evtAdmissao' | 'evtDeslig' | ...
 * @param {string} perApur   'YYYY-MM'
 * @returns {Promise<Array<{id: string, nrRecArqBase?: string, tpEvt: string}>>}
 */
async function consultarEventos(cnpj, tpEvt, perApur) {
  if (!cnpj) throw new Error('CNPJ obrigatório');
  if (!tpEvt) throw new Error('tpEvt obrigatório');
  if (!perApur || !/^\d{4}-\d{2}$/.test(perApur)) {
    throw new Error("perApur deve ser no formato 'YYYY-MM'");
  }

  const raiz = cnpjRaiz(cnpj);
  const endpoints = getEndpoints();
  const agent = await getHttpsAgent();
  const cert = await getCertBuffer();

  // Build the inner eSocial XML
  const innerEsocial = `<eSocial xmlns="http://www.esocial.gov.br/schema/consulta/identificadores-eventos/empregador/v1_0_0"><consultaIdentificadoresEvts><ideEmpregador><tpInsc>1</tpInsc><nrInsc>${raiz}</nrInsc></ideEmpregador><consultaEvtsEmpregador><tpEvt>${tpEvt}</tpEvt><perApur>${perApur}</perApur></consultaEvtsEmpregador></consultaIdentificadoresEvts></eSocial>`;

  // Sign the inner eSocial XML
  const signedEsocial = signEsocialXml(innerEsocial, cert.buffer, cert.password);

  const envelope =
`<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v1="${CONSULTA_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <v1:ConsultarIdentificadoresEventosEmpregador>
      <v1:consultaEventosEmpregador>${signedEsocial}</v1:consultaEventosEmpregador>
    </v1:ConsultarIdentificadoresEventosEmpregador>
  </soapenv:Body>
</soapenv:Envelope>`;

  const response = await axios.post(endpoints.consultar, envelope, {
    httpsAgent: agent,
    timeout: 60000,
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction:
        'http://www.esocial.gov.br/servicos/empregador/consulta/identificadores-eventos/v1_0_0/ServicoConsultarIdentificadoresEventos/ConsultarIdentificadoresEventosEmpregador',
    },
    // Do not throw on >=400 so we can inspect the SOAP fault
    validateStatus: () => true,
    transformResponse: [(data) => data],
  });

  if (response.status >= 400) {
    throw new Error(
      `eSocial HTTP ${response.status}: ${String(response.data).slice(0, 500)}`
    );
  }

  const parsed = xmlParser.parse(response.data);

  // SOAP fault?
  const fault = findFirst(parsed, 'Fault');
  if (fault) {
    const faultstring =
      findFirst(fault, 'faultstring') || JSON.stringify(fault).slice(0, 300);
    throw new Error(`SOAP Fault: ${faultstring}`);
  }

  // status check
  const status = findFirst(parsed, 'status');
  if (status && status.cdResposta && String(status.cdResposta) !== '200') {
    const desc = status.descResposta || `cdResposta=${status.cdResposta}`;
    throw new Error(`eSocial status ${status.cdResposta}: ${desc}`);
  }

  // Events — the response wraps identifiers in ideEvento elements
  const ideEventos = findAll(parsed, 'ideEvento');
  const eventos = ideEventos.map((ev) => ({
    id: ev.id || ev['@_id'] || ev.Id || null,
    nrRecArqBase: ev.nrRecArqBase || null,
    tpEvt: ev.tpEvt || tpEvt,
    hash: ev.hash || null,
  })).filter((ev) => ev.id);

  return eventos;
}

// ──────────────────────────────────────────────────────────────
// SOAP: downloadEvento
// ──────────────────────────────────────────────────────────────
/**
 * Download a single event XML by its identifier.
 *
 * @param {string} cnpj       CNPJ completo da empresa
 * @param {string} eventoId   ID do evento (S-XXXX.....)
 * @returns {Promise<{id: string, tpEvt: string, raw: object, xml: string}>}
 */
async function downloadEvento(cnpj, eventoId) {
  if (!cnpj) throw new Error('CNPJ obrigatório');
  if (!eventoId) throw new Error('eventoId obrigatório');

  const raiz = cnpjRaiz(cnpj);
  const endpoints = getEndpoints();
  const agent = await getHttpsAgent();

  const envelope =
`<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:dow="${DOWNLOAD_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <dow:DownloadEvento>
      <dow:solicitacaoDownloadEvento>
        <dow:ideEmpregador>
          <dow:tpInsc>1</dow:tpInsc>
          <dow:nrInsc>${raiz}</dow:nrInsc>
        </dow:ideEmpregador>
        <dow:solicDownloadEvtsPorId>
          <dow:id>${eventoId}</dow:id>
        </dow:solicDownloadEvtsPorId>
      </dow:solicitacaoDownloadEvento>
    </dow:DownloadEvento>
  </soapenv:Body>
</soapenv:Envelope>`;

  const response = await axios.post(endpoints.download, envelope, {
    httpsAgent: agent,
    timeout: 60000,
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction:
        'http://www.esocial.gov.br/servicos/empregador/download/solicitacao/v1_0_0/ServicoSolicitarDownloadEventos/SolicitarDownloadEventosPorId',
    },
    validateStatus: () => true,
    transformResponse: [(data) => data],
  });

  if (response.status >= 400) {
    throw new Error(
      `eSocial HTTP ${response.status}: ${String(response.data).slice(0, 500)}`
    );
  }

  const parsed = xmlParser.parse(response.data);

  const fault = findFirst(parsed, 'Fault');
  if (fault) {
    const faultstring =
      findFirst(fault, 'faultstring') || JSON.stringify(fault).slice(0, 300);
    throw new Error(`SOAP Fault: ${faultstring}`);
  }

  // The event body is inside the <eSocial> root in the SOAP response.
  const eSocialNode = findFirst(parsed, 'eSocial');
  if (!eSocialNode) {
    throw new Error('Evento não encontrado na resposta do eSocial');
  }

  return {
    id: eventoId,
    tpEvt: detectTpEvt(eSocialNode),
    raw: eSocialNode,
    xml: response.data,
  };
}

function detectTpEvt(eSocialNode) {
  if (findFirst(eSocialNode, 'evtAdmissao')) return 'evtAdmissao';
  if (findFirst(eSocialNode, 'evtDeslig')) return 'evtDeslig';
  if (findFirst(eSocialNode, 'evtTSVInicio')) return 'evtTSVInicio';
  if (findFirst(eSocialNode, 'evtTSVAltCadastral')) return 'evtTSVAltCadastral';
  if (findFirst(eSocialNode, 'evtAltCadastral')) return 'evtAltCadastral';
  return 'desconhecido';
}

// ──────────────────────────────────────────────────────────────
// Event → funcionário mapping
// ──────────────────────────────────────────────────────────────
/**
 * Extract funcionário fields from a parsed evtAdmissao (S-2200) event.
 */
function extractAdmissao(eventoRaw) {
  const evt = findFirst(eventoRaw, 'evtAdmissao');
  if (!evt) return null;

  const trab = findFirst(evt, 'trabalhador') || {};
  const vinc = findFirst(evt, 'vinculo') || {};
  const info = findFirst(vinc, 'infoRegimeTrab') || {};
  const infoCelet = findFirst(info, 'infoCeletista') || findFirst(vinc, 'infoCeletista') || {};
  const trabLegal = findFirst(info, 'infoEstatutario') || {};

  const cpf = findFirst(trab, 'cpfTrab') || findFirst(evt, 'cpfTrab') || null;
  const nome = findFirst(trab, 'nmTrab') || findFirst(evt, 'nmTrab') || null;
  const matricula = findFirst(vinc, 'matricula') || null;
  const dataAdmissao =
    findFirst(infoCelet, 'dtAdm') ||
    findFirst(trabLegal, 'dtExercicio') ||
    findFirst(vinc, 'dtAdm') ||
    null;
  const cargo = findFirst(vinc, 'codCargo') || findFirst(vinc, 'cargoFuncao') || null;

  return {
    cpf: cpf ? String(cpf).replace(/\D/g, '') : null,
    nome: nome ? String(nome).trim() : null,
    matricula: matricula ? String(matricula) : null,
    dataAdmissao: dataAdmissao || null,
    cargo: cargo ? String(cargo) : null,
  };
}

/**
 * Extract fields from a parsed evtDeslig (S-2299) event.
 */
function extractDesligamento(eventoRaw) {
  const evt = findFirst(eventoRaw, 'evtDeslig');
  if (!evt) return null;

  const ideVinc = findFirst(evt, 'ideVinculo') || {};
  const info = findFirst(evt, 'infoDeslig') || {};

  const cpf = findFirst(ideVinc, 'cpfTrab') || null;
  const matricula = findFirst(ideVinc, 'matricula') || null;
  const dataDesligamento = findFirst(info, 'dtDeslig') || null;

  return {
    cpf: cpf ? String(cpf).replace(/\D/g, '') : null,
    matricula: matricula ? String(matricula) : null,
    dataDesligamento: dataDesligamento || null,
  };
}

// ──────────────────────────────────────────────────────────────
// Simple delay helper
// ──────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
