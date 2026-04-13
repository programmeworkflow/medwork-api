const axios = require('axios');
const { logEvent } = require('./logger');

/**
 * Phone number validation and formatting
 * Accepts: +5511999999999, 5511999999999, 11999999999
 * Returns: +5511999999999 or throws
 */
function formatPhone(raw) {
  if (!raw) throw new Error('Número de telefone não informado');

  // Strip all non-digits
  const digits = raw.replace(/\D/g, '');

  // Must have 10-15 digits (international range)
  if (digits.length < 10 || digits.length > 15) {
    throw new Error(`Número inválido: "${raw}" — use formato internacional (+55...)`);
  }

  // If already has country code length (12-13 for BR), prefix +
  if (digits.startsWith('55') && digits.length >= 12) {
    return `+${digits}`;
  }

  // BR local number (10-11 digits): prepend 55
  if (digits.length === 10 || digits.length === 11) {
    return `+55${digits}`;
  }

  return `+${digits}`;
}

/**
 * Detect which provider is configured
 */
function getProvider() {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) return 'twilio';
  if (process.env.WHATSAPP_CLOUD_TOKEN && process.env.WHATSAPP_PHONE_ID)  return 'meta';
  return 'mock';
}

/**
 * Send via Twilio WhatsApp Sandbox / Business API
 */
async function sendViaTwilio(phone, message) {
  const accountSid  = process.env.TWILIO_ACCOUNT_SID;
  const authToken   = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber  = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'; // sandbox default

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  const params = new URLSearchParams();
  params.append('From', fromNumber);
  params.append('To',   `whatsapp:${phone}`);
  params.append('Body', message);

  const response = await axios.post(url, params, {
    auth: { username: accountSid, password: authToken },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return {
    provider: 'twilio',
    messageId: response.data.sid,
    status: response.data.status,
  };
}

/**
 * Send via Meta WhatsApp Cloud API
 */
async function sendViaMeta(phone, message) {
  const token   = process.env.WHATSAPP_CLOUD_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;

  // Remove leading + for Meta API
  const to = phone.replace(/^\+/, '');

  const response = await axios.post(
    `https://graph.facebook.com/v19.0/${phoneId}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: false, body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return {
    provider: 'meta',
    messageId: response.data.messages?.[0]?.id,
    status: 'sent',
  };
}

/**
 * Mock sender for development
 */
async function sendMock(phone, message) {
  console.log('\n📲 [WhatsApp MOCK]');
  console.log(`   To     : ${phone}`);
  console.log(`   Message: ${message}`);
  console.log('');
  return { provider: 'mock', messageId: `mock-${Date.now()}`, status: 'mock' };
}

/**
 * Main send function — auto-detects provider
 *
 * @param {string} rawPhone  - phone in any format
 * @param {string} message   - plain text message (max ~1600 chars)
 * @returns {{ provider, messageId, status, phone }}
 */
async function sendWhatsAppMessage(rawPhone, message) {
  const phone    = formatPhone(rawPhone);
  const provider = getProvider();

  await logEvent('info', 'whatsapp', `Sending via ${provider} → ${phone.slice(0, 7)}***`);

  try {
    let result;
    if (provider === 'twilio') result = await sendViaTwilio(phone, message);
    else if (provider === 'meta') result = await sendViaMeta(phone, message);
    else result = await sendMock(phone, message);

    await logEvent('info', 'whatsapp', `✅ Sent [${result.messageId}] via ${provider}`, null, null, null, {
      provider, phone: phone.slice(0, 7) + '***', status: result.status,
    });

    return { ...result, phone };
  } catch (err) {
    await logEvent('error', 'whatsapp', `❌ Send failed: ${err.message}`, null, null, null, {
      provider, phone: phone.slice(0, 7) + '***',
      error: err.response?.data || err.message,
    });
    throw err;
  }
}

module.exports = { sendWhatsAppMessage, formatPhone, getProvider };
