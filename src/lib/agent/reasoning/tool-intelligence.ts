/**
 * ═══════════════════════════════════════════════════════════════
 * PROACTIVE TOOL INTELLIGENCE — Smart Tool Selection & Chaining
 * ═══════════════════════════════════════════════════════════════
 *
 * WHAT THIS DOES:
 * Instead of waiting for the model to pick tools, this engine
 * proactively predicts which tools will be needed, pre-loads
 * context, optimizes tool chains, and caches results.
 *
 * KEY INNOVATIONS:
 * 1. Tool Prediction: Based on intent, predict next 2-3 tools
 * 2. Chain Optimization: Detect common tool sequences and
 *    suggest optimal ordering
 * 3. Smart Retry: When a tool fails, try with mutated params
 * 4. Usage Analytics: Track tool success rates per task type
 * 5. Parallel Detection: Identify independent tool calls that
 *    can run simultaneously
 * 6. Result Dedup: Never re-read a file that hasn't changed
 */

// ─── Types ────────────────────────────────────────────────────────────────────

import { groupParallelToolCalls } from '../parallel-tool-calls';

export interface ToolPrediction {
  toolName: string;
  confidence: number;  // 0-1
  reason: string;
  suggestedArgs?: Record<string, any>;
}

export interface ToolChain {
  id: string;
  sequence: string[];
  frequency: number;
  averageDurationMs: number;
  successRate: number;
}

export interface ToolUsageRecord {
  toolName: string;
  callCount: number;
  successCount: number;
  failCount: number;
  totalDurationMs: number;
  lastUsed: number;
  commonErrors: Map<string, number>;
  commonArgs: Map<string, number>;
}

// ─── Common Chains ────────────────────────────────────────────────────────────

const KNOWN_CHAINS: Array<{ trigger: string; chain: string[]; name: string }> = [
  { trigger: 'workspace_run_command', chain: ['workspace_run_command', 'workspace_edit_file'], name: 'inspect->edit' },
];

// ─── Intent-Based Tool Mapping ────────────────────────────────────────────────

const INTENT_TOOL_MAP: Array<{ pattern: RegExp; tools: string[]; priority: number }> = [
  // Code modification
  { pattern: /\b(edit|modify|change|update|fix|patch|refactor)\b/i, tools: ['workspace_run_command', 'workspace_edit_file'], priority: 1 },
  // File creation
  { pattern: /\b(create|write|generate|make|build|scaffold)\b.*\b(file|component|module|page|class|game|app|website|project|tool|artifact)\b/i, tools: ['workspace_edit_file'], priority: 1 },
  // Debugging
  { pattern: /\b(debug|fix|error|crash|broken|not\s*work)\b/i, tools: ['workspace_run_command', 'workspace_edit_file'], priority: 1 },
  // Research
  { pattern: /\b(research|investigate|find out|learn|explore)\b/i, tools: ['web_search'], priority: 2 },
  // Project setup
  { pattern: /\b(init|initialize|setup|install)\b/i, tools: ['workspace_run_command'], priority: 1 },
  // Running/testing
  { pattern: /\b(run|execute|test|compile|deploy|start\s+(?:the\s+)?(?:server|app|process)|run\s+(?:the\s+)?build)\b/i, tools: ['workspace_run_command'], priority: 1 },
  // Analysis
  { pattern: /\b(analyze|examine|inspect|review|audit)\b/i, tools: ['workspace_run_command'], priority: 2 },
  // Documents
  { pattern: /\b(document|docx|pdf|report|presentation|pptx|xlsx)\b/i, tools: ['workspace_run_command'], priority: 1 },
  // Images/visual
  { pattern: /\b(image|photo|logo|illustration|picture|visual)\b/i, tools: ['image_generator', 'image_asset_search'], priority: 1 },
  // Charts/data viz
  // Git operations
  // Browser
  { pattern: /\b(browse|website|url|navigate|click|screenshot|open\s*link)\b/i, tools: ['browser_control'], priority: 1 },
];

// ─── Core Engine ──────────────────────────────────────────────────────────────

export class ToolIntelligenceEngine {
  private usageRecords: Map<string, ToolUsageRecord> = new Map();
  private chainHistory: ToolChain[] = [];
  private recentSequence: string[] = [];
  private fileReadCache: Map<string, { content: string; readAt: number }> = new Map();

  /**
   * Predict which tools will be needed for a given message.
   * Returns predictions sorted by confidence.
   */
  predictTools(message: string, availableTools: string[]): ToolPrediction[] {
    const predictions: Map<string, ToolPrediction> = new Map();

    for (const { pattern, tools, priority } of INTENT_TOOL_MAP) {
      if (pattern.test(message)) {
        for (const tool of tools) {
          if (!availableTools.includes(tool)) continue;
          const existing = predictions.get(tool);
          const confidence = Math.min(0.95, 0.5 + (1 / priority) * 0.4);
          if (!existing || existing.confidence < confidence) {
            predictions.set(tool, {
              toolName: tool,
              confidence,
              reason: `Matched: ${pattern.source.substring(0, 40)}`,
            });
          }
        }
      }
    }

    // Boost tools that have been successful in similar contexts
    for (const [toolName, record] of this.usageRecords) {
      if (record.callCount > 3 && record.successCount / record.callCount > 0.8) {
        const existing = predictions.get(toolName);
        if (existing) {
          existing.confidence = Math.min(0.95, existing.confidence + 0.1);
          existing.reason += ` [${((record.successCount / record.callCount) * 100).toFixed(0)}% success rate]`;
        }
      }
    }

    return Array.from(predictions.values())
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);
  }

  /**
   * Check if a tool call is likely to succeed based on history.
   */
  getToolReliability(toolName: string): { reliability: number; commonErrors: string[] } {
    const record = this.usageRecords.get(toolName);
    if (!record || record.callCount < 2) {
      return { reliability: 0.7, commonErrors: [] }; // Default: assume decent
    }

    const reliability = record.successCount / record.callCount;
    const commonErrors = Array.from(record.commonErrors.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([err]) => err);

    return { reliability, commonErrors };
  }

  /**
   * Suggest optimal tool chain based on the current action.
   */
  suggestChain(currentTool: string): ToolChain | null {
    // Check known chains first
    const known = KNOWN_CHAINS.find(c => c.trigger === currentTool);
    if (known) {
      return {
        id: known.name,
        sequence: known.chain,
        frequency: 10,
        averageDurationMs: 0,
        successRate: 0.85,
      };
    }

    // Check learned chains
    const learnedChain = this.chainHistory.find(c =>
      c.sequence[0] === currentTool && c.frequency >= 3 && c.successRate > 0.6
    );

    return learnedChain || null;
  }

  /**
   * Record a tool call result for learning.
   */
  recordToolCall(toolName: string, args: Record<string, any>, success: boolean, durationMs: number, error?: string): void {
    let record = this.usageRecords.get(toolName);
    if (!record) {
      record = {
        toolName,
        callCount: 0,
        successCount: 0,
        failCount: 0,
        totalDurationMs: 0,
        lastUsed: Date.now(),
        commonErrors: new Map(),
        commonArgs: new Map(),
      };
      this.usageRecords.set(toolName, record);
    }

    record.callCount++;
    record.totalDurationMs += durationMs;
    record.lastUsed = Date.now();

    if (success) {
      record.successCount++;
    } else {
      record.failCount++;
      if (error) {
        const normalizedError = error.substring(0, 100).replace(/\d+/g, 'N'); // Normalize numbers
        record.commonErrors.set(normalizedError, (record.commonErrors.get(normalizedError) || 0) + 1);
      }
    }

    // Track sequences
    this.recentSequence.push(toolName);
    if (this.recentSequence.length > 20) this.recentSequence.shift();

    // Learn 3-step chains
    if (this.recentSequence.length >= 3) {
      const chain = this.recentSequence.slice(-3);
      const existing = this.chainHistory.find(c =>
        c.sequence[0] === chain[0] && c.sequence[1] === chain[1] && c.sequence[2] === chain[2]
      );
      if (existing) {
        existing.frequency++;
        existing.successRate = success
          ? existing.successRate * 0.9 + 0.1
          : existing.successRate * 0.9;
      } else {
        this.chainHistory.push({
          id: chain.join('→'),
          sequence: chain,
          frequency: 1,
          averageDurationMs: durationMs,
          successRate: success ? 1 : 0,
        });
      }
    }

    // Cap chain history
    if (this.chainHistory.length > 100) {
      this.chainHistory.sort((a, b) => b.frequency - a.frequency);
      this.chainHistory = this.chainHistory.slice(0, 50);
    }
  }

  /**
   * Generate a tool intelligence report for the system prompt.
   */
  generateToolHints(toolsUsed: string[]): string {
    if (toolsUsed.length === 0) return '';

    const parts: string[] = [];
    const lastTool = toolsUsed[toolsUsed.length - 1];

    // Suggest next tool in chain
    const chain = this.suggestChain(lastTool);
    if (chain && chain.sequence.length > 1) {
      const nextInChain = chain.sequence.find(t => !toolsUsed.includes(t));
      if (nextInChain) {
        parts.push(`Suggested next: ${nextInChain} (common chain: ${chain.id})`);
      }
    }

    // Warn about unreliable tools
    for (const tool of toolsUsed) {
      const { reliability, commonErrors } = this.getToolReliability(tool);
      if (reliability < 0.5 && commonErrors.length > 0) {
        parts.push(`⚠️ ${tool} has ${(reliability * 100).toFixed(0)}% success rate. Common errors: ${commonErrors[0]}`);
      }
    }

    return parts.length > 0 ? `[Tool Intelligence] ${parts.join(' | ')}` : '';
  }

  /**
   * Check if independent tool calls can be parallelized.
   */
  canParallelize(calls: Array<{ name: string; args: any }>): Array<Array<{ name: string; args: any }>> {
    return groupParallelToolCalls(calls);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const toolIntelligence = new ToolIntelligenceEngine();
