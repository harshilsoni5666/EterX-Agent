import assert from 'node:assert/strict';
import { withApiKeyRounds } from '../src/lib/agent/api-retry';

const alwaysFail = async (key: string, seen: string[]) => {
  seen.push(key);
  throw new Error('503 temporary provider failure');
};

const main = async () => {
  const noneSeen: string[] = [];
  await assert.rejects(
    withApiKeyRounds(
      ['key-1', 'key-2', 'key-3'],
      { apiRetries: 0 },
      key => alwaysFail(key, noneSeen),
    ),
    /503 temporary provider failure/,
  );
  assert.deepEqual(noneSeen, ['key-1', 'key-2', 'key-3']);

  const retrySeen: string[] = [];
  let attempts = 0;
  const recovered = await withApiKeyRounds(
    ['key-1', 'key-2', 'key-3'],
    { apiRetries: 1 },
    async key => {
      retrySeen.push(key);
      attempts += 1;
      if (attempts < 6) throw new Error('503 temporary provider failure');
      return key;
    },
  );
  assert.equal(recovered, 'key-3');
  assert.deepEqual(retrySeen, ['key-1', 'key-2', 'key-3', 'key-1', 'key-2', 'key-3']);

  const invalidRequestSeen: string[] = [];
  await assert.rejects(
    withApiKeyRounds(
      ['key-1', 'key-2', 'key-3'],
      { apiRetries: 3 },
      key => {
        invalidRequestSeen.push(key);
        throw new Error('400 invalid argument');
      },
    ),
    /400 invalid argument/,
  );
  assert.deepEqual(invalidRequestSeen, ['key-1']);

  console.log('api-retry.integration: passed');
};

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
