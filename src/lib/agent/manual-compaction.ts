import type { ContextUsageTrace } from './resilience/context-compaction';

export type ManualCompactionResult = {
  status: 'compacted' | 'unchanged' | 'cancelled' | 'failed';
  usage?: ContextUsageTrace;
  error?: string;
};

export type CompactionRun = {
  runId?: string;
  signal: AbortSignal;
  finished: Promise<void>;
  completed: () => boolean;
};

/** The next safe provider boundary can claim a request only while its run owns it. */
type Request = { run: CompactionRun; claimed: boolean; rawSettings?: unknown; finish: (result: ManualCompactionResult) => void };
type DirectRunControls = { cancel: () => void; codexModel?: string };
type DirectRun = CompactionRun & { controls?: DirectRunControls };
const state = globalThis as typeof globalThis & {
  __eterxManualCompactions?: Map<string, Request>;
  __eterxManualCompactionJobs?: Map<string, Promise<ManualCompactionResult>>;
  __eterxDirectCompactionRuns?: Map<string, DirectRun>;
};
const requests = state.__eterxManualCompactions ||= new Map();
const jobs = state.__eterxManualCompactionJobs ||= new Map();
const directRuns = state.__eterxDirectCompactionRuns ||= new Map();
export const getDirectCompactionRun = (chatId: string) => directRuns.get(chatId);
export const isDirectChatRunning = (chatId: string) => directRuns.has(chatId);
export const getActiveDirectChatRuns = () => [...directRuns.values()];
export function beginDirectChatRun(chatId: string, runId: string | undefined, signal: AbortSignal, controls?: DirectRunControls) {
  let succeeded = false;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const run: DirectRun = { runId, signal, finished, completed: () => succeeded, controls };
  directRuns.set(chatId, run);
  return (completed: boolean) => {
    if (directRuns.get(chatId) !== run) return;
    succeeded = completed && !signal.aborted;
    directRuns.delete(chatId);
    finish();
  };
}
export const isManualCompactionActive = (chatId: string) => jobs.has(chatId);
export const getManualCompactionJob = (chatId: string) => jobs.get(chatId);
export function claimManualCompaction(chatId: string, runId?: string, signal?: AbortSignal) {
  const request = requests.get(chatId);
  if (!request || request.claimed || request.run.signal.aborted || signal?.aborted) return null;
  const sameRun = runId && request.run.runId ? runId === request.run.runId : signal === request.run.signal;
  if (!sameRun) return null;
  request.claimed = true;
  return request;
}
export function requestManualCompaction(chatId: string, run: CompactionRun | undefined,
  compactIdle: () => Promise<ManualCompactionResult>, rawSettings?: unknown): Promise<ManualCompactionResult> {
  const existing = jobs.get(chatId);
  if (existing) return existing;
  const job = (async () => {
    if (!run) return compactIdle();
    let settle!: (result: ManualCompactionResult | null) => void;
    const receipt = new Promise<ManualCompactionResult | null>(resolve => { settle = resolve; });
    const request: Request = { run, claimed: false, rawSettings, finish: settle };
    const cancel = () => {
      if (!run.completed()) {
        if (requests.get(chatId) === request) requests.delete(chatId);
        settle({ status: 'cancelled' });
      }
    };
    requests.set(chatId, request);
    run.signal.addEventListener('abort', cancel, { once: true });
    if (run.signal.aborted) cancel();
    try {
      const result = await Promise.race([receipt, run.finished.then(() =>
        run.completed() && !request.claimed ? null : { status: 'cancelled' as const })]);
      if (result) return result;
    } finally {
      run.signal.removeEventListener('abort', cancel);
      if (requests.get(chatId) === request) requests.delete(chatId);
    }
    // A normally completed reply might never have reached another provider
    // boundary. Its final checkpoint now contains the entire exchange.
    return compactIdle();
  })().finally(() => jobs.delete(chatId));
  jobs.set(chatId, job);
  return job;
}
