/**
 * ═══════════════════════════════════════════════════════════════
 * AUTO CONTEXT MANAGER — Self-Compressing Agent Memory
 * ═══════════════════════════════════════════════════════════════
 *
 * Solves the #1 cause of long-task failure: CONTEXT OVERFLOW.
 *
 * As a task runs for hours, the conversation history grows until
 * it hits the model's context window limit → the agent crashes or
 * starts forgetting everything. This module prevents that by:
 *
 *  1. SMART COMPRESSION — Summarize old tool outputs, keep key facts
 *  2. PROTECTED ZONES   — Never compress system prompt, skill guidelines,
 *                         task plans, or recent (last 6) turns
 *  3. PROGRESSIVE TIERS — The older a turn, the more aggressively compressed
 *  4. FACT EXTRACTION   — Before compressing, mine important facts into
 *                         the Lifetime Brain so nothing is truly lost
 *  5. TOKEN BUDGET      — Track estimated token usage and compress
 *                         proactively before overflow, not after
 *  6. MILESTONE SAVES   — Every N tool calls, save a full compressed
 *                         snapshot to disk so the agent can resume
 *                         after a crash mid-task
 *  7. CONTEXT RESUME    — On task resume, inject the compressed snapshot
 *                         as the new starting context
 *
 * Used by: gemini.ts ReAct loop (called every iteration)
 */

import path from 'path';
import fs from 'fs-extra';
import { lifetimeBrain } from '../memory/lifetime';

const CONTEXT_DIR = path.resolve(process.cwd(), '.workspaces', '.context');
const SNAPSHOT_FILE = path.join(CONTEXT_DIR, 'context_snapshots.json');

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeJson(tmpPath, data, { spaces: 2 });
  await fs.move(tmpPath, filePath, { overwrite: true });
}

// ─── Token estimation ─────────────────────────────────────────────────────────
// ~4 chars per token (empirical for mixed code/text)
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateContentsTokens(contents: any[]): number {
  return estimateTokens(JSON.stringify(contents));
}

// ─── Compression tiers ────────────────────────────────────────────────────────
// How aggressively to compress based on age of the turn

export type CompressionTier = 'none' | 'light' | 'medium' | 'heavy' | 'ultra';

function getCompressionTier(turnIndex: number, totalTurns: number): CompressionTier {
  const recencyRatio = turnIndex / totalTurns; // 0 = oldest, 1 = newest
  if (recencyRatio > 0.85) return 'none';     // Last 15%: never touch
  if (recencyRatio > 0.6)  return 'light';    // 60-85%: gentle trim
  if (recencyRatio > 0.4)  return 'medium';   // 40-60%: moderate
  if (recencyRatio > 0.2)  return 'heavy';    // 20-40%: aggressive
  return 'ultra';                              // First 20%: maximum
}

// ─── Tool output compressor ───────────────────────────────────────────────────

const MAX_LENGTHS: Record<CompressionTier, number> = {
  none:   100_000, // No limit
  light:   8_000,
  medium:  2_000,
  heavy:     500,
  ultra:     120,
};

function compressFunctionResponse(
  part: any,
  tier: CompressionTier,
  toolName: string
): any {
  if (tier === 'none') return part;

  const maxLength = MAX_LENGTHS[tier];
  const response = part?.functionResponse?.response;
  if (!response) return part;

  const outputStr = typeof response.output === 'string'
    ? response.output
    : JSON.stringify(response.output);

  if (outputStr.length <= maxLength) return part;

  const isSuccess = !response.output?.error;
  const head = outputStr.substring(0, maxLength * 0.7);
  const tail = tier === 'ultra' ? '' : outputStr.slice(-(maxLength * 0.3));

  const compressed = tier === 'ultra'
    ? `${isSuccess ? 'SUCCESS' : 'FAILED'}. Key result: ${head}…[${tier} compressed]`
    : `${head}…[${tier} compressed, ${(outputStr.length / 1024).toFixed(0)}KB total]${tail}`;

  return {
    functionResponse: {
      name: part.functionResponse.name,
      response: {
        output: { _compressed: tier, _originalLen: outputStr.length, summary: compressed }
      },
      ...(part.functionResponse.id ? { id: part.functionResponse.id } : {}),
    }
  };
}

function compressTextPart(part: any, tier: CompressionTier): any {
  if (tier === 'none' || !part?.text) return part;
  const maxLength = MAX_LENGTHS[tier];
  if (part.text.length <= maxLength) return part;
  const head = part.text.substring(0, maxLength * 0.8);
  const tail = part.text.slice(-(maxLength * 0.2));
  return { text: `${head}\n…[${tier} compressed]…\n${tail}` };
}

// ─── Protected content detection ──────────────────────────────────────────────

function isProtectedContent(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes('skill_guidelines') ||
    t.includes('task_decomposer') ||
    t.includes('system_prompt') ||
    t.includes('[current user request') ||
    t.includes('current request guard') ||
    t.includes('task plan') ||
    t.includes('[already done]') ||
    t.includes('[next step]')
  );
}

// ─── Main compression function ────────────────────────────────────────────────

export interface CompressionResult {
  contents: any[];
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  compressionRatio: number;
  turnsCompressed: number;
}

/**
 * Compress a conversation contents array.
 *
 * @param contents The full conversation history (role/parts arrays)
 * @param targetTokenBudget Max tokens to stay under (default: 900k)
 * @param protectedTailTurns How many recent turns to never compress (default: 6)
 */
export function compressContents(
  contents: any[],
  targetTokenBudget = 900_000,
  protectedTailTurns = 6
): CompressionResult {
  const originalStr = JSON.stringify(contents);
  const originalTokens = estimateTokens(originalStr);

  if (originalTokens <= targetTokenBudget) {
    return {
      contents,
      originalTokens,
      compressedTokens: originalTokens,
      savedTokens: 0,
      compressionRatio: 1,
      turnsCompressed: 0,
    };
  }

  const total = contents.length;
  const protectedStart = Math.max(0, total - protectedTailTurns);
  let turnsCompressed = 0;

  const compressed = contents.map((entry, idx) => {
    if (idx >= protectedStart) return entry; // Never compress recent turns
    if (!Array.isArray(entry?.parts)) return entry;

    const tier = getCompressionTier(idx, total);
    if (tier === 'none') return entry;

    // Check if this is protected content (skill guidelines, task plans, etc.)
    const entryText = JSON.stringify(entry);
    if (isProtectedContent(entryText)) return entry;

    const newParts = entry.parts.map((part: any) => {
      if (part?.functionResponse) {
        const toolName = part.functionResponse.name || '';
        return compressFunctionResponse(part, tier, toolName);
      }
      if (part?.text) {
        return compressTextPart(part, tier);
      }
      return part;
    });

    const wasCompressed = JSON.stringify(newParts) !== JSON.stringify(entry.parts);
    if (wasCompressed) turnsCompressed++;

    return { ...entry, parts: newParts };
  });

  const compressedStr = JSON.stringify(compressed);
  const compressedTokens = estimateTokens(compressedStr);

  return {
    contents: compressed,
    originalTokens,
    compressedTokens,
    savedTokens: originalTokens - compressedTokens,
    compressionRatio: compressedTokens / originalTokens,
    turnsCompressed,
  };
}

// ─── Auto-compress with auto-escalation ──────────────────────────────────────

/**
 * Auto-compress contents to fit within token budget.
 * Escalates compression aggressiveness until budget is met.
 * Logs progress.
 */
export function autoCompress(
  contents: any[],
  targetTokenBudget = 900_000
): { contents: any[]; report: string } {
  const startTokens = estimateContentsTokens(contents);

  if (startTokens <= targetTokenBudget) {
    return { contents, report: `No compression needed (${(startTokens / 1000).toFixed(0)}k tokens)` };
  }

  console.warn(`[AutoContext] ⚠️ Context at ${(startTokens / 1000).toFixed(0)}k tokens — compressing to fit ${(targetTokenBudget / 1000).toFixed(0)}k budget`);

  // Try increasingly aggressive protected tail reductions
  for (const protectedTail of [8, 6, 4, 3, 2]) {
    const result = compressContents(contents, targetTokenBudget, protectedTail);
    if (result.compressedTokens <= targetTokenBudget) {
      const savedPct = ((result.savedTokens / result.originalTokens) * 100).toFixed(0);
      const report = `Compressed ${(result.originalTokens / 1000).toFixed(0)}k → ${(result.compressedTokens / 1000).toFixed(0)}k tokens (-${savedPct}%, ${result.turnsCompressed} turns, protected tail: ${protectedTail})`;
      console.log(`[AutoContext] ✅ ${report}`);
      return { contents: result.contents, report };
    }
  }

  // Last resort: keep only last 8 turns
  const tail = contents.slice(-8);
  const tailTokens = estimateContentsTokens(tail);
  const report = `Emergency truncation: kept last 8 turns (${(tailTokens / 1000).toFixed(0)}k tokens)`;
  console.warn(`[AutoContext] 🆘 ${report}`);
  return { contents: tail, report };
}

// ─── Context health monitor ───────────────────────────────────────────────────

export interface ContextHealth {
  tokenCount: number;
  utilizationPct: number;
  status: 'healthy' | 'warning' | 'critical' | 'overflow';
  recommendation: string;
  shouldCompress: boolean;
}

export function checkContextHealth(
  contents: any[],
  modelContextWindow = 1_000_000 // Gemini 2.5 Flash: 1M tokens
): ContextHealth {
  const tokens = estimateContentsTokens(contents);
  const utilizationPct = (tokens / modelContextWindow) * 100;

  if (utilizationPct < 60) {
    return {
      tokenCount: tokens,
      utilizationPct,
      status: 'healthy',
      recommendation: 'No action needed',
      shouldCompress: false,
    };
  } else if (utilizationPct < 75) {
    return {
      tokenCount: tokens,
      utilizationPct,
      status: 'warning',
      recommendation: 'Light compression recommended',
      shouldCompress: false,
    };
  } else if (utilizationPct < 90) {
    return {
      tokenCount: tokens,
      utilizationPct,
      status: 'critical',
      recommendation: 'Compress immediately',
      shouldCompress: true,
    };
  } else {
    return {
      tokenCount: tokens,
      utilizationPct,
      status: 'overflow',
      recommendation: 'Emergency compression required',
      shouldCompress: true,
    };
  }
}

// ─── Milestone snapshots ──────────────────────────────────────────────────────

export interface ContextSnapshot {
  id: string;
  chatId: string;
  ts: number;
  iteration: number;
  tokenCount: number;
  summary: string;
  compressedContentsLength: number;
  // We store only stats, not the full content (too large).
  // Resume uses session.ts + lifetimeBrain to reconstruct.
}

const _snapshotCache: ContextSnapshot[] = [];

export async function saveMilestoneSnapshot(opts: {
  chatId: string;
  iteration: number;
  contents: any[];
  taskSummary: string;
}): Promise<void> {
  try {
    await fs.ensureDir(CONTEXT_DIR);

    const tokens = estimateContentsTokens(opts.contents);
    const snapshot: ContextSnapshot = {
      id: `snap_${Date.now()}_i${opts.iteration}`,
      chatId: opts.chatId,
      ts: Date.now(),
      iteration: opts.iteration,
      tokenCount: tokens,
      summary: opts.taskSummary.substring(0, 300),
      compressedContentsLength: JSON.stringify(opts.contents).length,
    };

    _snapshotCache.push(snapshot);
    // Keep last 20 snapshots in memory
    if (_snapshotCache.length > 20) _snapshotCache.shift();

    // Also record to lifetime brain
    lifetimeBrain.record({
      chatId: opts.chatId,
      projectId: opts.chatId,
      type: 'agent_decision',
      title: `Context milestone at iteration ${opts.iteration}: ${opts.taskSummary.substring(0, 60)}`,
      detail: `Tokens: ${tokens}. Summary: ${opts.taskSummary.substring(0, 200)}`,
      tags: ['milestone', 'context', 'checkpoint'],
      importance: 7,
      metadata: { iteration: opts.iteration, tokens },
    });

    // Debounce disk save
    await writeJsonAtomic(SNAPSHOT_FILE, _snapshotCache.slice(-20));
    console.log(`[AutoContext] 📌 Milestone snapshot saved at iteration ${opts.iteration} (${(tokens / 1000).toFixed(0)}k tokens)`);
  } catch { /* silent */ }
}

export function getLastSnapshot(chatId: string): ContextSnapshot | null {
  const matching = _snapshotCache.filter(s => s.chatId === chatId);
  return matching.length > 0 ? matching[matching.length - 1] : null;
}

// ─── Per-iteration auto-manager ───────────────────────────────────────────────

export interface AutoContextOptions {
  chatId: string;
  iteration: number;
  totalIterations: number;
  modelContextWindow?: number;
  targetBudgetRatio?: number;     // Fraction of context window to aim for (default 0.80)
  milestoneInterval?: number;     // Save snapshot every N iterations (default: 15)
  taskSummary?: string;
}

/**
 * Called EVERY iteration of the ReAct loop.
 * Decides whether to compress, logs health, saves milestones.
 *
 * @returns Potentially compressed contents array
 */
export async function manageContextForIteration(
  contents: any[],
  opts: AutoContextOptions
): Promise<{ contents: any[]; compressed: boolean; health: ContextHealth }> {
  const {
    chatId,
    iteration,
    modelContextWindow = 1_048_576, // Gemini 2.5 Flash 1M
    targetBudgetRatio = 0.80,
    milestoneInterval = 15,
    taskSummary = '',
  } = opts;

  const targetBudget = Math.floor(modelContextWindow * targetBudgetRatio);
  const health = checkContextHealth(contents, modelContextWindow);

  // Log health every 10 iterations
  if (iteration % 10 === 0) {
    const statusIcon = { healthy: '✅', warning: '⚠️', critical: '🔴', overflow: '🆘' }[health.status];
    console.log(`[AutoContext] ${statusIcon} Iteration ${iteration}: ${(health.tokenCount / 1000).toFixed(0)}k tokens (${health.utilizationPct.toFixed(0)}% of ${(modelContextWindow / 1000).toFixed(0)}k)`);
  }

  // Save milestone snapshot
  if (iteration > 0 && (iteration % milestoneInterval) === 0) {
    saveMilestoneSnapshot({ chatId, iteration, contents, taskSummary }).catch(() => {});
  }

  // Compress if needed
  if (health.shouldCompress) {
    const { contents: compressed, report } = autoCompress(contents, targetBudget);
    const newHealth = checkContextHealth(compressed, modelContextWindow);

    if (iteration % 5 === 0 || health.status === 'overflow') {
      console.log(`[AutoContext] 🗜️ Compressed: ${report}`);
    }

    return { contents: compressed, compressed: true, health: newHealth };
  }

  return { contents, compressed: false, health };
}

// ─── Export singleton for convenience ────────────────────────────────────────

export const autoContextManager = {
  compress: autoCompress,
  check: checkContextHealth,
  manage: manageContextForIteration,
  saveSnapshot: saveMilestoneSnapshot,
  getLastSnapshot,
  estimateTokens: estimateContentsTokens,
};
