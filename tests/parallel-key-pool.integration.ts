import assert from 'node:assert/strict';
import { apiKeyPool } from '../src/lib/agent/api-key-pool';

const keyA = `AIza${'A'.repeat(32)}`;
const keyB = `AIza${'B'.repeat(32)}`;
const leaseIds = Array.from({ length: 6 }, (_, index) => `parallel-chat-${index}`);

try {
  apiKeyPool.setRuntimeKeys([keyA]);

  const leases = leaseIds.map(id => apiKeyPool.leaseSpecificKey(id, keyA));
  assert.equal(leases.every(Boolean), true, 'one configured key should admit at least six parallel chats');
  assert.equal(new Set(leases.map(lease => lease?.keyIndex)).size, 1);
  assert.equal(apiKeyPool.activeCount, 6);
  assert.equal(apiKeyPool.canAcceptNewAgent(), true);
  assert.ok(apiKeyPool.maxParallelAgents >= 6);

  for (const id of leaseIds) apiKeyPool.releaseKey(id);

  apiKeyPool.setRuntimeKeys([keyA, keyB]);
  assert.ok(apiKeyPool.leaseSpecificKey('remap-a', keyA));
  assert.ok(apiKeyPool.leaseSpecificKey('remap-b', keyB));

  apiKeyPool.setRuntimeKeys([keyB, keyA]);
  const remapped = apiKeyPool.getPoolStatus().leases;
  assert.equal(remapped.find(lease => lease.chatId.startsWith('remap-a'))?.keyIndex, 1);
  assert.equal(remapped.find(lease => lease.chatId.startsWith('remap-b'))?.keyIndex, 0);

  apiKeyPool.releaseKey('remap-a');
  apiKeyPool.releaseKey('remap-b');

  const balancedLeases = ['balanced-a', 'balanced-b'].map(id => apiKeyPool.leaseKey(id));
  assert.equal(new Set(balancedLeases.map(lease => lease?.keyIndex)).size, 2, 'all configured keys should be used before reusing one');

  const failedLease = apiKeyPool.leaseKey('failure-check');
  assert.ok(failedLease);
  const replacementLease = apiKeyPool.reportFailure('failure-check', 'auth', 'invalid API key');
  assert.ok(replacementLease);
  assert.notEqual(replacementLease?.keyIndex, failedLease?.keyIndex, 'failure rotation should try another configured key');
  assert.equal(apiKeyPool.getPoolStatus().totalKeys, 2);

  console.log('Parallel API-key pool integration checks passed.');
} finally {
  for (const id of [...leaseIds, 'remap-a', 'remap-b', 'balanced-a', 'balanced-b', 'failure-check']) apiKeyPool.releaseKey(id);
  apiKeyPool.setRuntimeKeys([]);
}
