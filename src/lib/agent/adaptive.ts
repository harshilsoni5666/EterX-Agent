import path from 'path';
import fs from 'fs-extra';

/**
 * ═══════════════════════════════════════════════════════════════
 * ADAPTIVE INTELLIGENCE ENGINE — Self-Improving Agent Brain
 * ═══════════════════════════════════════════════════════════════
 * 
 * 1. Adaptive Learning — Learn from every interaction, adjust behavior
 * 2. Intent Classifier — Understand WHAT the user really wants
 * 3. Code Intelligence — Deep understanding of code structure
 * 4. Session Persistence — Resume complex tasks across sessions
 * 5. Output Optimizer — Format output perfectly for content type
 * 6. Conversation Compressor — Summarize long conversations intelligently
 */

const LEARNING_DIR = path.resolve(process.cwd(), '.workspaces', 'learning');

// ═══════════════════════════════════════════════════════════════
// 1. ADAPTIVE LEARNING ENGINE
// ═══════════════════════════════════════════════════════════════

/**
 * Learns from every interaction to improve future performance.
 * 
 * WHAT IT TRACKS:
 * - Tool success/failure patterns per task type
 * - User correction patterns (what the user fixes after agent output)
 * - Preferred response formats and detail levels
 * - Common task flows (which tools used in what order for what task)
 * - Error recovery strategies that worked
 * 
 * HOW IT IMPROVES:
 * - Adjusts tool selection confidence based on history
 * - Pre-suggests tools based on task similarity
 * - Avoids previously failed approaches
 * - Adapts response length/detail to user preferences
 */
interface LearningRecord {
  taskSignature: string;  // Normalized task description
  toolSequence: string[];  // Which tools were used in order
  success: boolean;
  duration: number;
  corrections: number;  // How many times user asked to redo/fix
  timestamp: number;
}

interface ToolSuccessRate {
  tool: string;
  taskType: string;
  successes: number;
  failures: number;
  avgDuration: number;
  lastUsed: number;
}

export class AdaptiveLearningEngine {
  private records: LearningRecord[] = [];
  private toolRates: Map<string, ToolSuccessRate> = new Map();
  private userPatterns: {
    avgResponseLength: number;
    prefersCodeBlocks: boolean;
    prefersTables: boolean;
    prefersBulletPoints: boolean;
    correctionRate: number;
    topTaskTypes: string[];
  } = {
    avgResponseLength: 500,
    prefersCodeBlocks: true,
    prefersTables: true,
    prefersBulletPoints: true,
    correctionRate: 0,
    topTaskTypes: []
  };
  private loaded = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _savePending = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      await fs.ensureDir(LEARNING_DIR);
      const filePath = path.join(LEARNING_DIR, 'adaptive_data.json');
      if (await fs.pathExists(filePath)) {
        const data = await fs.readJson(filePath);
        this.records = data.records || [];
        this.userPatterns = { ...this.userPatterns, ...data.userPatterns };
        if (data.toolRates) {
          for (const [key, val] of Object.entries(data.toolRates)) {
            this.toolRates.set(key, val as ToolSuccessRate);
          }
        }
      }
      this.loaded = true;
      if (this.records.length > 0) {
        console.log(`[AdaptiveLearning] Loaded ${this.records.length} learning records`);
      }
    } catch {
      this.loaded = true;
    }
  }

  async save(): Promise<void> {
    try {
      await fs.ensureDir(LEARNING_DIR);
      const data = {
        records: this.records.slice(-100),  // Keep last 100
        userPatterns: this.userPatterns,
        toolRates: Object.fromEntries(this.toolRates)
      };
      await fs.writeJson(path.join(LEARNING_DIR, 'adaptive_data.json'), data, { spaces: 2 });
    } catch { }
  }

  /** Debounced save — batches multiple records into one disk write */
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

  /** Classify the task type from a message */
  classifyTask(message: string): string {
    const m = message.toLowerCase();

    if (/\b(build|create|make|implement|code|develop|app|component|function|class)\b/.test(m)) return 'coding';
    if (/\b(search|find|research|what is|who is|latest|news|compare)\b/.test(m)) return 'research';
    if (/\b(write|report|document|essay|article|blog|paper)\b/.test(m)) return 'writing';
    if (/\b(fix|debug|error|bug|broken|wrong|issue|crash)\b/.test(m)) return 'debugging';
    if (/\b(analyze|data|csv|chart|graph|statistics|visuali)\b/.test(m)) return 'analysis';
    if (/\b(deploy|build|compile|test|run|install|setup)\b/.test(m)) return 'devops';
    if (/\b(design|ui|ux|layout|style|theme|css)\b/.test(m)) return 'design';
    if (/\b(explain|how|why|teach|learn|understand)\b/.test(m)) return 'education';
    if (/\b(automate|schedule|watch|monitor|cron|task)\b/.test(m)) return 'automation';
    if (/\b(email|message|send|notify|communicate)\b/.test(m)) return 'communication';

    return 'general';
  }

  /** Record a completed task for learning */
  async recordTask(
    message: string,
    toolSequence: string[],
    success: boolean,
    duration: number,
    corrections: number = 0
  ): Promise<void> {
    const taskType = this.classifyTask(message);
    const record: LearningRecord = {
      taskSignature: `${taskType}:${message.substring(0, 100).toLowerCase().trim()}`,
      toolSequence,
      success,
      duration,
      corrections,
      timestamp: Date.now()
    };

    this.records.push(record);

    // Update tool success rates
    for (const tool of toolSequence) {
      const key = `${tool}:${taskType}`;
      const rate = this.toolRates.get(key) || {
        tool, taskType, successes: 0, failures: 0, avgDuration: 0, lastUsed: 0
      };
      if (success) rate.successes++;
      else rate.failures++;
      rate.avgDuration = (rate.avgDuration * (rate.successes + rate.failures - 1) + duration) / (rate.successes + rate.failures);
      rate.lastUsed = Date.now();
      this.toolRates.set(key, rate);
    }

    // Update user patterns
    this.userPatterns.correctionRate = this.records.filter(r => r.corrections > 0).length / this.records.length;

    // Track top task types
    const typeCounts: Record<string, number> = {};
    this.records.forEach(r => {
      const type = r.taskSignature.split(':')[0];
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    });
    this.userPatterns.topTaskTypes = Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type]) => type);

    await this.debouncedSave();
  }

  /** Get recommended tools for a task type */
  getRecommendedTools(taskType: string): string[] {
    const relevant: Array<{ tool: string, score: number }> = [];

    for (const [key, rate] of this.toolRates) {
      if (key.endsWith(`:${taskType}`)) {
        const total = rate.successes + rate.failures;
        if (total > 0) {
          const successRate = rate.successes / total;
          relevant.push({ tool: rate.tool, score: successRate * total });
        }
      }
    }

    return relevant
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(r => r.tool);
  }

  /** Get learning context for system prompt injection */
  getLearningContext(message: string): string {
    if (this.records.length < 3) return '';

    const taskType = this.classifyTask(message);
    const recommended = this.getRecommendedTools(taskType);

    const parts: string[] = [];
    if (recommended.length > 0) {
      parts.push(`Recommended tools for ${taskType}: ${recommended.join(', ')}`);
    }
    if (this.userPatterns.topTaskTypes.length > 0) {
      parts.push(`User's frequent tasks: ${this.userPatterns.topTaskTypes.join(', ')}`);
    }
    if (this.userPatterns.correctionRate > 0.3) {
      parts.push('⚠️ High correction rate — be extra careful with output quality');
    }

    return parts.length > 0 ? `━━━ ADAPTIVE INTELLIGENCE ━━━\n${parts.join('\n')}` : '';
  }

  /**
   * Record execution telemetry from the orchestrator.
   * Used for smart model routing optimization — tracks which model
   * performs best for which complexity level and task type.
   */
  async recordExecution(data: {
    taskSignature: string;
    complexity: string;
    mode: string;
    duration: number;
    success: boolean;
    toolSequence?: string[];
  }): Promise<void> {
    await this.load();
    
    const taskType = this.classifyTask(data.taskSignature);
    
    const record: LearningRecord = {
      taskSignature: `${taskType}:${data.taskSignature.substring(0, 100).toLowerCase().trim()}`,
      toolSequence: data.toolSequence || [],
      success: data.success,
      duration: data.duration,
      corrections: 0,
      timestamp: Date.now(),
    };
    
    // Extend record with model routing data
    (record as any).complexity = data.complexity;
    (record as any).modelMode = data.mode;
    
    this.records.push(record);

    // Update tool rates if sequence is provided
    if (data.toolSequence) {
      for (const tool of data.toolSequence) {
        const key = `${tool}:${taskType}`;
        const rate = this.toolRates.get(key) || {
          tool, taskType, successes: 0, failures: 0, avgDuration: 0, lastUsed: 0
        };
        if (data.success) rate.successes++;
        else rate.failures++;
        rate.avgDuration = (rate.avgDuration * (rate.successes + rate.failures - 1) + data.duration) / (rate.successes + rate.failures);
        rate.lastUsed = Date.now();
        this.toolRates.set(key, rate);
      }
    }

    this.debouncedSave();
    console.log(`[AdaptiveLearning] 📊 Recorded: ${taskType} (${data.complexity}/${data.mode}) in ${data.duration}ms`);
  }

  /**
   * Analyze historical performance data to recommend optimal model mode
   * for a given task type and complexity combination.
   */
  getModelRecommendation(taskType: string, complexity: string): { mode: 'think' | 'fast'; confidence: number; reason: string } {
    const relevant = this.records.filter((r: any) =>
      r.taskSignature.startsWith(taskType) &&
      r.complexity === complexity &&
      r.success
    ) as any[];

    if (relevant.length < 3) {
      return { mode: 'think', confidence: 0.3, reason: 'Insufficient data — defaulting to think' };
    }

    const thinkRecords = relevant.filter((r: any) => r.modelMode === 'think');
    const fastRecords = relevant.filter((r: any) => r.modelMode === 'fast');

    const thinkAvgDuration = thinkRecords.length > 0
      ? thinkRecords.reduce((sum: number, r: any) => sum + r.duration, 0) / thinkRecords.length
      : Infinity;
    const fastAvgDuration = fastRecords.length > 0
      ? fastRecords.reduce((sum: number, r: any) => sum + r.duration, 0) / fastRecords.length
      : Infinity;

    // If fast mode is reliable AND significantly faster, recommend it
    if (fastRecords.length >= 2 && fastAvgDuration < thinkAvgDuration * 0.7) {
      return { mode: 'fast', confidence: 0.8, reason: `Fast mode ${((1 - fastAvgDuration / thinkAvgDuration) * 100).toFixed(0)}% faster with reliable results` };
    }

    return { mode: 'think', confidence: 0.7, reason: 'Think mode provides more reliable results for this task type' };
  }
}

// ═══════════════════════════════════════════════════════════════
// 2. INTENT CLASSIFIER — Deep Understanding
// ═══════════════════════════════════════════════════════════════

/**
 * Classifies user intent at a deeper level than task type.
 * Understands urgency, scope, and implicit requirements.
 */
export interface IntentAnalysis {
  primaryIntent: string;
  secondaryIntents: string[];
  urgency: 'low' | 'normal' | 'high' | 'critical';
  scope: 'quick' | 'moderate' | 'large' | 'project';
  impliedRequirements: string[];
  confidence: number;
}

export class IntentClassifier {
  classify(message: string): IntentAnalysis {
    const m = message.toLowerCase().trim();
    const words = m.split(/\s+/);

    // Primary intent detection
    let primaryIntent = 'execute';
    const secondaryIntents: string[] = [];
    const impliedRequirements: string[] = [];

    // Urgency detection
    let urgency: IntentAnalysis['urgency'] = 'normal';
    if (/\b(asap|urgent|quickly|fast|hurry|immediately|right now|critical)\b/.test(m)) urgency = 'critical';
    else if (/\b(soon|today|please|need)\b/.test(m)) urgency = 'high';

    // Scope detection
    let scope: IntentAnalysis['scope'] = 'moderate';
    if (words.length < 10) scope = 'quick';
    else if (words.length > 50 || /\b(full|complete|entire|whole|app|project|system)\b/.test(m)) scope = 'large';
    else if (/\b(project|application|platform|system|redesign|refactor|migrate)\b/.test(m)) scope = 'project';

    // Intent classification
    if (/\b(fix|debug|error|bug|broken|wrong|issue|crash|not work)\b/.test(m)) {
      primaryIntent = 'debug_fix';
      impliedRequirements.push('identify root cause', 'apply fix', 'verify fix works');
    } else if (/\b(build|create|make|implement|code|develop)\b/.test(m)) {
      primaryIntent = 'create_build';
      impliedRequirements.push('write complete code', 'no placeholders', 'verify it compiles');
      if (/\b(app|application|website|dashboard)\b/.test(m)) {
        secondaryIntents.push('full_project');
        impliedRequirements.push('multiple files', 'proper structure', 'styling');
      }
    } else if (/\b(search|find|research|what|who|when|where|how|why)\b/.test(m)) {
      primaryIntent = 'research_answer';
      impliedRequirements.push('provide sources', 'be specific with facts');
    } else if (/\b(compare|vs|versus|difference|better)\b/.test(m)) {
      primaryIntent = 'compare_analyze';
      impliedRequirements.push('structured comparison', 'table format', 'clear conclusion');
      secondaryIntents.push('data_visualization');
    } else if (/\b(write|report|document|essay|article|blog)\b/.test(m)) {
      primaryIntent = 'write_document';
      impliedRequirements.push('proper formatting', 'sections', 'complete content');
    } else if (/\b(explain|teach|learn|understand|how does)\b/.test(m)) {
      primaryIntent = 'educate_explain';
      impliedRequirements.push('clear explanations', 'examples', 'structured');
    } else if (/\b(optimize|improve|better|faster|enhance|refactor)\b/.test(m)) {
      primaryIntent = 'optimize_improve';
      impliedRequirements.push('measure before/after', 'explain changes');
    }

    // Detect implied secondary intents
    if (/\b(chart|graph|visuali|plot|diagram)\b/.test(m)) secondaryIntents.push('data_visualization');
    if (/\b(test|verify|check|validate)\b/.test(m)) secondaryIntents.push('verification');
    if (/\b(deploy|publish|release|ship)\b/.test(m)) secondaryIntents.push('deployment');
    if (/\b(save|store|persist|database)\b/.test(m)) secondaryIntents.push('data_persistence');

    return {
      primaryIntent,
      secondaryIntents,
      urgency,
      scope,
      impliedRequirements,
      confidence: impliedRequirements.length > 0 ? 0.8 : 0.5
    };
  }

  /** Generate an intent hint for the system prompt */
  getIntentHint(analysis: IntentAnalysis): string {
    if (analysis.confidence < 0.6) return '';

    const parts = [
      `Intent: ${analysis.primaryIntent}`,
      `Scope: ${analysis.scope}`,
      analysis.urgency !== 'normal' ? `Urgency: ${analysis.urgency}` : '',
      analysis.impliedRequirements.length > 0 ? `Requirements: ${analysis.impliedRequirements.join(', ')}` : '',
      analysis.secondaryIntents.length > 0 ? `Also: ${analysis.secondaryIntents.join(', ')}` : ''
    ].filter(Boolean);

    return `[INTENT: ${parts.join(' | ')}]`;
  }
}

// ═══════════════════════════════════════════════════════════════
// 3. CODE INTELLIGENCE ENGINE
// ═══════════════════════════════════════════════════════════════

/**
 * Deep understanding of code structure.
 * Analyzes imports, exports, dependencies, function signatures.
 * Provides context about code relationships.
 */
export class CodeIntelligence {
  /** Analyze a TypeScript/JavaScript file and extract structure */
  async analyzeFile(filePath: string): Promise<{
    imports: string[];
    exports: string[];
    functions: string[];
    classes: string[];
    interfaces: string[];
    dependencies: string[];
    lineCount: number;
    complexity: 'simple' | 'moderate' | 'complex';
  }> {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    const imports: string[] = [];
    const exports: string[] = [];
    const functions: string[] = [];
    const classes: string[] = [];
    const interfaces: string[] = [];
    const dependencies: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Imports
      const importMatch = trimmed.match(/^import\s+.*from\s+['"](.+)['"]/);
      if (importMatch) {
        imports.push(importMatch[1]);
        if (!importMatch[1].startsWith('.') && !importMatch[1].startsWith('/')) {
          dependencies.push(importMatch[1].split('/')[0]);
        }
      }

      // Exports
      if (trimmed.startsWith('export ')) {
        const exportMatch = trimmed.match(/export\s+(const|function|class|interface|type|enum|default)\s+(\w+)/);
        if (exportMatch) exports.push(exportMatch[2]);
      }

      // Functions
      const funcMatch = trimmed.match(/(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\()/);
      if (funcMatch) functions.push(funcMatch[1] || funcMatch[2]);

      // Classes
      const classMatch = trimmed.match(/class\s+(\w+)/);
      if (classMatch) classes.push(classMatch[1]);

      // Interfaces
      const ifaceMatch = trimmed.match(/interface\s+(\w+)/);
      if (ifaceMatch) interfaces.push(ifaceMatch[1]);
    }

    const complexity = lines.length < 50 ? 'simple' :
                       lines.length < 200 ? 'moderate' : 'complex';

    return {
      imports: [...new Set(imports)],
      exports: [...new Set(exports)],
      functions: [...new Set(functions)],
      classes: [...new Set(classes)],
      interfaces: [...new Set(interfaces)],
      dependencies: [...new Set(dependencies)],
      lineCount: lines.length,
      complexity
    };
  }

  /** Analyze all files in a directory to build a dependency graph */
  async analyzeDependencyGraph(dir: string): Promise<{
    files: number;
    internalDeps: Array<{ from: string, to: string }>;
    externalDeps: string[];
    entryPoints: string[];
  }> {
    const internalDeps: Array<{ from: string, to: string }> = [];
    const externalDeps = new Set<string>();
    const allFiles: string[] = [];
    const importedFiles = new Set<string>();

    async function walkDir(d: string, depth: number) {
      if (depth > 4) return;
      try {
        const entries = await fs.readdir(d, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
          const fullPath = path.join(d, entry.name);
          if (entry.isDirectory()) {
            await walkDir(fullPath, depth + 1);
          } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
            allFiles.push(fullPath);
          }
        }
      } catch { }
    }

    await walkDir(dir, 0);

    for (const file of allFiles.slice(0, 50)) {  // Cap at 50 files
      try {
        const content = await fs.readFile(file, 'utf-8');
        const importRegex = /import\s+.*from\s+['"](.+)['"]/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
          const importPath = match[1];
          if (importPath.startsWith('.')) {
            const resolved = path.resolve(path.dirname(file), importPath);
            internalDeps.push({
              from: path.relative(dir, file),
              to: path.relative(dir, resolved)
            });
            importedFiles.add(path.relative(dir, resolved));
          } else {
            externalDeps.add(importPath.split('/')[0]);
          }
        }
      } catch { }
    }

    // Entry points are files that are never imported
    const entryPoints = allFiles
      .map(f => path.relative(dir, f))
      .filter(f => !importedFiles.has(f.replace(/\.(ts|tsx|js|jsx)$/, '')))
      .slice(0, 10);

    return {
      files: allFiles.length,
      internalDeps: internalDeps.slice(0, 100),
      externalDeps: Array.from(externalDeps),
      entryPoints
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// 4. SESSION PERSISTENCE ENGINE
// ═══════════════════════════════════════════════════════════════

/**
 * Save and resume complex multi-session tasks.
 * When a task is too big for one session, save progress and resume later.
 */
interface SessionState {
  id: string;
  taskDescription: string;
  status: 'in_progress' | 'paused' | 'completed';
  completedSteps: string[];
  pendingSteps: string[];
  filesCreated: string[];
  filesModified: string[];
  context: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

export class SessionPersistence {
  private sessions: Map<string, SessionState> = new Map();

  async load(): Promise<void> {
    try {
      const sessDir = path.join(LEARNING_DIR, 'sessions');
      await fs.ensureDir(sessDir);
      const files = await fs.readdir(sessDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const session = await fs.readJson(path.join(sessDir, file));
          this.sessions.set(session.id, session);
        }
      }
    } catch { }
  }

  async saveSession(session: SessionState): Promise<void> {
    this.sessions.set(session.id, session);
    try {
      const sessDir = path.join(LEARNING_DIR, 'sessions');
      await fs.ensureDir(sessDir);
      await fs.writeJson(path.join(sessDir, `${session.id}.json`), session, { spaces: 2 });
    } catch { }
  }

  createSession(taskDescription: string, steps: string[]): SessionState {
    const session: SessionState = {
      id: `sess_${Date.now()}`,
      taskDescription,
      status: 'in_progress',
      completedSteps: [],
      pendingSteps: steps,
      filesCreated: [],
      filesModified: [],
      context: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.sessions.set(session.id, session);
    return session;
  }

  markStepComplete(sessionId: string, step: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.completedSteps.push(step);
      session.pendingSteps = session.pendingSteps.filter(s => s !== step);
      session.updatedAt = Date.now();
      if (session.pendingSteps.length === 0) session.status = 'completed';
    }
  }

  getActiveSessions(): SessionState[] {
    return Array.from(this.sessions.values()).filter(s => s.status === 'in_progress');
  }

  /** Get resumption context for system prompt */
  getResumptionContext(): string {
    const active = this.getActiveSessions();
    if (active.length === 0) return '';

    const items = active.map(s =>
      `📋 [${s.id}] "${s.taskDescription.substring(0, 50)}" — ${s.completedSteps.length}/${s.completedSteps.length + s.pendingSteps.length} steps done`
    );
    return `━━━ ACTIVE SESSIONS (Resume?) ━━━\n${items.join('\n')}`;
  }
}

// ═══════════════════════════════════════════════════════════════
// 5. CONVERSATION COMPRESSOR
// ═══════════════════════════════════════════════════════════════

/**
 * Intelligently compresses long conversation histories.
 * Keeps recent messages intact, summarizes older ones.
 * 
 * STRATEGY:
 * - Last 6 messages: keep intact (recent context)
 * - Older messages: compress tool outputs to summary
 * - Very old: compress to single line summaries
 * - System messages: always keep
 */
export class ConversationCompressor {
  /** Compress a conversation to fit within token limits */
  static compress(contents: any[], maxEntries: number = 30): any[] {
    if (contents.length <= maxEntries) return contents;

    const recent = contents.slice(-8);  // Keep last 8
    const old = contents.slice(0, -8);

    // Compress old messages
    const compressed = old.map(entry => {
      if (!entry.parts) return entry;

      const newParts = entry.parts.map((part: any) => {
        // Compress long tool responses
        if (part.functionResponse) {
          const output = part.functionResponse.response?.output;
          if (output && JSON.stringify(output).length > 500) {
            return {
              functionResponse: {
                name: part.functionResponse.name,
                response: {
                  output: {
                    _compressed: true,
                    summary: typeof output === 'string'
                      ? output.substring(0, 200) + '...[compressed]'
                      : `Result: ${output.success !== undefined ? (output.success ? 'SUCCESS' : 'FAILED') : 'OK'}${output.error ? ` Error: ${output.error.substring(0, 100)}` : ''}`
                  }
                },
                ...(part.functionResponse.id ? { id: part.functionResponse.id } : {})
              }
            };
          }
        }

        // Compress long text parts
        if (part.text && part.text.length > 800) {
          return { text: part.text.substring(0, 400) + '\n...[compressed]...\n' + part.text.slice(-200) };
        }

        return part;
      });

      return { ...entry, parts: newParts };
    });

    return [...compressed, ...recent];
  }

  /** Estimate token count for a conversation */
  static estimateTokens(contents: any[]): number {
    const json = JSON.stringify(contents);
    return Math.ceil(json.length / 4);  // ~4 chars per token
  }
}

// ═══════════════════════════════════════════════════════════════
// 6. OUTPUT OPTIMIZER
// ═══════════════════════════════════════════════════════════════

/**
 * Analyzes output content and suggests optimal formatting.
 * Ensures agent output matches content type expectations.
 */
export class OutputOptimizer {
  /** Analyze content and suggest format */
  static suggestFormat(content: string, taskType: string): {
    shouldHaveCode: boolean;
    shouldHaveTable: boolean;
    shouldHaveHeadings: boolean;
    shouldHaveList: boolean;
    suggestedStructure: string;
  } {
    const hasNumbers = /\d+/.test(content);
    const hasComparison = /\b(vs|versus|compare|better|worse)\b/i.test(content);
    const isLong = content.length > 1000;

    return {
      shouldHaveCode: ['coding', 'debugging', 'devops'].includes(taskType),
      shouldHaveTable: hasComparison || (hasNumbers && taskType === 'analysis'),
      shouldHaveHeadings: isLong || ['writing', 'research', 'education'].includes(taskType),
      shouldHaveList: taskType === 'research' || isLong,
      suggestedStructure: getSuggestedStructure(taskType)
    };
  }
}

function getSuggestedStructure(taskType: string): string {
  switch (taskType) {
    case 'coding': return '## Solution\n[code]\n## Explanation\n[text]';
    case 'research': return '## Findings\n[sections]\n## Sources\n[list]';
    case 'analysis': return '## Analysis\n[data]\n## Charts\n[visuals]\n## Insights\n[text]';
    case 'debugging': return '## Problem\n[description]\n## Root Cause\n[text]\n## Fix\n[code]';
    case 'writing': return '## [Title]\n[sections with content]';
    case 'education': return '## Concept\n[explanation]\n## Examples\n[code/data]\n## Practice\n[exercises]';
    default: return '';
  }
}

// ═══════════════════════════════════════════════════════════════
// 7. NEURAL PLASTICITY ENGINE (AGI Self-Evolution)
// ═══════════════════════════════════════════════════════════════

/**
 * Neural Plasticity Engine — Self-Evolving System Prompts
 * 
 * Instead of relying on a static, hardcoded system prompt, this engine
 * allows the agent to dynamically rewrite its own base rules based on
 * project-specific patterns. 
 * 
 * If it notices that a certain framework requires a specific build flag,
 * or that the user hates a certain coding style, it synthesizes a new
 * rule and permanently embeds it into the prompt structure for this project.
 */
export class NeuralPlasticityEngine {
  private rulesPath = path.resolve(process.cwd(), '.workspaces', '.memory', 'neural_rules.json');
  private evolvedRules: string[] = [];
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      await fs.ensureDir(path.dirname(this.rulesPath));
      if (await fs.pathExists(this.rulesPath)) {
        const data = await fs.readJson(this.rulesPath);
        this.evolvedRules = Array.isArray(data.rules) ? data.rules : [];
      }
      this.loaded = true;
    } catch {
      this.loaded = true;
    }
  }

  /**
   * Evaluates recent errors and successes to synthesize a new permanent rule.
   * Called by the Orchestrator after complex task completions.
   */
  async synthesizeNewRule(context: string, triggerEvent: string): Promise<void> {
    // In a full implementation, this would use the LLM to generate the rule.
    // For now, we apply heuristic pattern matching to common AGI failure vectors.
    const lowerEvent = triggerEvent.toLowerCase();
    
    let newRule = '';
    if (lowerEvent.includes('timeout') || lowerEvent.includes('hang')) {
      newRule = `Never run blocking commands (like dev servers) without sending them to the background.`;
    } else if (lowerEvent.includes('lint') || lowerEvent.includes('type error')) {
      newRule = `Always run the typescript compiler (tsc) or linter after creating multiple files to verify type safety before completing the task.`;
    } else if (lowerEvent.includes('import') || lowerEvent.includes('module not found')) {
      newRule = `Always verify that required packages are listed in package.json before attempting to import them.`;
    } else if (lowerEvent.includes('too many files') || lowerEvent.includes('rate limit')) {
      newRule = `When modifying multiple files, use batch tools or combine logic where possible to avoid rate limiting.`;
    }

    if (newRule && !this.evolvedRules.includes(newRule)) {
      console.log(`[NeuralPlasticity] 🧠 Synthesized new self-preservation rule: "${newRule}"`);
      this.evolvedRules.push(newRule);
      
      // Keep only the 10 most relevant/recent rules to prevent prompt bloat
      if (this.evolvedRules.length > 10) {
        this.evolvedRules.shift();
      }
      
      try {
        await fs.writeJson(this.rulesPath, { rules: this.evolvedRules }, { spaces: 2 });
      } catch { /* silent */ }
    }
  }

  /**
   * Get the dynamically evolved prompt string to inject into the system.
   */
  getEvolvedPrompt(): string {
    if (this.evolvedRules.length === 0) return '';
    
    return `
━━━ 🧠 EVOLVED NEURAL RULES (CRITICAL) ━━━
Through past interactions in this specific project, you have learned the following strict rules. You MUST obey them:
${this.evolvedRules.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
  }
}

// ═══════════════════════════════════════════════════════════════
// GLOBAL INSTANCES
// ═══════════════════════════════════════════════════════════════

export const adaptiveLearning = new AdaptiveLearningEngine();
export const intentClassifier = new IntentClassifier();
export const codeIntelligence = new CodeIntelligence();
export const sessionPersistence = new SessionPersistence();
export const conversationCompressor = ConversationCompressor;
export const outputOptimizer = OutputOptimizer;
export const neuralPlasticity = new NeuralPlasticityEngine();

/** Initialize all adaptive intelligence systems (singleton — safe to call multiple times) */
let _adaptiveInitialized = false;
let _adaptiveInitPromise: Promise<void> | null = null;
export function initializeAdaptiveIntelligence(): Promise<void> {
  if (_adaptiveInitialized) return Promise.resolve();
  if (_adaptiveInitPromise) return _adaptiveInitPromise;
  _adaptiveInitPromise = (async () => {
    console.log('[AdaptiveIntel] Initializing self-improving intelligence layer...');
    await Promise.all([
      adaptiveLearning.load(),
      sessionPersistence.load(),
      neuralPlasticity.load(),
    ]);
    _adaptiveInitialized = true;
    console.log('[AdaptiveIntel] ✅ All systems ready');
  })();
  return _adaptiveInitPromise;
}
