/**
 * eSocial sync service.
 *
 * For each empresa with an active procuração, queries the eSocial webservice
 * for admissão (S-2200) and desligamento (S-2299) events over the last
 * 6 months, downloads each event, and upserts the results into
 * `esocial_funcionarios`.
 *
 * Key design points:
 *  - Never crashes on a single empresa/event failure — always continues.
 *  - Logs every operation to the `logs` table via logger.logEvent.
 *  - Rate-limits with a 2-second delay between eSocial HTTP requests.
 *  - Runs a cron every 24 hours via startSyncScheduler().
 */

const { query } = require('../config/database');
const { logEvent } = require('./logger');
const {
  consultarEventos,
  downloadEvento,
  extractAdmissao,
  extractDesligamento,
  sleep,
} = require('./esocialClient');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_MS = 2000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 10_000;

/**
 * Build the last N YYYY-MM periods (current month first, going back).
 */
function lastMonths(n = 6) {
  const periods = [];
  const now = new Date();
  now.setUTCDate(1);
  for (let i = 0; i < n; i++) {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() + 1;
    periods.push(`${y}-${String(m).padStart(2, '0')}`);
    now.setUTCMonth(now.getUTCMonth() - 1);
  }
  return periods;
}

/**
 * Upsert a funcionário based on an admissão event.
 */
async function upsertAdmissao(empresa, ev, parsed) {
  if (!parsed || !parsed.cpf) return;
  await query(
    `INSERT INTO esocial_funcionarios
       (empresa_id, cnpj_empresa, cpf, nome, matricula, data_admissao, cargo,
        situacao, ultimo_evento_id, ultima_sync)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ativo',$8, NOW())
     ON CONFLICT (cnpj_empresa, cpf) DO UPDATE SET
       nome = COALESCE(EXCLUDED.nome, esocial_funcionarios.nome),
       matricula = COALESCE(EXCLUDED.matricula, esocial_funcionarios.matricula),
       data_admissao = COALESCE(EXCLUDED.data_admissao, esocial_funcionarios.data_admissao),
       cargo = COALESCE(EXCLUDED.cargo, esocial_funcionarios.cargo),
       empresa_id = EXCLUDED.empresa_id,
       ultimo_evento_id = EXCLUDED.ultimo_evento_id,
       ultima_sync = NOW(),
       -- only flip back to 'ativo' if they don't have a future desligamento
       situacao = CASE
         WHEN esocial_funcionarios.data_desligamento IS NULL THEN 'ativo'
         ELSE esocial_funcionarios.situacao
       END`,
    [
      empresa.id,
      empresa.cnpj,
      parsed.cpf,
      parsed.nome,
      parsed.matricula,
      parsed.dataAdmissao,
      parsed.cargo,
      ev.id,
    ]
  );
}

/**
 * Upsert (update) a funcionário based on a desligamento event.
 */
async function upsertDesligamento(empresa, ev, parsed) {
  if (!parsed || !parsed.cpf) return;
  await query(
    `INSERT INTO esocial_funcionarios
       (empresa_id, cnpj_empresa, cpf, nome, matricula, data_desligamento,
        situacao, ultimo_evento_id, ultima_sync)
     VALUES ($1,$2,$3, COALESCE((SELECT nome FROM esocial_funcionarios WHERE cnpj_empresa=$2 AND cpf=$3), '(sem nome)'),
             $4,$5,'desligado',$6, NOW())
     ON CONFLICT (cnpj_empresa, cpf) DO UPDATE SET
       data_desligamento = EXCLUDED.data_desligamento,
       matricula = COALESCE(esocial_funcionarios.matricula, EXCLUDED.matricula),
       situacao = 'desligado',
       empresa_id = EXCLUDED.empresa_id,
       ultimo_evento_id = EXCLUDED.ultimo_evento_id,
       ultima_sync = NOW()`,
    [
      empresa.id,
      empresa.cnpj,
      parsed.cpf,
      parsed.matricula,
      parsed.dataDesligamento,
      ev.id,
    ]
  );
}

/**
 * Process a list of eventIds for a single (tpEvt, perApur) combination.
 */
async function processEventos(empresa, tpEvt, eventos) {
  let ok = 0;
  let fail = 0;

  for (const ev of eventos) {
    try {
      await sleep(RATE_LIMIT_MS);
      const evt = await downloadEvento(empresa.cnpj, ev.id);
      if (tpEvt === 'evtAdmissao') {
        const parsed = extractAdmissao(evt.raw);
        await upsertAdmissao(empresa, ev, parsed);
      } else if (tpEvt === 'evtDeslig') {
        const parsed = extractDesligamento(evt.raw);
        await upsertDesligamento(empresa, ev, parsed);
      }
      ok++;
    } catch (err) {
      fail++;
      await logEvent(
        'warn',
        'esocial-sync',
        `Falha ao processar evento ${ev.id} (${tpEvt}) da empresa ${empresa.cnpj}: ${err.message}`,
        null,
        null,
        null,
        { empresaId: empresa.id, eventoId: ev.id, tpEvt }
      );
    }
  }

  return { ok, fail };
}

/**
 * Sync a single empresa. Queries admissão and desligamento events over the
 * last 6 months. Updates sincronizado_em on success.
 *
 * Returns a summary object.
 */
async function syncEmpresa(empresaId) {
  const empRes = await query(
    `SELECT id, cnpj, razao_social, procuracao_ativa
       FROM esocial_empresas
      WHERE id = $1
      LIMIT 1`,
    [empresaId]
  );

  if (!empRes.rows.length) {
    throw new Error(`Empresa ${empresaId} não encontrada`);
  }

  const empresa = empRes.rows[0];
  if (!empresa.procuracao_ativa) {
    await logEvent(
      'info',
      'esocial-sync',
      `Empresa ${empresa.cnpj} pulada — procuração inativa`,
      null,
      null,
      null,
      { empresaId }
    );
    return { empresaId, skipped: true, reason: 'procuracao_inativa' };
  }

  await logEvent(
    'info',
    'esocial-sync',
    `Iniciando sync da empresa ${empresa.razao_social || empresa.cnpj}`,
    null,
    null,
    null,
    { empresaId }
  );

  // 5 years back to capture active employees admitted years ago
  const periods = lastMonths(60);
  const tpEvts = ['evtAdmissao', 'evtDeslig'];
  const summary = {
    empresaId,
    cnpj: empresa.cnpj,
    admissao: { consulted: 0, processed: 0, failed: 0 },
    deslig: { consulted: 0, processed: 0, failed: 0 },
    errors: [],
  };

  for (const tpEvt of tpEvts) {
    for (const perApur of periods) {
      let eventos = [];
      let attempt = 0;

      while (attempt <= MAX_RETRIES) {
        try {
          await sleep(RATE_LIMIT_MS);
          eventos = await consultarEventos(empresa.cnpj, tpEvt, perApur);
          break;
        } catch (err) {
          attempt++;
          if (attempt > MAX_RETRIES) {
            const msg = `consultarEventos(${tpEvt}, ${perApur}) falhou após ${MAX_RETRIES} retries: ${err.message}`;
            summary.errors.push(msg);
            await logEvent('error', 'esocial-sync', msg, null, null, null, {
              empresaId,
              tpEvt,
              perApur,
            });
            eventos = [];
            break;
          }
          await sleep(RETRY_DELAY_MS);
        }
      }

      const bucket = tpEvt === 'evtAdmissao' ? summary.admissao : summary.deslig;
      bucket.consulted += eventos.length;

      if (eventos.length) {
        const { ok, fail } = await processEventos(empresa, tpEvt, eventos);
        bucket.processed += ok;
        bucket.failed += fail;
      }
    }
  }

  // Update sincronizado_em even if partial success
  await query(
    `UPDATE esocial_empresas SET sincronizado_em = NOW() WHERE id = $1`,
    [empresaId]
  );

  // Count funcionários
  const countRes = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE situacao='ativo')::int AS ativos,
            COUNT(*) FILTER (WHERE situacao='desligado')::int AS desligados
       FROM esocial_funcionarios WHERE empresa_id = $1`,
    [empresaId]
  );
  summary.totals = countRes.rows[0];

  await logEvent(
    'info',
    'esocial-sync',
    `Sync concluído: ${empresa.cnpj} — ${summary.totals.total} funcionários (${summary.totals.ativos} ativos, ${summary.totals.desligados} desligados)`,
    null,
    null,
    null,
    summary
  );

  return summary;
}

/**
 * Sync all empresas with procuracao_ativa=true. One empresa failing
 * never stops the whole loop.
 */
async function syncAll() {
  console.log('[ESOCIAL-SYNC] Starting syncAll...');

  // Pre-flight: bail out early if no active certificate
  const cfgRes = await query(
    `SELECT id FROM esocial_config WHERE active = true LIMIT 1`
  );
  if (!cfgRes.rows.length) {
    console.log('[ESOCIAL-SYNC] No active certificate — skipping syncAll');
    return { skipped: true, reason: 'no_certificate' };
  }

  const empRes = await query(
    `SELECT id, cnpj, razao_social
       FROM esocial_empresas
      WHERE procuracao_ativa = true
      ORDER BY razao_social NULLS LAST, cnpj`
  );

  const empresas = empRes.rows;
  console.log(`[ESOCIAL-SYNC] ${empresas.length} empresa(s) to process`);

  const results = [];
  for (const emp of empresas) {
    try {
      const s = await syncEmpresa(emp.id);
      results.push({ ok: true, empresaId: emp.id, summary: s });
    } catch (err) {
      console.error(`[ESOCIAL-SYNC] Empresa ${emp.cnpj} failed:`, err.message);
      await logEvent(
        'error',
        'esocial-sync',
        `Sync empresa ${emp.cnpj} falhou: ${err.message}`,
        null,
        null,
        null,
        { empresaId: emp.id }
      );
      results.push({ ok: false, empresaId: emp.id, error: err.message });
    }
  }

  console.log(`[ESOCIAL-SYNC] syncAll finished — ${results.length} empresa(s)`);
  return { processed: results.length, results };
}

/**
 * Start the 24h sync scheduler.
 */
function startSyncScheduler() {
  if (process.env.NODE_ENV === 'test') return;

  console.log('[ESOCIAL-SYNC] Scheduler started (every 24h)');
  setInterval(() => {
    syncAll().catch((err) =>
      console.error('[ESOCIAL-SYNC] syncAll error:', err.message)
    );
  }, ONE_DAY_MS);

  // Run once ~2 minutes after boot so the server is warm
  setTimeout(() => {
    syncAll().catch((err) =>
      console.error('[ESOCIAL-SYNC] initial syncAll error:', err.message)
    );
  }, 2 * 60 * 1000);
}

module.exports = {
  syncEmpresa,
  syncAll,
  startSyncScheduler,
  lastMonths,
};
