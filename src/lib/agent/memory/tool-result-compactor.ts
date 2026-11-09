/**
 * EterX Agent — Smart Tool Result Compactor
 * 
 * Intelligent per-tool-type truncation that preserves the most useful information
 * instead of crude string slicing. Each tool type has its own compaction strategy
 * that knows what's important in that tool's output.
 */

import { distillEvidence } from './evidence-distiller';
import { getToolResultOutcome } from '../tool-semantics';
import { resolveTerminalOutputKind, terminalOutputPageChars } from '../source-read-policy';
import { splitComputerToolResult } from '../computer/tool-vision';

function isSourceRead(toolName: string, args: Record<string, any>, result?: any): boolean {
  if (toolName === 'context_memory' && args.action === 'open') return true;
  if (toolName !== 'workspace_run_command') return false;
  if (result?.outputKind === 'read' || result?.outputKind === 'mixed') return true;
  if (result?.outputKind === 'log') return false;
  if (args.mode === 'check') return resolveTerminalOutputKind(String(result?.command || ''), result?.outputKind) === 'read';
  if (!['run', undefined].includes(args.mode)) return false;
  return resolveTerminalOutputKind(String(args.command || args.cmd || ''), args.outputKind) === 'read' ||
    (Array.isArray(args.commands) && args.commands.some((entry: any) =>
      resolveTerminalOutputKind(String(entry?.command || entry?.cmd || ''), entry?.outputKind ?? args.outputKind) === 'read'));
}

/** Small lifecycle fields must survive every reduction of a tool payload. */
function outcomeEnvelope(result: any): Record<string, any> {
  const outcome = getToolResultOutcome(result);
  const envelope: Record<string, any> = {
    success: outcome !== 'failed',
    ...(outcome === 'pending' ? { status: 'running', stillRunning: true } : {}),
    ...(outcome === 'noop' ? { skipped: true } : {}),
  };
  if (result && typeof result === 'object') {
    for (const key of [
      'error', 'exitCode', 'exit_code', 'timedOut', 'cancelled', 'isError',
      'taskId', 'backgroundTaskId', 'streamId', 'outputEnd', 'hasNewOutput',
      'cwd', 'shell', 'nextActionNote', 'message', 'mode', '_consoleTraceEmitted',
      'operation', 'editsApplied', 'stateChanged', 'rollbackIncomplete', 'rolledBack',
      'replayed', 'committedPreviously',
    ]) {
      const value = result[key];
      if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) {
        envelope[key] = typeof value === 'string' ? value.slice(0, 1200) : value;
      }
    }
    if (Array.isArray(result.results)) {
      const pending = result.results.filter((entry: any) => getToolResultOutcome(entry) === 'pending');
      if (pending.length) envelope.pendingTasks = pending.slice(0, 32).map((entry: any) => ({
        taskId: entry.taskId || entry.backgroundTaskId,
        command: String(entry.command || '').slice(0, 300),
      }));
    }
  }
  return envelope;
}

interface CompactionResult {
  compacted: any;
  originalSize: number;
  compactedSize: number;
  strategy: string;
}

/** Size thresholds for compaction activation */
const COMPACT_THRESHOLD = 8_000;      // Compact before one result dominates the next turn
const MAX_COMPACT_SIZE = 10_000;      // Roughly 2.5K tokens for one fresh result
const MAX_TOOL_BATCH_SIZE = 18_000;    // Roughly 4.5K tokens across a parallel batch
const SEARCH_RESULT_LIMIT = 20;
const SHELL_TAIL_LINES = 60;
const SHELL_HEAD_LINES = 16;

export class ToolResultCompactor {
  
  /**
   * Compact a tool result intelligently based on the tool type.
   * Returns the original if it's small enough or can't be compacted.
   */
  compact(toolName: string, args: Record<string, any>, result: any): any {
    if (result === null || result === undefined) return result;
    if (toolName === 'computer' || toolName === 'screen_agent') {
      const desktop = splitComputerToolResult(toolName, result);
      const output = this.compactComputerResult(desktop.output, MAX_COMPACT_SIZE);
      // Images bypass text compaction, then the provider adapter extracts them
      // into native image parts before compactBatch accounts for JSON.
      return desktop.image ? { ...output, vision: { inlineData: desktop.image } } : output;
    }
    if (isSourceRead(toolName, args, result)) return this.pageReadOutput(toolName, result, terminalOutputPageChars(args.maxOutputChars ?? args.maxChars));
    
    // Estimate size
    const size = this.estimateSize(result);
    if (size < COMPACT_THRESHOLD) return result; // Small enough — keep as-is

    try {
      let compacted: any = result;
      switch (toolName) {
        case 'web_search':
          compacted = this.compactSearchResults(args, result);
          break;
        
        case 'workspace_run_command':
          compacted = this.compactShellOutput(args, result);
          break;

        case 'workspace_edit_file':
          compacted = this.compactEditResult(result);
          break;
        
        case 'browser_control':
          compacted = this.compactBrowserResult(args, result);
          break;

        case 'spawn_sub_agent':
          compacted = this.compactDelegationResult(result);
          break;
        
        default:
          compacted = this.compactGeneric(result);
          break;
      }
      return this.estimateSize(compacted) > MAX_COMPACT_SIZE
        ? this.compactToBudget(toolName, args, compacted, MAX_COMPACT_SIZE)
        : compacted;
    } catch {
      // Compaction failure is non-destructive. The real context boundary sees
      // the original result on the next turn and decides whether to compact.
      return result;
    }
  }

  /** Link a reduced provider payload to the immutable exact Context Fabric page. */
  withExactPageRef(result: any, pageRef?: string, canOpenContextMemory = true): any {
    const normalizedPageRef = String(pageRef || '').trim();
    if (!normalizedPageRef || !result || typeof result !== 'object') return result;
    if (result.__eterxContextDigest !== true && result._compacted !== true) return result;
    return {
      ...result,
      exactContextPageRef: normalizedPageRef,
      recovery: canOpenContextMemory
        ? `Use context_memory action="open" with pageRef="${normalizedPageRef}" for the exact result.`
        : 'This is a reduced tool result. Use this run\'s declared terminal/file tools to obtain the relevant evidence; do not infer omitted content or call an unavailable memory tool.',
    };
  }

  /**
   * Bound the whole provider tool cycle, including reads. Read reductions
   * update exact continuation offsets instead of summarizing source text.
   */
  compactBatch(toolNames: string[], argsList: Record<string, any>[], results: any[], contextWindow?: number): any[] {
    if (results.length === 0) return results;
    const reads = results.map((result, index) => isSourceRead(toolNames[index], argsList[index] || {}, result));
    const sizes = results.map(result => this.estimateSize(result));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const batchBudget = Math.min(reads.some(Boolean) ? 48_000 : MAX_TOOL_BATCH_SIZE,
      terminalOutputPageChars(48_000, contextWindow));
    if (total <= batchBudget) return results;

    // Water-fill: keep small siblings exact and give their unused allowance
    // to larger reads. A batch cannot multiply a minimum per-result budget.
    const allocations = sizes.map(() => 0);
    let remaining = batchBudget;
    const bounded = sizes.map((size, index) => ({ size, index }));
    bounded.sort((a, b) => a.size - b.size)
      .forEach((item, index) => {
        allocations[item.index] = Math.min(item.size, Math.floor(remaining / (bounded.length - index)));
        remaining -= allocations[item.index];
      });
    return results.map((result, index) => sizes[index] <= allocations[index] ? result
      : reads[index] ? this.pageReadOutput(toolNames[index], result, allocations[index])
      : this.compactToBudget(toolNames[index] || 'tool', argsList[index] || {}, result, allocations[index]));
  }

  private compactToBudget(
    toolName: string,
    args: Record<string, any>,
    result: any,
    maxChars: number,
  ): any {
    if (isSourceRead(toolName, args, result)) return this.pageReadOutput(toolName, result, maxChars);
    if (toolName === 'computer' || toolName === 'screen_agent') return this.compactComputerResult(result, maxChars);
    const exactContextPageRef = typeof result?.exactContextPageRef === 'string'
      ? result.exactContextPageRef
      : undefined;
    if (toolName === 'workspace_edit_file' && result && typeof result === 'object') {
      // File lifecycle/UI ownership depends on this small authoritative
      // manifest. A very large edit result used to fall through to the generic
      // evidence digest, dropping operation and changed-path metadata before
      // downstream preview/rendering code could settle the action card.
      const compacted = this.compactEditResult(result);
      const changes = Array.isArray(compacted?.changes)
        ? compacted.changes.map((change: any) => ({
            path: change?.path,
            filename: change?.filename,
            action: change?.action,
            additions: change?.additions,
            deletions: change?.deletions,
            error: change?.error,
          }))
        : [];
      return {
        ...outcomeEnvelope(result),
        success: compacted?.success !== false,
        message: compacted?.message,
        error: compacted?.error,
        operation: compacted?.operation,
        filesModified: Array.isArray(compacted?.filesModified) ? compacted.filesModified : [],
        filesCreated: Array.isArray(compacted?.filesCreated) ? compacted.filesCreated : [],
        filesDeleted: Array.isArray(compacted?.filesDeleted) ? compacted.filesDeleted : [],
        changes,
        errors: Array.isArray(compacted?.errors) ? compacted.errors.slice(0, 20) : [],
        rolledBack: Boolean(compacted?.rolledBack),
        editsApplied: compacted?.editsApplied,
        ...(Array.isArray(compacted?.previousTargets) ? { previousTargets: compacted.previousTargets } : {}),
        __eterxContextDigest: true,
        originalChars: this.estimateSize(result),
        recovery: 'Use a narrow workspace read if the exact edited content is needed.',
        ...(exactContextPageRef ? { exactContextPageRef } : {}),
      };
    }
    const query = `${toolName} ${JSON.stringify(args || {}).slice(0, 1_200)}`;
    const digest = distillEvidence(result, query, Math.max(800, maxChars - 280));
    return {
      __eterxContextDigest: true,
      tool: toolName,
      originalChars: digest.originalChars,
      status: digest.status,
      ...outcomeEnvelope(result),
      evidence: digest.text,
      recovery: 'Use a narrower follow-up read/search call if omitted detail becomes decision-relevant.',
      ...(exactContextPageRef ? { exactContextPageRef } : {}),
    };
  }

  /** Preserve complete target IDs and control tokens; never turn them into a prose digest. */
  private compactComputerResult(result: any, maxChars: number): any {
    if (!result || typeof result !== 'object' || this.estimateSize(result) <= maxChars) return result;
    const { vision: _vision, _visionParts, observation, result: actionResult, ...envelope } = result;
    const matches = Array.isArray(actionResult?.matches) ? actionResult.matches : [];
    const observed = Array.isArray(observation?.elements) ? observation.elements : [];
    const priority = new Set(matches.map((element: any) => element.element_token).filter(Boolean));
    const elements = [...observed].sort((a, b) => Number(priority.has(b.element_token)) - Number(priority.has(a.element_token)));
    const bounded: any = {
      ...envelope,
      result: typeof actionResult === 'string' ? actionResult.slice(0, Math.max(200, Math.floor(maxChars / 4)))
        : this.estimateSize(actionResult) <= Math.max(600, maxChars / 4) ? actionResult
          : Array.isArray(actionResult) ? [] : { message: actionResult?.message, effect: actionResult?.effect, status: actionResult?.status, target: actionResult?.target, matches: [] },
      ...(observation ? { observation: { ...observation, elements: [], tree: typeof observation.tree === 'string' ? observation.tree.slice(0, 1500) : undefined, truncated: true } } : {}),
      _compacted: true,
      recovery: 'Use find with a narrower query for omitted controls. Use only complete tokens from the latest observation of this target.',
    };
    // App discovery needs complete process/window IDs just as control reads
    // need complete tokens. Keep arrays as arrays for computer's selectors.
    const rows = Array.isArray(actionResult) ? actionResult : matches;
    const destination = Array.isArray(bounded.result) ? bounded.result : bounded.result?.matches;
    if (Array.isArray(destination) && destination.length === 0 && rows.length) {
      for (const row of rows) {
        destination.push(row);
        if (this.estimateSize(bounded) > maxChars) { destination.pop(); break; }
      }
      if (destination.length < rows.length) {
        bounded.omittedResults = rows.length - destination.length;
        if (Array.isArray(actionResult)) bounded.recovery = 'Use list_apps with an app name or filter to narrow the window list. Select a complete pid and window_id pair.';
      }
    }
    // Keep each element intact; half a token or target ID is never usable.
    if (bounded.observation) {
      for (const element of elements) {
        bounded.observation.elements.push(element);
        if (this.estimateSize(bounded) > maxChars) { bounded.observation.elements.pop(); break; }
      }
    }
    return bounded;
  }

  /** Preserve the complete multi-file manifest while bounding heavy previews. */
  private compactEditResult(result: any): any {
    if (!result || typeof result !== 'object') return result;
    const changes = Array.isArray(result.changes)
      ? result.changes.map((change: any) => ({
          ...change,
          diff: typeof change?.diff === 'string' ? change.diff.slice(0, 6000) : change?.diff,
          readback: typeof change?.readback === 'string' ? change.readback.slice(0, 1200) : change?.readback,
        }))
      : [];
    return {
      ...result,
      changes,
      readbacks: undefined,
      _compacted: true,
      _compactionStrategy: 'multi-file edit manifest',
    };
  }

  /** Compact search results — keep top results, remove boilerplate */
  private compactSearchResults(args: Record<string, any>, result: any): any {
    if (typeof result === 'string') {
      if (result.length < COMPACT_THRESHOLD) return result;
      // Just head+tail for string results
      return result.substring(0, 22_000) + `\n\n...[search results compacted]...\n\n` + result.substring(result.length - 6_000);
    }

    if (result?.results && Array.isArray(result.results)) {
      return {
        ...result,
        results: result.results.slice(0, SEARCH_RESULT_LIMIT).map((r: any) => ({
          ...r,
          // Trim long content fields
          content: typeof r.content === 'string' ? r.content.substring(0, 2000) : r.content,
          snippet: typeof r.snippet === 'string' ? r.snippet.substring(0, 500) : r.snippet,
          text: typeof r.text === 'string' ? r.text.substring(0, 2000) : r.text,
        })),
        _compacted: true,
        _originalResultCount: result.results.length,
      };
    }

    return this.compactGeneric(result);
  }

  private preserveReadOutput(result: any): any {
    if (!result || typeof result !== 'object') return result;
    const output = { ...result };
    // Removing an identical alias is lossless, unlike clipping source text.
    if (output.output === output.stdout || output.output === output.stderr) delete output.output;
    return output;
  }

  private pageReadOutput(toolName: string, result: any, budget: number): any {
    const output = this.preserveReadOutput(result);
    if (this.estimateSize(output) <= budget || !output || typeof output !== 'object') return output;
    // Apply to recoverable protocols only. Unknown read formats must not lose
    // content merely because they contain a string named "content" or "stdout".
    let build: ((chars: number) => any) | undefined;
    let length = 0;
    if (toolName === 'context_memory' && output.pageRef && typeof output.content === 'string') {
      length = output.content.length;
      build = chars => {
        const end = Number(output.offset || 0) + chars;
        const complete = end >= Number(output.totalChars || length);
        return { ...output, content: output.content.slice(0, chars), complete, nextOffset: complete ? null : end };
      };
    } else if (toolName === 'workspace_run_command' && output.taskId
      && output.outputKind === 'read' && typeof output.stdout === 'string' && !output.stderr && !output.outputReadError) {
      length = output.stdout.length;
      build = chars => {
        const end = Number(output.outputStart || 0) + chars;
        const hasMoreOutput = end < Number(output.totalOutputChars || length);
        return { ...output, stdout: output.stdout.slice(0, chars), outputEnd: end,
          hasMoreOutput, nextOutputOffset: hasMoreOutput ? end : undefined,
          outputLimited: output.outputLimited || hasMoreOutput,
          nextActionNote: hasMoreOutput
            ? `Read more with workspace_run_command mode="check", taskId="${output.taskId}", sinceOffset=${end}. Output is partial; do not rerun the command to retrieve it.`
            : output.nextActionNote,
        };
      };
    } else if (toolName === 'workspace_run_command' && output.batch && Array.isArray(output.results)
      && output.results.every((item: any) => item.taskId && !item.outputReadError)) {
      // Aggregated text has command headers, so shortening it without rewriting
      // every child's cursor would skip evidence. Return recovery handles instead.
      return { ...output, stdout: '', stderr: '', outputLimited: true, hasMoreOutput: true,
        results: output.results.map((item: any) => ({ ...item, outputEnd: item.outputStart || 0,
          nextOutputOffset: item.outputStart || 0, hasMoreOutput: Number(item.totalOutputChars || 0) > 0,
          nextActionNote: `Read retained output with mode="check", taskId="${item.taskId}", sinceOffset=${item.outputStart || 0}.`,
        })),
        nextActionNote: 'Batch output is retained. Open only the relevant command pages using their task IDs and outputEnd offsets below.',
      };
    }
    if (!build) return output;
    // JSON escaping affects the actual wire size. Find the largest verbatim
    // prefix that fits, rather than assuming one source character is one byte.
    let low = 0;
    let high = length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.estimateSize(build(middle)) <= budget) low = middle;
      else high = middle - 1;
    }
    return build(low);
  }

  /** Compact shell output — keep exit code + head + tail of stdout/stderr */
  private compactShellOutput(args: Record<string, any>, result: any): any {
    const compact = (text: string): string => {
      if (text.length < COMPACT_THRESHOLD) return text;
      const lines = text.split('\n');
      if (lines.length <= SHELL_HEAD_LINES + SHELL_TAIL_LINES) return text;
      
      const head = lines.slice(0, SHELL_HEAD_LINES).join('\n');
      const tail = lines.slice(-SHELL_TAIL_LINES).join('\n');
      return `${head}\n\n... [${lines.length - SHELL_HEAD_LINES - SHELL_TAIL_LINES} lines omitted] ...\n\n${tail}`;
    };

    if (typeof result === 'string') return compact(result);

    const compacted = { ...result, _compacted: true };
    if (typeof result.stdout === 'string') compacted.stdout = compact(result.stdout);
    if (typeof result.stderr === 'string') compacted.stderr = compact(result.stderr);
    if (typeof result.output === 'string') {
      if (result.output === result.stdout || result.output === result.stderr) {
        delete compacted.output;
      } else {
        compacted.output = compact(result.output);
      }
    }
    return compacted;
  }

  /** Compact browser control results */
  private compactBrowserResult(args: Record<string, any>, result: any): any {
    if (typeof result === 'string') {
      if (result.length < COMPACT_THRESHOLD) return result;
      return result.substring(0, 28_000) + '\n...[browser output compacted]';
    }
    
    // For snapshot/read_page results, keep the DOM structure summary
    if (result?.pageContent && typeof result.pageContent === 'string' && result.pageContent.length > COMPACT_THRESHOLD) {
      return {
        ...result,
        pageContent: result.pageContent.substring(0, 28_000) + '\n...[page content compacted]',
        _compacted: true,
      };
    }

    return this.compactGeneric(result);
  }

  /** Preserve delegation lineage while bounding each worker payload independently. */
  private compactDelegationResult(result: any): any {
    if (!result || typeof result !== 'object' || !Array.isArray(result.agents)) return this.compactGeneric(result);
    const agents = result.agents.map((agent: any) => {
      const raw = typeof agent?.result === 'string' ? agent.result : '';
      const bounded = raw.length <= 12_000
        ? raw
        : `${raw.slice(0, 9_000)}\n\n...[delegated result compacted; ${raw.length} chars total]...\n\n${raw.slice(-2_000)}`;
      return {
        ...agent,
        result: bounded,
        traceLog: Array.isArray(agent?.traceLog) ? agent.traceLog.slice(-8) : agent?.traceLog,
      };
    });
    return {
      ...result,
      agents,
      // `usableResults` and the legacy alias duplicate objects already present
      // in agents; keep identity/quality metadata without repeating payloads.
      usableResults: Array.isArray(result.usableResults)
        ? result.usableResults.map((agent: any) => ({
            name: agent?.name,
            agentId: agent?.agentId,
            status: agent?.status,
            delegationEvidence: agent?.delegationEvidence,
          }))
        : result.usableResults,
      completedResults: Array.isArray(result.completedResults)
        ? result.completedResults.map((agent: any) => ({
            name: agent?.name,
            agentId: agent?.agentId,
            status: agent?.status,
            delegationEvidence: agent?.delegationEvidence,
          }))
        : result.completedResults,
      _compacted: true,
      _compactionStrategy: 'delegation evidence manifest',
    };
  }

  /** Generic compaction — head + tail with size info */
  private compactGeneric(result: any): any {
    if (typeof result === 'string') {
      if (result.length <= MAX_COMPACT_SIZE) return result;
      const headSize = 22_000;
      const tailSize = 6_000;
      return `${result.substring(0, headSize)}\n\n...[${((result.length - headSize - tailSize) / 1024).toFixed(0)}KB compacted]...\n\n${result.substring(result.length - tailSize)}`;
    }

    // For objects, try to compact string values recursively (1 level)
    if (typeof result === 'object' && result !== null) {
      const compacted: any = Array.isArray(result) ? [...result] : { ...result };
      for (const key of Object.keys(compacted)) {
        if (typeof compacted[key] === 'string' && compacted[key].length > MAX_COMPACT_SIZE) {
          const val = compacted[key];
          compacted[key] = val.substring(0, 22_000) + `\n...[${key} compacted: ${((val.length) / 1024).toFixed(0)}KB total]...\n` + val.substring(val.length - 6_000);
        }
      }
      compacted._compacted = true;
      return compacted;
    }

    return result;
  }

  /** Estimate the byte size of a value */
  private estimateSize(value: any): number {
    if (typeof value === 'string') return value.length;
    if (typeof value === 'number' || typeof value === 'boolean') return 8;
    if (value === null || value === undefined) return 0;
    try {
      return JSON.stringify(value).length;
    } catch {
      return 0;
    }
  }
}

/** Singleton instance */
export const toolResultCompactor = new ToolResultCompactor();
