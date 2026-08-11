import assert from 'node:assert/strict';
import { PollingConcurrencyGate } from '../src/lib/agent/polling-coordinator';

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function testConcurrencyAndFairness() {
  const gate = new PollingConcurrencyGate(2);
  const first = await gate.acquire();
  const second = await gate.acquire();
  let thirdGranted = false;
  const thirdPromise = gate.acquire().then(release => {
    thirdGranted = true;
    release();
  });

  assert.equal(gate.stats.inFlight, 2);
  assert.equal(gate.stats.queued, 1);
  await sleep(5);
  assert.equal(thirdGranted, false);
  first();
  await thirdPromise;
  assert.equal(thirdGranted, true);
  second();
  assert.equal(gate.stats.inFlight, 0);
}

async function testAbortRemovesWaiter() {
  const gate = new PollingConcurrencyGate(1);
  const release = await gate.acquire();
  const controller = new AbortController();
  const waiting = gate.acquire(controller.signal).then(
    () => { throw new Error('Aborted poll unexpectedly acquired a slot.'); },
    error => assert.equal(error.name, 'AbortError'),
  );
  controller.abort();
  await waiting;
  assert.equal(gate.stats.queued, 0);
  release();
  assert.equal(gate.stats.inFlight, 0);
}

async function testTenAgentShape() {
  const gate = new PollingConcurrencyGate(8);
  const releases = await Promise.all(Array.from({ length: 8 }, () => gate.acquire()));
  let ninthGranted = false;
  const ninth = gate.acquire().then(release => {
    ninthGranted = true;
    release();
  });
  const tenth = gate.acquire();
  assert.equal(gate.stats.inFlight, 8);
  assert.equal(gate.stats.queued, 2);
  releases[0]();
  await ninth;
  assert.equal(ninthGranted, true);
  releases.slice(1).forEach(release => release());
  (await tenth)();
  assert.deepEqual(gate.stats, { inFlight: 0, queued: 0, maxConcurrent: 8 });
}

async function main() {
  await testConcurrencyAndFairness();
  await testAbortRemovesWaiter();
  await testTenAgentShape();
  console.log('polling-coordinator integration tests passed');
}

void main();
