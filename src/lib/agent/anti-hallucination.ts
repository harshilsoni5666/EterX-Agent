/**
 * ═══════════════════════════════════════════════════════════════
 * ANTI-HALLUCINATION GUARD — Catches Fabricated Agent Results
 * ═══════════════════════════════════════════════════════════════
 *
 * The agent's last line of defense against making things up.
 * Every tool call result gets verified against what the agent
 * CLAIMS it did. Every final answer gets cross-referenced against
 * the actual session ledger of files and commands.
 *
 * Design principles:
 *   • NEVER throw — all methods return results, never exceptions
 *   • FAST — no I/O, no async for verification methods
 *   • CONSERVATIVE — only flag clear violations, not borderline cases
 *   • LOGGED — every violation gets a console warning for observability
 *
 * Integration points:
 *   • Called after every tool call in the ReAct loop (verifyToolResult)
 *   • Called before emitting final response (verifyFinalAnswer)
 *   • Called on retry escalation (generateUncertaintyPrompt)
 *   • Called on agent text output (checkForGuessing)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HallucinationCheckResult {
  passed: boolean;
  violations: Array<{
    type: 'fake_file' | 'fake_success' | 'fake_command' | 'unclaimed_action' | 'missing_verification';
    detail: string;
    severity: 'warning' | 'critical';
  }>;
  correctionPrompt: string | null;
}

interface Violation {
  type: 'fake_file' | 'fake_success' | 'fake_command' | 'unclaimed_action' | 'missing_verification';
  detail: string;
  severity: 'warning' | 'critical';
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Patterns that indicate the agent is claiming an action succeeded */
const SUCCESS_CLAIM_PATTERNS: RegExp[] = [
  /\b(?:successfully|completed|done|finished|created|installed|built|fixed|resolved|applied|saved|wrote|generated|deployed)\b/i,
];

/** Patterns that extract action verbs the agent uses to claim it did something */
const ACTION_CLAIM_REGEX = /\bI\s+(created|installed|ran|built|fixed|resolved|wrote|generated|updated|deleted|configured|set\s+up|deployed|downloaded|compiled|started|stopped|modified|edited|added|removed|implemented|refactored)\b/gi;

/**
 * File path extraction patterns.
 * Covers Unix paths, Windows paths, and quoted filenames with extensions.
 */
const FILE_PATH_PATTERNS: RegExp[] = [
  // Unix-style absolute paths: /path/to/file.ext
  /(?:^|\s|["'`(])(\/?(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,10})(?=[\s"'`),;:]|$)/gm,
  // Windows-style paths: C:\path\to\file.ext or C:/path/to/file.ext
  /([A-Za-z]:[\\\/](?:[\w .@-]+[\\\/])*[\w .@-]+\.\w{1,10})/g,
  // Quoted filenames with common extensions: "something.ts", 'report.xlsx'
  /["'`]([\w./@\\-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|hpp|css|scss|html|json|yaml|yml|toml|md|txt|csv|xlsx|pdf|sql|sh|bat|ps1|vue|svelte))["'`]/gi,
];

/** Words that indicate hedging / guessing */
const HEDGING_WORDS: string[] = [
  'probably',
  'likely',
  'i think',
  'might be',
  'should be',
  'i believe',
  'i assume',
  'perhaps',
  'possibly',
  'it seems',
  'it appears',
  'i\'m not sure',
  'i\'m guessing',
  'my guess is',
  'presumably',
  'i suspect',
];

/** Patterns for fabricated specifics (exact numbers/percentages without tool evidence) */
const FABRICATED_SPECIFIC_PATTERNS: RegExp[] = [
  // Exact percentages in a claim context: "improved performance by 47%"
  /\b(?:improved|reduced|increased|boosted|optimized)\b.{0,30}\b\d{2,}(?:\.\d+)?%/gi,
  // Made-up URLs (not in code blocks)
  /https?:\/\/(?:example\.com|your-domain|my-app|test-site|placeholder|localhost:\d{4,5}\/api)\b/gi,
];

/** Tools that execute commands and have exit codes */
const COMMAND_TOOLS = new Set([
  'workspace_run_command',
]);

/** Tools that write or create files */
const FILE_WRITE_TOOLS = new Set([
  'workspace_edit_file',
]);

// ─── Utility helpers ──────────────────────────────────────────────────────────

function extractErrorFromResult(result: any): string | null {
  if (!result) return null;
  if (typeof result === 'string') {
    const lower = result.toLowerCase();
    if (lower.includes('error') || lower.includes('failed') || lower.includes('denied') || lower.includes('not found')) {
      return result.substring(0, 300);
    }
    return null;
  }
  if (result.error) return String(result.error).substring(0, 300);
  if (result._retryFailed) return String(result._retryFailed).substring(0, 300);
  if (result.stderr && !result.stdout && (result.exitCode !== 0 && result.exitCode !== null)) {
    return String(result.stderr).substring(0, 300);
  }
  return null;
}

function extractExitCode(result: any): number | null {
  if (!result || typeof result !== 'object') return null;
  if (typeof result.exitCode === 'number') return result.exitCode;
  if (typeof result.code === 'number') return result.code;
  if (typeof result.exit_code === 'number') return result.exit_code;
  return null;
}

function workNoteLooksLikeSuccess(note: string): boolean {
  const lower = note.toLowerCase();
  return SUCCESS_CLAIM_PATTERNS.some(p => p.test(lower));
}

function workNoteLooksLikeAction(note: string, actionVerb: string): boolean {
  return note.toLowerCase().includes(actionVerb.toLowerCase());
}

function isDestructiveOrDangerousCommand(cmd: string): boolean {
  const cleanCmd = cmd.toLowerCase().trim();
  if (/\brm\s+-rf\s+\/(?:\s+|$)/i.test(cleanCmd) || /\bdel\s+\/f\s+\/s\s+\/q\s+[a-z]:\\/i.test(cleanCmd)) {
    return true;
  }
  if (/\.\.[\\/]\.\.[\\/]\.\.[\\/]\.\.[\\/]/.test(cleanCmd)) {
    return true;
  }
  return false;
}

function extractFilePaths(text: string): Set<string> {
  const paths = new Set<string>();
  for (const pattern of FILE_PATH_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const filePath = (match[1] || match[0]).trim();
      // Filter out very short matches and common false positives
      if (filePath.length < 4) continue;
      if (/^(e\.g|i\.e|vs\.|etc\.|fig\.)$/i.test(filePath)) continue;
      paths.add(filePath);
    }
  }
  return paths;
}

function normalizeFilePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

function filePathsMatch(mentioned: string, actual: string): boolean {
  const a = normalizeFilePath(mentioned);
  const b = normalizeFilePath(actual);
  // Exact match
  if (a === b) return true;
  // Basename match (agent might say "report.xlsx" and ledger has full path)
  const aBase = a.split('/').pop() || '';
  const bBase = b.split('/').pop() || '';
  if (aBase && aBase === bBase) return true;
  // Suffix match — "src/lib/foo.ts" matches "/full/path/src/lib/foo.ts"
  if (b.endsWith(a) || a.endsWith(b)) return true;
  return false;
}

function extractActionClaims(text: string): string[] {
  const claims: string[] = [];
  ACTION_CLAIM_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ACTION_CLAIM_REGEX.exec(text)) !== null) {
    claims.push(match[1].toLowerCase().replace(/\s+/g, '_'));
  }
  return claims;
}

function buildCorrectionPrompt(violations: Violation[]): string {
  const criticals = violations.filter(v => v.severity === 'critical');
  const warnings = violations.filter(v => v.severity === 'warning');

  const parts: string[] = ['[SYSTEM — ANTI-HALLUCINATION GUARD]'];

  if (criticals.length > 0) {
    parts.push('CRITICAL VIOLATIONS DETECTED — your previous response contains fabricated claims:');
    for (const v of criticals) {
      parts.push(`  ❌ ${v.type}: ${v.detail}`);
    }
    parts.push('You MUST correct your response. Do NOT claim actions that did not happen.');
    parts.push('Correct any misleading user-visible claim once, then recover from the actual error. Follow WORK NOTES for useful updates; ask for help only when progress requires missing user input or authority.');
  }

  if (warnings.length > 0) {
    parts.push('Warnings:');
    for (const v of warnings) {
      parts.push(`  ⚠️ ${v.type}: ${v.detail}`);
    }
  }

  parts.push('[END ANTI-HALLUCINATION GUARD]');
  return parts.join('\n');
}

// ─── Main class ───────────────────────────────────────────────────────────────

class AntiHallucinationGuard {

  // ── 1. verifyToolResult ─────────────────────────────────────────────────────

  /**
   * Called after every tool call.
   * Checks if the agent's work note contradicts the tool's actual result.
   * Purely synchronous — no I/O.
   */
  public verifyToolResult(opts: {
    toolName: string;
    args: Record<string, any>;
    result: any;
    agentWorkNote: string;
  }): HallucinationCheckResult {
    const violations: Violation[] = [];

    try {
      const { toolName, args, result, agentWorkNote } = opts;
      const error = extractErrorFromResult(result);
      const exitCode = extractExitCode(result);
      const claimsSuccess = workNoteLooksLikeSuccess(agentWorkNote);

      // ── Check 1: Agent said "Creating file X" but tool returned error ──
      if (FILE_WRITE_TOOLS.has(toolName) && error && claimsSuccess) {
        const filename = args.filename || args.path || args.file || 'unknown';
        violations.push({
          type: 'fake_file',
          detail: `Agent claimed file "${filename}" was created/written, but tool ${toolName} FAILED with: "${error}"`,
          severity: 'critical',
        });
      }

      // ── Check 2: Agent said "Running command" but exit code != 0 ──
      if (COMMAND_TOOLS.has(toolName) && exitCode !== null && exitCode !== 0 && claimsSuccess) {
        const cmd = String(args.command || args.cmd || '').substring(0, 100);
        violations.push({
          type: 'fake_command',
          detail: `Agent claimed command succeeded, but "${cmd}" exited with code ${exitCode}`,
          severity: 'critical',
        });
      }

      // ── Check 2b: Pre-emptive safety command audit ──
      if (COMMAND_TOOLS.has(toolName)) {
        const cmd = String(args.command || args.cmd || args.CommandLine || '');
        if (isDestructiveOrDangerousCommand(cmd)) {
          violations.push({
            type: 'fake_command',
            detail: `Security/Safety check triggered: Prohibited dangerous command pattern detected: "${cmd.substring(0, 100)}"`,
            severity: 'critical',
          });
        }
      }

      // ── Check 3: Result has error field but agent note claims success ──
      if (error && claimsSuccess && !FILE_WRITE_TOOLS.has(toolName) && !COMMAND_TOOLS.has(toolName)) {
        violations.push({
          type: 'fake_success',
          detail: `Tool ${toolName} returned error "${error}" but agent claimed success`,
          severity: 'critical',
        });
      }

      // Log violations
      for (const v of violations) {
        console.warn(`[AntiHallucination] ⚠️ VIOLATION: ${v.type} — ${v.detail}`);
      }
    } catch {
      // Never throw — if our checker itself fails, silently pass
    }

    const correctionPrompt = violations.length > 0
      ? `[SYSTEM - TOOL VERIFICATION FAILED] The tool ${opts.toolName} FAILED with error: "${extractErrorFromResult(opts.result) || 'unknown'}". You CANNOT claim this action succeeded. Correct any misleading user-visible claim once, then recover from the actual error. Follow WORK NOTES for useful updates; ask for help only when progress requires missing user input or authority.`
      : null;

    return {
      passed: violations.length === 0,
      violations,
      correctionPrompt,
    };
  }

  // ── 2. verifyFinalAnswer ────────────────────────────────────────────────────

  /**
   * Called before emitting the agent's final response.
   * Cross-references claimed files and actions against the actual session ledger.
   * Purely synchronous — no I/O.
   */
  public verifyFinalAnswer(opts: {
    answer: string;
    filesCreated: Set<string>;
    commandsRun: string[];
    toolResultDigest: Array<{ tool: string; result: string }>;
  }): HallucinationCheckResult {
    const violations: Violation[] = [];

    try {
      const { answer, filesCreated, commandsRun, toolResultDigest } = opts;

      // ── Check A: File paths mentioned but never created ──
      const mentionedPaths = extractFilePaths(answer);
      const createdArray = Array.from(filesCreated);

      for (const mentioned of mentionedPaths) {
        // Skip if the agent is just referencing existing files (reading/analyzing)
        // We only flag if the agent says "I created" or "I wrote" near the path mention
        const mentionedIdx = answer.indexOf(mentioned);
        if (mentionedIdx < 0) continue;

        // Get surrounding context (200 chars before the path mention)
        const contextBefore = answer.substring(Math.max(0, mentionedIdx - 200), mentionedIdx).toLowerCase();
        const claimsCreation = /\b(created|wrote|generated|saved|built|produced|output)\b/.test(contextBefore);

        if (!claimsCreation) continue; // Not claiming creation — skip

        const matchesAny = createdArray.some(actual => filePathsMatch(mentioned, actual));
        if (!matchesAny) {
          violations.push({
            type: 'fake_file',
            detail: `Agent claimed to have created/written "${mentioned}" but this file is NOT in the session ledger`,
            severity: 'critical',
          });
        }
      }

      // ── Check B: Action claims without supporting tool evidence ──
      const actionClaims = extractActionClaims(answer);
      const digestStr = toolResultDigest.map(d => `${d.tool}:${d.result}`).join(' ').toLowerCase();
      const commandsStr = commandsRun.join(' ').toLowerCase();
      const evidenceStr = `${digestStr} ${commandsStr}`;

      for (const claim of actionClaims) {
        let hasEvidence = false;

        switch (claim) {
          case 'installed':
            hasEvidence = evidenceStr.includes('install') || evidenceStr.includes('npm') ||
                          evidenceStr.includes('pip') || evidenceStr.includes('apt') ||
                          evidenceStr.includes('brew') || evidenceStr.includes('yarn') ||
                          evidenceStr.includes('pnpm') || evidenceStr.includes('cargo');
            break;
          case 'ran':
            hasEvidence = commandsRun.length > 0;
            break;
          case 'built':
          case 'compiled':
            hasEvidence = evidenceStr.includes('build') || evidenceStr.includes('compile') ||
                          evidenceStr.includes('tsc') || evidenceStr.includes('webpack') ||
                          evidenceStr.includes('vite') || evidenceStr.includes('esbuild');
            break;
          case 'deployed':
            hasEvidence = evidenceStr.includes('deploy') || evidenceStr.includes('publish') ||
                          evidenceStr.includes('push');
            break;
          case 'downloaded':
            hasEvidence = evidenceStr.includes('download') || evidenceStr.includes('fetch') ||
                          evidenceStr.includes('curl') || evidenceStr.includes('wget');
            break;
          case 'started':
          case 'stopped':
            hasEvidence = evidenceStr.includes('start') || evidenceStr.includes('stop') ||
                          evidenceStr.includes('kill') || evidenceStr.includes('server');
            break;
          default:
            // For created/wrote/edited/updated/etc — check file ledger
            hasEvidence = filesCreated.size > 0 || evidenceStr.includes(claim);
            break;
        }

        if (!hasEvidence) {
          violations.push({
            type: 'unclaimed_action',
            detail: `Agent claimed "I ${claim}" but no supporting tool call or command was found in session evidence`,
            severity: 'warning',
          });
        }
      }

      // ── Check C: Code modification without verification (Missing Verification Gate) ──
      const editedCodeFiles = Array.from(filesCreated).filter(f => /\.(tsx?|jsx?|py|rs|go)$/i.test(f));
      if (editedCodeFiles.length > 0) {
        const hasVerificationEvidence = toolResultDigest.some(d => 
          /test|lint|compile|tsc|verify|check|run_command|run-script/i.test(d.tool) ||
          /test|lint|compile|tsc|run/i.test(d.result.toLowerCase())
        );
        if (!hasVerificationEvidence) {
          violations.push({
            type: 'missing_verification',
            detail: `You modified code files [${editedCodeFiles.join(', ')}] but have not run any compiler, linter, or tests to verify them. Please run verification.`,
            severity: 'critical',
          });
        }
      }

      // Log violations
      for (const v of violations) {
        console.warn(`[AntiHallucination] ⚠️ VIOLATION: ${v.type} — ${v.detail}`);
      }
    } catch {
      // Never throw
    }

    const correctionPrompt = violations.length > 0 ? buildCorrectionPrompt(violations) : null;

    return {
      passed: violations.length === 0,
      violations,
      correctionPrompt,
    };
  }

  // ── 3. generateUncertaintyPrompt ────────────────────────────────────────────

  /**
   * Generates an autonomous recovery prompt when a tool keeps failing.
   * Repeated failures are not a reason to interrupt the user: the agent must
   * change strategy, inspect live connector state, and keep working first.
   */
  public generateUncertaintyPrompt(opts: {
    toolName: string;
    error: string;
    retryCount: number;
  }): string {
    const { toolName, error, retryCount } = opts;

    if (retryCount < 2) {
      // Early failures get a small recovery hint and do not interrupt work.
      return `[SYSTEM — RETRY NOTE] Tool ${toolName} failed (attempt ${retryCount + 1}): "${error.substring(0, 150)}". Consider changing your approach if the next attempt also fails.`;
    }

    console.warn(`[AntiHallucination] ⚠️ Tool ${toolName} has failed ${retryCount} times — switching to autonomous recovery`);

    return [
      `[SYSTEM — AUTONOMOUS RECOVERY]`,
      `Tool ${toolName} has failed ${retryCount} times with error: "${error.substring(0, 200)}".`,
      `Do not call ask_user just because this tool failed. Do not repeat the same approach.`,
      `Change strategy autonomously: inspect current state, use the connector or Gateway discovery/status tool when relevant, try a safe alternate route, and verify the result.`,
      `Follow WORK NOTES and the user's communication preferences: explain a consequential obstacle or changed approach once when useful, without narrating each retry or repeating an unchanged update. A recovery notice alone does not require a work note. Ask only if a secret, irreversible consent, or genuinely irreducible decision is required after safe alternatives are exhausted.`,
      `[END AUTONOMOUS RECOVERY]`,
    ].join('\n');
  }

  // ── 4. checkForGuessing ─────────────────────────────────────────────────────

  /**
   * Lightweight check on agent text output for hedging language
   * and fabricated specifics. No I/O, no async.
   */
  public checkForGuessing(text: string): {
    isGuessing: boolean;
    indicators: string[];
  } {
    const indicators: string[] = [];

    try {
      const lower = text.toLowerCase();

      // ── Hedging language detection ──
      for (const hedge of HEDGING_WORDS) {
        if (lower.includes(hedge)) {
          indicators.push(`hedging: "${hedge}"`);
        }
      }

      // ── Fabricated specifics detection ──
      for (const pattern of FABRICATED_SPECIFIC_PATTERNS) {
        pattern.lastIndex = 0;
        const match = pattern.exec(text);
        if (match) {
          indicators.push(`fabricated_specific: "${match[0].substring(0, 60)}"`);
        }
      }

      // Log if significant guessing detected
      if (indicators.length >= 2) {
        console.warn(`[AntiHallucination] 🔍 Guessing detected (${indicators.length} indicators): ${indicators.slice(0, 3).join(', ')}`);
      }
    } catch {
      // Never throw
    }

    return {
      isGuessing: indicators.length >= 2,
      indicators,
    };
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const antiHallucination = new AntiHallucinationGuard();
