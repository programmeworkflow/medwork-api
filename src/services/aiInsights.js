const axios = require('axios');
const { logEvent } = require('./logger');

/**
 * Generate AI-powered business insights
 */
async function generateInsights(metrics) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return generateRuleBasedInsights(metrics);
  }

  const prompt = `You are a business analyst for Medwork Centro Médico, a Brazilian medical services company.
Analyze these business metrics and provide actionable insights in Portuguese (Brazil).

METRICS:
- MRR (Receita Mensal Recorrente): R$ ${metrics.mrr?.toFixed(2)}
- ARR (Receita Anual): R$ ${metrics.arr?.toFixed(2)}
- Total de contratos ativos: ${metrics.activeContracts}
- Ticket médio: R$ ${metrics.averageTicket?.toFixed(2)}
- Crescimento MoM: ${metrics.momGrowth?.toFixed(1)}%
- Meta mensal: R$ ${metrics.monthlyGoal?.toFixed(2) || 'Não definida'}

Return a JSON object with:
{
  "summary": "2-3 sentence executive summary",
  "alerts": ["alert1", "alert2"] (max 3 risk alerts),
  "opportunities": ["opportunity1"] (max 3 growth opportunities),
  "actions": ["action1", "action2"] (max 3 specific recommended actions),
  "contractsToGoal": number (contracts needed to reach goal, if goal set),
  "score": number (business health score 0-100)
}

Be specific, data-driven, and actionable. Return only valid JSON.`;

  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    });

    const content = response.data.content[0].text;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in AI response');

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    await logEvent('warn', 'system', `AI insights failed, using rule-based: ${err.message}`);
    return generateRuleBasedInsights(metrics);
  }
}

/**
 * Rule-based insights fallback
 */
function generateRuleBasedInsights(metrics) {
  const alerts = [];
  const opportunities = [];
  const actions = [];

  const growth = metrics.momGrowth || 0;
  const mrr = metrics.mrr || 0;
  const contracts = metrics.activeContracts || 0;
  const ticket = metrics.averageTicket || 0;

  if (growth < 0) alerts.push(`Queda de ${Math.abs(growth).toFixed(1)}% no MRR. Revisar churn e novos contratos.`);
  if (growth < 5) alerts.push('Crescimento abaixo de 5% ao mês. Atenção à meta de crescimento.');
  if (contracts < 10) alerts.push('Número baixo de contratos ativos. Foco em prospecção.');

  if (growth > 10) opportunities.push('Crescimento acelerado: momento ideal para expandir equipe.');
  if (ticket < 500) opportunities.push('Ticket médio baixo: oportunidade de upsell em contratos existentes.');
  opportunities.push('Mapeie contratos próximos ao vencimento para renovação antecipada.');

  actions.push(`Manter ${Math.ceil(mrr * 0.1 / ticket || 1)} novos contratos/mês para crescer 10%.`);
  actions.push('Revisar contratos com desconto > 20% para renegociação.');
  actions.push('Acompanhar inadimplência mensalmente.');

  const score = Math.min(100, Math.max(0,
    50 + (growth * 2) + (contracts > 20 ? 10 : 0) + (ticket > 1000 ? 10 : 0)
  ));

  return {
    summary: `A empresa possui ${contracts} contratos ativos com MRR de R$ ${mrr.toFixed(2)}. Crescimento mensal de ${growth.toFixed(1)}%.`,
    alerts,
    opportunities,
    actions,
    contractsToGoal: metrics.monthlyGoal ? Math.max(0, Math.ceil((metrics.monthlyGoal - mrr) / ticket)) : null,
    score: Math.round(score)
  };
}

/**
 * Generate revenue forecast for next N months
 */
function generateForecast(historicalData, months = 12) {
  if (!historicalData || historicalData.length < 2) {
    return { conservative: [], realistic: [], aggressive: [] };
  }

  // Calculate average growth rate from historical data
  const values = historicalData.map(d => parseFloat(d.revenue) || 0).filter(v => v > 0);
  
  let avgGrowth = 0.05; // default 5%
  if (values.length >= 2) {
    const growthRates = [];
    for (let i = 1; i < values.length; i++) {
      if (values[i - 1] > 0) {
        growthRates.push((values[i] - values[i - 1]) / values[i - 1]);
      }
    }
    if (growthRates.length > 0) {
      avgGrowth = growthRates.reduce((a, b) => a + b, 0) / growthRates.length;
    }
  }

  const lastValue = values[values.length - 1] || 0;
  const lastDate = new Date();

  const scenarios = {
    conservative: [],
    realistic: [],
    aggressive: []
  };

  for (let i = 1; i <= months; i++) {
    const date = new Date(lastDate);
    date.setMonth(date.getMonth() + i);
    const monthStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    const conservativeRate = Math.max(0, avgGrowth * 0.5);
    const realisticRate = Math.max(0, avgGrowth);
    const aggressiveRate = Math.max(0, avgGrowth * 1.5);

    scenarios.conservative.push({
      month: monthStr,
      revenue: lastValue * Math.pow(1 + conservativeRate, i)
    });
    scenarios.realistic.push({
      month: monthStr,
      revenue: lastValue * Math.pow(1 + realisticRate, i)
    });
    scenarios.aggressive.push({
      month: monthStr,
      revenue: lastValue * Math.pow(1 + aggressiveRate, i)
    });
  }

  return scenarios;
}

module.exports = { generateInsights, generateForecast };
