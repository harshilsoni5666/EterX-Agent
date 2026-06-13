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

/** After this many iterations, start compressing old tool results */
const COMPRESS_AFTER_ITERATIONS = 12;
/** Keep the last N message exchanges at full fidelity */
const FULL_FIDELITY_WINDOW = 8;
/** Max chars for a single compressed tool result summary */
const MAX_COMPRESSED_RESULT_CHARS = 280;
/** Max total chars for all tool results in compressed region */
const MAX_COMPRESSED_REGION_CHARS = 6000;
/** Inject edit session summary every N iterations */
const SESSION_SUMMARY_INTERVAL = 8;
/** Warn agent about budget after this many iterations */
const BUDGET_WARN_THRESHOLD = 350;

export const CODING_AGENT_SPEED_RULES = `
CODING FAST MODE:
- Use task_decomposer, sub-agents, and background scouting only when they create real leverage: broad scope, independent review, long-running checks, or UI/server workflows.
- Explore with workspace_semantic_search + workspace_symbol_lookup before broad reads.
- Batch reads with workspace_read_many_files. Never read the same file twice in one task unless it changed.
- Default edit tool: workspace_str_replace. One precise change per call. It returns diff + readback automatically.
- NEVER use workspace_write_file on existing files. That tool is ONLY for creating new files.
- NEVER rewrite an entire file. Use workspace_str_replace for targeted edits.
- If workspace_str_replace fails, re-read the target lines, copy exact text, and retry.
- If a tool errors once, read exact context and retry once with corrected args. Do not loop blindly.
- Verify with the smallest meaningful command after edits.
- Stop as soon as the requested change is done and verified.
`.trim();

export const CODING_ERROR_RECOVERY = `
TOOL ERROR RECOVERY (coding only):
- "old_string not found" -> workspace_read_file the target range, copy exact text, retry workspace_str_replace.
- "patch failed" -> read current file, switch to workspace_str_replace or smaller patch hunks.
- "file not found" -> workspace_find_files or workspace_semantic_search, then retry with correct path.
- "ambiguous match" -> add surrounding context lines to old_string or use workspace_apply_patch.
- "command failed" -> read stderr, fix root cause, rerun closest smaller verification command.
`.trim();

export const CODING_LONG_TASK_RULES = `
LONG TASK RULES (active after 10+ iterations):
- After 10+ iterations, re-read the user request to stay precisely on-task. Do not drift.
- After 15+ edits, run workspace_verify_code or a targeted test before continuing.
- Use workspace_edit_session action=summary periodically to stay oriented on what changed.
- Use workspace_edit_session action=checkpoint before risky changes.
- If approaching 400+ iterations, summarize all work done and ask if the user wants to continue.
- Keep edits focused. Do not refactor unrelated code during long sessions.
- After completing a logical sub-task, emit a brief progress note before moving to the next.
`.trim();

// ═══════════════════════════════════════════════════════════════════
// SMART CONTEXT COMPRESSION
// Summarizes old tool results to keep context window manageable
// ═══════════════════════════════════════════════════════════════════

/**
 * Compress a single tool result into a short summary.
 * Extracts the essential information based on tool type.
 */
export function compressToolResult(toolName: string, result: string): string {
  const text = String(result || '').trim();
  if (!text || text.length < MAX_COMPRESSED_RESULT_CHARS) return text;

  const name = toolName.toLowerCase();

  // Read results → just note what was read
  if (name.includes('read_file') || name.includes('read_many')) {
    const fileMatch = text.match(/File:\s*([^\s|]+)/);
    const lineMatch = text.match(/(\d+)\s*lines/);
    const showMatch = text.match(/Showing\s+(\d+)-(\d+)/);
    return `[Read ${fileMatch?.[1] || 'file'}${lineMatch ? ` (${lineMatch[1]} lines)` : ''}${showMatch ? ` lines ${showMatch[1]}-${showMatch[2]}` : ''}]`;
  }

  // Search results → note match count
  if (name.includes('search') || name.includes('find_files') || name.includes('symbol_lookup')) {
    const matchCount = (text.match(/\"file\"/g) || []).length;
    const totalMatch = text.match(/totalMatches[\":\s]+(\d+)/);
    const count = totalMatch ? totalMatch[1] : String(matchCount);
    return `[Search: ${count} matches found]`;
  }

  // Edit results → note what was changed
  if (name.includes('str_replace') || name.includes('edit_file') || name.includes('apply_patch') || name.includes('edit_many')) {
    const successMatch = text.match(/success[\":\s]+(true|false)/i);
    const fileMatch = text.match(/(?:path|filename)[\":\s]+\"?([^\"}\s,]+)/);
    const replMatch = text.match(/replacements[\":\s]+(\d+)/);
    const success = successMatch?.[1] === 'true' ? '✓' : '✗';
    return `[Edit ${success} ${fileMatch?.[1] || 'file'}${replMatch ? ` (${replMatch[1]} replacements)` : ''}]`;
  }

  // Command results → note exit code
  if (name.includes('run_command') || name.includes('verify_code') || name.includes('execute_script')) {
    const exitMatch = text.match(/exitCode[\":\s]+(\d+)/);
    const passedMatch = text.match(/passed[\":\s]+(true|false)/i);
    const code = exitMatch?.[1] || '?';
    const status = passedMatch ? (passedMatch[1] === 'true' ? 'passed' : 'failed') : `exit ${code}`;
    // Keep last 200 chars of output for error context
    const tail = text.length > 200 ? text.slice(-200) : '';
    return `[Command ${status}]${tail ? `\n${tail}` : ''}`;
  }

  // Outline results → brief summary
  if (name.includes('outline')) {
    const lineMatch = text.match(/lineCount[\":\s]+(\d+)/);
    const itemCount = (text.match(/\"kind\"/g) || []).length;
    return `[Outline: ${itemCount} items, ${lineMatch?.[1] || '?'} lines]`;
  }

  // Git results → keep short
  if (name.includes('git')) {
    return text.slice(0, MAX_COMPRESSED_RESULT_CHARS);
  }

  // Edit session results → keep as-is (already compact)
  if (name.includes('edit_session')) {
    return text.slice(0, MAX_COMPRESSED_RESULT_CHARS * 2);
  }

  // Default: truncate
  return text.slice(0, MAX_COMPRESSED_RESULT_CHARS) + (text.length > MAX_COMPRESSED_RESULT_CHARS ? '...[compressed]' : '');
}

/**
 * Compress the message history for the coding agent.
 * Keeps recent exchanges full-fidelity, compresses older tool results.
 * Returns compressed messages array.
 */
export function compressCodingContext(
  messages: any[],
  iteration: number,
): { messages: any[]; compressed: boolean; originalTokenEstimate: number; compressedTokenEstimate: number } {
  if (iteration < COMPRESS_AFTER_ITERATIONS || messages.length < FULL_FIDELITY_WINDOW * 2) {
    const est = estimateTokens(messages);
    return { messages, compressed: false, originalTokenEstimate: est, compressedTokenEstimate: est };
  }

  const originalEstimate = estimateTokens(messages);

  // Split: old region (to compress) + recent region (keep full)
  const recentStart = Math.max(0, messages.length - FULL_FIDELITY_WINDOW * 2);
  const oldMessages = messages.slice(0, recentStart);
  const recentMessages = messages.slice(recentStart);

  let compressedChars = 0;
  const compressedOld = oldMessages.map((msg: any) => {
    // Keep user messages intact (they're usually short)
    if (msg.role === 'user') {
      // But compress tool result parts in user messages (Gemini format)
      if (Array.isArray(msg.parts)) {
        const compressedParts = msg.parts.map((part: any) => {
          if (part.functionResponse) {
            const toolName = part.functionResponse.name || '';
            const response = part.functionResponse.response || {};
            const resultText = typeof response === 'string' ? response : JSON.stringify(response);

            if (compressedChars > MAX_COMPRESSED_REGION_CHARS) {
              return {
                functionResponse: {
                  name: toolName,
                  response: { _compressed: true, summary: `[Old result omitted for context budget]` },
                },
              };
            }

            const compressed = compressToolResult(toolName, resultText);
            compressedChars += compressed.length;
            return {
              functionResponse: {
                name: toolName,
                response: typeof response === 'object' && response.success !== undefined
                  ? { success: response.success, _compressed: true, summary: compressed }
                  : { _compressed: true, summary: compressed },
              },
            };
          }
          return part;
        });
        return { ...msg, parts: compressedParts };
      }

      // OpenAI/Anthropic format — compress tool content
      if (msg.role === 'tool' && msg.content) {
        const compressed = compressToolResult(msg.name || '', msg.content);
        compressedChars += compressed.length;
        return { ...msg, content: compressed };
      }

      return msg;
    }

    // Model messages: keep text, compress function call args if huge
    if (msg.role === 'model' && Array.isArray(msg.parts)) {
      const compressedParts = msg.parts.map((part: any) => {
        if (part.functionCall && part.functionCall.args) {
          const argsStr = JSON.stringify(part.functionCall.args);
          if (argsStr.length > 2000) {
            // Keep name but truncate large args in old messages
            return {
              functionCall: {
                name: part.functionCall.name,
                args: { _compressed: true, _originalLength: argsStr.length },
              },
            };
          }
        }
        return part;
      });
      return { ...msg, parts: compressedParts };
    }

    return msg;
  });

  const result = [...compressedOld, ...recentMessages];
  const compressedEstimate = estimateTokens(result);

  if (iteration % 25 === 0) {
    console.log(`[CodingContext] Compressed: ${originalEstimate} → ${compressedEstimate} tokens (iter ${iteration})`);
  }

  return {
    messages: result,
    compressed: true,
    originalTokenEstimate: originalEstimate,
    compressedTokenEstimate: compressedEstimate,
  };
}

/** Rough token estimate (1 token ≈ 4 chars) */
function estimateTokens(messages: any[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += JSON.stringify(msg).length;
  }
  return Math.ceil(chars / 4);
}

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
    return `${text}\n\nRECOVERY: Read the exact target range with workspace_read_file, then retry workspace_str_replace with copied text.`;
  }
  if (/ambiguous|matched \d+ times/i.test(text)) {
    return `${text}\n\nRECOVERY: Add more surrounding context to old_string, or use workspace_apply_patch with context lines.`;
  }
  if (/patch failed|context line/i.test(text)) {
    return `${text}\n\nRECOVERY: Read the current file section and use workspace_str_replace or a smaller patch hunk.`;
  }
  if (/file not found|directory not found/i.test(text)) {
    return `${text}\n\nRECOVERY: Use workspace_find_files or workspace_semantic_search to locate the correct path.`;
  }
  if (/not loaded|unknown tool/i.test(text)) {
    return `${text}\n\nRECOVERY: Use one of the loaded coding tools only. Do not invent tool names.`;
  }
  return text;
}
