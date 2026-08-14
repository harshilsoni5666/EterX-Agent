/**
 * ═══════════════════════════════════════════════════════════════
 * AUTONOMOUS ERROR RECOVERY ENGINE — Self-Healing Agent
 * ═══════════════════════════════════════════════════════════════
 *
 * WHAT THIS DOES:
 * When things go wrong, the agent should:
 * 1. DIAGNOSE: Parse error messages, identify root cause category
 * 2. CLASSIFY: Transient (retry), config (fix), or blocker (ask user)
 * 3. AUTO-HEAL: Apply the most common fix automatically
 * 4. FALLBACK: If 3x fails, switch to alternative strategy
 * 5. LEARN: Record what fixed it so next time it's instant
 * 6. ROLLBACK: If edit broke something, revert to last good state
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ErrorCategory =
  | 'transient'       // Network timeouts, rate limits → retry
  | 'permission'      // File/folder permissions → fix or ask user
  | 'not_found'       // File/module not found → fix path
  | 'syntax'          // Code syntax error → fix code
  | 'dependency'      // Missing package/module → install
  | 'config'          // Configuration issue → fix config
  | 'resource'        // Out of memory/disk → warn user
  | 'auth'            // Authentication failure → ask user
  | 'logic'           // Logic/runtime error → debug
  | 'unknown';        // Can't classify → generic recovery

export interface ErrorDiagnosis {
  category: ErrorCategory;
  confidence: number;
  rootCause: string;
  canAutoFix: boolean;
  suggestedFix: ErrorFix | null;
  escalateToUser: boolean;
}

export interface ErrorFix {
  description: string;
  tool: string;
  args: Record<string, any>;
  rollbackPossible: boolean;
}

export interface ErrorPattern {
  pattern: RegExp;
  category: ErrorCategory;
  fixTemplate?: (match: RegExpMatchArray, context: ErrorContext) => ErrorFix | null;
  description: string;
}

export interface ErrorContext {
  toolName: string;
  args: Record<string, any>;
  errorMessage: string;
  previousErrors: string[];
  filesModified: string[];
}

export interface RecoveryRecord {
  errorPattern: string;
  category: ErrorCategory;
  fixApplied: string;
  success: boolean;
  timestamp: number;
}

// ─── Error Patterns ───────────────────────────────────────────────────────────

const ERROR_PATTERNS: ErrorPattern[] = [
  // ── Transient ──
  {
    pattern: /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|socket hang up|network)\b/i,
    category: 'transient',
    description: 'Network connectivity issue',
  },
  {
    pattern: /\b(429|rate.?limit|too many requests|quota|RESOURCE_EXHAUSTED)\b/i,
    category: 'transient',
    description: 'API rate limit',
  },
  {
    pattern: /\b(503|502|500|UNAVAILABLE|service unavailable|internal server error)\b/i,
    category: 'transient',
    description: 'Server error',
  },

  // ── Not Found ──
  {
    pattern: /\bENOENT\b|no such file|cannot find (?:module|file|path)|not found/i,
    category: 'not_found',
    description: 'File or module not found',
    fixTemplate: (match, ctx) => {
      const pathMatch = ctx.errorMessage.match(/['"]([^'"]+)['"]/);
      if (pathMatch) {
        return {
          description: `Search for the correct path of "${pathMatch[1]}"`,
          tool: 'workspace_run_command',
          args: { command: 'rg --files' },
          rollbackPossible: false,
        };
      }
      return null;
    },
  },

  // ── Dependency ──
  {
    pattern: /\bcannot find module|Module not found|No module named|ERR_MODULE_NOT_FOUND\b/i,
    category: 'dependency',
    description: 'Missing dependency',
    fixTemplate: (_match, ctx) => {
      const moduleMatch = ctx.errorMessage.match(/(?:cannot find module|Module not found)[:\s]*['"]([^'"]+)['"]/i);
      if (moduleMatch) {
        return {
          description: `Install missing dependency: ${moduleMatch[1]}`,
          tool: 'workspace_run_command',
          args: { command: `npm install ${moduleMatch[1]}` },
          rollbackPossible: true,
        };
      }
      return null;
    },
  },

  // ── Syntax ──
  {
    pattern: /\bSyntaxError|Unexpected token|unexpected (?:identifier|string|number)|Parse error\b/i,
    category: 'syntax',
    description: 'Code syntax error',
    fixTemplate: (_match, ctx) => {
      const fileMatch = ctx.errorMessage.match(/(?:at |in )([^\s:]+):(\d+)/);
      if (fileMatch) {
        return {
          description: `Read and fix syntax error in ${fileMatch[1]}:${fileMatch[2]}`,
          tool: 'workspace_run_command',
          args: { command: `rg -n "^" -- "${fileMatch[1]}"` },
          rollbackPossible: false,
        };
      }
      return null;
    },
  },

  // ── Permission ──
  {
    pattern: /\bEACCES|EPERM|permission denied|access denied|not permitted\b/i,
    category: 'permission',
    description: 'Permission denied',
  },

  // ── Auth ──
  {
    pattern: /\b401|403|unauthorized|forbidden|invalid.*(?:key|token|credential)|auth.*fail\b/i,
    category: 'auth',
    description: 'Authentication failure',
  },

  // ── Config ──
  {
    pattern: /\binvalid.*config|configuration error|missing.*env|\.env.*not found\b/i,
    category: 'config',
    description: 'Configuration error',
  },

  // ── Resource ──
  {
    pattern: /\bout of memory|ENOMEM|heap|ENOSPC|no space left|disk full\b/i,
    category: 'resource',
    description: 'Resource exhaustion',
  },

  // ── Logic ──
  {
    pattern: /\bTypeError|ReferenceError|RangeError|undefined is not|null is not|cannot read prop\b/i,
    category: 'logic',
    description: 'Runtime logic error',
    fixTemplate: (_match, ctx) => {
      const fileMatch = ctx.errorMessage.match(/(?:at |in )([^\s:]+):(\d+)/);
      if (fileMatch) {
        return {
          description: `Debug runtime error in ${fileMatch[1]}:${fileMatch[2]}`,
          tool: 'workspace_run_command',
          args: { command: `rg -n "^" -- "${fileMatch[1]}"` },
          rollbackPossible: false,
        };
      }
      return null;
    },
  },
];

// ─── Core Engine ──────────────────────────────────────────────────────────────

export class ErrorRecoveryEngine {
  private recoveryHistory: RecoveryRecord[] = [];
  private consecutiveFailures: Map<string, number> = new Map();
  private maxHistorySize = 100;

  /**
   * Diagnose an error and suggest recovery.
   */
  diagnose(context: ErrorContext): ErrorDiagnosis {
    const errMsg = context.errorMessage.toLowerCase();

    // Try each pattern
    for (const pattern of ERROR_PATTERNS) {
      const match = context.errorMessage.match(pattern.pattern);
      if (match) {
        const fix = pattern.fixTemplate ? pattern.fixTemplate(match, context) : null;

        // Check recovery history for this pattern
        const pastFixes = this.recoveryHistory.filter(r =>
          r.errorPattern === pattern.description && r.success
        );
        const learnedFix = pastFixes.length > 0 ? pastFixes[pastFixes.length - 1] : null;

        // Track consecutive failures per tool
        const failKey = `${context.toolName}:${pattern.category}`;
        const failures = (this.consecutiveFailures.get(failKey) || 0) + 1;
        this.consecutiveFailures.set(failKey, failures);

        const canAutoFix = pattern.category !== 'auth' && pattern.category !== 'resource' && failures < 3;
        const escalateToUser = pattern.category === 'auth' || pattern.category === 'resource' || failures >= 3;

        return {
          category: pattern.category,
          confidence: 0.8,
          rootCause: pattern.description,
          canAutoFix,
          suggestedFix: fix,
          escalateToUser,
        };
      }
    }

    // Unknown error
    return {
      category: 'unknown',
      confidence: 0.3,
      rootCause: `Unknown error: ${context.errorMessage.substring(0, 100)}`,
      canAutoFix: false,
      suggestedFix: null,
      escalateToUser: false,
    };
  }

  /**
   * Record a recovery attempt result for learning.
   */
  recordRecovery(errorPattern: string, category: ErrorCategory, fixApplied: string, success: boolean): void {
    this.recoveryHistory.push({
      errorPattern,
      category,
      fixApplied,
      success,
      timestamp: Date.now(),
    });

    if (success) {
      // Reset consecutive failure counter for this category
      for (const [key] of this.consecutiveFailures) {
        if (key.endsWith(`:${category}`)) {
          this.consecutiveFailures.set(key, 0);
        }
      }
    }

    // Trim history
    if (this.recoveryHistory.length > this.maxHistorySize) {
      this.recoveryHistory = this.recoveryHistory.slice(-this.maxHistorySize);
    }
  }

  /**
   * Generate an error recovery directive for the system prompt.
   */
  generateRecoveryDirective(diagnosis: ErrorDiagnosis, context: ErrorContext): string {
    const parts: string[] = ['[ERROR RECOVERY ENGINE]'];

    parts.push(`Error Category: ${diagnosis.category} (confidence: ${(diagnosis.confidence * 100).toFixed(0)}%)`);
    parts.push(`Root Cause: ${diagnosis.rootCause}`);

    if (diagnosis.suggestedFix) {
      parts.push(`Suggested Fix: ${diagnosis.suggestedFix.description}`);
      parts.push(`Use tool: ${diagnosis.suggestedFix.tool}`);
    }

    if (diagnosis.escalateToUser) {
      parts.push('⚠️ ESCALATE: This error likely requires user input (credentials, permissions, or system resources).');
      parts.push('Ask the user for help using ask_user.');
    } else if (diagnosis.canAutoFix) {
      parts.push('AUTO-FIX: Apply the suggested fix automatically. If it fails again, try an alternative approach.');
    } else {
      parts.push('INVESTIGATE: Read error context, then decide on fix approach.');
    }

    // Add pattern-specific advice
    switch (diagnosis.category) {
      case 'transient':
        parts.push('Transient errors usually resolve on retry. Wait briefly, then retry.');
        break;
      case 'not_found':
        parts.push('Search for the correct file path with workspace_run_command before retrying.');
        break;
      case 'dependency':
        parts.push('Install the missing dependency, then retry the original command.');
        break;
      case 'syntax':
        parts.push('Read the file at the error line, identify the syntax issue, fix it, then verify.');
        break;
      case 'logic':
        parts.push('Read the code at the error location. Trace the variable/property that is undefined/null. Add null checks or fix the root cause.');
        break;
    }

    parts.push('[END ERROR RECOVERY]');
    return parts.join('\n');
  }

  /**
   * Check if we should switch to a completely different strategy.
   */
  shouldShiftStrategy(toolName: string): boolean {
    for (const [key, count] of this.consecutiveFailures) {
      if (key.startsWith(toolName) && count >= 3) return true;
    }
    return false;
  }

  /**
   * Get learned fixes for a specific error category.
   */
  getLearnedFixes(category: ErrorCategory): RecoveryRecord[] {
    return this.recoveryHistory
      .filter(r => r.category === category && r.success)
      .slice(-5);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const errorRecovery = new ErrorRecoveryEngine();
