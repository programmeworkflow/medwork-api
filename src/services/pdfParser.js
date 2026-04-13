// pdf-parse has a known bug where requiring the package directly
// tries to load test data from ./test/data/ and crashes.
// Fix: require the lib file directly.
let pdfParse;
try {
  pdfParse = require('pdf-parse/lib/pdf-parse.js');
} catch (_) {
  pdfParse = require('pdf-parse'); // fallback for environments where lib path works
}

const axios = require('axios');
const { logEvent } = require('./logger');

/**
 * Extract contract data from a PDF buffer.
 * Strategy: regex first → Claude AI fallback → validate critical fields.
 */
async function parsePDF(buffer, fileId = null) {
  let rawText = '';

  try {
    const data = await pdfParse(buffer);
    rawText = data.text || '';
    await logEvent('info', 'parse', `PDF extracted (${data.numpages} pages, ${rawText.length} chars)`, null, fileId);
  } catch (err) {
    await logEvent('error', 'parse', `PDF extraction failed: ${err.message}`, null, fileId);
    throw new Error(`Não foi possível ler o PDF: ${err.message}`);
  }

  let extracted = extractWithRegex(rawText);

  await logEvent('info', 'parse', 'Regex result', null, fileId, null, {
    cnpj:         extracted.cnpj         || 'NÃO ENCONTRADO',
    email:        extracted.email        || 'NÃO ENCONTRADO',
    monthlyValue: extracted.monthlyValue || 'NÃO ENCONTRADO',
    services:     extracted.services?.length || 0,
  });

  // If critical data missing, try AI
  if (!extracted.cnpj || !extracted.monthlyValue) {
    await logEvent('warn', 'parse', 'Dados críticos ausentes — tentando IA', null, fileId);
    try {
      const aiData = await extractWithAI(rawText, fileId);
      extracted = merge(extracted, aiData);
    } catch (aiErr) {
      await logEvent('error', 'parse', `IA falhou: ${aiErr.message}`, null, fileId);
    }
  }

  // Validate
  if (!extracted.cnpj) {
    throw new Error('CNPJ não encontrado no documento. Verifique se o PDF contém um espelho financeiro válido.');
  }
  if (!extracted.monthlyValue || extracted.monthlyValue <= 0) {
    throw new Error('Valor mensal não encontrado no documento.');
  }

  return { ...extracted, rawText };
}

// ── Regex extractor ───────────────────────────────────────────
function extractWithRegex(text) {
  const result = { cnpj: null, email: null, services: [], monthlyValue: null, grossValue: null, netValue: null, discount: 0, observations: null };

  // CNPJ
  const cnpjPatterns = [
    /CNPJ[:\s#]*([0-9]{2}[\.\-]?[0-9]{3}[\.\-]?[0-9]{3}[\/\-]?[0-9]{4}[\-]?[0-9]{2})/i,
    /(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/,
    /(\d{2}\d{3}\d{3}\d{4}\d{2})/,
  ];
  for (const p of cnpjPatterns) {
    const m = text.match(p);
    if (m) {
      const digits = m[1].replace(/\D/g, '');
      if (digits.length === 14) {
        result.cnpj = `${digits.slice(0,2)}.${digits.slice(2,5)}.${digits.slice(5,8)}/${digits.slice(8,12)}-${digits.slice(12)}`;
        break;
      }
    }
  }

  // Email — prefer financial/faturamento address
  const allEmails = [...text.matchAll(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g)].map(m => m[1]);
  result.email = allEmails.find(e => /fatura|financ|cobran|contab|pagament|fiscal/i.test(e)) || allEmails[0] || null;

  // Valor BRUTO (gross) — prioridade
  const grossPatterns = [
    /valor\s+bruto[:\s]*R?\$?\s*([\d.,]+)/i,
    /bruto[:\s]*R?\$?\s*([\d.,]+)/i,
    /valor\s+(?:mensal|total)[:\s]*R?\$?\s*([\d.,]+)/i,
    /mensalidade[:\s]*R?\$?\s*([\d.,]+)/i,
  ];
  for (const p of grossPatterns) {
    const m = text.match(p);
    if (m) {
      const v = parseBRL(m[1]);
      if (v > 0) { result.grossValue = v; break; }
    }
  }

  // Valor LÍQUIDO (net)
  const netPatterns = [
    /valor\s+l[ií]quido[:\s]*R?\$?\s*([\d.,]+)/i,
    /l[ií]quido[:\s]*R?\$?\s*([\d.,]+)/i,
    /total\s+l[ií]quido[:\s]*R?\$?\s*([\d.,]+)/i,
  ];
  for (const p of netPatterns) {
    const m = text.match(p);
    if (m) {
      const v = parseBRL(m[1]);
      if (v > 0) { result.netValue = v; break; }
    }
  }

  // Se não achou bruto mas achou líquido, tenta pegar todos os R$ e usar o maior como bruto
  if (!result.grossValue) {
    const allValues = [...text.matchAll(/R\$\s*([\d.]+,\d{2})/g)].map(m => parseBRL(m[1])).filter(v => v > 0);
    if (allValues.length) {
      allValues.sort((a, b) => b - a);
      result.grossValue = allValues[0]; // maior valor = bruto
      if (!result.netValue && allValues.length > 1) {
        result.netValue = allValues[1]; // segundo maior = líquido
      }
    }
  }

  // monthlyValue = BRUTO (é o que vai pro Conta Azul como valor do contrato)
  result.monthlyValue = result.grossValue || result.netValue || null;

  // Discount = bruto - líquido
  const discMatch = text.match(/desconto[:\s]*R?\$?\s*([\d.,]+)/i);
  if (discMatch) {
    result.discount = parseBRL(discMatch[1]);
  } else if (result.grossValue && result.netValue && result.grossValue > result.netValue) {
    result.discount = Math.round((result.grossValue - result.netValue) * 100) / 100;
  }

  // Services marked with X / [X] / (X) / ✓ / ☑
  result.services = extractServices(text);

  // Observations
  const obsMatch = text.match(/observa[çc][õo]es?[:\s]*(.{10,500}?)(?:\n\n|\r\n\r\n|$)/is);
  if (obsMatch) result.observations = obsMatch[1].trim().substring(0, 500);

  return result;
}

function extractServices(text) {
  const services = [];
  const lines = text.split('\n');

  // Try to find sections: "Serviços Contratados", "Documentos", "Programas"
  let inServiceSection = false;
  for (const line of lines) {
    // Detect start of service/document sections
    if (/servi[çc]os?\s+(contratad|incluíd|incluid)/i.test(line) ||
        /documentos/i.test(line) ||
        /programas/i.test(line)) {
      inServiceSection = true;
      continue;
    }

    // Detect end of section (empty line or new section header)
    if (inServiceSection && /^\s*$/.test(line)) {
      inServiceSection = false;
    }

    // Extract items marked with X, [X], (X), ✓, ☑, ✅
    const hasMarker = /\[x\]|\(x\)|☑|✓|✅|\bX\b/i.test(line);
    if (hasMarker) {
      const cleaned = line
        .replace(/\[x\]|\(x\)|☑|✓|✅/gi, '')
        .replace(/^\s*X\s+/i, '')  // X at start of line
        .replace(/\s+X\s*$/i, '')  // X at end of line
        .replace(/\s+X\s+/i, ' ') // X in middle (be careful)
        .replace(/R?\$[\d.,]+/g, '')
        .replace(/[-–—]+/g, ' ')
        .trim();
      if (cleaned.length > 3 && cleaned.length < 200) services.push(cleaned);
    }

    // Also capture lines in service section even without X marker (if section detected)
    if (inServiceSection && !hasMarker) {
      const trimmed = line.trim();
      // Lines that look like service names (start with - or • or number)
      if (/^[-•●]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
        const cleaned = trimmed.replace(/^[-•●]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/R?\$[\d.,]+/g, '').trim();
        if (cleaned.length > 3 && cleaned.length < 200) services.push(cleaned);
      }
    }
  }
  return [...new Set(services)];
}

function parseBRL(str) {
  if (!str) return 0;
  // Handle both 1.234,56 and 1234.56 and 1234,56
  const s = str.trim();
  if (/^\d+\.\d{3},\d{2}$/.test(s)) {
    // 1.234,56 format
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }
  // Try replacing last comma with dot
  return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
}

// ── AI fallback ───────────────────────────────────────────────
async function extractWithAI(text, fileId) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY não configurado');
  }

  const prompt = `Você é um parser de documentos financeiros brasileiros.
Extraia dados deste espelho financeiro. Retorne APENAS JSON válido, sem texto adicional.

TEXTO DO DOCUMENTO:
${text.substring(0, 4000)}

Retorne exatamente este JSON (null se não encontrar):
{
  "cnpj": "XX.XXX.XXX/XXXX-XX ou null",
  "email": "email ou null (priorize financeiro/faturamento)",
  "monthlyValue": 1234.56 ou null,
  "discount": 0 ou número,
  "services": ["serviço 1", "serviço 2"],
  "observations": "texto ou null"
}

REGRAS: Nunca invente dados. Se não encontrar, retorne null.`;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-20250514', max_tokens: 800, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } }
  );

  const raw = response.data.content[0].text;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('IA não retornou JSON válido');
  return JSON.parse(jsonMatch[0]);
}

function merge(base, ai) {
  return {
    cnpj:         base.cnpj         || ai.cnpj         || null,
    email:        base.email        || ai.email        || null,
    monthlyValue: base.monthlyValue || ai.monthlyValue || null,
    discount:     base.discount     || ai.discount     || 0,
    services:     base.services?.length ? base.services : (ai.services || []),
    observations: base.observations || ai.observations || null,
  };
}

module.exports = { parsePDF };
