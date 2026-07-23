/**
 * ═══════════════════════════════════════════════════════════════
 * SMART RESUME ENGINE — Zero Re-exploration, Zero Cross-Chat Leak
 * ═══════════════════════════════════════════════════════════════
 *
 * Fixes THREE critical agent failures:
 *
 * FAILURE 1 — MEMORY LEAK / TASK HIJACK
 *   "hey continue" in new chat → agent resumed an ANNIVERSARY LETTER
 *   task instead of the Kaggle data task it was actually on.
 *   Root cause: agentMemory/memoryV2 contains GLOBAL memories from
 *   different chats that bleed in when continuation is detected.
 *   Fix: Validate task identity before injecting any session context.
 *        If the memory topic doesn't match the last actual work done,
 *        BLOCK it and use only lifetime brain for this chatId.
 *
 * FAILURE 2 — RE-EXPLORATION LOOP
 *   Agent created 10+ analysis scripts then on "continue" re-ran
 *   inspection scripts it had ALREADY run. 27 actions, no deliverable.
 *   Root cause: Agent has no "ALREADY DONE" awareness.
 *   Fix: Build explicit DONE / NOT-DONE / NEXT STEP blocks and inject
 *        them as a STRICT constraint in the system prompt.
 *
 * FAILURE 3 — FRAGMENTED WORK (NO DELIVERABLE)
 *   Agent spent all iterations on exploration scripts and never
 *   produced the final Excel file.
 *   Root cause: No milestone tracking, no "remaining work" awareness.
 *   Fix: Track deliverable vs intermediate work. Inject
 *        "MISSING DELIVERABLE" warning when the task isn't done.
 */

import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { lifetimeBrain, type LifetimeEvent } from '../memory/lifetime';

const USERPROFILE = os.homedir();
const DESKTOP_PATHS = [
  ...(process.platform === 'win32' ? [path.join(USERPROFILE, 'OneDrive', 'Desktop')] : []),
  path.join(USERPROFILE, 'Desktop'),
];

// ─── Desktop file scanner ─────────────────────────────────────────────────────

async function getRecentDesktopFiles(maxAgeMs = 4 * 60 * 60 * 1000): Promise<Array<{
  name: string;
  ext: string;
  sizeKb: number;
  minsAgo: number;
  isDeliverable: boolean;
}>> {
  const results: Array<{ name: string; ext: string; sizeKb: number; minsAgo: number; isDeliverable: boolean }> = [];
  const now = Date.now();
  const deliverableExts = new Set(['.xlsx', '.xls', '.csv', '.pdf', '.docx', '.pptx', '.html', '.zip', '.mp4', '.png']);

  for (const desktopPath of DESKTOP_PATHS) {
    try {
      if (!await fs.pathExists(desktopPath)) continue;
      const entries = await fs.readdir(desktopPath);
      for (const name of entries) {
        try {
          const fullPath = path.join(desktopPath, name);
          const stat = await fs.stat(fullPath);
          if (!stat.isFile()) continue;
          const mtime = stat.mtimeMs;
          const ageMs = now - mtime;
          if (ageMs > maxAgeMs) continue;
          const ext = path.extname(name).toLowerCase();
          results.push({
            name,
            ext,
            sizeKb: Math.round(stat.size / 1024),
            minsAgo: Math.round(ageMs / 60000),
            isDeliverable: deliverableExts.has(ext),
          });
        } catch { /* skip */ }
      }
      if (results.length > 0) break; // Found files in first valid desktop
    } catch { /* try next desktop path */ }
  }

  return results.sort((a, b) => a.minsAgo - b.minsAgo);
}

// ─── Task topic similarity ────────────────────────────────────────────────────
// Lightweight topic extraction — no AI call, just keyword fingerprint.
// Used to detect cross-chat contamination.

function extractTopicWords(text: string): Set<string> {
  const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'have', 'has', 'do', 'does', 'did', 'it', 'this', 'that', 'i', 'you',
    'we', 'me', 'my', 'your', 'our', 'get', 'make', 'create', 'use', 'run',
    'file', 'task', 'work', 'can', 'also', 'more', 'all', 'just', 'now',
    'hey', 'please', 'help', 'want', 'need', 'let', 'try',
  ]);
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOPWORDS.has(w))
      .slice(0, 40)
  );
}

function topicOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const w of a) { if (b.has(w)) overlap++; }
  return overlap / Math.min(a.size, b.size);
}

// ─── Core: Build the smart resume brief ──────────────────────────────────────

export interface ResumeBriefOptions {
  chatId: string;
  currentMessage: string;
  lastUserMessageInSession?: string;
  sessionFileRecords?: Array<{ filename: string; action: string; purpose: string; timestamp: number }>;
  sessionActionSummary?: string[];
  sessionTaskPlan?: Array<{ name: string; status: 'pending' | 'done'; description?: string }>;
}

export interface ResumeBriefResult {
  brief: string;
  isContaminated: boolean;  // True if session context is from a DIFFERENT task (memory leak)
  hasPendingDeliverable: boolean;
  alreadyDoneFiles: string[];
  nextLogicalStep: string;
}

export async function buildResumeBrief(opts: ResumeBriefOptions): Promise<ResumeBriefResult> {
  const {
    chatId,
    currentMessage,
    lastUserMessageInSession = '',
    sessionFileRecords = [],
    sessionActionSummary = [],
    sessionTaskPlan = [],
  } = opts;

  // ── STEP 1: Contamination check ──
  // Compare current task topic with what's in the session.
  // If they're unrelated → session memory is from a DIFFERENT chat → BLOCK it.
  let isContaminated = false;
  const currentTopics = extractTopicWords(currentMessage);
  const sessionTopics = extractTopicWords(lastUserMessageInSession);

  if (lastUserMessageInSession && lastUserMessageInSession.length > 20 && currentTopics.size > 2) {
    const overlap = topicOverlap(currentTopics, sessionTopics);
    // If overlap < 10%, the session is about a completely different thing
    // Exception: if message is pure "continue"/"cont" with no topic words, don't flag contamination
    const isPureContinue = isPureContinuationMessage(currentMessage) || currentTopics.size <= 2;
    if (!isPureContinue && overlap < 0.1) {
      isContaminated = true;
      console.warn(`[ResumeEngine] ⚠️ Contamination detected! Session topic mismatch (overlap: ${(overlap * 100).toFixed(0)}%). Session memory BLOCKED.`);
    }
  }

  // ── STEP 2: Get lifetime brain data for THIS chatId only ──
  const brainEvents = lifetimeBrain.recall({
    chatId,
    projectId: chatId,
    limit: 50,
    types: ['file_write', 'file_edit', 'terminal_cmd', 'task_complete', 'task_failed', 'error', 'error_fixed'],
  }).sort((a, b) => a.ts - b.ts); // Oldest first

  // ── STEP 3: Scan Desktop for recently created files ──
  let recentDesktopFiles: Awaited<ReturnType<typeof getRecentDesktopFiles>> = [];
  try {
    recentDesktopFiles = await getRecentDesktopFiles(8 * 60 * 60 * 1000); // Last 8 hours
  } catch { /* silent */ }

  // ── STEP 4: Build ALREADY DONE list ──
  const alreadyDoneFiles: string[] = [];

  // From session file records
  for (const rec of sessionFileRecords) {
    const basename = rec.filename.split(/[/\\]/).pop() || rec.filename;
    alreadyDoneFiles.push(`${basename} (${rec.action}) — ${rec.purpose.substring(0, 60)}`);
  }

  // From lifetime brain events for this chat
  for (const evt of brainEvents) {
    if (evt.type === 'file_write' || evt.type === 'file_edit') {
      const fname = evt.metadata?.filename || '';
      const basename = fname.split(/[/\\]/).pop() || fname;
      if (basename && !alreadyDoneFiles.some(f => f.startsWith(basename))) {
        alreadyDoneFiles.push(`${basename} (${evt.type.replace('file_', '')}) — ${evt.title.substring(0, 60)}`);
      }
    }
  }

  // From Desktop scan
  const desktopMadeFiles = recentDesktopFiles.map(f =>
    `${f.name} (${f.sizeKb}KB, ${f.minsAgo}m ago)${f.isDeliverable ? ' ← DELIVERABLE' : ' ← helper script'}`
  );

  // ── STEP 5: Determine pending deliverable ──
  const deliverableDesktopFiles = recentDesktopFiles.filter(f => f.isDeliverable);
  const hasPendingDeliverable = deliverableDesktopFiles.length === 0 && alreadyDoneFiles.length > 0;

  // ── STEP 6: Extract last terminal commands ──
  const terminalEvents = brainEvents.filter(e => e.type === 'terminal_cmd').slice(-6);
  const terminalLines = terminalEvents.map(e => {
    const icon = e.metadata?.exitCode === 0 ? '✅' : '❌';
    const cmd = String(e.metadata?.command || e.title).substring(0, 80);
    const out = String(e.metadata?.output || '').substring(0, 100).replace(/\n/g, ' ');
    return `  ${icon} ${cmd}${out ? ` → ${out}` : ''}`;
  });

  // ── STEP 7: Determine NEXT LOGICAL STEP ──
  let nextLogicalStep = '';

  // From task plan (pending steps)
  const pendingPlanSteps = sessionTaskPlan.filter(s => s.status === 'pending');
  if (pendingPlanSteps.length > 0) {
    nextLogicalStep = `Execute next task plan step: "${pendingPlanSteps[0].name}" — ${pendingPlanSteps[0].description || ''}`;
  }

  // If deliverable is missing → that's the next step
  if (hasPendingDeliverable && !nextLogicalStep) {
    const intermediateNames = alreadyDoneFiles.map(f => f.split(' ')[0]).join(', ');
    nextLogicalStep = `Create the FINAL DELIVERABLE. You have already done the exploration (${intermediateNames}). Now produce the actual output file requested by the user.`;
  }

  // From last error
  const lastError = brainEvents.filter(e => e.type === 'error').slice(-1)[0];
  if (lastError && !nextLogicalStep) {
    nextLogicalStep = `Fix the error from last session: "${lastError.title.substring(0, 80)}"`;
  }

  if (!nextLogicalStep) {
    nextLogicalStep = 'Continue from the last completed action. Do NOT restart from scratch.';
  }

  // ── STEP 8: Build the final brief string ──
  const parts: string[] = ['━━━ SMART RESUME ENGINE ━━━'];

  if (isContaminated) {
    parts.push(
      '🚨 CONTAMINATION GUARD ACTIVE: Session memory from a DIFFERENT task has been BLOCKED.',
      'Only verified work from THIS conversation is shown below.',
      'Do NOT resume any task that is not represented by the files/commands below.'
    );
  }

  // What was the last task
  const lastTask = lifetimeBrain.recall({ chatId, types: ['session_start'], limit: 1 })[0];
  if (lastTask) {
    const agoMin = Math.round((Date.now() - lastTask.ts) / 60000);
    const agoStr = agoMin < 60 ? `${agoMin}m ago` : `${Math.round(agoMin / 60)}h ago`;
    parts.push(`📋 LAST TASK (${agoStr}): ${lastTask.detail?.substring(0, 120) || lastTask.title}`);
  } else if (lastUserMessageInSession && !isContaminated) {
    parts.push(`📋 LAST TASK: ${lastUserMessageInSession.substring(0, 120)}`);
  }

  // Already done files (most important — prevents re-exploration)
  if (alreadyDoneFiles.length > 0 || desktopMadeFiles.length > 0) {
    const doneLines = [
      ...alreadyDoneFiles.slice(0, 15).map(f => `  ✅ ${f}`),
      ...(desktopMadeFiles.length > 0 && alreadyDoneFiles.length === 0
        ? desktopMadeFiles.map(f => `  📁 ${f}`) : []),
    ];
    parts.push(
      '🚫 ALREADY DONE — DO NOT RECHECK, RECREATE, OR RE-ANALYZE ANY OF THESE:',
      ...doneLines
    );
  }

  // Desktop files (ground truth)
  if (desktopMadeFiles.length > 0) {
    parts.push('📁 CONFIRMED ON DESKTOP:', ...desktopMadeFiles.slice(0, 10).map(f => `  ${f}`));
  }

  // Terminal history
  if (terminalLines.length > 0) {
    parts.push('💻 TERMINAL HISTORY (already run — do NOT repeat these):', ...terminalLines);
  }

  // Action summary
  if (sessionActionSummary.length > 0 && !isContaminated) {
    parts.push('📝 WORK SUMMARY:', ...sessionActionSummary.slice(-5).map(s => `  • ${s}`));
  }

  // Pending deliverable warning
  if (hasPendingDeliverable) {
    parts.push(
      '⚠️ MISSING DELIVERABLE DETECTED:',
      '  You did exploration/analysis work but the FINAL OUTPUT (e.g. Excel file, report, cleaned dataset) was NOT created.',
      '  The user\'s original task is NOT complete.',
      '  → Your job is to create the FINAL deliverable NOW, not do more exploration.'
    );
  }

  // Task plan progress
  if (sessionTaskPlan.length > 0 && !isContaminated) {
    const done = sessionTaskPlan.filter(s => s.status === 'done').map(s => s.name);
    const pending = sessionTaskPlan.filter(s => s.status === 'pending').map(s => s.name);
    if (done.length > 0) parts.push(`✅ COMPLETED STEPS: ${done.join(', ')}`);
    if (pending.length > 0) parts.push(`⏳ PENDING STEPS: ${pending.join(', ')}`);
  }

  // Next step (critical)
  parts.push(
    `🎯 YOUR NEXT ACTION: ${nextLogicalStep}`,
    '',
    '⚡ EXECUTION RULES:',
    '  1. Do not repeat DONE work; re-read only a narrow current-state range when needed to safely continue.',
    '  2. NEVER start a new unrelated task — resume only what the last session was doing.',
    '  3. If you see analysis scripts on Desktop → SKIP them, they are DONE → go to the next missing step.',
    '  4. If the deliverable (Excel/report/cleaned file) is missing → create it NOW as your first action.',
    '  5. If you are not certain what step to take, read the LAST FEW lines of previously created files, then decide.'
  );

  parts.push('━━━ END SMART RESUME ━━━');

  return {
    brief: parts.join('\n'),
    isContaminated,
    hasPendingDeliverable,
    alreadyDoneFiles,
    nextLogicalStep,
  };
}

// ─── Detect if message is a pure continuation (no specific new task) ──────────

export function isPureContinuationMessage(msg: string): boolean {
  const normalized = msg.trim().toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const continuationRoots = ['cont', 'keep', 'work', 'go', 'proc', 'resum', 'next', 'adv', 'kepp', 'dvnc', 'dvc'];
  let continuationScore = 0;
  for (const t of tokens) {
    if (continuationRoots.some(root => t.includes(root))) {
      continuationScore++;
    }
  }

  const newTaskWords = ['create', 'write', 'implement', 'explain', 'python', 'typescript', 'js', 'ts', 'file', 'script', 'code', 'function', 'class', 'wrapper', 'page', 'api', 'route', 'css', 'html', 'json', 'yaml', 'toml', 'readme'];
  let newTaskScore = 0;
  for (const t of tokens) {
    if (newTaskWords.some(w => t.includes(w))) {
      newTaskScore++;
    }
  }

  if (continuationScore > 0 && newTaskScore === 0) {
    return true;
  }

  const purePatterns = [
    /^(hey\s+)?(continue|cont|go on|keep going|carry on|next|resume|proceed|dont stop|keep working|work more)$/,
    /^(yes|ok|okay)\s+(continue|proceed|go)$/,
    /^(just\s+)?continue\s*(please|now|again)?$/,
  ];
  return purePatterns.some(p => p.test(normalized));
}

// ─── Work-done deduplication check ───────────────────────────────────────────
// Prevents the agent from calling a tool on something it already did.

export function buildDoneToolSignatures(brainEvents: LifetimeEvent[]): Set<string> {
  const sigs = new Set<string>();
  for (const evt of brainEvents) {
    if (evt.type === 'file_write' || evt.type === 'file_edit') {
      const f = evt.metadata?.filename || '';
      if (f) sigs.add(`write:${path.basename(f).toLowerCase()}`);
    }
    if (evt.type === 'terminal_cmd') {
      const cmd = String(evt.metadata?.command || '').split(/\s+/).slice(0, 3).join(' ').toLowerCase();
      if (cmd) sigs.add(`cmd:${cmd}`);
    }
  }
  return sigs;
}
