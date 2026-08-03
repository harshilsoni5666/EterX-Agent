import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'eterx-scheduled-task-store-'));
  process.env.ETERX_DATA_DIR = dataDir;

  try {
    const { loadScheduledTaskSnapshot } = await import('../src/lib/scheduled-task-store');

    const initial = await loadScheduledTaskSnapshot();
    assert.equal(initial.tasks.length, 0, 'the isolated store should start empty');

    const storeDir = path.join(dataDir, 'scheduled-tasks');
    await mkdir(storeDir, { recursive: true });
    await writeFile(path.join(storeDir, 'tasks.json'), JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      tasks: [{
        id: 'task_external_writer',
        title: 'Written by agent runtime',
        description: 'Verify that a separate runtime can publish a task to the Tasks tab.',
        scheduledTimestamp: Date.now() + 60_000,
        status: 'scheduled',
      }],
    }));

    const refreshed = await loadScheduledTaskSnapshot();
    assert.equal(
      refreshed.tasks[0]?.id,
      'task_external_writer',
      'reads must observe tasks written after an earlier runtime cached an empty snapshot',
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }

  console.log('Scheduled task store integration checks passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
