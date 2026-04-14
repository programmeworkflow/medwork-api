const nodemailer = require('nodemailer');

const SMTP_USER = process.env.SMTP_USER || 'medwork.financeiro@gmail.com';
const SMTP_PASS = process.env.SMTP_PASS;

/**
 * Send email notification when an espelho is processed.
 * If SMTP is not configured, logs a warning and skips silently.
 */
async function sendContractEmail({ companyName, cnpj, monthlyValue, discount, netValue, services, month, status }) {
  if (!SMTP_PASS) {
    console.warn('[EMAIL] SMTP_PASS not configured — skipping email notification');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const servicesList = (services || []).length
    ? services.map(s => `  - ${s}`).join('\n')
    : '  (nenhum servico extraido)';

  const statusLabel = {
    success: 'Sucesso',
    pendente_ca: 'Pendente Conta Azul',
    ca_error: 'Erro Conta Azul',
    error: 'Erro',
  }[status] || status;

  const text = [
    `Espelho processado — ${companyName}`,
    '',
    `Empresa:       ${companyName}`,
    `CNPJ:          ${cnpj || 'N/A'}`,
    `Mes:           ${month}`,
    `Valor Bruto:   R$ ${(monthlyValue || 0).toFixed(2)}`,
    `Desconto:      R$ ${(discount || 0).toFixed(2)}`,
    `Valor Liquido: R$ ${(netValue || 0).toFixed(2)}`,
    `Status:        ${statusLabel}`,
    '',
    'Servicos:',
    servicesList,
  ].join('\n');

  await transporter.sendMail({
    from: SMTP_USER,
    to: 'medwork.financeiro@gmail.com',
    subject: `[Medwork] Espelho processado — ${companyName} (${month})`,
    text,
  });

  console.log(`[EMAIL] Notification sent for ${companyName}`);
}

module.exports = { sendContractEmail };
