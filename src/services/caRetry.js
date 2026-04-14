const { query } = require('../config/database');
const { processContaAzul } = require('./contaAzul');
const { logEvent } = require('./logger');

const TWO_HOURS = 2 * 60 * 60 * 1000;

/**
 * Retry CA contract creation for all contracts stuck as pendente_ca.
 */
async function retryCaContracts() {
  console.log('[CA-RETRY] Checking for pendente_ca contracts...');

  try {
    const result = await query(
      `SELECT * FROM contracts WHERE status = 'pendente_ca' ORDER BY created_at ASC`
    );

    const contracts = result.rows;
    if (!contracts.length) {
      console.log('[CA-RETRY] No pendente_ca contracts found');
      return;
    }

    console.log(`[CA-RETRY] Found ${contracts.length} pendente_ca contracts`);

    for (const contract of contracts) {
      try {
        const services = typeof contract.services === 'string'
          ? JSON.parse(contract.services)
          : (contract.services || []);

        const caResult = await processContaAzul({
          companyName: contract.company_name,
          cnpj: contract.cnpj,
          email: contract.email,
          month: contract.month,
          monthlyValue: parseFloat(contract.monthly_value) || 0,
          discount: parseFloat(contract.discount) || 0,
          services,
          observations: contract.observations,
        }, contract.id);

        if (caResult.contractId) {
          await query(
            `UPDATE contracts SET status='success', conta_azul_customer_id=$1, conta_azul_contract_id=$2, updated_at=NOW() WHERE id=$3`,
            [caResult.customerId, caResult.contractId, contract.id]
          );
          await logEvent('info', 'ca-retry', `Contract ${contract.id} (${contract.company_name}) succeeded on retry`, contract.id);
          console.log(`[CA-RETRY] Contract ${contract.id} (${contract.company_name}) -> success`);
        } else {
          // Still pendente_ca, leave as is
          await logEvent('info', 'ca-retry', `Contract ${contract.id} still pendente_ca after retry`, contract.id);
        }
      } catch (err) {
        await logEvent('error', 'ca-retry', `Retry failed for contract ${contract.id}: ${err.message}`, contract.id);
        console.error(`[CA-RETRY] Failed for contract ${contract.id}: ${err.message}`);
        // Leave status as pendente_ca — will retry next cycle
      }
    }
  } catch (err) {
    console.error('[CA-RETRY] Scheduler error:', err.message);
  }
}

/**
 * Start the CA retry scheduler — runs every 2 hours.
 */
function startCaRetryScheduler() {
  if (process.env.NODE_ENV === 'test') return;

  console.log('[CA-RETRY] Scheduler started (every 2 hours)');
  setInterval(retryCaContracts, TWO_HOURS);

  // Run first check after 30 seconds (let the server finish booting)
  setTimeout(retryCaContracts, 30000);
}

module.exports = { startCaRetryScheduler, retryCaContracts };
