/**
 * EterX Agent — Smart Tool Result Compactor
 * 
 * Intelligent per-tool-type truncation that preserves the most useful information
 * instead of crude string slicing. Each tool type has its own compaction strategy
 * that knows what's important in that tool's output.
 */

import { distillEvidence } from './evidence-distiller';

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
  withExactPageRef(result: any, pageRef?: string): any {
    const normalizedPageRef = String(pageRef || '').trim();
    if (!normalizedPageRef || !result || typeof result !== 'object') return result;
    if (result.__eterxContextDigest !== true && result._compacted !== true) return result;
    return {
      ...result,
      exactContextPageRef: normalizedPageRef,
      recovery: `Use context_memory action="open" with pageRef="${normalizedPageRef}" for the exact result.`,
    };
  }

  /**
   * Bound the combined payload of one parallel tool batch. Small results stay
   * exact; only oversized siblings are distilled. Raw outputs are retained by
   * Context Fabric before this provider-facing reduction is applied.
   */
  compactBatch(toolNames: string[], argsList: Record<string, any>[], results: any[]): any[] {
    if (results.length <= 1) return results;
    const sizes = results.map(result => this.estimateSize(result));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (total <= MAX_TOOL_BATCH_SIZE) return results;

    const exactIndexes = sizes
      .map((size, index) => ({ size, index }))
      .filter(item => item.size <= 2_000);
    const exactChars = exactIndexes.reduce((sum, item) => sum + item.size, 0);
    const largeCount = Math.max(1, results.length - exactIndexes.length);
    const perLargeBudget = Math.max(2_400, Math.floor((MAX_TOOL_BATCH_SIZE - exactChars) / largeCount));

    return results.map((result, index) => sizes[index] <= 2_000
      ? result
      : this.compactToBudget(toolNames[index] || 'tool', argsList[index] || {}, result, perLargeBudget));
  }

  private compactToBudget(
    toolName: string,
    args: Record<string, any>,
    result: any,
    maxChars: number,
  ): any {
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
      evidence: digest.text,
      recovery: 'Use a narrower follow-up read/search call if omitted detail becomes decision-relevant.',
      ...(exactContextPageRef ? { exactContextPageRef } : {}),
    };
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
