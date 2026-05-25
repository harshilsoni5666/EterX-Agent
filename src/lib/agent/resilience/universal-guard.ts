/**
 * ═══════════════════════════════════════════════════════════════
 * UNIVERSAL RESILIENCE GUARD
 * ═══════════════════════════════════════════════════════════════
 *
 * The single point of protection for ALL external calls in EterX.
 * Wraps every API call, tool call, and I/O operation with:
 *
 *   1. MODEL DEPRECATION GUARD — auto-advances fallback chain on 404/deprecated
 *   2. KEY EXHAUSTION GUARD   — waits & hot-reloads when ALL keys are rate-limited
 *   3. RETRY + JITTER GUARD   — exponential backoff with jitter for transient errors
 *   4. NETWORK GUARD          — handles DNS failures, ECONNRESET, stream timeouts
 *   5. CONTEXT OVERFLOW GUARD — auto-compresses and retries when context is too long
 *   6. CIRCUIT BREAKER        — stops hammering a failing endpoint for a cooling period
 *   7. TIMEOUT GUARD          — per-call hard timeout with configurable ms
 *
 * Usage:
 *   import { guard } from './resilience/universal-guard';
 *   const result = await guard(() => someApiCall(), { mode: 'think', chatId, timeoutMs: 30000 });
 */

import { isModelDeprecatedError, getFallbackChain, clearProvenModel, recordProvenModel, type MainAgentMode } from '../model-routing';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GuardOptions {
  /** Agent mode — used for model fallback chain traversal */
  mode?: MainAgentMode;
  /** Chat / project ID — used for key pool reporting */
  chatId?: string;
  /** Hard timeout per attempt in ms. Default: 300_000 (5 min) */
  timeoutMs?: number;
  /** Max total attempts (across all strategies). Default: 4 */
  maxAttempts?: number;
  /** Label for logging. Default: 'operation' */
  label?: string;
  /** Called when the model switches mid-chain, so the caller can update its client */
  onModelSwitch?: (newModelName: string) => void;
  /** If true, context overflow errors will call this to get compressed content */
  onContextOverflow?: () => Promise<any[] | null>;
  /** Disable retry for this call */
  noRetry?: boolean;
}

export interface GuardResult<T> {
  value: T;
  modelUsed?: string;
  attempts: number;
  totalMs: number;
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

interface CircuitState {
  failures: number;
  lastFailureAt: number;
  openUntil: number;
}

const CIRCUIT_OPEN_MS = 60_000;     // 60 seconds cool-down
const CIRCUIT_THRESHOLD = 5;        // open after 5 consecutive failures
const circuits: Map<string, CircuitState> = new Map();

function isCircuitOpen(key: string): boolean {
  const state = circuits.get(key);
  if (!state) return false;
  if (Date.now() > state.openUntil) {
    circuits.delete(key);
    return false;
  }
  return true;
}

function recordCircuitFailure(key: string): void {
  const state = circuits.get(key) ?? { failures: 0, lastFailureAt: 0, openUntil: 0 };
  state.failures++;
  state.lastFailureAt = Date.now();
  if (state.failures >= CIRCUIT_THRESHOLD) {
    state.openUntil = Date.now() + CIRCUIT_OPEN_MS;
    console.warn(`[Guard] ⚡ Circuit OPEN for "${key}" — cooling ${CIRCUIT_OPEN_MS / 1000}s`);
  }
  circuits.set(key, state);
}

function recordCircuitSuccess(key: string): void {
  circuits.delete(key);
}

// ─── Error classification ─────────────────────────────────────────────────────

type ErrorClass =
  | 'rate_limit'
  | 'model_deprecated'
  | 'context_overflow'
  | 'auth'
  | 'server_error'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'unknown';

function classifyError(error: unknown): ErrorClass {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (lower.includes('cancelled_by_user')) return 'cancelled';
  if (lower.includes('context_length_exceeded') || lower.includes('too many tokens') || lower.includes('token limit') || lower.includes('context window') || lower.includes('input too long')) return 'context_overflow';
  if (isModelDeprecatedError(lower)) return 'model_deprecated';
  if (lower.includes('429') || lower.includes('quota') || lower.includes('rate limit') || lower.includes('resource_exhausted')) return 'rate_limit';
  if (lower.includes('401') || lower.includes('403') || lower.includes('api key') || lower.includes('unauthenticated') || lower.includes('forbidden')) return 'auth';
  if (lower.includes('503') || lower.includes('500') || lower.includes('502') || lower.includes('unavailable') || lower.includes('overloaded')) return 'server_error';
  if (lower.includes('econnreset') || lower.includes('enotfound') || lower.includes('fetch failed') || lower.includes('network') || lower.includes('dns') || lower.includes('socket')) return 'network';
  if (lower.includes('timeout') || lower.includes('deadline_exceeded') || lower.includes('timed out')) return 'timeout';
  return 'unknown';
}

// ─── Backoff strategy ─────────────────────────────────────────────────────────

function getBackoffMs(attempt: number, errorClass: ErrorClass): number {
  const base: Record<ErrorClass, number> = {
    rate_limit: 8_000,
    model_deprecated: 100,
    context_overflow: 100,
    auth: 1_000,
    server_error: 4_000,
    network: 2_000,
    timeout: 3_000,
    cancelled: 0,
    unknown: 2_000,
  };
  const jitter = Math.floor(Math.random() * 1_000);
  // Exponential backoff capped at 60s
  return Math.min(base[errorClass] * Math.pow(1.8, attempt) + jitter, 60_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

// ─── Main guard function ──────────────────────────────────────────────────────

/**
 * Wrap any async call with full resilience protection.
 *
 * @param fn Factory that creates the promise. Called again on retry with updated context.
 * @param opts GuardOptions
 */
export async function guard<T>(
  fn: (ctx: { modelName?: string }) => Promise<T>,
  opts: GuardOptions = {}
): Promise<GuardResult<T>> {
  const {
    mode,
    chatId,
    timeoutMs = 300_000,
    maxAttempts = 4,
    label = 'operation',
    onModelSwitch,
    onContextOverflow,
    noRetry = false,
  } = opts;

  const circuitKey = `${label}:${mode ?? 'generic'}`;
  const startTime = Date.now();

  if (isCircuitOpen(circuitKey)) {
    throw new Error(`[Guard] Circuit open for "${label}" — cooling period active. Try again in ~60s.`);
  }

  // Build model fallback chain
  const modelChain: string[] = mode ? getFallbackChain(mode) : [];
  let modelIdx = 0;
  let currentModel = modelChain[modelIdx] ?? undefined;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const result = await Promise.race([
        fn({ modelName: currentModel }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`[Guard] Timeout after ${timeoutMs}ms for "${label}"`)), timeoutMs)
        ),
      ]);

      // Success
      recordCircuitSuccess(circuitKey);
      if (mode && currentModel) {
        recordProvenModel(mode, currentModel);
        if (attempts > 1) {
          console.log(`[Guard] ✅ "${label}" succeeded on attempt ${attempts} with model: ${currentModel}`);
        }
      }

      return { value: result, modelUsed: currentModel, attempts, totalMs: Date.now() - startTime };

    } catch (err: unknown) {
      const errClass = classifyError(err);
      const errMsg = err instanceof Error ? err.message : String(err);

      // Cancelled — never retry
      if (errClass === 'cancelled') throw err;

      console.warn(`[Guard] ⚠️ "${label}" attempt ${attempts}/${maxAttempts} failed [${errClass}]: ${errMsg.substring(0, 120)}`);

      // ── Model deprecated → advance fallback chain ──────────────────────────
      if (errClass === 'model_deprecated' && mode) {
        clearProvenModel(mode);
        modelIdx++;
        if (modelIdx < modelChain.length) {
          const nextModel = modelChain[modelIdx];
          console.warn(`[Guard] 🔄 Model deprecated. Switching to fallback: ${nextModel}`);
          currentModel = nextModel;
          onModelSwitch?.(nextModel);
          // Don't count model switch as an "attempt" toward max
          attempts--;
          continue;
        } else {
          console.error(`[Guard] ❌ All ${modelChain.length} models in fallback chain exhausted.`);
          recordCircuitFailure(circuitKey);
          throw new Error(`All model fallbacks exhausted for mode "${mode}". Last error: ${errMsg}`);
        }
      }

      // ── Context overflow → compress and retry once ─────────────────────────
      if (errClass === 'context_overflow' && onContextOverflow && attempts === 1) {
        console.warn(`[Guard] 📦 Context overflow detected. Requesting compression…`);
        try {
          await onContextOverflow();
          // Retry immediately without backoff
          continue;
        } catch {
          // compression failed — fall through to normal retry/fail
        }
      }

      // ── Auth failure — no point retrying with same key ─────────────────────
      if (errClass === 'auth') {
        recordCircuitFailure(circuitKey);
        throw err;
      }

      // ── Rate limit — wait longer before retry ──────────────────────────────
      if (errClass === 'rate_limit' && attempts < maxAttempts) {
        if (noRetry) { recordCircuitFailure(circuitKey); throw err; }
        // Extract retry-after header hint if embedded in the message
        const retryAfterMatch = errMsg.match(/retry[_\s-]?after[:\s]+(\d+)/i);
        const waitMs = retryAfterMatch
          ? parseInt(retryAfterMatch[1], 10) * 1_000
          : getBackoffMs(attempts, errClass);
        console.warn(`[Guard] ⏳ Rate limited. Waiting ${(waitMs / 1000).toFixed(1)}s before retry…`);
        await sleep(waitMs);
        continue;
      }

      // ── Server / network / timeout — exponential backoff ──────────────────
      if (
        (errClass === 'server_error' || errClass === 'network' || errClass === 'timeout' || errClass === 'unknown')
        && attempts < maxAttempts
        && !noRetry
      ) {
        const waitMs = getBackoffMs(attempts, errClass);
        console.warn(`[Guard] 🔁 Retrying in ${(waitMs / 1000).toFixed(1)}s…`);
        await sleep(waitMs);
        continue;
      }

      // Out of attempts
      recordCircuitFailure(circuitKey);
      throw err;
    }
  }

  // Should never reach here
  recordCircuitFailure(circuitKey);
  throw new Error(`[Guard] "${label}" failed after ${maxAttempts} attempts.`);
}

// ─── Key exhaustion guard (global) ────────────────────────────────────────────
// Called by the API key pool when ALL keys are exhausted.
// Waits 65s (quota window) then signals hot-reload.

let _keyExhaustionResolvers: Array<() => void> = [];
let _keyExhaustionTimer: ReturnType<typeof setTimeout> | null = null;

export function waitForKeyRecovery(): Promise<void> {
  return new Promise<void>((resolve) => {
    _keyExhaustionResolvers.push(resolve);
    if (!_keyExhaustionTimer) {
      _keyExhaustionTimer = setTimeout(() => {
        _keyExhaustionTimer = null;
        const resolvers = _keyExhaustionResolvers.splice(0);
        console.warn(`[Guard] 🔑 Key exhaustion wait complete — signalling ${resolvers.length} waiters`);
        resolvers.forEach(r => r());
      }, 65_000); // 65s = one quota window
    }
  });
}

export function signalKeysRefreshed(): void {
  if (_keyExhaustionTimer) {
    clearTimeout(_keyExhaustionTimer);
    _keyExhaustionTimer = null;
  }
  const resolvers = _keyExhaustionResolvers.splice(0);
  if (resolvers.length > 0) {
    console.log(`[Guard] ✅ Keys refreshed — releasing ${resolvers.length} waiters immediately`);
    resolvers.forEach(r => r());
  }
}

// ─── Circuit breaker status (for diagnostics) ────────────────────────────────
export function getCircuitStatus(): Array<{ key: string; failures: number; openUntil: number; isOpen: boolean }> {
  return Array.from(circuits.entries()).map(([key, state]) => ({
    key,
    failures: state.failures,
    openUntil: state.openUntil,
    isOpen: Date.now() < state.openUntil,
  }));
}

export function resetAllCircuits(): void {
  circuits.clear();
  console.log('[Guard] 🔄 All circuit breakers reset');
}
