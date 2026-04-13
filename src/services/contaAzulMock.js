/**
 * contaAzulMock.js
 * Simulates Conta Azul API responses for development/testing.
 * Activated when CONTA_AZUL_CLIENT_ID is not set.
 */

const { v4: uuidv4 } = require('uuid');
const { logEvent } = require('../services/logger');

async function processContaAzulMock(contractData, contractId) {
  await logEvent('warn', 'contaazul', '⚠️  MOCK MODE — Conta Azul not configured, simulating response', contractId);

  // Simulate network delay
  await new Promise(r => setTimeout(r, 300));

  const customerId = `mock-customer-${uuidv4().slice(0, 8)}`;
  const caContractId = `mock-contract-${uuidv4().slice(0, 8)}`;

  await logEvent('info', 'contaazul', `MOCK: Customer created ${customerId}`, contractId);
  await logEvent('info', 'contaazul', `MOCK: Contract created ${caContractId}`, contractId);

  return {
    customerId,
    contractId: caContractId,
    customer: { id: customerId, name: contractData.companyName, mock: true },
    contract: { id: caContractId, mock: true }
  };
}

module.exports = { processContaAzulMock };
