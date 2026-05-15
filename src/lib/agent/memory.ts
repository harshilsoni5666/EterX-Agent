import path from 'path';
import fs from 'fs-extra';

/**
 * Agent Memory System — Persistent Learning Engine
 * 
 * Stores and retrieves agent knowledge across sessions:
 * - User preferences (learned from interactions)
 * - Error patterns (what failed and how it was fixed)
 * - Project knowledge (file structures, tech stacks detected)
 * - Conversation summaries (compressed key insights)
 * 
 * STORAGE: .workspaces/memory/
 * - preferences.json: User preferences and patterns
 * - errors.json: Error patterns and solutions
 * - projects.json: Project-specific knowledge
 * - sessions.json: Session summaries
 */

const MEMORY_DIR = path.resolve(process.cwd(), '.workspaces', 'memory');

interface MemoryStore {
  preferences: Record<string, any>;
  errorPatterns: Array<{ tool: string, error: string, solution: string, timestamp: number }>;
  projectKnowledge: Record<string, any>;
  sessionSummaries: Array<{ timestamp: number, summary: string }>;
}

class AgentMemory {
  private store: MemoryStore = {
    preferences: {},
    errorPatterns: [],
    projectKnowledge: {},
    sessionSummaries: []
  };
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savePending = false;

  /** Initialize and load from disk */
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      await fs.ensureDir(MEMORY_DIR);

      const prefsPath = path.join(MEMORY_DIR, 'preferences.json');
      const errorsPath = path.join(MEMORY_DIR, 'errors.json');
      const projectsPath = path.join(MEMORY_DIR, 'projects.json');
      const sessionsPath = path.join(MEMORY_DIR, 'sessions.json');

      // All 4 reads in parallel
      const [p, e, pr, s] = await Promise.allSettled([
        fs.pathExists(prefsPath).then(x => x ? fs.readJson(prefsPath) : null),
        fs.pathExists(errorsPath).then(x => x ? fs.readJson(errorsPath) : null),
        fs.pathExists(projectsPath).then(x => x ? fs.readJson(projectsPath) : null),
        fs.pathExists(sessionsPath).then(x => x ? fs.readJson(sessionsPath) : null),
      ]);

      if (p.status === 'fulfilled' && p.value) this.store.preferences = p.value;
      if (e.status === 'fulfilled' && e.value) this.store.errorPatterns = e.value;
      if (pr.status === 'fulfilled' && pr.value) this.store.projectKnowledge = pr.value;
      if (s.status === 'fulfilled' && s.value) this.store.sessionSummaries = s.value;

      this.loaded = true;
      console.log(`[AgentMemory] Loaded: ${Object.keys(this.store.preferences).length} prefs, ${this.store.errorPatterns.length} error patterns, ${this.store.sessionSummaries.length} sessions`);
    } catch (e) {
      console.warn(`[AgentMemory] Could not load memory, starting fresh.`);
      this.loaded = true;
    }
  }

  /** Save current state to disk — DEBOUNCED to avoid excessive I/O */
  async save(): Promise<void> {
    try {
      await fs.ensureDir(MEMORY_DIR);
      await Promise.all([
        fs.writeJson(path.join(MEMORY_DIR, 'preferences.json'), this.store.preferences, { spaces: 2 }),
        fs.writeJson(path.join(MEMORY_DIR, 'errors.json'), this.store.errorPatterns.slice(-50), { spaces: 2 }),
        fs.writeJson(path.join(MEMORY_DIR, 'projects.json'), this.store.projectKnowledge, { spaces: 2 }),
        fs.writeJson(path.join(MEMORY_DIR, 'sessions.json'), this.store.sessionSummaries.slice(-20), { spaces: 2 }),
      ]);
    } catch (e) {
      console.warn(`[AgentMemory] Could not save memory.`);
    }
  }

  /** Debounced save — batches multiple mutations into one disk write */
  private debouncedSave(): void {
    this.savePending = true;
    if (this.saveTimer) return; // Already scheduled
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.savePending) {
        this.savePending = false;
        this.save().catch(() => {});
      }
    }, 3000); // Write at most every 3 seconds
  }

  // ── Preferences ──
  setPreference(key: string, value: any) {
    this.store.preferences[key] = value;
    this.debouncedSave();
  }

  getPreference(key: string): any {
    return this.store.preferences[key];
  }

  getAllPreferences(): Record<string, any> {
    return { ...this.store.preferences };
  }

  // ── Error Patterns ──
  recordError(tool: string, error: string, solution: string) {
    this.store.errorPatterns.push({
      tool, error: error.substring(0, 200), solution: solution.substring(0, 200),
      timestamp: Date.now()
    });
    this.debouncedSave();
  }

  findSimilarErrors(tool: string): Array<{ error: string, solution: string }> {
    return this.store.errorPatterns
      .filter(e => e.tool === tool)
      .slice(-5)  // Last 5 errors for this tool
      .map(e => ({ error: e.error, solution: e.solution }));
  }

  /**
   * PREDICTIVE ERROR AVOIDANCE — AGI-level anticipation
   * 
   * Before executing a tool, check if similar calls failed before.
   * Returns preventive hints that can be injected into the tool's context
   * so the agent avoids repeating the same mistakes.
   */
  getPredictiveHints(toolName: string, args: Record<string, any>): string | null {
    const relatedErrors = this.store.errorPatterns
      .filter(e => e.tool === toolName)
      .slice(-10);
    
    if (relatedErrors.length === 0) return null;
    
    // Check for pattern matches in args
    const argsStr = JSON.stringify(args).toLowerCase();
    const matchingErrors = relatedErrors.filter(e => {
      // Check if any keywords from the error match the current args
      const errorWords = e.error.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      return errorWords.some(w => argsStr.includes(w));
    });
    
    if (matchingErrors.length === 0) return null;
    
    const hints = matchingErrors.slice(-3).map(e => 
      `• Previous failure: "${e.error.substring(0, 80)}" → Fix: "${e.solution.substring(0, 80)}"`
    );
    
    return `⚠️ PREDICTIVE ALERT for ${toolName}:\n${hints.join('\n')}\nApply these fixes preemptively.`;
  }

  /**
   * ASSOCIATIVE MEMORY RECALL — Fuzzy cross-domain knowledge retrieval
   * 
   * Searches across ALL memory stores (preferences, errors, projects, sessions)
   * for anything related to the current query using keyword overlap.
   * This enables the agent to say "I remember working on something similar..."
   */
  associativeRecall(query: string, maxResults: number = 5): string[] {
    const queryWords = new Set(
      query.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    );
    if (queryWords.size === 0) return [];
    
    const candidates: Array<{ text: string; relevance: number }> = [];
    
    // Search session summaries
    for (const session of this.store.sessionSummaries) {
      const sessionWords = session.summary.toLowerCase().split(/\s+/);
      let overlap = 0;
      for (const w of queryWords) {
        if (sessionWords.some(sw => sw.includes(w))) overlap++;
      }
      if (overlap >= 2) {
        candidates.push({ 
          text: `[Past Session] ${session.summary.substring(0, 150)}`,
          relevance: overlap / queryWords.size 
        });
      }
    }
    
    // Search error patterns for relevant solutions
    for (const err of this.store.errorPatterns) {
      const errText = `${err.tool} ${err.error} ${err.solution}`.toLowerCase();
      let overlap = 0;
      for (const w of queryWords) {
        if (errText.includes(w)) overlap++;
      }
      if (overlap >= 2) {
        candidates.push({
          text: `[Known Issue] ${err.tool}: ${err.solution.substring(0, 100)}`,
          relevance: overlap / queryWords.size
        });
      }
    }
    
    // Search project knowledge
    for (const [key, value] of Object.entries(this.store.projectKnowledge)) {
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
      const combined = `${key} ${valueStr}`.toLowerCase();
      let overlap = 0;
      for (const w of queryWords) {
        if (combined.includes(w)) overlap++;
      }
      if (overlap >= 2) {
        candidates.push({
          text: `[Project Knowledge] ${key}: ${valueStr.substring(0, 100)}`,
          relevance: overlap / queryWords.size
        });
      }
    }
    
    return candidates
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, maxResults)
      .map(c => c.text);
  }

  // ── Project Knowledge ──
  setProjectKnowledge(key: string, value: any) {
    this.store.projectKnowledge[key] = value;
    this.debouncedSave();
  }

  getProjectKnowledge(key: string): any {
    return this.store.projectKnowledge[key];
  }

  // ── Session Summaries ──
  addSessionSummary(summary: string) {
    this.store.sessionSummaries.push({ timestamp: Date.now(), summary });
    this.debouncedSave();
  }

  getRecentSessions(count: number = 5): string[] {
    return this.store.sessionSummaries
      .slice(-count)
      .map(s => `[${new Date(s.timestamp).toLocaleDateString()}] ${s.summary}`);
  }

  /**
   * Generate a memory context string for injection into system prompt.
   * Returns relevant preferences and patterns the agent should know about.
   */
  getMemoryContext(currentQuery?: string, options: { includeRecentSessions?: boolean } = {}): string {
    const parts: string[] = [];

    const prefs = this.getAllPreferences();
    if (Object.keys(prefs).length > 0) {
      // Filter out internal-only prefs, show user-facing ones
      const userPrefs = Object.entries(prefs)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .slice(0, 10);
      if (userPrefs.length > 0) {
        parts.push(`User Preferences: ${userPrefs.join(', ')}`);
      }
    }

    const sessions = options.includeRecentSessions ? this.getRecentSessions(3) : [];
    if (sessions.length > 0) {
      parts.push(`Recent Sessions:\n${sessions.join('\n')}`);
    }

    // ASSOCIATIVE RECALL: Find relevant memories for current query
    if (currentQuery) {
      const memories = this.associativeRecall(currentQuery, 3);
      if (memories.length > 0) {
        parts.push(`Relevant Memories:\n${memories.map(m => `  ${m}`).join('\n')}`);
      }
    }

    // Error avoidance hints for commonly used tools
    const errorSummary = this.store.errorPatterns
      .slice(-10)
      .reduce((acc: Record<string, number>, e) => {
        acc[e.tool] = (acc[e.tool] || 0) + 1;
        return acc;
      }, {});
    const problematicTools = Object.entries(errorSummary)
      .filter(([_, count]) => count >= 3)
      .map(([tool, count]) => `${tool} (${count} recent errors)`);
    if (problematicTools.length > 0) {
      parts.push(`⚠️ High-error tools: ${problematicTools.join(', ')} — use with caution`);
    }

    return parts.length > 0 ? `━━━ AGENT MEMORY ━━━\n${parts.join('\n')}\n━━━ END MEMORY ━━━` : '';
  }
}

/**
 * Context Window Manager — Smart Conversation Trimming
 * 
 * Manages the conversation history to prevent context window overflow.
 * Strategies:
 * - Summarize old tool results (replace with brief summaries)
 * - Drop old thinking/thought parts
 * - Keep recent tool calls intact
 * - Never drop the system instruction or latest user message
 */
export class ContextWindowManager {
  // Rough token estimation: ~4 chars per token
  private static estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** Tools whose results should NEVER be summarized — their content is critical */
  private static PROTECTED_TOOLS = new Set([
    'get_skill_guidelines',   // Skill content — agent NEEDS this for the entire task
    'task_decomposer',        // Task plan — agent references this throughout
    'ask_user',               // User answers — always important
  ]);

  /** Tools whose results can be aggressively summarized — they're verbose */
  private static VERBOSE_TOOLS = new Set([
    'web_search',
    'workspace_list_directory',
    'workspace_search_text',
    'system_shell',           // Shell output can be huge
    'web_scraper',
    'pdf_parser',
    'youtube_transcript',
    'browser_control',
  ]);

  /**
   * Trim conversation contents to fit within a safe context window.
   * 
   * IMPROVED v2:
   * - Skill guidelines are NEVER summarized (fixes lost skill connection)
   * - Larger tail (18 entries) for better long-task continuity
   * - Smarter summarization that preserves key tool results
   * - Protected tools list prevents critical context from being lost
   * 
   * @param contents The full conversation history
   * @param maxTokens Target maximum tokens (default: 800K, safe for Gemini)
   * @returns Trimmed contents
   */
  static trimContents(contents: any[], maxTokens: number = 800000): any[] {
    const estimatedTokens = this.estimateTokens(JSON.stringify(contents));

    if (estimatedTokens < maxTokens * 0.8) {
      return contents; // Under 80% — no trimming needed
    }

    console.log(`[ContextManager] ⚠️ Context is ${(estimatedTokens / 1000).toFixed(0)}K tokens. Trimming...`);

    // IMPROVED: Larger tail for long tasks, protects more recent context
    const keepHead = 2;
    const keepTail = 18; // Was 10 — doubled for better long-task continuity

    if (contents.length <= keepHead + keepTail) {
      return contents;
    }

    const trimmed: any[] = [
      ...contents.slice(0, keepHead),
      {
        role: 'user',
        parts: [{ text: '[SYSTEM] Earlier conversation was summarized to manage context. Recent context is intact. If you loaded any skills via get_skill_guidelines, their content is preserved below.' }]
      },
    ];

    // Middle section: smart summarization
    const middle = contents.slice(keepHead, contents.length - keepTail);
    for (const entry of middle) {
      if (entry.role === 'user' && entry.parts) {
        const textContent = entry.parts.map((p: any) => p.text || '').join('');
        
        // Drop stale system injections
        if (textContent.startsWith('[SYSTEM]') || 
            textContent.includes('STOP THINKING and use your tools') ||
            textContent.includes('Continue to the next pending step')) {
          continue;
        }

        // Handle function responses (tool results)
        const hasFunctionResponse = entry.parts.some((p: any) => p.functionResponse);
        if (hasFunctionResponse) {
          const summarizedParts = entry.parts.map((p: any) => {
            if (p.functionResponse) {
              const toolName = p.functionResponse.name;
              const outputStr = JSON.stringify(p.functionResponse.response?.output || '');
              
              // NEVER summarize protected tools (skills, task plans, user answers)
              if (this.PROTECTED_TOOLS.has(toolName)) {
                return p; // Keep FULL content
              }
              
              // Aggressively summarize verbose tools
              if (this.VERBOSE_TOOLS.has(toolName) && outputStr.length > 800) {
                return {
                  functionResponse: {
                    name: toolName,
                    response: { output: { 
                      summary: `[${toolName}: ${(outputStr.length / 1024).toFixed(1)}KB output]`,
                      // Keep first 200 chars of result for key data
                      preview: outputStr.substring(0, 200)
                    }},
                    ...(p.functionResponse.id ? { id: p.functionResponse.id } : {})
                  }
                };
              }
              
              // Normal tools: summarize if > 1500 chars (was 500 — too aggressive)
              if (outputStr.length > 1500) {
                return {
                  functionResponse: {
                    name: toolName,
                    response: { output: { 
                      summary: `[${toolName}: ${(outputStr.length / 1024).toFixed(1)}KB]`,
                      preview: outputStr.substring(0, 400) 
                    }},
                    ...(p.functionResponse.id ? { id: p.functionResponse.id } : {})
                  }
                };
              }
            }
            return p;
          });
          trimmed.push({ ...entry, parts: summarizedParts });
        } else {
          // Keep short user messages, summarize long ones
          if (textContent.length > 1000) {
            trimmed.push({
              role: entry.role,
              parts: [{ text: textContent.substring(0, 300) + '... [truncated]' }]
            });
          } else {
            trimmed.push(entry);
          }
        }
      } else if (entry.role === 'model' && entry.parts) {
        // Drop thinking parts from old model responses, keep function calls and text
        const filteredParts = entry.parts.filter((p: any) => !p.thought);

        // Keep function calls intact (they're small and important for context)
        const compactParts = filteredParts.map((p: any) => {
          if (p.functionCall) return p; // Always keep function calls
          if (p.text && p.text.length > 800) {
            return { text: p.text.substring(0, 400) + '... [truncated]' };
          }
          return p;
        });
        
        if (compactParts.length > 0) {
          trimmed.push({ ...entry, parts: compactParts });
        }
      } else {
        trimmed.push(entry);
      }
    }

    // Append tail (recent turns) intact
    trimmed.push(...contents.slice(contents.length - keepTail));

    const newTokens = this.estimateTokens(JSON.stringify(trimmed));
    console.log(`[ContextManager] Trimmed: ${(estimatedTokens / 1000).toFixed(0)}K → ${(newTokens / 1000).toFixed(0)}K tokens (${trimmed.length} entries)`);

    return trimmed;
  }
}

export const agentMemory = new AgentMemory();
