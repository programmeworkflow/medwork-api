const express = require('express');
const { getAuthorizeUrl, exchangeCode, isAuthorized } = require('../services/contaAzul');

const router = express.Router();

// GET /api/contaazul/authorize — redireciona pro login do Conta Azul
router.get('/authorize', (_req, res) => {
  const url = getAuthorizeUrl();
  res.redirect(url);
});

// GET /api/contaazul/callback — recebe o code e troca por tokens
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2 style="color:red">Erro na autorização</h2>
        <p>${error}</p>
        <a href="/api/contaazul/authorize">Tentar novamente</a>
      </body></html>
    `);
  }

  if (!code) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2 style="color:red">Código de autorização ausente</h2>
        <a href="/api/contaazul/authorize">Tentar novamente</a>
      </body></html>
    `);
  }

  try {
    await exchangeCode(code);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0d1117;color:#f0f6fc">
        <div style="max-width:400px;margin:0 auto;background:#1e2535;border-radius:16px;padding:40px;border:1px solid rgba(34,197,94,0.3)">
          <div style="font-size:48px;margin-bottom:16px">✅</div>
          <h2 style="color:#22c55e;margin-bottom:12px">Conta Azul Conectado!</h2>
          <p style="color:#8b949e">A integração foi autorizada com sucesso. Os contratos agora serão criados automaticamente no Conta Azul.</p>
          <p style="color:#8b949e;margin-top:20px;font-size:14px">Você pode fechar esta janela.</p>
        </div>
      </body></html>
    `);
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2 style="color:red">Falha ao obter tokens</h2>
        <p>${msg}</p>
        <a href="/api/contaazul/authorize">Tentar novamente</a>
      </body></html>
    `);
  }
});

// GET /api/contaazul/status — verifica se está autorizado
router.get('/status', async (_req, res) => {
  const authorized = await isAuthorized();
  res.json({ authorized });
});

// DEBUG: test GET requests to CA
router.get('/test-get', async (req, res) => {
  try {
    const { getAccessToken } = require('../services/contaAzul');
    const axios = require('axios');
    const token = await getAccessToken();
    const path = req.query.path || '/v1/pessoas';
    const response = await axios.get(`https://api-v2.contaazul.com${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    res.json({ success: true, data: response.data });
  } catch (err) {
    res.json({ success: false, status: err.response?.status, error: err.response?.data });
  }
});

// DEBUG: test PUT/PATCH to any CA endpoint
router.put('/test-update', async (req, res) => {
  try {
    const { getAccessToken } = require('../services/contaAzul');
    const axios = require('axios');
    const token = await getAccessToken();
    const endpoint = req.body._endpoint;
    const method = req.body._method || 'put';
    const payload = { ...req.body };
    delete payload._endpoint;
    delete payload._method;
    const response = await axios({ method, url: `https://api-v2.contaazul.com${endpoint}`, data: payload,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      timeout: 15000,
    });
    res.json({ success: true, data: response.data });
  } catch (err) {
    res.json({ success: false, status: err.response?.status, error: err.response?.data });
  }
});

// DEBUG: test POST to any CA endpoint
router.post('/test-create', async (req, res) => {
  try {
    const { getAccessToken } = require('../services/contaAzul');
    const axios = require('axios');
    const token = await getAccessToken();
    const endpoint = req.body._endpoint || '/v1/pessoas';
    const baseUrl = req.body._baseUrl || 'https://api-v2.contaazul.com';
    const payload = { ...req.body };
    delete payload._endpoint;
    delete payload._baseUrl;
    console.log('[CA DEBUG] POST', baseUrl + endpoint, JSON.stringify(payload));
    const response = await axios.post(`${baseUrl}${endpoint}`, payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      timeout: 15000,
    });
    res.json({ success: true, data: response.data });
  } catch (err) {
    res.json({ success: false, status: err.response?.status, error: err.response?.data });
  }
});

module.exports = router;
