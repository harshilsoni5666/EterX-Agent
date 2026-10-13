/** One request per conversation; provider adapters consume it at a safe boundary. */
type Request = { claimed: boolean; rawSettings?: unknown; finish: (error?: Error) => void };
const state = globalThis as typeof globalThis & {
  __eterxManualCompactions?: Map<string, Request>;
  __eterxManualCompactionJobs?: Map<string, Promise<void>>;
  __eterxDirectChatRuns?: Map<string, number>;
};
const requests = state.__eterxManualCompactions ||= new Map();
const jobs = state.__eterxManualCompactionJobs ||= new Map();
const directRuns = state.__eterxDirectChatRuns ||= new Map();
export const isDirectChatRunning = (chatId: string) => (directRuns.get(chatId) || 0) > 0;
export function beginDirectChatRun(chatId: string): () => void {
  directRuns.set(chatId, (directRuns.get(chatId) || 0) + 1);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const count = (directRuns.get(chatId) || 1) - 1;
    if (count > 0) directRuns.set(chatId, count);
    else directRuns.delete(chatId);
  };
}
export const isManualCompactionActive = (chatId: string) => jobs.has(chatId);
export function claimManualCompaction(chatId: string) {
  const request = requests.get(chatId);
  if (!request || request.claimed) return null;
  request.claimed = true;
  return request;
}
export function requestManualCompaction(chatId: string, isRunning: () => boolean, compactIdle: () => Promise<void>, rawSettings?: unknown): Promise<void> {
  const existing = jobs.get(chatId);
  if (existing) return existing;
  const job = (async () => {
    if (isRunning()) {
      let finished = false;
      let failure: Error | undefined;
      const request: Request = { claimed: false, rawSettings, finish: error => { failure = error; finished = true; } };
      requests.set(chatId, request);
      try {
        // An in-flight tool completes normally. If the run settles without another
        // model boundary, compact its saved transcript instead.
        while (!finished && (isRunning() || request.claimed)) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        // Stopping the agent must not cancel the user's separate Compact action.
        // Wait for its final checkpoint in compactIdle and retry independently.
        if (failure && !/CANCELLED_BY_USER|AbortError|aborted/i.test(`${failure.name}: ${failure.message}`)) throw failure;
        if (finished && !failure) return;
      } finally { requests.delete(chatId); }
    }
    await compactIdle();
  })().finally(() => jobs.delete(chatId));
  jobs.set(chatId, job);
  return job;
}
