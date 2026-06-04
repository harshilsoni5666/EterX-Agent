/**
 * ═══════════════════════════════════════════════════════════════
 * LAYERED PROMPT ARCHITECTURE — Composable, Cacheable Prompts
 * ═══════════════════════════════════════════════════════════════
 *
 * WHAT THIS DOES:
 * Replaces the monolithic 2000-line system prompt with a modular
 * layer system. Each layer is independently composable, cacheable,
 * and compressible.
 *
 * LAYER ARCHITECTURE:
 *   Layer 0: Core Identity     (50 tokens — NEVER changes)
 *   Layer 1: Capability Matrix (100 tokens — changes per model)
 *   Layer 2: Behavioral Rules  (200 tokens — cached per session)
 *   Layer 3: Task Context      (dynamic — only what's relevant NOW)
 *   Layer 4: Active Memory     (dynamic — semantic-relevant only)
 *   Layer 5: Execution State   (dynamic — current plan progress)
 *   Layer 6: Cognitive Engine   (dynamic — reasoning directives)
 *   Layer 7: Self-Rules        (dynamic — evolved plasticity rules)
 *   Layer 8: Real-time Steering (ephemeral — user mid-run feedback)
 *
 * KEY BENEFITS:
 * - 40-60% token savings on average (static layers cached)
 * - Each layer can be independently compressed when token budget tight
 * - Task-irrelevant layers are automatically excluded
 * - Layer priorities ensure critical context survives compression
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PromptLayer {
  id: string;
  name: string;
  priority: number;        // 0 = highest (never compress), 10 = lowest (compress first)
  content: string;
  tokenEstimate: number;
  cacheable: boolean;
  compressed: boolean;
  compressedContent?: string;
}

export interface LayerCompositionResult {
  fullPrompt: string;
  totalTokens: number;
  layerCount: number;
  compressedLayers: string[];
  excludedLayers: string[];
}

// ─── Layer Definitions ────────────────────────────────────────────────────────

export class PromptLayerArchitecture {
  private layers: Map<string, PromptLayer> = new Map();
  private tokenBudget: number = 8000; // System prompt token budget

  /**
   * Set the token budget for system prompt composition.
   */
  setTokenBudget(budget: number): void {
    this.tokenBudget = Math.max(2000, budget);
  }

  /**
   * Build Layer 0: Core Identity — The absolute minimum the agent needs.
   */
  buildCoreIdentity(userName?: string): PromptLayer {
    const content = [
      `You are EterX — an autonomous agent running locally on the user's Windows machine.`,
      `You have full filesystem, shell, network, browser, and desktop access.`,
      `You EXECUTE — you don't discuss, you deliver.`,
      userName && userName !== 'Developer' && userName !== 'User'
        ? `The user is "${userName}". Always address them by this name.`
        : '',
    ].filter(Boolean).join('\n');

    return this.registerLayer({
      id: 'core_identity',
      name: 'Core Identity',
      priority: 0,
      content,
      tokenEstimate: Math.ceil(content.length / 4),
      cacheable: true,
      compressed: false,
    });
  }

  /**
   * Build Layer 1: Temporal Context — Time awareness.
   */
  buildTemporalContext(): PromptLayer {
    const now = new Date();
    const content = [
      `📅 ${now.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
      `🕐 ${now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}`,
      `Use the above for "today", "now", or time-sensitive queries. Never use training data dates.`,
    ].join(' · ');

    return this.registerLayer({
      id: 'temporal_context',
      name: 'Temporal Context',
      priority: 1,
      content,
      tokenEstimate: Math.ceil(content.length / 4),
      cacheable: false,
      compressed: false,
    });
  }

  /**
   * Build Layer 2: Behavioral Rules — Core execution protocol.
   * Compressed version of the original 500-line behavioral section.
   */
  buildBehavioralRules(): PromptLayer {
    const content = [
      '━━━ EXECUTION PROTOCOL ━━━',
      'JUST DO IT — Execute, don\'t plan or ask permission.',
      'CHAIN FAST — research → write → verify → next file.',
      'COMPLETE FILES — No placeholders, no TODOs, no stubs.',
      'FIX AND CONTINUE — If something breaks, fix it and keep going.',
      'VERIFY BEFORE CLAIMING — A task is done when tools PROVE it works.',
      'NEVER RESTART — Use persistent memory. Move forward, not backward.',
      '',
      'DECIDE YOURSELF: technical choices, file paths, tool order, code style.',
      'ASK USER ONLY: secrets/credentials, destructive actions, fundamentally ambiguous tasks.',
      'NEVER ask "should I proceed?" or "would you like me to continue?" — JUST DO IT.',
      '',
      'CONFIDENCE CALIBRATION:',
      '- Before factual answers: "Am I 90%+ confident from verified sources?" If not → verify.',
      '- Before claiming success: "Did a tool confirm this worked?" If not → verify.',
      '- Before presenting data: "Did I compute this from real inputs?" If not → don\'t present.',
      '',
      'SELF-CORRECTION LOOP:',
      '- After each action: "Did this advance the task? Did anything break?"',
      '- If a tool fails: diagnose WHY before retrying. Never retry same args blindly.',
      '- If stuck for 3+ iterations: stop, summarize, present the blocker.',
      '',
      'ANTI-REPETITION: Never call same tool with same args twice. Check history first.',
      '━━━ END PROTOCOL ━━━',
    ].join('\n');

    return this.registerLayer({
      id: 'behavioral_rules',
      name: 'Behavioral Rules',
      priority: 2,
      content,
      tokenEstimate: Math.ceil(content.length / 4),
      cacheable: true,
      compressed: false,
    });
  }

  /**
   * Build Layer 3: Tool Mastery — Available tools and usage patterns.
   */
  buildToolMastery(toolNames: string[], toolCount: number): PromptLayer {
    const content = [
      `━━━ TOOLS (${toolCount}) ━━━`,
      'TERMINAL: workspace_run_command (project), system_shell (OS), process_manager (long-running).',
      'TERMINAL HANDOFF: if a command returns stillRunning/backgroundTaskId, do not rerun it; use wait_timer, then background_task mode="check" with that taskId until final output arrives.',
      'FILES: workspace_read_file, workspace_write_file, workspace_edit_file, smart_refactor.',
      'VERIFY: workspace_verify_code (lint/build/test), realtime_verify (file/syntax/json).',
      'RESEARCH: web_search (discovery), deep_research (multi-angle).',
      'CREATE: chart_generator, image_generator, docx_generator, project_scaffolder.',
      'BROWSER: browser_control (one call at a time, snapshot for refs).',
      `ALL: ${toolNames.join(', ')}`,
      '━━━ END TOOLS ━━━',
    ].join('\n');

    return this.registerLayer({
      id: 'tool_mastery',
      name: 'Tool Mastery',
      priority: 3,
      content,
      tokenEstimate: Math.ceil(content.length / 4),
      cacheable: true,
      compressed: false,
    });
  }

  /**
   * Build Layer 4: Task Context — Dynamic context for the current task.
   */
  buildTaskContext(parts: string[]): PromptLayer {
    const content = parts.filter(Boolean).join('\n\n');
    return this.registerLayer({
      id: 'task_context',
      name: 'Task Context',
      priority: 4,
      content,
      tokenEstimate: Math.ceil(content.length / 4),
      cacheable: false,
      compressed: false,
    });
  }

  /**
   * Build Layer 5: Active Memory — Relevant memories for current context.
   */
  buildActiveMemory(memoryContext: string): PromptLayer {
    return this.registerLayer({
      id: 'active_memory',
      name: 'Active Memory',
      priority: 5,
      content: memoryContext,
      tokenEstimate: Math.ceil(memoryContext.length / 4),
      cacheable: false,
      compressed: false,
    });
  }

  /**
   * Build Layer 6: Cognitive Engine — Reasoning directives.
   */
  buildCognitiveLayer(cognitiveDirective: string): PromptLayer {
    return this.registerLayer({
      id: 'cognitive_engine',
      name: 'Cognitive Engine',
      priority: 4,
      content: cognitiveDirective,
      tokenEstimate: Math.ceil(cognitiveDirective.length / 4),
      cacheable: false,
      compressed: false,
    });
  }

  /**
   * Build Layer 7: Filesystem context.
   */
  buildFilesystemContext(): PromptLayer {
    const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\User';
    const content = [
      `Home: ${home}`,
      `Save to project directories, never Desktop. Use .workspaces/sandbox/ for temp work.`,
      `Use absolute paths. Protected: cannot modify AgentX source (src/, electron/, public/).`,
    ].join('\n');

    return this.registerLayer({
      id: 'filesystem',
      name: 'Filesystem',
      priority: 6,
      content,
      tokenEstimate: Math.ceil(content.length / 4),
      cacheable: true,
      compressed: false,
    });
  }

  /**
   * Build Layer 8: Output Quality — Format and quality rules.
   */
  buildOutputQuality(): PromptLayer {
    const content = [
      '━━━ OUTPUT QUALITY ━━━',
      'Proper Markdown with blank lines around headings/lists.',
      'Code blocks with language tags. LaTeX for math.',
      'Mermaid for architecture/flow diagrams (flowchart TD for complex, LR for short).',
      'Concise. Sharp. Report what you DID, not what you could do.',
      'Work notes: 1-2 natural sentences. "I found X. Fixing Y." Never synthetic AI language.',
      '━━━ END OUTPUT ━━━',
    ].join('\n');

    return this.registerLayer({
      id: 'output_quality',
      name: 'Output Quality',
      priority: 7,
      content,
      tokenEstimate: Math.ceil(content.length / 4),
      cacheable: true,
      compressed: false,
    });
  }

  /**
   * Compose all registered layers into a single system prompt,
   * respecting the token budget and compressing as needed.
   */
  compose(): LayerCompositionResult {
    const sortedLayers = Array.from(this.layers.values())
      .sort((a, b) => a.priority - b.priority);

    let totalTokens = 0;
    const includedLayers: PromptLayer[] = [];
    const compressedLayers: string[] = [];
    const excludedLayers: string[] = [];

    for (const layer of sortedLayers) {
      if (!layer.content || layer.content.trim().length === 0) {
        excludedLayers.push(layer.id);
        continue;
      }

      const remainingBudget = this.tokenBudget - totalTokens;

      if (layer.tokenEstimate <= remainingBudget) {
        // Fits within budget — include as-is
        includedLayers.push(layer);
        totalTokens += layer.tokenEstimate;
      } else if (layer.priority <= 4) {
        // High-priority layer — compress to fit
        const compressedContent = this.compressLayer(layer, remainingBudget);
        const compressedLayer = { ...layer, content: compressedContent, compressed: true, tokenEstimate: Math.ceil(compressedContent.length / 4) };
        includedLayers.push(compressedLayer);
        totalTokens += compressedLayer.tokenEstimate;
        compressedLayers.push(layer.id);
      } else {
        // Low-priority layer — exclude to save tokens
        excludedLayers.push(layer.id);
      }
    }

    const fullPrompt = includedLayers
      .map(l => l.content)
      .filter(Boolean)
      .join('\n\n');

    return {
      fullPrompt,
      totalTokens,
      layerCount: includedLayers.length,
      compressedLayers,
      excludedLayers,
    };
  }

  /**
   * Clear all layers (call at start of each message).
   */
  reset(): void {
    this.layers.clear();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private registerLayer(layer: PromptLayer): PromptLayer {
    this.layers.set(layer.id, layer);
    return layer;
  }

  private compressLayer(layer: PromptLayer, maxTokens: number): string {
    const lines = layer.content.split('\n');
    const maxChars = maxTokens * 4;

    // Strategy 1: Remove empty lines and comments
    let compressed = lines
      .filter(l => l.trim().length > 0)
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');

    if (compressed.length <= maxChars) return compressed;

    // Strategy 2: Truncate long lines
    compressed = lines
      .filter(l => l.trim().length > 0)
      .map(l => l.length > 100 ? l.substring(0, 100) + '…' : l)
      .join('\n');

    if (compressed.length <= maxChars) return compressed;

    // Strategy 3: Take first N lines that fit
    let result = '';
    for (const line of lines) {
      if ((result + line + '\n').length > maxChars) break;
      result += line + '\n';
    }
    return result.trim() + '\n[...compressed]';
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const promptLayers = new PromptLayerArchitecture();
