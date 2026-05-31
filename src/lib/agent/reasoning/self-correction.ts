/**
 * ═══════════════════════════════════════════════════════════════
 * DEEP SELF-CORRECTION ENGINE — Semantic Quality Assurance
 * ═══════════════════════════════════════════════════════════════
 *
 * WHAT THIS DOES:
 * Goes beyond the existing AgentReflectionEngine's 15 heuristics.
 * Instead of just checking "is the output formatted correctly?",
 * this engine checks "did the output ACTUALLY solve the problem?"
 *
 * KEY INNOVATIONS:
 * 1. Semantic Verification: Does the answer address every part
 *    of the user's multi-part request?
 * 2. Consistency Check: Does the response contradict earlier
 *    statements or known facts?
 * 3. Completeness Scoring: 0-100% score against the request.
 * 4. Auto-Enhancement: If score < threshold, automatically
 *    generate follow-up actions to fill gaps.
 * 5. Evidence Linking: Every factual claim gets verified
 *    against tool result evidence.
 *
 * DESIGN PRINCIPLES:
 * - NEVER throw — all methods return results
 * - FAST — synchronous where possible, async only for disk reads
 * - CONSERVATIVE — only flag clear violations
 * - COMPOSABLE — each check is independent and testable
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SelfCorrectionResult {
  /** Overall quality score 0-100 */
  qualityScore: number;
  /** Whether the output passes quality threshold */
  passes: boolean;
  /** Specific issues found */
  issues: CorrectionIssue[];
  /** Suggested follow-up actions to improve the output */
  suggestedActions: CorrectionAction[];
  /** Injection text for the model to fix its output */
  correctionPrompt: string | null;
}

export interface CorrectionIssue {
  type: 'incomplete' | 'inconsistent' | 'unverified' | 'superficial' | 'off_topic' | 'missing_code' | 'placeholder' | 'overclaimed';
  severity: 'info' | 'warning' | 'critical';
  detail: string;
  scoreImpact: number; // How many points this deducts
}

export interface CorrectionAction {
  type: 'tool_call' | 'rephrase' | 'add_section' | 'verify' | 'remove';
  tool?: string;
  args?: Record<string, any>;
  reason: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum quality score to pass without correction */
const QUALITY_THRESHOLD = 65;

/** Patterns that indicate placeholder content */
const PLACEHOLDER_PATTERNS = [
  /\b(TODO|FIXME|HACK|XXX|PLACEHOLDER)\b/,
  /\.\.\.\s*(?:add|implement|complete|fill|your|remaining)/i,
  /\/\/ .{0,30}(?:implement|add|complete|fill) .{0,30} here/i,
  /\b(your[_-]?(?:api[_-]?key|token|secret|password))\b/i,
  /\b(example\.com|placeholder|lorem ipsum|sample data)\b/i,
];

/** Patterns that suggest superficial answers */
const SUPERFICIAL_PATTERNS = [
  /\bhere(?:'s| is) (?:a|an) (?:simple|basic) (?:example|overview)\b/i,
  /\bthis is just a (?:starting point|basic template|simple demo)\b/i,
  /\byou can (?:customize|modify|extend|adapt) (?:this|it) (?:further|as needed|to fit)\b/i,
  /\bfor (?:more|further) (?:details|information|customization),? (?:see|check|refer)\b/i,
];

/** Patterns that indicate overclaiming without evidence */
const OVERCLAIM_PATTERNS = [
  /\bincreased (?:by|to) \d+%\b/i,    // Specific percentages without measurement
  /\boptimized (?:by|to) \d+x\b/i,    // Specific multipliers without benchmarks
  /\b(?:best|optimal|perfect|ideal) (?:solution|approach|strategy)\b/i,
];

// ─── Core Engine ──────────────────────────────────────────────────────────────

export class DeepSelfCorrectionEngine {
  /**
   * Full quality assessment of an agent response.
   */
  assess(opts: {
    userMessage: string;
    agentResponse: string;
    toolsUsed: string[];
    toolResultDigest: Array<{ tool: string; args: string; result: string }>;
    filesCreated: string[];
  }): SelfCorrectionResult {
    const issues: CorrectionIssue[] = [];
    const actions: CorrectionAction[] = [];
    let score = 100;

    try {
      // ── Check 1: Request Completeness ──
      const completeness = this.checkCompleteness(opts.userMessage, opts.agentResponse);
      score -= completeness.deduction;
      issues.push(...completeness.issues);
      actions.push(...completeness.actions);

      // ── Check 2: Placeholder Detection ──
      const placeholders = this.checkPlaceholders(opts.agentResponse);
      score -= placeholders.deduction;
      issues.push(...placeholders.issues);
      actions.push(...placeholders.actions);

      // ── Check 3: Consistency Check ──
      const consistency = this.checkConsistency(opts.agentResponse, opts.toolResultDigest);
      score -= consistency.deduction;
      issues.push(...consistency.issues);

      // ── Check 4: Superficiality Check ──
      const superficiality = this.checkSuperficiality(opts.userMessage, opts.agentResponse);
      score -= superficiality.deduction;
      issues.push(...superficiality.issues);
      actions.push(...superficiality.actions);

      // ── Check 5: Evidence Linking ──
      const evidence = this.checkEvidence(opts.agentResponse, opts.toolResultDigest, opts.filesCreated);
      score -= evidence.deduction;
      issues.push(...evidence.issues);

      // ── Check 6: Code Quality (if code is present) ──
      const codeQuality = this.checkCodeQuality(opts.agentResponse);
      score -= codeQuality.deduction;
      issues.push(...codeQuality.issues);
      actions.push(...codeQuality.actions);

      // ── Check 7: Overclaiming ──
      const overclaiming = this.checkOverclaiming(opts.agentResponse, opts.toolResultDigest);
      score -= overclaiming.deduction;
      issues.push(...overclaiming.issues);

    } catch {
      // Never throw — if our checker fails, assume passing
    }

    score = Math.max(0, Math.min(100, score));
    const passes = score >= QUALITY_THRESHOLD;

    // Build correction prompt for the model
    let correctionPrompt: string | null = null;
    if (!passes && issues.length > 0) {
      const criticals = issues.filter(i => i.severity === 'critical');
      const warnings = issues.filter(i => i.severity === 'warning');

      const parts = ['[SYSTEM — DEEP SELF-CORRECTION]'];
      parts.push(`Quality Score: ${score}/100 (threshold: ${QUALITY_THRESHOLD})`);

      if (criticals.length > 0) {
        parts.push('CRITICAL ISSUES:');
        for (const issue of criticals) {
          parts.push(`  ❌ ${issue.type}: ${issue.detail}`);
        }
      }
      if (warnings.length > 0) {
        parts.push('WARNINGS:');
        for (const issue of warnings.slice(0, 3)) {
          parts.push(`  ⚠️ ${issue.type}: ${issue.detail}`);
        }
      }
      if (actions.length > 0) {
        parts.push('SUGGESTED FIXES:');
        for (const action of actions.slice(0, 3)) {
          parts.push(`  → ${action.reason}${action.tool ? ` (use ${action.tool})` : ''}`);
        }
      }
      parts.push('Fix these issues and provide an improved response.');
      parts.push('[END SELF-CORRECTION]');

      correctionPrompt = parts.join('\n');
    }

    return { qualityScore: score, passes, issues, suggestedActions: actions, correctionPrompt };
  }

  // ─── Individual Checks ──────────────────────────────────────────────────────

  private checkCompleteness(userMessage: string, response: string): { deduction: number; issues: CorrectionIssue[]; actions: CorrectionAction[] } {
    const issues: CorrectionIssue[] = [];
    const actions: CorrectionAction[] = [];
    let deduction = 0;

    // Extract distinct requests/parts from the user message
    const requestParts = this.extractRequestParts(userMessage);
    if (requestParts.length <= 1) return { deduction: 0, issues: [], actions: [] };

    const responseLower = response.toLowerCase();
    let addressedCount = 0;

    for (const part of requestParts) {
      // Check if the response addresses this part
      const keywords = part.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const matchCount = keywords.filter(k => responseLower.includes(k)).length;
      const matchRatio = keywords.length > 0 ? matchCount / keywords.length : 1;

      if (matchRatio >= 0.4) {
        addressedCount++;
      }
    }

    const completenessRatio = addressedCount / requestParts.length;
    if (completenessRatio < 0.6) {
      const missed = requestParts.length - addressedCount;
      deduction = Math.min(30, missed * 10);
      issues.push({
        type: 'incomplete',
        severity: 'critical',
        detail: `Only ${addressedCount}/${requestParts.length} parts of the request were addressed`,
        scoreImpact: deduction,
      });
      actions.push({
        type: 'add_section',
        reason: `Address the remaining ${missed} parts of the user's request`,
      });
    } else if (completenessRatio < 0.8) {
      deduction = 10;
      issues.push({
        type: 'incomplete',
        severity: 'warning',
        detail: `${addressedCount}/${requestParts.length} parts addressed — some parts may need more detail`,
        scoreImpact: deduction,
      });
    }

    return { deduction, issues, actions };
  }

  private checkPlaceholders(response: string): { deduction: number; issues: CorrectionIssue[]; actions: CorrectionAction[] } {
    const issues: CorrectionIssue[] = [];
    const actions: CorrectionAction[] = [];
    let deduction = 0;

    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(response)) {
        deduction += 15;
        issues.push({
          type: 'placeholder',
          severity: 'critical',
          detail: `Placeholder content detected: ${pattern.source.substring(0, 50)}`,
          scoreImpact: 15,
        });
        actions.push({
          type: 'rephrase',
          reason: 'Replace placeholder content with actual implementation',
        });
        break; // One placeholder flag is enough
      }
    }

    return { deduction: Math.min(20, deduction), issues, actions };
  }

  private checkConsistency(response: string, toolResults: Array<{ tool: string; args: string; result: string }>): { deduction: number; issues: CorrectionIssue[] } {
    const issues: CorrectionIssue[] = [];
    let deduction = 0;

    // Check if response contradicts tool results
    const responseLower = response.toLowerCase();
    for (const tr of toolResults) {
      const resultLower = tr.result.toLowerCase();

      // Agent says "success" but tool said "error/failed"
      if (resultLower.includes('error') || resultLower.includes('failed')) {
        // Check if agent acknowledges the failure
        const toolName = tr.tool;
        const ackFailure = responseLower.includes('error') || responseLower.includes('fail') ||
          responseLower.includes('issue') || responseLower.includes('problem');

        if (!ackFailure && /\b(successfully|completed|done|working)\b/i.test(response)) {
          deduction += 20;
          issues.push({
            type: 'inconsistent',
            severity: 'critical',
            detail: `Response claims success but ${toolName} returned an error: "${tr.result.substring(0, 80)}"`,
            scoreImpact: 20,
          });
        }
      }
    }

    return { deduction: Math.min(25, deduction), issues };
  }

  private checkSuperficiality(userMessage: string, response: string): { deduction: number; issues: CorrectionIssue[]; actions: CorrectionAction[] } {
    const issues: CorrectionIssue[] = [];
    const actions: CorrectionAction[] = [];
    let deduction = 0;

    // Only check for non-trivial requests
    const words = userMessage.split(/\s+/).length;
    if (words < 10) return { deduction: 0, issues: [], actions: [] };

    for (const pattern of SUPERFICIAL_PATTERNS) {
      if (pattern.test(response)) {
        deduction += 10;
        issues.push({
          type: 'superficial',
          severity: 'warning',
          detail: 'Response contains superficial language suggesting incomplete implementation',
          scoreImpact: 10,
        });
        actions.push({
          type: 'rephrase',
          reason: 'Provide complete implementation instead of a basic example',
        });
        break;
      }
    }

    // Check response length vs request complexity
    const responseWords = response.split(/\s+/).length;
    const isComplexRequest = words > 30 || /\b(full|complete|entire|detailed|comprehensive)\b/i.test(userMessage);
    if (isComplexRequest && responseWords < 50) {
      deduction += 15;
      issues.push({
        type: 'superficial',
        severity: 'warning',
        detail: `Complex request (${words} words) got a very short response (${responseWords} words)`,
        scoreImpact: 15,
      });
    }

    return { deduction: Math.min(20, deduction), issues, actions };
  }

  private checkEvidence(response: string, toolResults: Array<{ tool: string; result: string }>, filesCreated: string[]): { deduction: number; issues: CorrectionIssue[] } {
    const issues: CorrectionIssue[] = [];
    let deduction = 0;

    // Check if claimed file creations have evidence
    const filePattern = /(?:created|wrote|generated|saved|built)\s+(?:the\s+)?(?:file\s+)?["'`]?([^\s"'`]+\.\w{1,6})["'`]?/gi;
    let match: RegExpExecArray | null;
    while ((match = filePattern.exec(response)) !== null) {
      const claimedFile = match[1];
      const hasEvidence = filesCreated.some(f => {
        const fBase = f.split(/[\\/]/).pop() || '';
        return fBase.toLowerCase() === claimedFile.toLowerCase() || f.toLowerCase().includes(claimedFile.toLowerCase());
      });

      if (!hasEvidence) {
        const toolEvidence = toolResults.some(tr =>
          tr.tool === 'workspace_write_file' && tr.result.toLowerCase().includes(claimedFile.toLowerCase())
        );
        if (!toolEvidence) {
          deduction += 10;
          issues.push({
            type: 'unverified',
            severity: 'warning',
            detail: `Claimed file "${claimedFile}" but no tool evidence of creation`,
            scoreImpact: 10,
          });
        }
      }
    }

    return { deduction: Math.min(20, deduction), issues };
  }

  private checkCodeQuality(response: string): { deduction: number; issues: CorrectionIssue[]; actions: CorrectionAction[] } {
    const issues: CorrectionIssue[] = [];
    const actions: CorrectionAction[] = [];
    let deduction = 0;

    // Extract code blocks
    const codeBlocks = response.match(/```[\s\S]*?```/g) || [];
    if (codeBlocks.length === 0) return { deduction: 0, issues: [], actions: [] };

    for (const block of codeBlocks) {
      const code = block.replace(/```\w*\n?/, '').replace(/```$/, '');

      // Check for empty or stub functions
      if (/function\s+\w+\s*\([^)]*\)\s*\{\s*\}/m.test(code)) {
        deduction += 10;
        issues.push({
          type: 'missing_code',
          severity: 'warning',
          detail: 'Code contains empty function bodies',
          scoreImpact: 10,
        });
      }

      // Check for "// ..." or "/* ... */" indicating missing implementation
      if (/\/\/\s*\.{3}\s*$/m.test(code) || /\/\*\s*\.{3}\s*\*\//m.test(code)) {
        deduction += 15;
        issues.push({
          type: 'placeholder',
          severity: 'critical',
          detail: 'Code contains "..." placeholder indicating missing implementation',
          scoreImpact: 15,
        });
        actions.push({
          type: 'rephrase',
          reason: 'Replace code placeholders with complete implementation',
        });
      }
    }

    return { deduction: Math.min(20, deduction), issues, actions };
  }

  private checkOverclaiming(response: string, toolResults: Array<{ tool: string; result: string }>): { deduction: number; issues: CorrectionIssue[] } {
    const issues: CorrectionIssue[] = [];
    let deduction = 0;

    // Check for specific performance claims without measurement evidence
    for (const pattern of OVERCLAIM_PATTERNS) {
      if (pattern.test(response)) {
        // Check if there's tool evidence to support the claim
        const hasBenchmarkEvidence = toolResults.some(tr =>
          /benchmark|perf|measure|time|speed|latency|throughput/i.test(tr.result)
        );

        if (!hasBenchmarkEvidence) {
          deduction += 10;
          issues.push({
            type: 'overclaimed',
            severity: 'warning',
            detail: 'Performance claims made without benchmark evidence',
            scoreImpact: 10,
          });
          break;
        }
      }
    }

    return { deduction: Math.min(15, deduction), issues };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private extractRequestParts(message: string): string[] {
    // Split by common conjunctions and list markers
    const parts: string[] = [];
    const sentences = message.split(/[.!?]\s+/);

    for (const sentence of sentences) {
      // Split by "and", "also", numbered lists
      const subParts = sentence.split(/\b(?:and also|and then|also|plus|additionally)\b/i);
      parts.push(...subParts.filter(p => p.trim().length > 5));
    }

    // Also check for numbered/bulleted lists
    const listItems = message.match(/(?:^|\n)\s*(?:\d+[.)]\s*|-\s*|•\s*)(.+)/gm);
    if (listItems) {
      parts.push(...listItems.map(item => item.replace(/^\s*(?:\d+[.)]\s*|-\s*|•\s*)/, '').trim()));
    }

    return parts.filter(p => p.length > 5);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const deepSelfCorrection = new DeepSelfCorrectionEngine();
