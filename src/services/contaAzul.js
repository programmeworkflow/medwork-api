/**
 * Conta Azul API Integration — OAuth2 Authorization Code Flow
 *
 * Flow:
 *   1. User visits /api/contaazul/authorize → redirects to Conta Azul login
 *   2. Conta Azul redirects back to /api/contaazul/callback with ?code=xxx
 *   3. Backend exchanges code for access_token + refresh_token
 *   4. Tokens stored in DB (ca_tokens table) — auto-refreshed when expired
 *
 * Supports API v1 and v3 via CONTA_AZUL_API_VERSION env var (default: v3)
 */

const axios = require('axios');
const { logEvent } = require('./logger');
const { query } = require('../config/database');

// ─── Config ────────────────────────────────────────────────────
const API_VERSION = process.env.CONTA_AZUL_API_VERSION || 'v3';
const BASE_URL    = process.env.CONTA_AZUL_BASE_URL || 'https://api-v2.contaazul.com';
const AUTH_URL    = 'https://auth.contaazul.com/oauth2/authorize';
const TOKEN_URL   = 'https://auth.contaazul.com/oauth2/token';
const CLIENT_ID   = process.env.CONTA_AZUL_CLIENT_ID;
const CLIENT_SECRET = process.env.CONTA_AZUL_CLIENT_SECRET;
const REDIRECT_URI  = process.env.CONTA_AZUL_REDIRECT_URI || 'http://localhost:3001/api/contaazul/callback';

// ─── Token storage in DB ──────────────────────────────────────
async function ensureTokenTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS ca_tokens (
      id INTEGER PRIMARY KEY DEFAULT 1,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT single_row CHECK (id = 1)
    )
  `);
}

async function saveTokens(accessToken, refreshToken, expiresIn) {
  await ensureTokenTable();
  const expiresAt = new Date(Date.now() + (expiresIn || 3600) * 1000 - 120000);
  await query(`
    INSERT INTO ca_tokens (id, access_token, refresh_token, expires_at, updated_at)
    VALUES (1, $1, $2, $3, NOW())
    ON CONFLICT (id) DO UPDATE SET
      access_token = $1, refresh_token = $2, expires_at = $3, updated_at = NOW()
  `, [accessToken, refreshToken, expiresAt.toISOString()]);
}

async function loadTokens() {
  await ensureTokenTable();
  const result = await query('SELECT access_token, refresh_token, expires_at FROM ca_tokens WHERE id = 1');
  return result.rows[0] || null;
}

// ─── OAuth2 Authorization Code Flow ──────────────────────────
function getAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    state: state || 'medwork',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(code) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const response = await axios.post(TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });

  const { access_token, refresh_token, expires_in } = response.data;
  await saveTokens(access_token, refresh_token, expires_in);
  await logEvent('info', 'contaazul', 'OAuth2 tokens obtained via authorization code');
  return { access_token, refresh_token, expires_in };
}

async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const response = await axios.post(TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });

  const { access_token, refresh_token: newRefresh, expires_in } = response.data;
  await saveTokens(access_token, newRefresh || refreshToken, expires_in);
  await logEvent('info', 'contaazul', 'OAuth2 token refreshed');
  return access_token;
}

// ─── Get valid access token ───────────────────────────────────
async function getAccessToken() {
  const tokens = await loadTokens();
  if (!tokens) {
    throw new Error('Conta Azul não autorizado. Acesse /api/contaazul/authorize para conectar.');
  }

  // Check if expired
  if (new Date(tokens.expires_at) > new Date()) {
    return tokens.access_token;
  }

  // Refresh
  try {
    return await refreshAccessToken(tokens.refresh_token);
  } catch (err) {
    await logEvent('error', 'contaazul', `Token refresh failed: ${err.response?.data?.message || err.message}`);
    throw new Error('Token expirado e refresh falhou. Re-autorize em /api/contaazul/authorize');
  }
}

// ─── Check if authorized ──────────────────────────────────────
async function isAuthorized() {
  try {
    const tokens = await loadTokens();
    return !!tokens;
  } catch {
    return false;
  }
}

// ─── Generic authenticated request ────────────────────────────
async function apiCall(method, endpoint, data = null, contractId = null) {
  const token = await getAccessToken();

  try {
    const response = await axios({
      method,
      url:  `${BASE_URL}${endpoint}`,
      data: data ?? undefined,
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    await logEvent(
      'info', 'contaazul',
      `${method.toUpperCase()} ${endpoint} → ${response.status}`,
      contractId
    );
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data;
    const errorDetail = typeof detail === 'string' ? { body: detail } : (detail || { message: err.message });
    console.error(`[CA ERROR] ${method.toUpperCase()} ${endpoint} HTTP ${status}:`, JSON.stringify(errorDetail));
    await logEvent(
      'error', 'contaazul',
      `${method.toUpperCase()} ${endpoint} failed (HTTP ${status ?? 'no-response'}): ${JSON.stringify(errorDetail).slice(0, 300)}`,
      contractId, null, null, errorDetail
    );
    throw err;
  }
}

// ─── Customer lookup — /v1/pessoas filtered by exact CNPJ ───
async function findCustomer(cnpj, email) {
  if (!cnpj) return null;
  const doc = cnpj.replace(/\D/g, '');

  try {
    const res = await apiCall('get', `/v1/pessoas?documento=${doc}`);
    const items = res?.items || res?.itens || (Array.isArray(res) ? res : []);
    // MUST match exact CNPJ — ignore CPFs or other documents
    const exact = items.find(p => {
      const pDoc = (p.documento || '').replace(/\D/g, '');
      return pDoc === doc;
    });
    if (exact) {
      await logEvent('info', 'contaazul', `Customer found by CNPJ ${doc}: ${exact.id} (${exact.nome})`);
      return exact;
    }
    await logEvent('info', 'contaazul', `No exact CNPJ match for ${doc} (got ${items.length} results, none matched)`);
  } catch (err) {
    if (err.response?.status === 404 || err.response?.status === 400) return null;
    throw err;
  }
  return null;
}

// ─── Customer create — /v1/pessoas ────────────────────
async function createCustomer({ companyName, cnpj, email }) {
  return apiCall('post', '/v1/pessoas', {
    nome:      companyName,
    documento: cnpj ? cnpj.replace(/\D/g, '') : undefined,
    email:     email ?? undefined,
    ativo:     true,
    tipo_pessoa: 'Jurídica',
    perfis:    [{ tipo_perfil: 'Cliente' }],
  });
}

async function ensureCustomer(data) {
  let customer = await findCustomer(data.cnpj, data.email);
  if (!customer) {
    await logEvent('info', 'contaazul', `CNPJ not found, creating customer: ${data.companyName} (${data.cnpj})`);
    customer = await createCustomer(data);
    await logEvent('info', 'contaazul', `Customer created: ${customer.id} (${customer.nome})`);
  }
  return customer;
}

// ─── Contract create (API v2: /v1/contratos) ──────────────────
async function createContract(data, customerId, contractId) {
  const [year, monthNum] = data.month.split('-');
  const startDate  = `${year}-${monthNum}-01`;
  const endYear = parseInt(year) + 1;
  const endDate = `${endYear}-${monthNum}-01`;
  // monthlyValue = valor BRUTO (total do contrato)
  const grossValue = data.monthlyValue || 0;
  const discount   = data.discount || 0;
  const description = data.services?.length
    ? data.services.slice(0, 3).join(', ')
    : 'Programas e Laudos Técnicos';

  // Get next contract number
  let numero = 1;
  try {
    const numRes = await apiCall('get', '/v1/contratos/proximo-numero');
    numero = numRes || 1;
  } catch { /* use default */ }

  // Find or create a service/product item in CA
  let itemId = null;
  try {
    const items = await apiCall('get', '/v1/servicos?nome=Programas e Laudos');
    const list = items?.items || items?.itens || (Array.isArray(items) ? items : []);
    if (list.length) {
      itemId = list[0].id;
    }
  } catch { /* ignore */ }

  if (!itemId) {
    try {
      const newItem = await apiCall('post', '/v1/servicos', {
        nome: 'Programas e Laudos Técnicos',
        valor: grossValue,
      });
      itemId = newItem.id;
      await logEvent('info', 'contaazul', `Service created in CA: ${itemId}`);
    } catch (e) {
      await logEvent('warn', 'contaazul', `Failed to create service: ${e.response?.data?.error || e.message}`);
    }
  }

  const itemEntry = {
    quantidade: 1,
    descricao: description,
    valor: grossValue,
    valor_custo: grossValue,
    desconto: discount > 0 ? discount : undefined,
  };
  if (itemId) itemEntry.id_item = itemId;

  const payload = {
    id_cliente: customerId,
    data_emissao: startDate,
    observacoes: `${data.companyName} — ${description}`,
    termos: {
      tipo_frequencia: 'MENSAL',
      tipo_expiracao: 'DATA',
      data_inicio: startDate,
      data_fim: endDate,
      intervalo_frequencia: 1,
      dia_emissao_venda: 1,
      numero,
    },
    condicao_pagamento: {
      tipo_pagamento: 'BOLETO_BANCARIO',
      dia_vencimento: 10,
      primeira_data_vencimento: `${year}-${monthNum}-10`,
    },
    itens: [itemEntry],
  };

  await logEvent('info', 'contaazul', `Creating contract #${numero} for customer ${customerId}`, contractId);
  return apiCall('post', '/v1/contratos', payload, contractId);
}

// ─── Main entry point ──────────────────────────────────────────
async function processContaAzul(data, contractId) {
  await logEvent('info', 'contaazul', `Starting integration: ${data.companyName}`, contractId);
  const customer = await ensureCustomer(data);
  const contract = await createContract(data, customer.id, contractId);
  await logEvent('info', 'contaazul',
    `Integration complete — contract ID: ${contract.id ?? contract.uuid ?? 'unknown'}`,
    contractId
  );
  return {
    customerId:  customer.id ?? customer.uuid,
    contractId:  contract.id ?? contract.uuid,
    customer,
    contract,
  };
}

module.exports = {
  processContaAzul, ensureCustomer, createContract, findCustomer,
  getAuthorizeUrl, exchangeCode, isAuthorized, getAccessToken,
};
