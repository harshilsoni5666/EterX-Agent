/**
 * EterX Agent — Smart Tool Result Compactor
 * 
 * Intelligent per-tool-type truncation that preserves the most useful information
 * instead of crude string slicing. Each tool type has its own compaction strategy
 * that knows what's important in that tool's output.
 */

interface CompactionResult {
  compacted: any;
  originalSize: number;
  compactedSize: number;
  strategy: string;
}

/** Size thresholds for compaction activation */
const COMPACT_THRESHOLD = 30_000;     // 30KB — below this, keep as-is
const MAX_COMPACT_SIZE = 50_000;      // 50KB max output
const CODE_LINE_LIMIT = 500;          // Max lines for code file reads
const SEARCH_RESULT_LIMIT = 30;       // Max search results to keep
const SHELL_TAIL_LINES = 80;          // Keep last N lines of shell output
const SHELL_HEAD_LINES = 20;          // Keep first N lines of shell output

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
      switch (toolName) {
        case 'workspace_read_file':
        case 'workspace_view_file':
          return this.compactFileRead(args, result);

        case 'workspace_read_many_files':
          return this.compactReadManyFiles(args, result);
        
        case 'web_search':
        case 'deep_research':
          return this.compactSearchResults(args, result);
        
        case 'system_shell':
        case 'workspace_run_command':
          return this.compactShellOutput(args, result);
        
        case 'workspace_search_text':
        case 'workspace_semantic_search':
          return this.compactSearchText(args, result);
        
        case 'workspace_list_directory':
        case 'workspace_find_files':
        case 'workspace_analyze':
          return this.compactDirectoryListing(args, result);
        
        case 'web_scraper':
          return this.compactWebScrape(args, result);
        
        case 'browser_control':
          return this.compactBrowserResult(args, result);
        
        default:
          return this.compactGeneric(result);
      }
    } catch {
      // Fallback to generic compaction
      return this.compactGeneric(result);
    }
  }

  /** Compact file read output — keep structure: imports, exports, class/function signatures */
  private compactFileRead(args: Record<string, any>, result: any): any {
    const content = typeof result === 'string' ? result : (result?.content || result?.output || '');
    if (typeof content !== 'string' || content.length < COMPACT_THRESHOLD) return result;

    const lines = content.split('\n');
    if (lines.length <= CODE_LINE_LIMIT) return result;

    const kept: string[] = [];
    const filename = String(args?.filename || args?.path || '');
    const ext = filename.split('.').pop()?.toLowerCase() || '';

    // Always keep first 50 lines (imports, header)
    kept.push(...lines.slice(0, 50));
    kept.push(`\n// ... [${lines.length - 100} lines compacted by EterX] ...\n`);

    // Scan for structural elements based on language
    const isTS = ['ts', 'tsx', 'js', 'jsx'].includes(ext);
    const isPython = ext === 'py';
    const isRust = ext === 'rs';
    const isGo = ext === 'go';

    for (let i = 50; i < lines.length - 50; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // Keep structural elements
      if (isTS && /^(export|import|interface|type|class|function|const|enum|abstract)\b/.test(trimmed)) {
        kept.push(line);
      } else if (isPython && /^(class|def|import|from|async def|@)/.test(trimmed)) {
        kept.push(line);
      } else if (isRust && /^(pub|fn|struct|enum|impl|use|mod|trait)/.test(trimmed)) {
        kept.push(line);
      } else if (isGo && /^(func|type|package|import|var|const)/.test(trimmed)) {
        kept.push(line);
      }
      // Keep comments that look like section headers
      else if (/^(\/\/\s*={3,}|\/\/\s*-{3,}|#\s*={3,}|\/\*\*|\s*\*\s*@)/.test(trimmed)) {
        kept.push(line);
      }
    }

    // Always keep last 50 lines
    kept.push(`\n// ... [end of compacted section] ...\n`);
    kept.push(...lines.slice(-50));

    const compacted = kept.join('\n');
    
    if (typeof result === 'string') return compacted;
    return { ...result, content: compacted, _compacted: true, _originalLines: lines.length };
  }

  /** Compact search results — keep top results, remove boilerplate */
  private compactReadManyFiles(args: Record<string, any>, result: any): any {
    if (!result?.files || !Array.isArray(result.files)) return this.compactFileRead(args, result);

    return {
      ...result,
      files: result.files.map((file: any) => {
        if (!file || typeof file.content !== 'string') return file;
        if (file.content.length < COMPACT_THRESHOLD) return file;
        const lines = file.content.split('\n');
        const head = lines.slice(0, 120).join('\n');
        const tail = lines.slice(-60).join('\n');
        return {
          ...file,
          content: `${head}\n\n// ... [${Math.max(0, lines.length - 180)} lines compacted from ${file.filename || file.path || 'file'}] ...\n\n${tail}`,
          _compacted: true,
          _originalLines: lines.length,
        };
      }),
      _compacted: true,
    };
  }

  private compactSearchResults(args: Record<string, any>, result: any): any {
    if (typeof result === 'string') {
      if (result.length < COMPACT_THRESHOLD) return result;
      // Just head+tail for string results
      return result.substring(0, 35000) + `\n\n...[search results compacted]...\n\n` + result.substring(result.length - 10000);
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
    if (typeof result.output === 'string') compacted.output = compact(result.output);
    return compacted;
  }

  /** Compact text search results — keep matched lines + context, remove duplicates */
  private compactSearchText(args: Record<string, any>, result: any): any {
    if (typeof result === 'string') {
      if (result.length < COMPACT_THRESHOLD) return result;
      // Keep first 30KB + last 10KB
      return result.substring(0, 30000) + '\n\n...[search results truncated]...\n\n' + result.substring(result.length - 10000);
    }

    if (result?.results && Array.isArray(result.results)) {
      // Deduplicate by file
      const byFile = new Map<string, any[]>();
      for (const r of result.results) {
        const file = r.file || r.filename || 'unknown';
        if (!byFile.has(file)) byFile.set(file, []);
        const matches = byFile.get(file)!;
        if (matches.length < 10) { // Max 10 matches per file
          matches.push(r);
        }
      }

      const deduped: any[] = [];
      for (const [, matches] of byFile) {
        deduped.push(...matches);
      }

      return {
        ...result,
        results: deduped.slice(0, SEARCH_RESULT_LIMIT * 2),
        _compacted: true,
        _originalResultCount: result.results.length,
      };
    }

    return this.compactGeneric(result);
  }

  /** Compact directory listing — keep first level, summarize deep nesting */
  private compactDirectoryListing(args: Record<string, any>, result: any): any {
    if (typeof result === 'string') {
      if (result.length < COMPACT_THRESHOLD) return result;
      const lines = result.split('\n');
      // Keep first 200 entries + summary
      return lines.slice(0, 200).join('\n') + `\n\n... [${lines.length - 200} more entries]`;
    }
    return this.compactGeneric(result);
  }

  /** Compact web scrape results — extract main content, drop navigation/footer */
  private compactWebScrape(args: Record<string, any>, result: any): any {
    const content = typeof result === 'string' ? result : (result?.content || result?.text || '');
    if (typeof content !== 'string' || content.length < COMPACT_THRESHOLD) return result;

    // Simple heuristic: split into paragraphs, keep longest ones (main content)
    const paragraphs = content.split(/\n{2,}/);
    const scored = paragraphs.map(p => ({ text: p, score: p.length }));
    scored.sort((a, b) => b.score - a.score);
    
    // Keep top paragraphs up to size limit
    let total = 0;
    const kept: string[] = [];
    for (const p of scored) {
      if (total + p.text.length > MAX_COMPACT_SIZE) break;
      kept.push(p.text);
      total += p.text.length;
    }

    const compacted = kept.join('\n\n');
    if (typeof result === 'string') return compacted;
    return { ...result, content: compacted, _compacted: true };
  }

  /** Compact browser control results */
  private compactBrowserResult(args: Record<string, any>, result: any): any {
    if (typeof result === 'string') {
      if (result.length < COMPACT_THRESHOLD) return result;
      return result.substring(0, 40000) + '\n...[browser output compacted]';
    }
    
    // For snapshot/read_page results, keep the DOM structure summary
    if (result?.pageContent && typeof result.pageContent === 'string' && result.pageContent.length > COMPACT_THRESHOLD) {
      return {
        ...result,
        pageContent: result.pageContent.substring(0, 40000) + '\n...[page content compacted]',
        _compacted: true,
      };
    }

    return this.compactGeneric(result);
  }

  /** Generic compaction — head + tail with size info */
  private compactGeneric(result: any): any {
    if (typeof result === 'string') {
      if (result.length <= MAX_COMPACT_SIZE) return result;
      const headSize = 35_000;
      const tailSize = 10_000;
      return `${result.substring(0, headSize)}\n\n...[${((result.length - headSize - tailSize) / 1024).toFixed(0)}KB compacted]...\n\n${result.substring(result.length - tailSize)}`;
    }

    // For objects, try to compact string values recursively (1 level)
    if (typeof result === 'object' && result !== null) {
      const compacted: any = Array.isArray(result) ? [...result] : { ...result };
      for (const key of Object.keys(compacted)) {
        if (typeof compacted[key] === 'string' && compacted[key].length > MAX_COMPACT_SIZE) {
          const val = compacted[key];
          compacted[key] = val.substring(0, 35000) + `\n...[${key} compacted: ${((val.length) / 1024).toFixed(0)}KB total]...\n` + val.substring(val.length - 10000);
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
