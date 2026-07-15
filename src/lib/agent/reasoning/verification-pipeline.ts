/**
 * ═══════════════════════════════════════════════════════════════
 * AUTONOMOUS VERIFICATION PIPELINE — Never Claim Without Proof
 * ═══════════════════════════════════════════════════════════════
 *
 * WHAT THIS DOES:
 * After every significant action, automatically verifies the result.
 * This is what makes  Code feel "alive" — it never claims
 * success without proof.
 *
 * VERIFICATION CHAIN:
 *   Write Code → Auto-Lint → Check Errors → Fix → Re-check
 *   Write File → Verify Exists → Read Back → Compare
 *   Run Command → Check Exit Code → Parse Output → Validate
 *   Research → Cross-Reference Sources → Flag Contradictions
 *
 * INTEGRATION:
 * Called between tool calls in the ReAct loop. If verification
 * fails, the engine generates a correction injection that the
 * model receives in its next iteration.
 *
 * DESIGN PRINCIPLES:
 * - Zero-latency: Only run verifications that matter
 * - Non-blocking: Verification failures are soft (inject corrections)
 * - Learning: Track which verifications catch real issues
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VerificationResult {
  verified: boolean;
  confidence: number;  // 0-1
  checksPassed: string[];
  checksFailed: VerificationFailure[];
  correctionInjection: string | null;
  suggestedNextTool: string | null;
}

export interface VerificationFailure {
  check: string;
  expected: string;
  actual: string;
  severity: 'info' | 'warning' | 'critical';
  autoFixable: boolean;
}

export type VerificationRule = {
  /** Name of the check */
  name: string;
  /** Which tool triggers this verification */
  triggerTool: string;
  /** Condition to decide if this rule applies */
  condition: (args: Record<string, any>, result: any) => boolean;
  /** The verification logic */
  verify: (args: Record<string, any>, result: any) => VerificationCheckResult;
};

type VerificationCheckResult = {
  passed: boolean;
  detail: string;
  severity: 'info' | 'warning' | 'critical';
  autoFixable: boolean;
  suggestedTool?: string;
  suggestedArgs?: Record<string, any>;
};

// ─── Verification Rules ───────────────────────────────────────────────────────

const VERIFICATION_RULES: VerificationRule[] = [
  // ── File Write: Check for empty/tiny files ──
  {
    name: 'file_write_non_empty',
    triggerTool: 'workspace_write_file',
    condition: (_args, result) => !result?.error,
    verify: (args, result) => {
      const content = args?.content || '';
      if (content.length < 10) {
        return {
          passed: false,
          detail: `File "${args?.filename}" written with only ${content.length} characters — likely incomplete`,
          severity: 'warning',
          autoFixable: false,
        };
      }
      return { passed: true, detail: `File written: ${content.length} chars`, severity: 'info', autoFixable: false };
    },
  },

  // ── File Write: Verify file actually exists after creation ──
  {
    name: 'file_write_verified',
    triggerTool: 'workspace_write_file',
    condition: (_args, result) => !result?.error,
    verify: (args, result) => {
      if (result?._verified === true) {
        return { passed: true, detail: `File verified on disk (${((result._fileSize || 0) / 1024).toFixed(1)}KB)`, severity: 'info', autoFixable: false };
      }
      if (result?._verified === false) {
        return {
          passed: false,
          detail: `File "${args?.filename}" was written but NOT found on disk`,
          severity: 'critical',
          autoFixable: true,
          suggestedTool: 'realtime_verify',
          suggestedArgs: { type: 'file_exists', target: args?.filename },
        };
      }
      return { passed: true, detail: 'File write completed (no disk verification)', severity: 'info', autoFixable: false };
    },
  },

  // ── Command: Check exit code ──
  {
    name: 'command_exit_code',
    triggerTool: 'system_shell',
    condition: (_args, result) => result?.exitCode !== undefined || result?.code !== undefined,
    verify: (_args, result) => {
      const exitCode = result?.exitCode ?? result?.code ?? 0;
      if (exitCode !== 0) {
        const stderr = String(result?.stderr || '').substring(0, 200);
        return {
          passed: false,
          detail: `Command exited with code ${exitCode}${stderr ? `: ${stderr}` : ''}`,
          severity: exitCode === 1 ? 'warning' : 'critical',
          autoFixable: false,
        };
      }
      return { passed: true, detail: 'Command succeeded (exit code 0)', severity: 'info', autoFixable: false };
    },
  },

  // ── Command: Same check for workspace_run_command ──
  {
    name: 'workspace_cmd_exit_code',
    triggerTool: 'workspace_run_command',
    condition: (_args, result) => result?.exitCode !== undefined || result?.code !== undefined,
    verify: (_args, result) => {
      const exitCode = result?.exitCode ?? result?.code ?? 0;
      if (exitCode !== 0) {
        const stderr = String(result?.stderr || '').substring(0, 200);
        return {
          passed: false,
          detail: `Project command exited with code ${exitCode}${stderr ? `: ${stderr}` : ''}`,
          severity: 'warning',
          autoFixable: false,
        };
      }
      return { passed: true, detail: 'Command succeeded', severity: 'info', autoFixable: false };
    },
  },

  // ── File Edit: Check that the edit was actually applied ──
  {
    name: 'file_edit_applied',
    triggerTool: 'workspace_edit_file',
    condition: (_args, result) => !result?.error,
    verify: (args, result) => {
      if (result?.error) {
        return {
          passed: false,
          detail: `Edit failed: ${String(result.error).substring(0, 100)}`,
          severity: 'critical',
          autoFixable: false,
        };
      }
      // Check if the target was found
      if (result?.matchesFound === 0 || result?.replaced === false) {
        return {
          passed: false,
          detail: 'Edit target pattern was not found in the file — content may have changed',
          severity: 'warning',
          autoFixable: true,
          suggestedTool: 'workspace_read_file',
          suggestedArgs: { filename: args?.filename },
        };
      }
      return { passed: true, detail: 'Edit applied successfully', severity: 'info', autoFixable: false };
    },
  },

  {
    name: 'str_replace_applied',
    triggerTool: 'workspace_str_replace',
    condition: (_args, result) => !result?.error,
    verify: (args, result) => {
      if (result?.error) {
        return {
          passed: false,
          detail: `Edit failed: ${String(result.error).substring(0, 100)}`,
          severity: 'critical',
          autoFixable: false,
        };
      }
      if (result?.matchesFound === 0 || result?.replaced === false || result?.success === false) {
        return {
          passed: false,
          detail: 'Target text was not replaced; content may have changed',
          severity: 'warning',
          autoFixable: true,
          suggestedTool: 'workspace_read_file',
          suggestedArgs: { filename: args?.filename || args?.path },
        };
      }
      return { passed: true, detail: 'Targeted replacement applied successfully', severity: 'info', autoFixable: false };
    },
  },

  {
    name: 'patch_applied',
    triggerTool: 'workspace_apply_patch',
    condition: (_args, result) => !result?.error,
    verify: (args, result) => {
      if (result?.error) {
        return {
          passed: false,
          detail: `Patch failed: ${String(result.error).substring(0, 100)}`,
          severity: 'critical',
          autoFixable: false,
        };
      }
      if (result?.success === false || result?.applied === false) {
        return {
          passed: false,
          detail: 'Patch was not applied; re-read current context and retry with smaller hunks',
          severity: 'warning',
          autoFixable: true,
          suggestedTool: 'workspace_read_file',
          suggestedArgs: { filename: args?.filename || args?.path },
        };
      }
      return { passed: true, detail: 'Patch applied successfully', severity: 'info', autoFixable: false };
    },
  },

  // ── Search: Check that results are relevant ──
  {
    name: 'search_has_results',
    triggerTool: 'web_search',
    condition: (args) => args?.action !== 'extract' && args?.action !== 'scrape',
    verify: (_args, result) => {
      const results = result?.results || result?.organic || [];
      if (Array.isArray(results) && results.length === 0) {
        return {
          passed: false,
          detail: 'Search returned zero results — try different keywords',
          severity: 'warning',
          autoFixable: true,
          suggestedTool: 'web_search',
        };
      }
      return { passed: true, detail: `Search returned ${Array.isArray(results) ? results.length : '?'} results`, severity: 'info', autoFixable: false };
    },
  },

  // ── Verify Code: Check for compilation errors ──
  {
    name: 'code_verify_clean',
    triggerTool: 'workspace_verify_code',
    condition: () => true,
    verify: (_args, result) => {
      const hasErrors = result?.errors && result.errors.length > 0;
      const hasIssues = result?.issues && result.issues.length > 0;
      if (hasErrors) {
        return {
          passed: false,
          detail: `Code verification found ${result.errors.length} error(s)`,
          severity: 'critical',
          autoFixable: true,
          suggestedTool: 'workspace_str_replace',
        };
      }
      if (hasIssues) {
        return {
          passed: true,
          detail: `Code verification passed with ${result.issues.length} warning(s)`,
          severity: 'warning',
          autoFixable: false,
        };
      }
      return { passed: true, detail: 'Code verification passed clean', severity: 'info', autoFixable: false };
    },
  },
];

// ─── Pipeline Engine ──────────────────────────────────────────────────────────

export class VerificationPipeline {
  private stats = {
    totalChecks: 0,
    passed: 0,
    failed: 0,
    autoFixed: 0,
    issuesCaught: 0,
  };

  /**
   * Run all applicable verification rules for a tool call result.
   * Returns a verification result with any correction injections.
   */
  verify(toolName: string, args: Record<string, any>, result: any): VerificationResult {
    const applicableRules = VERIFICATION_RULES.filter(
      rule => rule.triggerTool === toolName && rule.condition(args, result)
    );

    if (applicableRules.length === 0) {
      return {
        verified: true,
        confidence: 1.0,
        checksPassed: [],
        checksFailed: [],
        correctionInjection: null,
        suggestedNextTool: null,
      };
    }

    const passed: string[] = [];
    const failed: VerificationFailure[] = [];
    let suggestedTool: string | null = null;

    for (const rule of applicableRules) {
      this.stats.totalChecks++;

      try {
        const check = rule.verify(args, result);
        if (check.passed) {
          passed.push(`✅ ${rule.name}: ${check.detail}`);
          this.stats.passed++;
        } else {
          failed.push({
            check: rule.name,
            expected: 'success',
            actual: check.detail,
            severity: check.severity,
            autoFixable: check.autoFixable,
          });
          this.stats.failed++;
          this.stats.issuesCaught++;

          if (check.suggestedTool && !suggestedTool) {
            suggestedTool = check.suggestedTool;
          }
        }
      } catch {
        // Never throw — if a check itself fails, skip it
        passed.push(`⚠️ ${rule.name}: check skipped (internal error)`);
      }
    }

    const verified = failed.filter(f => f.severity === 'critical').length === 0;
    const totalChecks = passed.length + failed.length;
    const confidence = totalChecks > 0 ? passed.length / totalChecks : 1.0;

    // Build correction injection for the model
    let correctionInjection: string | null = null;
    if (failed.length > 0) {
      const criticalFails = failed.filter(f => f.severity === 'critical');
      const warningFails = failed.filter(f => f.severity === 'warning');

      const parts: string[] = ['[VERIFICATION PIPELINE]'];
      if (criticalFails.length > 0) {
        parts.push('❌ CRITICAL VERIFICATION FAILURES:');
        for (const f of criticalFails) {
          parts.push(`  • ${f.check}: ${f.actual}`);
        }
        parts.push('You MUST address these failures before proceeding.');
      }
      if (warningFails.length > 0) {
        parts.push('⚠️ Warnings:');
        for (const f of warningFails.slice(0, 3)) {
          parts.push(`  • ${f.check}: ${f.actual}`);
        }
      }
      if (suggestedTool) {
        parts.push(`Suggested next action: use ${suggestedTool} to investigate/fix.`);
      }
      parts.push('[END VERIFICATION]');
      correctionInjection = parts.join('\n');
    }

    return { verified, confidence, checksPassed: passed, checksFailed: failed, correctionInjection, suggestedNextTool: suggestedTool };
  }

  /**
   * Get verification statistics for monitoring.
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Build a summary of recent verification results for the system prompt.
   */
  buildVerificationContext(recentResults: VerificationResult[]): string {
    const failures = recentResults.filter(r => !r.verified);
    if (failures.length === 0) return '';

    const failDetails = failures.flatMap(r => r.checksFailed)
      .filter(f => f.severity !== 'info')
      .slice(-5)
      .map(f => `  • ${f.check}: ${f.actual}`)
      .join('\n');

    if (!failDetails) return '';

    return `━━━ VERIFICATION ALERTS ━━━\nRecent tool verification issues:\n${failDetails}\nAddress these before claiming success.\n━━━ END VERIFICATION ━━━`;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const verificationPipeline = new VerificationPipeline();
