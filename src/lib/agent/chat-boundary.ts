/**
 * ═══════════════════════════════════════════════════════════════
 * CHAT BOUNDARY DETECTOR — New Task vs. Continuation Classifier
 * ═══════════════════════════════════════════════════════════════
 *
 * Detects when the user's message is a new task vs. continuation of
 * the current task within the same chat. Uses instant heuristics
 * (NO LLM call) to classify every incoming message.
 *
 * Four possible decisions:
 *   continue_task    — Same task, keep full context
 *   new_task         — Different task, archive old context
 *   related_followup — Related to previous, keep relevant context
 *   clarification    — User answering a question we asked
 *
 * Design principles:
 *   - Never throws (all paths wrapped in try/catch)
 *   - Defaults to 'continue_task' when uncertain (safest)
 *   - Zero external dependencies beyond types
 *   - Sub-millisecond execution
 *
 * Used by: gemini.ts at the start of each user turn
 */

// ─── Types ────────────────────────────────────────────────────────────────────


export type BoundaryDecision =
  | 'continue_task'     // Same task, keep full context
  | 'new_task'          // Different task, archive old context
  | 'related_followup'  // Related to previous, keep relevant context
  | 'clarification'     // User answering a question we asked
  ;

export interface BoundaryContext {
  newMessage: string;
  lastUserMessage: string;
  lastAgentOutput: string;
  activeTaskPlan: Array<{ name: string; status: string }> | null;
  recentToolNames: string[];
  recentFileNames: string[];
  pendingAskUser: boolean;  // Did agent ask a question?
}

export interface BoundaryResult {
  decision: BoundaryDecision;
  confidence: number;     // 0-1
  reason: string;         // Human-readable explanation
  shouldArchiveContext: boolean;
  shouldResetSession: boolean;
}

export interface BoundaryHistoryMessage {
  role?: string;
  text?: unknown;
  content?: unknown;
  parts?: Array<{ text?: unknown }>;
}

export interface HistoryBoundaryInput {
  newMessage: string;
  history?: BoundaryHistoryMessage[];
  hasActiveTask?: boolean;
  recentToolNames?: string[];
  recentFileNames?: string[];
  pendingAskUser?: boolean;
}

// ─── Stop words for keyword extraction ────────────────────────────────────────

const STOP_WORDS = new Set([
  // Articles & determiners
  'the', 'this', 'that', 'these', 'those', 'what', 'which', 'whom',
  // Pronouns
  'will', 'would', 'could', 'should', 'might', 'must', 'shall',
  'have', 'been', 'being', 'does', 'done', 'doing',
  'with', 'from', 'into', 'onto', 'upon', 'about', 'above', 'below',
  'after', 'before', 'between', 'through', 'during', 'until', 'against',
  'some', 'more', 'most', 'other', 'each', 'every', 'both', 'such',
  'than', 'then', 'when', 'where', 'here', 'there', 'also', 'just',
  'only', 'very', 'much', 'well', 'even', 'back', 'still', 'over',
  'also', 'like', 'want', 'need', 'know', 'think', 'take', 'come',
  'give', 'tell', 'look', 'good', 'sure', 'okay', 'yeah', 'your',
  'mine', 'them', 'they', 'their', 'were', 'able',
  // Common prepositions/conjunctions
  'and', 'but', 'for', 'not', 'you', 'all', 'can', 'had', 'her',
  'was', 'one', 'our', 'out', 'are', 'has', 'his', 'how', 'its',
  'let', 'may', 'new', 'now', 'old', 'see', 'way', 'who', 'did',
  'get', 'got', 'him', 'put', 'say', 'she', 'too', 'use',
  // Task-neutral words
  'please', 'thanks', 'thank', 'help', 'thing', 'things', 'work',
  'make', 'file', 'files', 'code', 'using', 'used', 'same',
]);

// ─── Keyword extraction ──────────────────────────────────────────────────────

/**
 * Extracts meaningful words from text (>3 chars, no stop words).
 * Strips punctuation, lowercases, removes duplicates.
 */
export function extractKeywords(text: string): Set<string> {
  try {
    if (!text || typeof text !== 'string') return new Set();

    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s_.-]/g, ' ')   // Strip punctuation
      .split(/\s+/)
      .filter(w => w.length > 3)           // Only words > 3 chars
      .filter(w => !STOP_WORDS.has(w))     // Remove stop words
      .filter(w => !/^\d+$/.test(w));      // Remove pure numbers

    return new Set(words);
  } catch {
    return new Set();
  }
}

/**
 * Computes Jaccard-style keyword overlap between two texts.
 * Returns 0-1 ratio where 1 = identical keyword sets.
 */
export function computeKeywordOverlap(text1: string, text2: string): number {
  try {
    const kw1 = extractKeywords(text1);
    const kw2 = extractKeywords(text2);

    if (kw1.size === 0 || kw2.size === 0) return 0;

    let intersection = 0;
    for (const word of kw1) {
      if (kw2.has(word)) intersection++;
    }

    const union = new Set([...kw1, ...kw2]).size;
    return union > 0 ? intersection / union : 0;
  } catch {
    return 0;
  }
}

// ─── Pattern constants ────────────────────────────────────────────────────────

/** Action verbs that indicate a NEW instruction (not an answer to a question) */
const ACTION_VERBS = /\b(build|create|make|fix|write|search|find|install|run|deploy|implement|generate|develop|design|setup|configure|construct|compile|execute|launch|start|initialize|refactor|migrate|convert|transform|analyze|scan|crawl|scrape|download|upload|export|import|connect|integrate)\b/i;

/** Task-initiating phrases that signal a fresh task */
const TASK_STARTERS = /^(i need|can you|please\b|build me|create a|write a|make a|find out|research|i want|help me|set up|setup|let's build|let's create|let's make|could you|would you|i'd like|i would like|we need|show me how)/i;

/** Modification keywords — user wants to tweak what was just done */
const MODIFICATION_KEYWORDS = /\b(change|update|fix|modify|tweak|adjust|improve|add|remove|rename|replace|refactor|move|swap|switch|redo|undo|revert|increase|decrease|enlarge|shrink|simplify|clean up|optimize|enhance|extend|shorten|expand)\b/i;

/** "Make it X" / "Change the Y" / "Fix the Z" — referencing agent's prior work */
const REFERENTIAL_MOD_PATTERN = /^(make it|change the|fix the|add a|add the|remove the|update the|modify the|rename the|move the|replace the|put the|set the|turn the|use a|switch to|swap the)\b/i;

/** Looks like an answer: starts with yes/no, or is a path/name/number */
const ANSWER_PATTERN = /^(yes|no|yep|nope|yeah|nah|correct|right|wrong|true|false|ok|okay|sure|exactly|indeed|absolutely|definitely|neither|either|both|none|maybe)\b/i;

/** Paths, filenames, plain names/values that look like answers */
const VALUE_PATTERN = /^[a-zA-Z0-9_\-./\\:]+$/;

// ─── Helper: count words ──────────────────────────────────────────────────────

function wordCount(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Helper: check if message references recent context items ─────────────────

function referencesRecentContext(
  message: string,
  recentFileNames: string[],
  recentToolNames: string[],
): boolean {
  const lower = message.toLowerCase();

  for (const f of recentFileNames) {
    // Check for basename or full path references
    const basename = f.replace(/^.*[\\/]/, '').toLowerCase();
    if (basename.length > 2 && lower.includes(basename)) return true;
    // Also check without extension
    const noExt = basename.replace(/\.[^.]+$/, '');
    if (noExt.length > 3 && lower.includes(noExt)) return true;
  }

  for (const t of recentToolNames) {
    // Tool names are snake_case — check for readable fragments.
    const fragments = t.toLowerCase().split('_').filter(f => f.length > 3);
    for (const frag of fragments) {
      if (lower.includes(frag)) return true;
    }
  }

  return false;
}

// ─── Helper: check if task plan has pending steps ─────────────────────────────

function hasPendingSteps(plan: Array<{ name: string; status: string }> | null): boolean {
  if (!plan || plan.length === 0) return false;
  return plan.some(s => ['pending', 'in_progress', 'blocked', 'failed'].includes(s.status));
}

function isAllComplete(plan: Array<{ name: string; status: string }> | null): boolean {
  if (!plan || plan.length === 0) return false;
  return plan.every(s => ['done', 'completed', 'skipped'].includes(s.status));
}

// ─── Main classifier ─────────────────────────────────────────────────────────

/**
 * Classify whether a user message represents a new task, continuation,
 * related followup, or clarification — using instant heuristics only.
 *
 * Never throws. Defaults to 'continue_task' on any error or uncertainty.
 */
export function detectChatBoundary(ctx: BoundaryContext): BoundaryResult {
  try {
    const msg = (ctx.newMessage || '').trim();
    const words = wordCount(msg);

    // ── Empty / trivially short ──────────────────────────────────────────
    if (!msg || words === 0) {
      return result('continue_task', 0.5, 'Empty message — defaulting to continue');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PASS 1: CLARIFICATION — user answering a question we asked
    // ═══════════════════════════════════════════════════════════════════════

    if (ctx.pendingAskUser) {
      const hasActionVerb = ACTION_VERBS.test(msg);
      const isShort = words < 30;
      const looksLikeAnswer =
        ANSWER_PATTERN.test(msg) ||
        VALUE_PATTERN.test(msg) ||
        /^\d+$/.test(msg.trim()) ||                          // Just a number
        /^["'].*["']$/.test(msg.trim()) ||                    // Quoted value
        msg.includes(',') && words < 10;                       // Comma-separated list

      if (isShort && !hasActionVerb) {
        return result('clarification', 0.95, 'Pending question + short non-action answer');
      }
      if (looksLikeAnswer && !hasActionVerb) {
        return result('clarification', 0.95, 'Pending question + answer-like response');
      }
      // Even with action verbs, short answers to pending questions are likely clarifications
      if (isShort && looksLikeAnswer) {
        return result('clarification', 0.90, 'Pending question + short answer despite action verb');
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PASS 2: EXPLICIT REPLACEMENT — user abandons the active task
    // ═══════════════════════════════════════════════════════════════════════

    if (/^(?:new unrelated task\b|(?:forget|drop|abandon) (?:the )?(?:previous|current|earlier) task\b|switch (?:to a different|tasks)\b)/i.test(msg)) {
      return result('new_task', 0.99, 'User explicitly replaced the active task');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PASS 3: RELATED FOLLOWUP — modifying/tweaking the agent's prior work
    // ═══════════════════════════════════════════════════════════════════════

    if (REFERENTIAL_MOD_PATTERN.test(msg) && words < 40) {
      return result('related_followup', 0.90, 'Referential modification pattern (e.g. "make it X", "fix the Y")');
    }

    if (MODIFICATION_KEYWORDS.test(msg) && words < 40) {
      // Check if it references recent context for higher confidence
      const refsContext = referencesRecentContext(msg, ctx.recentFileNames, ctx.recentToolNames);
      const overlapWithAgent = computeKeywordOverlap(msg, ctx.lastAgentOutput);
      const overlapWithUser = computeKeywordOverlap(msg, ctx.lastUserMessage);

      if (refsContext || overlapWithAgent > 0.1 || overlapWithUser > 0.15) {
        return result('related_followup', 0.85, `Modification keyword + context overlap (agent: ${overlapWithAgent.toFixed(2)}, user: ${overlapWithUser.toFixed(2)})`);
      }

      // Modification keywords alone with a short message are still likely followup
      if (words < 20) {
        return result('related_followup', 0.75, 'Short message with modification keyword');
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PASS 4: CONTINUE_TASK — contextual signals suggesting same task
    // ═══════════════════════════════════════════════════════════════════════

    // References recent files or tools
    if (referencesRecentContext(msg, ctx.recentFileNames, ctx.recentToolNames)) {
      if (words < 40) {
        return result('continue_task', 0.90, 'Message references recent files/tools');
      }
    }

    // Active task plan with pending steps + short message
    if (hasPendingSteps(ctx.activeTaskPlan) && words < 10) {
      const hasActionVerb = ACTION_VERBS.test(msg);
      if (!hasActionVerb || words < 5) {
        return result('continue_task', 0.90, 'Short message with pending task plan steps');
      }
    }

    // Short message (<10 words) that doesn't introduce a new topic
    if (words < 10 && !TASK_STARTERS.test(msg)) {
      const overlapWithPrevious = computeKeywordOverlap(msg, ctx.lastUserMessage + ' ' + ctx.lastAgentOutput);
      if (overlapWithPrevious > 0.1) {
        return result('continue_task', 0.90, `Short message with keyword overlap (${overlapWithPrevious.toFixed(2)})`);
      }
      // Even without overlap, very short non-starter messages are likely continuations
      if (words <= 5 && !ACTION_VERBS.test(msg)) {
        return result('continue_task', 0.80, 'Very short message without task-starting patterns');
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PASS 5: NEW_TASK — detecting a completely different task
    // ═══════════════════════════════════════════════════════════════════════

    const overlapWithPrevUser = computeKeywordOverlap(msg, ctx.lastUserMessage);
    const overlapWithPrevAgent = computeKeywordOverlap(msg, ctx.lastAgentOutput);
    const combinedOverlap = Math.max(overlapWithPrevUser, overlapWithPrevAgent);

    // A completed prior task plus a distinct task-starter is a new objective,
    // even when the user states it concisely. Requiring a long prompt caused
    // ordinary second turns to inherit stale plans and memory.
    if (TASK_STARTERS.test(msg) && combinedOverlap < 0.05 && isAllComplete(ctx.activeTaskPlan)) {
      if (words >= 3) {
        return result('new_task', 0.85, `Distinct request after recorded plan completion (${words} words)`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PASS 6: AMBIGUOUS — use combined signals for best guess
    // ═══════════════════════════════════════════════════════════════════════

    // Medium message with some overlap — likely related followup
    if (words >= 10 && words <= 40 && combinedOverlap > 0.1) {
      return result('related_followup', 0.70, `Medium message with partial overlap (${combinedOverlap.toFixed(2)})`);
    }

    // Medium-length task-starter with some overlap — could be related new work
    if (TASK_STARTERS.test(msg) && combinedOverlap >= 0.08 && combinedOverlap < 0.2) {
      return result('related_followup', 0.70, `Task-starter with moderate overlap (${combinedOverlap.toFixed(2)}) — likely related new work`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // DEFAULT — when uncertain, continue is safest
    // ═══════════════════════════════════════════════════════════════════════

    return result('continue_task', 0.60, `Default: uncertain classification (${words} words, overlap: ${combinedOverlap.toFixed(2)})`);

  } catch (err: any) {
    console.warn(`[ChatBoundary] ⚠️ Classification error: ${err?.message || 'unknown'}. Defaulting to continue_task.`);
    return result('continue_task', 0.50, 'Error during classification — safe default');
  }
}

function historyMessageText(message: BoundaryHistoryMessage | null | undefined): string {
  if (!message) return '';
  if (typeof message.text === 'string') return message.text.trim();
  if (typeof message.content === 'string') return message.content.trim();
  if (Array.isArray(message.parts)) {
    return message.parts.map(part => String(part?.text || '')).join('\n').trim();
  }
  return '';
}

/**
 * Build a boundary decision from the transcript shapes used by direct chat,
 * custom agents, and lightweight adapters. The current user turn may already
 * be appended optimistically; remove only an identical trailing copy.
 */
export function detectChatBoundaryFromHistory(input: HistoryBoundaryInput): BoundaryResult {
  try {
    const newMessage = String(input.newMessage || '').trim();
    const history = Array.isArray(input.history) ? input.history : [];
    let lastIndex = history.length - 1;
    const trailing = history[lastIndex];
    if (
      String(trailing?.role || '').toLowerCase() === 'user'
      && historyMessageText(trailing) === newMessage
    ) {
      lastIndex -= 1;
    }
    let lastUser: BoundaryHistoryMessage | undefined;
    let lastAgent: BoundaryHistoryMessage | undefined;
    for (let index = lastIndex; index >= 0 && (!lastUser || !lastAgent); index -= 1) {
      const message = history[index];
      if (!message) continue;
      const role = String(message.role || '').toLowerCase();
      if (!lastUser && role === 'user') lastUser = message;
      if (!lastAgent && (role === 'model' || role === 'assistant')) lastAgent = message;
    }
    const lastAgentOutput = historyMessageText(lastAgent);
    return detectChatBoundary({
      newMessage,
      lastUserMessage: historyMessageText(lastUser),
      lastAgentOutput,
      activeTaskPlan: input.hasActiveTask
        ? [{ name: 'Active objective', status: 'pending' }]
        : null,
      recentToolNames: input.recentToolNames || [],
      recentFileNames: input.recentFileNames || [],
      pendingAskUser: input.pendingAskUser ?? /\?\s*$/.test(lastAgentOutput),
    });
  } catch {
    return result('continue_task', 0.50, 'History classification failed; preserving continuity');
  }
}

// ─── Result builder ───────────────────────────────────────────────────────────

function result(
  decision: BoundaryDecision,
  confidence: number,
  reason: string,
): BoundaryResult {
  const shouldArchiveContext = decision === 'new_task';
  const shouldResetSession = decision === 'new_task' && confidence >= 0.85;

  console.log(`[ChatBoundary] 🎯 Decision: ${decision} (confidence: ${confidence.toFixed(2)}) — ${reason}`);

  return {
    decision,
    confidence,
    reason,
    shouldArchiveContext,
    shouldResetSession,
  };
}

// ─── Export singleton ─────────────────────────────────────────────────────────

export const chatBoundary = { detect: detectChatBoundary };
