/** One request per conversation; provider adapters consume it at a safe boundary. */
type Request = { claimed: boolean; finish: (error?: Error) => void };
const state = globalThis as typeof globalThis & {
  __eterxManualCompactions?: Map<string, Request>;
  __eterxManualCompactionJobs?: Map<string, Promise<void>>;
};
const requests = state.__eterxManualCompactions ||= new Map();
const jobs = state.__eterxManualCompactionJobs ||= new Map();
export const isManualCompactionActive = (chatId: string) => jobs.has(chatId);
export function claimManualCompaction(chatId: string) {
  const request = requests.get(chatId);
  if (!request || request.claimed) return null;
  request.claimed = true;
  return request.finish;
}
export function requestManualCompaction(chatId: string, isRunning: () => boolean, compactIdle: () => Promise<void>): Promise<void> {
  const existing = jobs.get(chatId);
  if (existing) return existing;
  const job = (async () => {
    if (isRunning()) {
      let finished = false;
      let failure: Error | undefined;
      const request: Request = { claimed: false, finish: error => { failure = error; finished = true; } };
      requests.set(chatId, request);
      try {
        // An in-flight tool completes normally. If the run settles without another
        // model boundary, compact its saved transcript instead.
        while (!finished && (isRunning() || request.claimed)) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (failure) throw failure;
        if (finished) return;
      } finally { requests.delete(chatId); }
    }
    await compactIdle();
  })().finally(() => jobs.delete(chatId));
  jobs.set(chatId, job);
  return job;
}
