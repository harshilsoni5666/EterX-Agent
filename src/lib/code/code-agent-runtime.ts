import path from 'path';
import fs from 'fs';
import { CODE_AGENT_TOOLS, CODE_AGENT_WORKFLOW } from './code-agent-tools';
import { getCodeAgentSystemPrompt, getToolEnhancements } from './code-prompts';
import { getPathResolverInfo } from '@/lib/agent/workspace/path_resolver';
import { globalToolRegistry } from '@/lib/agent/tools/registry';
import { editTracker } from './edit-tracker';

export const CODING_FAST_MODE = true;

// ═══════════════════════════════════════════════════════════════════
// CONTEXT BUDGET CONFIGURATION
// Tuned for Gemini 2.5 context windows — keeps long sessions tight
// ═══════════════════════════════════════════════════════════════════

/** Inject edit session summary every N iterations */
const SESSION_SUMMARY_INTERVAL = 8;
/** Warn agent about budget after this many iterations */
const BUDGET_WARN_THRESHOLD = 350;

export const CODING_AGENT_SPEED_RULES = `
CODING FAST MODE:
- Use task_decomposer autonomously when broad scope, dependent stages, multiple files/systems, or a separate verification phase makes live tracking materially safer. The user does not need to request plan mode.
- Once planned, use task_checkpoint to advance each item only after its done_when condition has evidence; revise changed work and never finalize an unresolved plan.
- Use sub-agents and background scouting only when they create real leverage: independent review, long-running checks, or UI/server workflows.
- Explore with workspace_semantic_search + workspace_search_text before broad reads.
- Batch reads with workspace_read_many_files. Never read the same file twice in one task unless it changed.
- Use workspace_edit_file for every file mutation: new files, targeted existing-file edits, deletion, and atomic multi-file changes.
- Single file: filename plus edits/delete. Multiple files: files=[{filename, edits/delete}].
- Never create persistent source files through shell commands.
- If an edit fails, re-read the exact target lines and retry once with corrected context.
- If a tool errors once, read exact context and retry once with corrected args. Do not loop blindly.
- Verify with the smallest meaningful command after edits.
- Stop as soon as the requested change is done and verified.
`.trim();

export const CODING_ERROR_RECOVERY = `
TOOL ERROR RECOVERY (coding only):
- "edit failed" -> read the exact current file range, then retry workspace_edit_file with corrected search text or line ranges.
- "file not found" -> workspace_find_files or workspace_semantic_search, then retry with correct path.
- "ambiguous match" -> add surrounding context to the search text or use a validated line range with workspace_edit_file.
- "command failed" -> read stderr, fix root cause, rerun closest smaller verification command.
`.trim();

export const CODING_LONG_TASK_RULES = `
LONG TASK RULES (active after 10+ iterations):
- After 10+ iterations, re-read the user request to stay precisely on-task. Do not drift.
- After 15+ edits, run workspace_verify_code or a targeted test before continuing.
- Keep each workspace_edit_file call focused on one file and group its related edits.
- If approaching 400+ iterations, summarize all work done and ask if the user wants to continue.
- Keep edits focused. Do not refactor unrelated code during long sessions.
- After completing a logical sub-task, emit a brief progress note before moving to the next.
`.trim();

/**
 * Build iteration context block injected into the system prompt during long sessions.
 * Gives the agent awareness of progress, budget, and session state.
 */
export function buildIterationContext(opts: {
  iteration: number;
  totalToolCalls: number;
  editCount: number;
  fileCount: number;
  compressed: boolean;
}): string {
  const { iteration, totalToolCalls, editCount, fileCount, compressed } = opts;
  const parts: string[] = [];

  parts.push(`[Session: iteration ${iteration} | ${totalToolCalls} tool calls | ${editCount} edits across ${fileCount} files${compressed ? ' | context compressed' : ''}]`);

  // Inject long-task rules after threshold
  if (iteration >= 10) {
    parts.push(CODING_LONG_TASK_RULES);
  }

  // Budget warning
  if (iteration >= BUDGET_WARN_THRESHOLD) {
    parts.push(`⚠️ BUDGET WARNING: Iteration ${iteration}/${500}. Summarize progress and verify key changes. Consider checkpointing.`);
  }

  // Edit session summary (periodically)
  if (iteration > 0 && iteration % SESSION_SUMMARY_INTERVAL === 0 && editCount > 0) {
    try {
      const summary = editTracker.getEditSummary();
      parts.push(`SESSION EDITS:\n${summary.summary}`);
    } catch { /* best effort */ }
  }

  return parts.join('\n\n');
}

// ═══════════════════════════════════════════════════════════════════
// EXISTING EXPORTS (preserved)
// ═══════════════════════════════════════════════════════════════════

export function getCodingAgentToolNames(): string[] {
  return [...CODE_AGENT_TOOLS];
}

export function getCodingAgentToolSummary(): { count: number; names: string } {
  const names = getCodingAgentToolNames().filter(name => globalToolRegistry.getTool(name));
  return { count: names.length, names: names.join(', ') };
}

export function buildCodingChatSystemPrompt(
  workspacePath: string,
  loadedToolNames: string[] = getCodingAgentToolNames(),
  iterationContext?: string,
): string {
  const cwd = workspacePath || getPathResolverInfo().desktopPath;
  let prompt = getCodeAgentSystemPrompt(cwd);
  prompt += `\n\n${CODING_AGENT_SPEED_RULES}\n\n${CODING_ERROR_RECOVERY}\n`;
  prompt += `\n# Loaded Coding Tools (${loadedToolNames.length})\n${loadedToolNames.join(', ')}\n`;

  const enhancements = getToolEnhancements();
  for (const toolName of loadedToolNames) {
    if (enhancements[toolName]) {
      prompt += `\n## Tool: ${toolName}\n${String(enhancements[toolName]).slice(0, 900)}\n`;
    }
  }

  for (const fname of ['AGENTS.md', 'CLAUDE.md', '.cursor/rules', 'README.md']) {
    const fpath = path.join(cwd, fname);
    if (!fs.existsSync(fpath)) continue;
    try {
      const content = fs.readFileSync(fpath, 'utf-8');
      prompt += `\n## ${fname}\n${content.slice(0, 2500)}\n`;
    } catch { /* ignore */ }
  }

  // Inject iteration context for long sessions
  if (iterationContext) {
    prompt += `\n\n${iterationContext}\n`;
  }

  return prompt;
}

export function buildCodingProfileToolBlock(): string {
  const { count, names } = getCodingAgentToolSummary();
  return [
    'CODING TOOL SURFACE (only these tools are available in Coding mode):',
    CODE_AGENT_WORKFLOW,
    CODING_AGENT_SPEED_RULES,
    CODING_ERROR_RECOVERY,
    `Tool count: ${count}`,
    names,
  ].join('\n\n');
}

export function formatCodingToolFailure(toolName: string, output: string): string {
  const text = String(output || '');
  if (/old_string not found|search block not found|Could not find search/i.test(text)) {
    return `${text}\n\nRECOVERY: Read the exact target range with workspace_read_file, then retry workspace_edit_file with current context.`;
  }
  if (/ambiguous|matched \d+ times/i.test(text)) {
    return `${text}\n\nRECOVERY: Add more surrounding context to the search text, or use workspace_edit_file with a validated line range.`;
  }
  if (/patch failed|context line/i.test(text)) {
    return `${text}\n\nRECOVERY: Read the current file section and retry workspace_edit_file with corrected input.`;
  }
  if (/file not found|directory not found/i.test(text)) {
    return `${text}\n\nRECOVERY: Use workspace_find_files or workspace_semantic_search to locate the correct path.`;
  }
  if (/not loaded|unknown tool/i.test(text)) {
    return `${text}\n\nRECOVERY: Use one of the loaded coding tools only. Do not invent tool names.`;
  }
  return text;
}
