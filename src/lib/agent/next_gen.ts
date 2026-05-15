import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';

/**
 * ═══════════════════════════════════════════════════════════════
 * NEXT-GEN AGENT CORE — 100x Innovation Layer
 * ═══════════════════════════════════════════════════════════════
 * 
 * 1. Intelligent Caching — Never re-execute identical tool calls
 * 2. Smart Query Router — Route queries to optimal strategy
 * 3. Knowledge Extraction — Auto-extract facts from conversations
 * 4. Multi-Strategy Recovery — When Plan A fails, auto-try B, C, D
 * 5. Agent Pipeline Builder — Define reusable multi-step pipelines
 * 6. Performance Analytics — Track agent performance metrics
 */

const CACHE_DIR = path.resolve(process.cwd(), '.workspaces', 'cache');
const KNOWLEDGE_DIR = path.resolve(process.cwd(), '.workspaces', 'knowledge');
const PIPELINES_DIR = path.resolve(process.cwd(), '.workspaces', 'pipelines');

// ═══════════════════════════════════════════════════════════════
// 1. INTELLIGENT CACHING LAYER
// ═══════════════════════════════════════════════════════════════

/**
 * Caches tool execution results to prevent redundant work.
 * Uses content-addressable storage (hash of tool name + args).
 * 
 * STRATEGY:
 * - Cache web_search results for 30 minutes (info changes)
 * - Cache file reads for 5 minutes (files may change)
 * - Cache workspace_analyze for 1 hour (project rarely changes mid-session)  
 * - Never cache write/edit/shell tools (side effects)
 * - In-memory + disk persistence
 */
interface CacheEntry {
  key: string;
  toolName: string;
  args: any;
  result: any;
  cachedAt: number;
  ttlMs: number;
  hits: number;
}

const TOOL_TTL: Record<string, number> = {
  web_search: 30 * 60 * 1000,      // 30 min
  web_scraper: 60 * 60 * 1000,     // 1 hour
  workspace_read_file: 5 * 60 * 1000, // 5 min
  workspace_list_directory: 5 * 60 * 1000,
  workspace_search_text: 5 * 60 * 1000,
  workspace_analyze: 60 * 60 * 1000,  // 1 hour
  pdf_parser: 60 * 60 * 1000,
  youtube_transcript: 60 * 60 * 1000,
  rss_feed_reader: 15 * 60 * 1000,   // 15 min
  calculator: 24 * 60 * 60 * 1000,   // 24 hours (math doesn't change)
  realtime_verify: 2 * 60 * 1000,    // 2 min
};

// Tools that should NEVER be cached (have side effects or need fresh results)
const UNCACHEABLE_TOOLS = new Set([
  'workspace_write_file', 'workspace_edit_file', 'system_shell',
  'workspace_run_command', 'workspace_verify_code', 'git_operations',
  'docx_generator', 'task_decomposer', 'spawn_sub_agent', 'background_task',
  'create_dynamic_tool', 'run_macro', 'screenshot_capture',
  'desktop_notification', 'email_sender', 'tts_engine',
  'process_manager', 'task_scheduler', 'file_watcher',
  'code_generator', 'compression_tool', 'self_improve',
  'ask_user',            // MUST always actually ask the user
  'task_checkpoint',     // MUST always read/write real checkpoint state
  'get_skill_guidelines', // Skills should load fresh content each time
]);

export class IntelligentCache {
  private memoryCache: Map<string, CacheEntry> = new Map();
  private stats = { hits: 0, misses: 0, saves: 0 };

  /** Generate a deterministic cache key from tool name + args */
  private generateKey(toolName: string, args: any): string {
    const sortedArgs: any = {};
    if (args && typeof args === 'object') {
      Object.keys(args).sort().forEach(k => {
        sortedArgs[k] = args[k];
      });
    }
    const normalized = JSON.stringify({ tool: toolName, args: sortedArgs });
    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  /** Check if a cached result exists and is still valid */
  get(toolName: string, args: any): any | null {
    if (UNCACHEABLE_TOOLS.has(toolName)) return null;

    const key = this.generateKey(toolName, args);
    const entry = this.memoryCache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check TTL
    const age = Date.now() - entry.cachedAt;
    if (age > entry.ttlMs) {
      this.memoryCache.delete(key);
      this.stats.misses++;
      return null;
    }

    entry.hits++;
    this.stats.hits++;
    console.log(`[Cache] ⚡ HIT: ${toolName} (${(age / 1000).toFixed(0)}s old, ${entry.hits} hits)`);
    return entry.result;
  }

  /** Store a result in cache */
  set(toolName: string, args: any, result: any): void {
    if (UNCACHEABLE_TOOLS.has(toolName)) return;

    const ttl = TOOL_TTL[toolName];
    if (!ttl) return; // No TTL configured = don't cache

    const key = this.generateKey(toolName, args);
    this.memoryCache.set(key, {
      key,
      toolName,
      args,
      result,
      cachedAt: Date.now(),
      ttlMs: ttl,
      hits: 0
    });
    this.stats.saves++;

    // Cap cache size
    if (this.memoryCache.size > 200) {
      const oldest = Array.from(this.memoryCache.entries())
        .sort((a, b) => a[1].cachedAt - b[1].cachedAt)
        .slice(0, 50);
      oldest.forEach(([k]) => this.memoryCache.delete(k));
    }
  }

  /** Get cache statistics */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? ((this.stats.hits / (this.stats.hits + this.stats.misses)) * 100).toFixed(1)
      : '0';
    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      cacheSize: this.memoryCache.size,
      savedTokens: this.stats.hits * 500 // Rough estimate: 500 tokens saved per cache hit
    };
  }

  /** Clear all cache */
  clear() {
    this.memoryCache.clear();
    this.stats = { hits: 0, misses: 0, saves: 0 };
  }

  /** Purge only expired entries — keeps valid cross-message cache intact */
  purgeExpired() {
    const now = Date.now();
    let purged = 0;
    for (const [key, entry] of this.memoryCache.entries()) {
      if (now - entry.cachedAt > entry.ttlMs) {
        this.memoryCache.delete(key);
        purged++;
      }
    }
    if (purged > 0) {
      console.log(`[Cache] 🧹 Purged ${purged} expired entries. ${this.memoryCache.size} valid entries retained.`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 2. SMART QUERY ROUTER
// ═══════════════════════════════════════════════════════════════

/**
 * Analyzes incoming queries and routes them to the optimal execution strategy.
 * 
 * STRATEGIES:
 * - direct_answer: Simple factual question → answer from knowledge, no tools
 * - single_tool: Needs one specific tool → identify and call it
 * - multi_tool_sequential: Multiple tools needed in order → chain them
 * - multi_tool_parallel: Independent tasks → spawn sub-agents
 * - research_heavy: Needs external info → prioritize search/scrape
 * - code_heavy: Code generation → prioritize file ops
 * - document_heavy: Document creation → prioritize docx/write tools
 * - creative: Open-ended creative task → higher temperature, more freedom
 */
export type ExecutionStrategy =
  | 'direct_answer'
  | 'single_tool'
  | 'multi_tool_sequential'
  | 'multi_tool_parallel'
  | 'research_heavy'
  | 'code_heavy'
  | 'document_heavy'
  | 'creative';

interface QueryAnalysis {
  strategy: ExecutionStrategy;
  confidence: number;
  suggestedTools: string[];
  complexity: 'simple' | 'moderate' | 'complex';
  parallelizable: boolean;
  estimatedSteps: number;
  keywords: string[];
}

export class SmartQueryRouter {
  /** Analyze a query and determine optimal strategy */
  analyze(query: string): QueryAnalysis {
    const q = query.toLowerCase().trim();
    const words = q.split(/\s+/);
    const wordCount = words.length;

    // Keyword detection
    const codeKeywords = ['code', 'function', 'class', 'implement', 'build', 'create app', 'write code', 'debug', 'fix bug', 'refactor', 'typescript', 'javascript', 'python', 'api', 'component', 'module'];
    const researchKeywords = ['search', 'find', 'what is', 'who is', 'when', 'research', 'compare', 'analyze', 'latest', 'news', 'current', 'stock', 'price', 'weather'];
    const docKeywords = ['document', 'report', 'presentation', 'ppt', 'docx', 'pdf', 'write report', 'create document', 'essay', 'paper', 'article', 'blog'];
    const mathKeywords = ['calculate', 'solve', 'equation', 'integral', 'derivative', 'matrix', 'probability', 'statistics', 'math', 'physics', 'formula'];
    const creativeKeywords = ['design', 'creative', 'idea', 'brainstorm', 'suggest', 'imagine', 'story', 'write a', 'poem', 'song'];
    const parallelKeywords = ['and', 'also', 'plus', 'both', 'simultaneously', 'at the same time', 'while also'];

    const hasCode = codeKeywords.some(k => q.includes(k));
    const hasResearch = researchKeywords.some(k => q.includes(k));
    const hasDoc = docKeywords.some(k => q.includes(k));
    const hasMath = mathKeywords.some(k => q.includes(k));
    const hasCreative = creativeKeywords.some(k => q.includes(k));
    const hasParallel = parallelKeywords.some(k => q.includes(k));

    // Determine strategy
    let strategy: ExecutionStrategy = 'direct_answer';
    let suggestedTools: string[] = [];
    let complexity: 'simple' | 'moderate' | 'complex' = 'simple';
    let parallelizable = false;
    let estimatedSteps = 1;

    if (hasMath && !hasCode && !hasResearch && wordCount < 20) {
      strategy = 'single_tool';
      suggestedTools = ['calculator'];
      complexity = 'simple';
      estimatedSteps = 1;
    } else if (hasCode && hasResearch) {
      strategy = 'multi_tool_sequential';
      suggestedTools = ['web_search', 'workspace_write_file', 'workspace_verify_code'];
      complexity = 'complex';
      estimatedSteps = 5;
    } else if (hasCode) {
      strategy = 'code_heavy';
      suggestedTools = ['workspace_write_file', 'workspace_edit_file', 'workspace_verify_code', 'workspace_run_command'];
      complexity = wordCount > 30 ? 'complex' : 'moderate';
      estimatedSteps = wordCount > 30 ? 8 : 4;
    } else if (hasResearch) {
      strategy = 'research_heavy';
      suggestedTools = ['web_search', 'web_scraper'];
      complexity = 'moderate';
      estimatedSteps = 3;
    } else if (hasDoc) {
      strategy = 'document_heavy';
      suggestedTools = ['workspace_write_file', 'docx_generator'];
      complexity = 'moderate';
      estimatedSteps = 5;
    } else if (hasCreative) {
      strategy = 'creative';
      suggestedTools = [];
      complexity = 'moderate';
      estimatedSteps = 2;
    } else if (wordCount < 10 && !hasCode && !hasResearch) {
      strategy = 'direct_answer';
      suggestedTools = [];
      complexity = 'simple';
      estimatedSteps = 1;
    }

    if (hasParallel || (hasCode && hasDoc) || (hasResearch && hasCode)) {
      parallelizable = true;
      if (strategy === 'direct_answer') strategy = 'multi_tool_parallel';
    }

    const allKeywords = [
      ...codeKeywords.filter(k => q.includes(k)),
      ...researchKeywords.filter(k => q.includes(k)),
      ...docKeywords.filter(k => q.includes(k)),
      ...mathKeywords.filter(k => q.includes(k)),
    ];

    return {
      strategy,
      confidence: allKeywords.length > 0 ? Math.min(0.9, 0.5 + allKeywords.length * 0.1) : 0.4,
      suggestedTools,
      complexity,
      parallelizable,
      estimatedSteps,
      keywords: allKeywords.slice(0, 5)
    };
  }

  /** Generate a routing hint string for injection into the prompt */
  getRoutingHint(analysis: QueryAnalysis): string {
    if (analysis.strategy === 'direct_answer') return '';

    return `[ROUTE: ${analysis.strategy} | Complexity: ${analysis.complexity} | Est. steps: ${analysis.estimatedSteps}${analysis.parallelizable ? ' | PARALLELIZABLE' : ''}${analysis.suggestedTools.length > 0 ? ` | Suggested: ${analysis.suggestedTools.join(', ')}` : ''}]`;
  }
}

// ═══════════════════════════════════════════════════════════════
// 3. KNOWLEDGE EXTRACTION ENGINE
// ═══════════════════════════════════════════════════════════════

/**
 * Automatically extracts and stores key facts from agent interactions.
 * Builds a local knowledge base the agent can reference in future sessions.
 * 
 * TYPES:
 * - fact: A specific piece of information learned
 * - preference: User preference discovered
 * - pattern: Repeated behavior or workflow
 * - error_fix: How a specific error was resolved
 * - project_insight: Something learned about the project
 */
interface KnowledgeEntry {
  id: string;
  type: 'fact' | 'preference' | 'pattern' | 'error_fix' | 'project_insight';
  content: string;
  source: string;  // Where this was learned (tool, conversation, etc.)
  confidence: number;  // 0-1
  createdAt: number;
  lastUsed: number;
  useCount: number;
  tags: string[];
}

export class KnowledgeEngine {
  private entries: KnowledgeEntry[] = [];
  private loaded = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _savePending = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      await fs.ensureDir(KNOWLEDGE_DIR);
      const filePath = path.join(KNOWLEDGE_DIR, 'knowledge_base.json');
      if (await fs.pathExists(filePath)) {
        this.entries = await fs.readJson(filePath);
      }
      this.loaded = true;
      if (this.entries.length > 0) {
        console.log(`[Knowledge] Loaded ${this.entries.length} knowledge entries`);
      }
    } catch {
      this.loaded = true;
    }
  }

  async save(): Promise<void> {
    try {
      await fs.ensureDir(KNOWLEDGE_DIR);
      // Keep most recent 200 entries
      const toSave = this.entries.slice(-200);
      await fs.writeJson(path.join(KNOWLEDGE_DIR, 'knowledge_base.json'), toSave, { spaces: 2 });
    } catch { }
  }

  /** Add a new knowledge entry */
  async addEntry(
    type: KnowledgeEntry['type'],
    content: string,
    source: string,
    tags: string[] = [],
    confidence: number = 0.7
  ): Promise<void> {
    // Dedup — don't add if similar content exists
    const similar = this.entries.find(e =>
      e.content.toLowerCase().includes(content.toLowerCase().substring(0, 50)) ||
      content.toLowerCase().includes(e.content.toLowerCase().substring(0, 50))
    );
    if (similar) {
      similar.useCount++;
      similar.lastUsed = Date.now();
      similar.confidence = Math.min(1, similar.confidence + 0.05);
      this.debouncedSave();
      return;
    }

    this.entries.push({
      id: `k_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      type,
      content,
      source,
      confidence,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      useCount: 1,
      tags
    });

    this.debouncedSave();
  }

  /** Debounced save — batches multiple additions into one disk write */
  private debouncedSave(): void {
    this._savePending = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._savePending) {
        this._savePending = false;
        this.save().catch(() => {});
      }
    }, 5000);
  }

  /** Search knowledge base for relevant entries */
  search(query: string, limit: number = 5): KnowledgeEntry[] {
    const qLower = query.toLowerCase();
    const words = qLower.split(/\s+/).filter(w => w.length > 3);

    return this.entries
      .map(entry => {
        const contentLower = entry.content.toLowerCase();
        // Score based on keyword overlap + tag matches
        let score = 0;
        for (const word of words) {
          if (contentLower.includes(word)) score += 1;
          if (entry.tags.some(t => t.includes(word))) score += 2;
        }
        score += entry.confidence * 0.5;
        score += Math.min(entry.useCount * 0.1, 0.5);
        return { entry, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry }) => entry);
  }

  /** Get knowledge context for system prompt */
  getRelevantContext(query: string): string {
    const relevant = this.search(query, 3);
    if (relevant.length === 0) return '';

    const items = relevant.map(e =>
      `[${e.type}] ${e.content} (confidence: ${(e.confidence * 100).toFixed(0)}%)`
    );
    return `━━━ LEARNED KNOWLEDGE ━━━\n${items.join('\n')}`;
  }

  /** Auto-extract knowledge from tool results — stores ACTUAL DATA, not just query strings */
  async extractFromToolResult(toolName: string, args: any, result: any): Promise<void> {
    // Extract project insights from workspace_analyze
    if (toolName === 'workspace_analyze' && result?.profile) {
      await this.addEntry('project_insight',
        `Project uses ${result.profile.framework} with ${result.profile.language}. Build: ${result.profile.buildSystem}`,
        'workspace_analyze',
        ['project', 'framework', 'stack'],
        0.9
      );
    }

    // Extract from web search results — store ACTUAL RESULTS, not just the query
    if (toolName === 'web_search' && result && !result.error) {
      const query = args?.query || '';
      if (query) {
        // Extract actual result content if available
        let resultSummary = '';
        if (typeof result === 'string') {
          resultSummary = result.substring(0, 300);
        } else if (result.results && Array.isArray(result.results)) {
          resultSummary = result.results.slice(0, 3).map((r: any) =>
            `${r.title || ''}: ${(r.snippet || r.description || '').substring(0, 80)}`
          ).join(' | ');
        } else if (result.output && typeof result.output === 'string') {
          resultSummary = result.output.substring(0, 300);
        } else if (result.answer || result.text || result.content) {
          resultSummary = String(result.answer || result.text || result.content).substring(0, 300);
        }

        const content = resultSummary
          ? `Searched: "${query}" → ${resultSummary}`
          : `Searched: "${query}" — results returned (check context)`;

        await this.addEntry('fact', content, 'web_search',
          query.split(/\s+/).filter((w: string) => w.length > 3),
          resultSummary ? 0.75 : 0.6
        );
      }
    }

    // Extract from web scraper — store URL + content summary
    if (toolName === 'web_scraper' && result && !result.error) {
      const url = args?.url || '';
      if (url) {
        let contentSummary = '';
        if (typeof result === 'string') {
          contentSummary = result.substring(0, 300);
        } else if (result.content || result.text || result.output) {
          contentSummary = String(result.content || result.text || result.output).substring(0, 300);
        }

        if (contentSummary) {
          await this.addEntry('fact',
            `Scraped ${url}: ${contentSummary}`,
            'web_scraper',
            [url.replace(/https?:\/\//, '').split('/')[0], ...url.split('/').slice(3, 5)].filter(Boolean),
            0.7
          );
        }
      }
    }

    // Extract from file writes — remember what files were created and why
    if (toolName === 'workspace_write_file' && result && !result.error) {
      const filename = args?.filename || args?.path || '';
      if (filename) {
        const contentPreview = typeof args?.content === 'string'
          ? args.content.substring(0, 100).replace(/\n/g, ' ')
          : '';
        await this.addEntry('fact',
          `Created file: ${filename}${contentPreview ? ` — ${contentPreview}...` : ''}`,
          'workspace_write_file',
          [filename.split('/').pop() || filename, ...filename.split('/').filter(Boolean).slice(0, 2)],
          0.65
        );
      }
    }

    // Extract from docx generator — remember document titles
    if (toolName === 'docx_generator' && result && !result.error) {
      const title = args?.title || args?.filename || 'Untitled';
      const outputPath = result?.path || result?.output || '';
      await this.addEntry('fact',
        `Generated document: "${title}"${outputPath ? ` → ${outputPath}` : ''}`,
        'docx_generator',
        ['document', title.split(' ').slice(0, 3).join(' ')],
        0.7
      );
    }

    // Extract error patterns from failed tools
    if (result?.error || result?._retryFailed) {
      await this.addEntry('error_fix',
        `${toolName} failed with args ${JSON.stringify(args).substring(0, 100)}: ${result.error || 'unknown'}`,
        toolName,
        ['error', toolName],
        0.8
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 4. MULTI-STRATEGY RECOVERY PROTOCOL
// ═══════════════════════════════════════════════════════════════

/**
 * When the primary execution strategy fails, automatically tries
 * alternative approaches before giving up.
 * 
 * STRATEGIES:
 * 1. Retry with modified args (fix common mistakes)
 * 2. Use alternative tool (e.g., web_scraper instead of web_search)
 * 3. Break into smaller sub-tasks
 * 4. Fall back to shell command
 * 5. Ask the agent to reason about the failure
 */
interface RecoveryStrategy {
  name: string;
  condition: (toolName: string, error: string) => boolean;
  recover: (toolName: string, args: any, error: string) => { newTool: string, newArgs: any } | null;
}

export class MultiStrategyRecovery {
  private strategies: RecoveryStrategy[] = [
    {
      name: 'fix_path',
      condition: (tool, error) => error.includes('ENOENT') || error.includes('not found') || error.includes('no such file'),
      recover: (tool, args) => {
        // Try fixing common path issues
        if (args?.filename || args?.path || args?.target) {
          const origPath = args.filename || args.path || args.target;
          // Try with ./ prefix
          if (!origPath.startsWith('./') && !origPath.startsWith('/') && !origPath.includes(':')) {
            const newArgs = { ...args };
            const key = args.filename ? 'filename' : args.path ? 'path' : 'target';
            newArgs[key] = './' + origPath;
            return { newTool: tool, newArgs };
          }
        }
        return null;
      }
    },
    {
      name: 'alternative_search',
      condition: (tool, error) =>
        (tool === 'web_search' && (error.includes('no results') || error.includes('failed'))) ||
        (tool === 'web_scraper' && error.includes('failed')),
      recover: (tool, args) => {
        if (tool === 'web_search') {
          return { newTool: 'web_scraper', newArgs: { url: `https://www.google.com/search?q=${encodeURIComponent(args?.query || '')}` } };
        }
        return null;
      }
    },
    {
      name: 'shell_fallback',
      condition: (tool, error) =>
        tool === 'workspace_run_command' && error.includes('not recognized'),
      recover: (tool, args) => {
        // Try via PowerShell
        return {
          newTool: 'system_shell',
          newArgs: { command: args?.command || '', shell: 'powershell' }
        };
      }
    },
    {
      name: 'json_fix',
      condition: (tool, error) =>
        error.includes('JSON') || error.includes('SyntaxError') || error.includes('Unexpected token'),
      recover: (tool, args) => {
        // Try to fix common JSON issues in args
        if (args?.content && typeof args.content === 'string') {
          const newArgs = { ...args };
          try {
            // Try to auto-fix common JSON issues
            let fixed = args.content
              .replace(/,\s*}/g, '}')
              .replace(/,\s*]/g, ']')
              .replace(/'/g, '"');
            JSON.parse(fixed);
            newArgs.content = fixed;
            return { newTool: tool, newArgs };
          } catch { }
        }
        return null;
      }
    }
  ];

  /** Attempt recovery from a tool failure */
  attemptRecovery(toolName: string, args: any, error: string): { newTool: string, newArgs: any } | null {
    for (const strategy of this.strategies) {
      if (strategy.condition(toolName, error)) {
        const recovery = strategy.recover(toolName, args, error);
        if (recovery) {
          console.log(`[Recovery] 🔄 Strategy "${strategy.name}": ${toolName} → ${recovery.newTool}`);
          return recovery;
        }
      }
    }
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// 5. AGENT PIPELINE BUILDER
// ═══════════════════════════════════════════════════════════════

/**
 * Define and execute reusable multi-step pipelines.
 * Pipelines are saved to disk and can be triggered by name.
 * 
 * Each pipeline step has:
 * - tool: Which tool to call
 * - args: Arguments (can reference {{previous.outputKey}})
 * - condition: Optional condition to skip step
 * - onFail: What to do on failure (skip, abort, retry)
 */
interface PipelineStep {
  name: string;
  tool: string;
  args: Record<string, any>;
  outputKey: string;
  onFail: 'skip' | 'abort' | 'retry';
  retryCount?: number;
}

interface Pipeline {
  id: string;
  name: string;
  description: string;
  steps: PipelineStep[];
  createdAt: number;
  lastRun?: number;
  runCount: number;
}

export class PipelineBuilder {
  private pipelines: Map<string, Pipeline> = new Map();

  async initialize(): Promise<void> {
    try {
      await fs.ensureDir(PIPELINES_DIR);
      const files = await fs.readdir(PIPELINES_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const pipeline = await fs.readJson(path.join(PIPELINES_DIR, file));
          this.pipelines.set(pipeline.id, pipeline);
        }
      }
      if (this.pipelines.size > 0) {
        console.log(`[Pipeline] Loaded ${this.pipelines.size} saved pipelines`);
      }
    } catch { }
  }

  /** Create and save a new pipeline */
  async createPipeline(name: string, description: string, steps: PipelineStep[]): Promise<Pipeline> {
    const pipeline: Pipeline = {
      id: `pipe_${Date.now()}`,
      name,
      description,
      steps,
      createdAt: Date.now(),
      runCount: 0
    };

    this.pipelines.set(pipeline.id, pipeline);

    await fs.ensureDir(PIPELINES_DIR);
    await fs.writeJson(path.join(PIPELINES_DIR, `${pipeline.id}.json`), pipeline, { spaces: 2 });

    console.log(`[Pipeline] Created: ${name} (${steps.length} steps)`);
    return pipeline;
  }

  /** Get pipeline by name or ID */
  getPipeline(nameOrId: string): Pipeline | undefined {
    // Try by ID first
    if (this.pipelines.has(nameOrId)) return this.pipelines.get(nameOrId);
    // Try by name
    return Array.from(this.pipelines.values()).find(p => p.name === nameOrId);
  }

  /** List all pipelines */
  listPipelines(): Pipeline[] {
    return Array.from(this.pipelines.values());
  }
}

// ═══════════════════════════════════════════════════════════════
// 6. PERFORMANCE ANALYTICS ENGINE
// ═══════════════════════════════════════════════════════════════

/**
 * Tracks agent performance metrics for optimization.
 * 
 * METRICS:
 * - Tool call frequency and success rates
 * - Average response time per tool
 * - Error patterns and recovery rates
 * - Cache hit rates
 * - Sub-agent performance
 */
interface ToolMetric {
  calls: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  avgDurationMs: number;
  lastCalled: number;
}

export class PerformanceAnalytics {
  private metrics: Map<string, ToolMetric> = new Map();
  private sessionStart = Date.now();

  /** Record a tool execution */
  recordToolCall(toolName: string, durationMs: number, success: boolean) {
    const metric = this.metrics.get(toolName) || {
      calls: 0, successes: 0, failures: 0,
      totalDurationMs: 0, avgDurationMs: 0, lastCalled: 0
    };

    metric.calls++;
    if (success) metric.successes++;
    else metric.failures++;
    metric.totalDurationMs += durationMs;
    metric.avgDurationMs = metric.totalDurationMs / metric.calls;
    metric.lastCalled = Date.now();

    this.metrics.set(toolName, metric);
  }

  /** Get performance summary */
  getSummary(): {
    sessionDurationMs: number;
    totalToolCalls: number;
    topTools: Array<{ tool: string, calls: number, avgMs: number, successRate: string }>;
    overallSuccessRate: string;
  } {
    let totalCalls = 0;
    let totalSuccess = 0;

    const toolStats: Array<{ tool: string, calls: number, avgMs: number, successRate: string }> = [];

    for (const [tool, metric] of this.metrics) {
      totalCalls += metric.calls;
      totalSuccess += metric.successes;
      toolStats.push({
        tool,
        calls: metric.calls,
        avgMs: Math.round(metric.avgDurationMs),
        successRate: `${((metric.successes / metric.calls) * 100).toFixed(0)}%`
      });
    }

    toolStats.sort((a, b) => b.calls - a.calls);

    return {
      sessionDurationMs: Date.now() - this.sessionStart,
      totalToolCalls: totalCalls,
      topTools: toolStats.slice(0, 10),
      overallSuccessRate: totalCalls > 0 ? `${((totalSuccess / totalCalls) * 100).toFixed(0)}%` : 'N/A'
    };
  }

  /** Reset for new session */
  reset() {
    this.metrics.clear();
    this.sessionStart = Date.now();
  }

  /** 
   * AGI-LEVEL: Identify performance bottlenecks automatically.
   * Returns tools that are slowest, most error-prone, or most frequently called.
   */
  getBottlenecks(): { slowest: string[]; errorProne: string[]; hotspots: string[] } {
    const slowest: Array<{ tool: string; avgMs: number }> = [];
    const errorProne: Array<{ tool: string; failRate: number }> = [];
    const hotspots: Array<{ tool: string; calls: number }> = [];

    for (const [tool, metric] of this.metrics) {
      if (metric.calls >= 2) {
        slowest.push({ tool, avgMs: metric.avgDurationMs });
        const failRate = metric.failures / metric.calls;
        if (failRate > 0.3) errorProne.push({ tool, failRate });
        if (metric.calls >= 5) hotspots.push({ tool, calls: metric.calls });
      }
    }

    return {
      slowest: slowest.sort((a, b) => b.avgMs - a.avgMs).slice(0, 3).map(s => `${s.tool} (${Math.round(s.avgMs)}ms avg)`),
      errorProne: errorProne.sort((a, b) => b.failRate - a.failRate).slice(0, 3).map(e => `${e.tool} (${(e.failRate * 100).toFixed(0)}% fail rate)`),
      hotspots: hotspots.sort((a, b) => b.calls - a.calls).slice(0, 3).map(h => `${h.tool} (${h.calls} calls)`)
    };
  }

  /**
   * Generate optimization hints for system prompt injection.
   * Tells the agent which tools to avoid or use differently based on real performance data.
   */
  getOptimizationHints(): string {
    const bottlenecks = this.getBottlenecks();
    const hints: string[] = [];

    if (bottlenecks.slowest.length > 0) {
      hints.push(`Slowest tools: ${bottlenecks.slowest.join(', ')} — batch calls when possible`);
    }
    if (bottlenecks.errorProne.length > 0) {
      hints.push(`Unreliable tools: ${bottlenecks.errorProne.join(', ')} — use alternatives or add error handling`);
    }
    if (bottlenecks.hotspots.length > 0) {
      hints.push(`Most used tools: ${bottlenecks.hotspots.join(', ')} — consider caching results`);
    }

    return hints.length > 0 ? `━━━ PERFORMANCE INSIGHTS ━━━\n${hints.join('\n')}` : '';
  }
}

// ═══════════════════════════════════════════════════════════════
// GLOBAL INSTANCES
// ═══════════════════════════════════════════════════════════════

export const intelligentCache = new IntelligentCache();
export const smartQueryRouter = new SmartQueryRouter();
export const knowledgeEngine = new KnowledgeEngine();
export const multiStrategyRecovery = new MultiStrategyRecovery();
export const pipelineBuilder = new PipelineBuilder();
export const performanceAnalytics = new PerformanceAnalytics();

/** Initialize all next-gen systems (singleton — safe to call multiple times) */
let _nextGenInitialized = false;
let _nextGenInitPromise: Promise<void> | null = null;
export function initializeNextGenSystems(): Promise<void> {
  if (_nextGenInitialized) return Promise.resolve();
  if (_nextGenInitPromise) return _nextGenInitPromise;
  _nextGenInitPromise = (async () => {
    console.log('[NextGen] Initializing innovation layer...');
    await Promise.all([
      knowledgeEngine.load(),
      pipelineBuilder.initialize(),
    ]);
    _nextGenInitialized = true;
    console.log('[NextGen] ✅ All systems online');
  })();
  return _nextGenInitPromise;
}
