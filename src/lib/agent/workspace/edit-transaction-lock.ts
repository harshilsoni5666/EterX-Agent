// Reserve an entire target set before awaiting, avoiding A->B / B->A deadlocks.
// Unrelated files remain independent across chats and concurrent tool calls.
const pendingEdits = new Map<string, Promise<void>>();

export async function acquireEditTransaction(paths: string[]): Promise<() => void> {
  const keys = [...new Set(paths.map(value => process.platform === 'win32' ? value.toLowerCase() : value))].sort();
  const predecessors = keys.flatMap(key => pendingEdits.has(key) ? [pendingEdits.get(key)!] : []);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = Promise.all(predecessors);
  const tail = ready.then(() => held);
  for (const key of keys) pendingEdits.set(key, tail);
  await ready;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) if (pendingEdits.get(key) === tail) pendingEdits.delete(key);
    release();
  };
}
