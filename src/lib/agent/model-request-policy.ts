// Reasoning and large code responses can take much longer than discovery.
// This is a per-request SDK allowance, not a total agent-run time limit.
// Caller AbortSignals still allow the user to stop the request immediately.
export const MODEL_REQUEST_TIMEOUT_MS = 60 * 60_000;
