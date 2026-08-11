/**
 * ═══════════════════════════════════════════════════════════════
 * ETERX CONVERSATION LEDGER — Per-Chat Structured Action Log
 * ═══════════════════════════════════════════════════════════════
 *
 * The most important new file in the agent overhaul.
 * An append-only, per-chat structured log of everything the agent
 * does during a conversation — tool calls, file operations, commands,
 * searches, facts learned, decisions, and milestones.
 *
 * Purpose:
 *   • Prevents the agent from re-doing work it already completed
 *   • Provides compact, prioritised summaries for LLM context injection
 *   • Enables smart deduplication of tool calls
 *   • Crash-safe JSONL storage with in-memory hot cache
 *
 * Storage:
 *   .workspaces/.session/{chatId}/ledger.jsonl
 *
 * Architecture:
 *   • JSONL append-only writes (crash-safe, never corrupts existing data)
 *   • In-memory hot cache capped at 3,000 entries
 *   • Debounced flush to disk every 1.5 seconds
 *   • Fire-and-forget public API — NEVER throws
 */

import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { getEterxWorkspaceDir } from '../storage-paths';
import { stableScopeSegment } from '../context-scope';

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_DIR = getEterxWorkspaceDir('.session');
const MAX_ENTRIES = 3_000;
const FLUSH_DEBOUNCE_MS = 1_500;
const MAX_KEY_FACTS = 5;
const MAX_SUMMARY_CHARS = 200;
/** Maximum number of per-chat ledger instances to keep in the LRU. */
const MAX_LEDGER_INSTANCES = 30;

const FILLER_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'in', 'to', 'is',
  'it', 'that', 'this', 'with', 'on', 'at', 'by', 'from', 'as',
  'be', 'was', 'are', 'were', 'been', 'being', 'have', 'has', 'had',
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export type LedgerEntryType =
  | 'tool_call'
  | 'tool_result'
  | 'file_create'
  | 'file_edit'
  | 'command'
  | 'search'
  | 'fact'
  | 'error'
  | 'decision'
  | 'milestone';

export interface LedgerEntry {
  id: string;
  ts: number;
  chatId: string;
  type: LedgerEntryType;
  toolName: string;
  argsDigest: Record<string, any>;
  resultDigest: {
    status: 'success' | 'error' | 'cached';
    keyFacts: string[];
    filePaths: string[];
    summary: string;
  };
  importance: number;
  iteration: number;
}

export interface RecordToolCallOpts {
  chatId: string;
  toolName: string;
  args: Record<string, any>;
  result: any;
  iteration: number;
  durationMs: number;
}

export interface BuildContextSummaryOpts {
  maxTokens?: number;
  includeFiles?: boolean;
  includeCommands?: boolean;
  includeSearchResults?: boolean;
  excludeLastN?: number;
}

// ─── Helper utilities ─────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID().substring(0, 16);
}

function clampImportance(value: number): number {
  return Math.min(10, Math.max(0, value));
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.substring(0, max - 3) + '...' : clean;
}

function normalizePath(filePath: string): string {
  return String(filePath || '').replace(/\\/g, '/').toLowerCase();
}

function extractBasename(filePath: string): string {
  return String(filePath || '').split(/[/\\]/).pop() || filePath;
}

function safeStringify(value: any, maxLen = 300): string {
  try {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.substring(0, maxLen);
    return JSON.stringify(value).substring(0, maxLen);
  } catch {
    return String(value).substring(0, maxLen);
  }
}

// ─── Main class ───────────────────────────────────────────────────────────────

export class ConversationLedger {
  private entries: LedgerEntry[] = [];
  private currentChatId: string | null = null;
  private ledgerFilePath: string | null = null;
  private initialized = false;

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPending = false;
  private pendingWrites: string[] = [];

  // Deduplication cache: normalized key → entry id
  private dedupCache: Map<string, string> = new Map();

  // ── Initialization ──────────────────────────────────────────────────────────

  /**
   * Load or create a ledger for the given chat.
   * Safe to call multiple times — will no-op if already loaded for the same chatId.
   */
  public async initialize(chatId: string): Promise<void> {
    try {
      if (this.initialized && this.currentChatId === chatId) return;

      this.currentChatId = chatId;
      const scopedId = stableScopeSegment(chatId);
      const legacyId = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const chatDir = path.join(SESSION_DIR, scopedId);
      const legacyChatDir = path.join(SESSION_DIR, legacyId);
      this.ledgerFilePath = path.join(chatDir, 'ledger.jsonl');
      const legacyLedgerFilePath = path.join(legacyChatDir, 'ledger.jsonl');

      await fs.ensureDir(chatDir);

      // Load existing entries from disk
      this.entries = [];
      this.dedupCache.clear();
      this.pendingWrites = [];

      const readableLedgerPath = await fs.pathExists(this.ledgerFilePath)
        ? this.ledgerFilePath
        : (legacyLedgerFilePath !== this.ledgerFilePath && await fs.pathExists(legacyLedgerFilePath)
          ? legacyLedgerFilePath
          : null);
      if (readableLedgerPath) {
        try {
          const content = await fs.readFile(readableLedgerPath, 'utf8');
          const lines = content.trim().split('\n').filter(Boolean);
          // Only load the last MAX_ENTRIES lines
          const tail = lines.slice(-MAX_ENTRIES);
          for (const line of tail) {
            try {
              const entry = JSON.parse(line) as LedgerEntry;
              // Old sanitized directories could collide. The record identity
              // is the final ownership check before anything reaches memory.
              if (String(entry.chatId || '') !== chatId) continue;
              this.entries.push(entry);
              // Rebuild dedup cache
              const dedupKey = this.getDeduplicationKey(entry.toolName, entry.argsDigest);
              if (dedupKey) this.dedupCache.set(dedupKey, entry.id);
            } catch { /* skip corrupt lines */ }
          }
        } catch { /* file unreadable — start fresh */ }
      }

      this.initialized = true;
      console.log(`[ConversationLedger] 📒 Initialized for chat ${chatId.substring(0, 8)}… — ${this.entries.length} entries loaded`);
    } catch (err: any) {
      console.warn(`[ConversationLedger] ⚠️ Init failed: ${err.message}. Starting fresh.`);
      this.entries = [];
      this.dedupCache.clear();
      this.initialized = true;
    }
  }

  // ── Core recording ──────────────────────────────────────────────────────────

  /**
   * Append a raw entry to the ledger.
   * Fire-and-forget — NEVER throws.
   */
  public record(partial: Omit<LedgerEntry, 'id' | 'ts'>): void {
    try {
      const entry: LedgerEntry = {
        id: generateId(),
        ts: Date.now(),
        chatId: partial.chatId || this.currentChatId || '',
        type: partial.type,
        toolName: partial.toolName || '',
        argsDigest: partial.argsDigest || {},
        resultDigest: {
          status: partial.resultDigest?.status || 'success',
          keyFacts: (partial.resultDigest?.keyFacts || []).slice(0, MAX_KEY_FACTS),
          filePaths: partial.resultDigest?.filePaths || [],
          summary: truncate(partial.resultDigest?.summary || '', MAX_SUMMARY_CHARS),
        },
        importance: clampImportance(partial.importance ?? 5),
        iteration: partial.iteration ?? 0,
      };

      this.entries.push(entry);

      // Cap hot cache
      if (this.entries.length > MAX_ENTRIES) {
        this.entries = this.entries.slice(-MAX_ENTRIES);
      }

      // Update dedup cache
      const dedupKey = this.getDeduplicationKey(entry.toolName, entry.argsDigest);
      if (dedupKey) this.dedupCache.set(dedupKey, entry.id);

      // Queue for disk write
      this.pendingWrites.push(JSON.stringify(entry));
      this.scheduleDiskFlush();
    } catch (err: any) {
      console.warn(`[ConversationLedger] ⚠️ record() failed: ${err.message}`);
    }
  }

  // ── Smart tool call recording ───────────────────────────────────────────────

  /**
   * Record a tool call with smart arg/result extraction.
   * Automatically determines entry type, importance, argsDigest, and resultDigest.
   * Fire-and-forget — NEVER throws.
   */
  public recordToolCall(opts: RecordToolCallOpts): void {
    try {
      const { chatId, toolName, args, result, iteration, durationMs } = opts;
      const hasError = !!(result?.error || result?._retryFailed);

      const argsDigest = this.extractArgsDigest(toolName, args);
      const resultDigest = this.extractResultDigest(toolName, args, result, hasError);
      const entryType = this.determineEntryType(toolName, hasError);
      const importance = this.autoImportance(toolName, hasError);

      this.record({
        chatId,
        type: entryType,
        toolName,
        argsDigest: { ...argsDigest, durationMs },
        resultDigest,
        importance,
        iteration,
      });
    } catch (err: any) {
      console.warn(`[ConversationLedger] ⚠️ recordToolCall() failed: ${err.message}`);
    }
  }

  // ── Arg extraction ──────────────────────────────────────────────────────────

  private extractArgsDigest(toolName: string, args: Record<string, any>): Record<string, any> {
    try {
      switch (toolName) {
        case 'workspace_write_file': {
          const content = String(args.content || '');
          return {
            filename: String(args.filename || args.path || ''),
            purpose: truncate(String(args.purpose || args.description || args.uiActionText || ''), 100),
            linesWritten: content.split('\n').length,
          };
        }

        case 'workspace_read_file': {
          return {
            filename: String(args.filename || args.path || ''),
          };
        }

        case 'workspace_edit_file': {
          return {
            filename: String(args.filename || args.path || ''),
            changeDescription: truncate(String(args.purpose || args.description || args.uiActionText || ''), 100),
          };
        }

        case 'system_shell':
        case 'workspace_run_command': {
          return {
            command: truncate(String(args.command || args.cmd || ''), 150),
            cwd: String(args.cwd || args.workingDirectory || ''),
          };
        }

        case 'web_search': {
          return {
            query: String(args.query || ''),
            action: String(args.action || 'search'),
          };
        }

        case 'get_skill_guidelines': {
          return {
            skillName: String(args.skill_name || args.skillName || ''),
          };
        }

        default: {
          // First 3 args as key-value pairs
          const keys = Object.keys(args || {}).slice(0, 3);
          const digest: Record<string, any> = {};
          for (const key of keys) {
            digest[key] = safeStringify(args[key], 100);
          }
          return digest;
        }
      }
    } catch {
      return {};
    }
  }

  // ── Result extraction ───────────────────────────────────────────────────────

  private extractResultDigest(
    toolName: string,
    args: Record<string, any>,
    result: any,
    hasError: boolean,
  ): LedgerEntry['resultDigest'] {
    try {
      const status: LedgerEntry['resultDigest']['status'] = hasError ? 'error' : 'success';
      const filePaths: string[] = [];
      const keyFacts: string[] = [];
      let summary = '';

      if (hasError) {
        const errorMsg = String(result?.error || result?.message || 'unknown error');
        summary = truncate(`Error: ${errorMsg}`, MAX_SUMMARY_CHARS);
        keyFacts.push(truncate(errorMsg, 100));
        return { status, keyFacts, filePaths, summary };
      }

      switch (toolName) {
        case 'workspace_read_file': {
          const content = String(result?.content || result || '');
          const filename = String(args.filename || args.path || '');
          filePaths.push(filename);

          // Extract key function names, exports, imports
          const lines = content.split('\n');
          const exports = lines
            .filter(l => /^export\s+(default\s+)?(function|class|const|let|var|interface|type|enum)\s+/i.test(l.trim()))
            .map(l => l.trim().substring(0, 80))
            .slice(0, 3);
          const imports = lines
            .filter(l => /^import\s+/i.test(l.trim()))
            .map(l => {
              const match = l.match(/from\s+['"]([^'"]+)['"]/);
              return match ? match[1] : '';
            })
            .filter(Boolean)
            .slice(0, 3);

          if (exports.length > 0) keyFacts.push(`Exports: ${exports.join(', ')}`);
          if (imports.length > 0) keyFacts.push(`Imports from: ${imports.join(', ')}`);
          keyFacts.push(`${lines.length} lines`);
          summary = truncate(`Read ${extractBasename(filename)} (${lines.length} lines)`, MAX_SUMMARY_CHARS);
          break;
        }

        case 'workspace_write_file': {
          const filename = String(args.filename || args.path || '');
          const content = String(args.content || '');
          const lineCount = content.split('\n').length;
          const purpose = String(args.purpose || args.description || '');
          filePaths.push(filename);
          keyFacts.push(`Created ${extractBasename(filename)}`);
          if (purpose) keyFacts.push(truncate(purpose, 80));
          keyFacts.push(`${lineCount} lines`);
          summary = truncate(`Created ${extractBasename(filename)} — ${purpose || 'new file'} (${lineCount} lines)`, MAX_SUMMARY_CHARS);
          break;
        }

        case 'workspace_edit_file': {
          const filename = String(args.filename || args.path || '');
          const change = String(args.purpose || args.description || args.uiActionText || '');
          filePaths.push(filename);
          keyFacts.push(`Edited ${extractBasename(filename)}`);
          if (change) keyFacts.push(truncate(change, 80));
          summary = truncate(`Edited ${extractBasename(filename)} — ${change || 'modified'}`, MAX_SUMMARY_CHARS);
          break;
        }

        case 'system_shell':
        case 'workspace_run_command': {
          const cmd = String(args.command || args.cmd || '');
          const output = String(result?.output || result?.stdout || result?.result || '');
          const stderr = String(result?.stderr || '');
          const exitCode = result?.exitCode ?? result?.code ?? null;
          const success = exitCode === 0 || exitCode === null;
          const icon = success ? '✅' : '❌';

          keyFacts.push(`Exit code: ${exitCode ?? 'unknown'}`);

          // Extract key output lines (non-empty, non-progress)
          const outputLines = output.split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 5 && !l.startsWith('[') && !l.includes('...'))
            .slice(0, 3);
          for (const line of outputLines) {
            keyFacts.push(truncate(line, 80));
          }

          if (!success && stderr) {
            keyFacts.push(truncate(`stderr: ${stderr}`, 80));
          }

          summary = truncate(`${icon} ${cmd.substring(0, 60)} → exit ${exitCode ?? '?'}`, MAX_SUMMARY_CHARS);
          break;
        }

        case 'web_search': {
          const query = String(args.query || '');
          // Extract top 3 result titles
          const results = Array.isArray(result?.results) ? result.results : [];
          const titles = results
            .slice(0, 3)
            .map((r: any) => String(r?.title || r?.name || '').substring(0, 60))
            .filter(Boolean);

          for (const title of titles) {
            keyFacts.push(title);
          }

          summary = truncate(`Searched: "${query}" — ${titles.length} results`, MAX_SUMMARY_CHARS);
          break;
        }

        case 'get_skill_guidelines': {
          const skillName = String(args.skill_name || args.skillName || '');
          keyFacts.push(`Loaded skill: ${skillName}`);
          summary = truncate(`Loaded skill guidelines: ${skillName}`, MAX_SUMMARY_CHARS);
          break;
        }

        default: {
          // Generic result extraction
          const resultStr = safeStringify(result, 400);
          summary = truncate(`${toolName} completed`, MAX_SUMMARY_CHARS);

          // Try to extract any file paths from the result
          const pathMatches = resultStr.match(/(?:[a-zA-Z]:)?[\\/][^\s"'<>|]+\.\w+/g);
          if (pathMatches) {
            filePaths.push(...pathMatches.slice(0, 3));
          }

          // First meaningful line of result as a fact
          const firstLine = resultStr.split('\n')[0]?.trim();
          if (firstLine && firstLine.length > 5) {
            keyFacts.push(truncate(firstLine, 80));
          }
          break;
        }
      }

      return {
        status,
        keyFacts: keyFacts.slice(0, MAX_KEY_FACTS),
        filePaths: filePaths.slice(0, 10),
        summary,
      };
    } catch {
      return {
        status: hasError ? 'error' : 'success',
        keyFacts: [],
        filePaths: [],
        summary: truncate(`${toolName} completed`, MAX_SUMMARY_CHARS),
      };
    }
  }

  // ── Entry type & importance inference ───────────────────────────────────────

  private determineEntryType(toolName: string, hasError: boolean): LedgerEntryType {
    if (hasError) return 'error';

    switch (toolName) {
      case 'workspace_write_file':
        return 'file_create';
      case 'workspace_edit_file':
        return 'file_edit';
      case 'system_shell':
      case 'workspace_run_command':
        return 'command';
      case 'web_search':
        return 'search';
      case 'workspace_read_file':
      case 'get_skill_guidelines':
        return 'tool_call';
      default:
        return 'tool_call';
    }
  }

  private autoImportance(toolName: string, hasError: boolean): number {
    if (hasError) return 7;

    switch (toolName) {
      case 'workspace_write_file':
        return 8;
      case 'workspace_edit_file':
        return 7;
      case 'system_shell':
      case 'workspace_run_command':
        return 6;
      case 'web_search':
        return 5;
      case 'workspace_read_file':
        return 4;
      case 'get_skill_guidelines':
        return 3;
      default:
        return 4;
    }
  }

  // ── Context summary generation ──────────────────────────────────────────────

  /**
   * Build a compact, prioritised summary of ledger entries for LLM context injection.
   * Entries are sorted by importance and grouped by type.
   */
  public buildContextSummary(opts: BuildContextSummaryOpts = {}): string {
    try {
      const {
        maxTokens = 2000,
        includeFiles = true,
        includeCommands = true,
        includeSearchResults = true,
        excludeLastN = 0,
      } = opts;

      if (this.entries.length === 0) return '';

      // Filter entries — exclude the last N if requested
      const sourceEntries = excludeLastN > 0
        ? this.entries.slice(0, -excludeLastN)
        : this.entries;

      if (sourceEntries.length === 0) return '';

      const parts: string[] = [];
      let estimatedChars = 0;
      const charBudget = maxTokens * 4; // rough tokens-to-chars

      // ── Files created ──
      if (includeFiles) {
        const fileCreates = sourceEntries.filter(e => e.type === 'file_create');
        const fileEdits = sourceEntries.filter(e => e.type === 'file_edit');

        if (fileCreates.length > 0 || fileEdits.length > 0) {
          const fileLines: string[] = [];

          // Deduplicate: show latest action per file path
          const seenFiles = new Set<string>();

          // The previous implementation concatenated importance-sorted creates
          // before edits, so an old create could hide the file's newer state.
          // Temporal order is authoritative when selecting the latest action.
          const latestFileActions = [...fileCreates, ...fileEdits]
            .sort((a, b) => b.ts - a.ts || b.importance - a.importance);
          for (const entry of latestFileActions) {
            const filename = String(
              entry.argsDigest.filename || entry.resultDigest.filePaths[0] || ''
            );
            const normalizedName = normalizePath(filename);
            if (seenFiles.has(normalizedName) || !filename) continue;
            seenFiles.add(normalizedName);

            const icon = entry.type === 'file_create' ? '📄' : '✏️';
            const action = entry.type === 'file_create' ? 'created' : 'edited';
            const line = `  ${fileLines.length + 1}. ${icon} ${extractBasename(filename)} — ${entry.resultDigest.summary || action} [importance: ${entry.importance}]`;
            fileLines.push(line);
            if (fileLines.length >= 15) break;
          }

          if (fileLines.length > 0) {
            parts.push(`📁 FILES CREATED/EDITED:\n${fileLines.join('\n')}`);
            estimatedChars += fileLines.join('\n').length + 30;
          }
        }
      }

      // ── Commands run ──
      if (includeCommands && estimatedChars < charBudget) {
        const commands = sourceEntries
          .filter(e => e.type === 'command')
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 10);

        if (commands.length > 0) {
          const cmdLines = commands.map((entry, i) => {
            const icon = entry.resultDigest.status === 'error' ? '❌' : '✅';
            const cmd = String(entry.argsDigest.command || entry.toolName);
            return `  ${i + 1}. ${icon} ${truncate(cmd, 60)} — ${entry.resultDigest.summary || 'completed'} [importance: ${entry.importance}]`;
          });
          parts.push(`💻 COMMANDS RUN:\n${cmdLines.join('\n')}`);
          estimatedChars += cmdLines.join('\n').length + 20;
        }
      }

      // ── Searches ──
      if (includeSearchResults && estimatedChars < charBudget) {
        const searches = sourceEntries
          .filter(e => e.type === 'search')
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 8);

        if (searches.length > 0) {
          const searchLines = searches.map((entry, i) => {
            const query = String(entry.argsDigest.query || '');
            const facts = entry.resultDigest.keyFacts.slice(0, 2).join(', ');
            return `  ${i + 1}. "${truncate(query, 50)}" — found: ${facts || 'results'} [importance: ${entry.importance}]`;
          });
          parts.push(`🔍 SEARCHES:\n${searchLines.join('\n')}`);
          estimatedChars += searchLines.join('\n').length + 15;
        }
      }

      // ── Facts learned ──
      if (estimatedChars < charBudget) {
        const facts = sourceEntries
          .filter(e => e.type === 'fact')
          .sort((a, b) => b.importance - a.importance || b.ts - a.ts)
          .slice(0, 8);

        // Also extract facts from tool results
        const allFacts: string[] = [];
        for (const f of facts) {
          if (f.resultDigest.summary) allFacts.push(f.resultDigest.summary);
        }

        // Collect keyFacts from high-importance entries
        for (const entry of sourceEntries) {
          if (entry.importance >= 6 && entry.resultDigest.keyFacts.length > 0) {
            for (const fact of entry.resultDigest.keyFacts) {
              if (fact && !allFacts.includes(fact) && allFacts.length < 10) {
                allFacts.push(fact);
              }
            }
          }
        }

        if (allFacts.length > 0) {
          const factLines = allFacts.slice(0, 8).map((f, i) => `  ${i + 1}. ${truncate(f, 100)}`);
          parts.push(`🧠 FACTS LEARNED:\n${factLines.join('\n')}`);
          estimatedChars += factLines.join('\n').length + 20;
        }
      }

      // ── Errors ──
      if (estimatedChars < charBudget) {
        const errors = sourceEntries
          .filter(e => e.type === 'error')
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 5);

        if (errors.length > 0) {
          const errLines = errors.map((entry, i) => {
            return `  ${i + 1}. ❌ ${entry.toolName}: ${entry.resultDigest.summary || 'error occurred'} [importance: ${entry.importance}]`;
          });
          parts.push(`⚠️ ERRORS ENCOUNTERED:\n${errLines.join('\n')}`);
        }
      }

      // ── Decisions & milestones ──
      if (estimatedChars < charBudget) {
        const decisions = sourceEntries
          .filter(e => e.type === 'decision' || e.type === 'milestone')
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 5);

        if (decisions.length > 0) {
          const decLines = decisions.map((entry, i) => {
            const icon = entry.type === 'milestone' ? '🏁' : '🤔';
            return `  ${i + 1}. ${icon} ${entry.resultDigest.summary || entry.toolName}`;
          });
          parts.push(`📌 DECISIONS/MILESTONES:\n${decLines.join('\n')}`);
        }
      }

      if (parts.length === 0) return '';

      return [
        '━━━ CONVERSATION LEDGER (what you already did) ━━━',
        ...parts,
        '⚠️ DO NOT repeat any of the above actions. Continue from the next step.',
        '━━━ END LEDGER ━━━',
      ].join('\n');
    } catch (err: any) {
      console.warn(`[ConversationLedger] ⚠️ buildContextSummary() failed: ${err.message}`);
      return '';
    }
  }

  // ── Deduplication ───────────────────────────────────────────────────────────

  /**
   * Returns a normalised key for detecting duplicate tool calls.
   * Different normalisation strategies per tool type.
   */
  public getDeduplicationKey(toolName: string, args: any): string {
    try {
      const safeArgs = args || {};

      switch (toolName) {
        // Search tools: lowercase, remove filler words
        case 'web_search': {
          const query = String(safeArgs.query || '')
            .toLowerCase()
            .split(/\s+/)
            .filter(w => !FILLER_WORDS.has(w) && w.length > 0)
            .sort()
            .join(' ');
          return `search:${query}`;
        }

        // File tools: normalize path separators, lowercase
        case 'workspace_read_file':
        case 'workspace_write_file':
        case 'workspace_edit_file': {
          const filename = normalizePath(String(safeArgs.filename || safeArgs.path || ''));
          return `${toolName}:${filename}`;
        }

        // Shell commands: extract base command, ignore flag ordering
        case 'system_shell':
        case 'workspace_run_command': {
          const cmd = String(safeArgs.command || safeArgs.cmd || '').trim();
          // Split into tokens, sort flags (tokens starting with -)
          const tokens = cmd.split(/\s+/);
          const baseCmd = tokens[0]?.toLowerCase() || '';
          const positionalArgs: string[] = [];
          const flags: string[] = [];

          for (let i = 1; i < tokens.length; i++) {
            if (tokens[i].startsWith('-')) {
              flags.push(tokens[i].toLowerCase());
            } else {
              positionalArgs.push(tokens[i].toLowerCase());
            }
          }

          // Check if any positional argument points to an existing file to include its size & mtime in the hash
          let fileSignatures = '';
          for (const arg of positionalArgs) {
            const cleanArg = arg.replace(/^["']|["']$/g, '');
            if (!cleanArg) continue;
            try {
              const resolved = path.isAbsolute(cleanArg) ? cleanArg : path.resolve(process.cwd(), cleanArg);
              if (fs.pathExistsSync(resolved)) {
                const stat = fs.lstatSync(resolved);
                if (stat.isFile()) {
                  fileSignatures += `_file:${cleanArg}:${stat.mtimeMs}:${stat.size}`;
                }
              }
            } catch {}
          }

          flags.sort();
          return `cmd:${baseCmd}:${positionalArgs.join(',')}:${flags.join(',')}${fileSignatures}`;
        }

        // Skill tools: just the skill name
        case 'get_skill_guidelines': {
          const skillName = String(safeArgs.skill_name || safeArgs.skillName || '').toLowerCase().trim();
          return `skill:${skillName}`;
        }

        default: {
          // Generic: tool name + sorted stringified keys
          const keys = Object.keys(safeArgs).sort();
          const parts = keys.slice(0, 3).map(k => `${k}=${safeStringify(safeArgs[k], 50)}`);
          return `${toolName}:${parts.join(',')}`;
        }
      }
    } catch {
      return '';
    }
  }

  /**
   * Check if an exact duplicate of this tool call was already made.
   */
  public isDuplicate(toolName: string, args: any): boolean {
    try {
      const key = this.getDeduplicationKey(toolName, args);
      if (!key) return false;
      return this.dedupCache.has(key);
    } catch {
      return false;
    }
  }

  // ── Query methods ───────────────────────────────────────────────────────────

  /** Returns list of files created in this session. */
  public getFilesCreated(): Array<{ filename: string; summary: string; importance: number; ts: number }> {
    try {
      const fileEntries = this.entries.filter(e => e.type === 'file_create');
      const seenFiles = new Set<string>();
      const result: Array<{ filename: string; summary: string; importance: number; ts: number }> = [];

      // Walk in reverse to get latest per file
      for (let i = fileEntries.length - 1; i >= 0; i--) {
        const entry = fileEntries[i];
        const filename = String(entry.argsDigest.filename || entry.resultDigest.filePaths[0] || '');
        const normalised = normalizePath(filename);
        if (seenFiles.has(normalised) || !filename) continue;
        seenFiles.add(normalised);
        result.push({
          filename,
          summary: entry.resultDigest.summary,
          importance: entry.importance,
          ts: entry.ts,
        });
      }

      return result.reverse(); // chronological order
    } catch {
      return [];
    }
  }

  /** Returns list of commands and their outcomes. */
  public getCommandsRun(): Array<{ command: string; status: string; summary: string; importance: number; ts: number }> {
    try {
      return this.entries
        .filter(e => e.type === 'command')
        .map(entry => ({
          command: String(entry.argsDigest.command || entry.toolName),
          status: entry.resultDigest.status,
          summary: entry.resultDigest.summary,
          importance: entry.importance,
          ts: entry.ts,
        }));
    } catch {
      return [];
    }
  }

  /** Returns all extracted facts from the ledger. */
  public getFactsLearned(): string[] {
    try {
      const facts: string[] = [];
      const seenFacts = new Set<string>();

      // Collect from fact-type entries
      for (const entry of this.entries) {
        if (entry.type === 'fact' && entry.resultDigest.summary) {
          const fact = entry.resultDigest.summary;
          const normalised = fact.toLowerCase().trim();
          if (!seenFacts.has(normalised)) {
            seenFacts.add(normalised);
            facts.push(fact);
          }
        }
      }

      // Collect keyFacts from high-importance entries
      for (const entry of this.entries) {
        if (entry.importance >= 7) {
          for (const fact of entry.resultDigest.keyFacts) {
            const normalised = fact.toLowerCase().trim();
            if (fact && !seenFacts.has(normalised)) {
              seenFacts.add(normalised);
              facts.push(fact);
            }
          }
        }
      }

      return facts;
    } catch {
      return [];
    }
  }

  /** Returns number of entries in the ledger. */
  public getEntryCount(): number {
    return this.entries.length;
  }

  // ── Clear ───────────────────────────────────────────────────────────────────

  /**
   * Clear the ledger for this chat.
   * Removes in-memory entries and deletes the JSONL file.
   */
  public async clear(): Promise<void> {
    try {
      this.entries = [];
      this.dedupCache.clear();
      this.pendingWrites = [];

      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
        this.flushPending = false;
      }

      if (this.ledgerFilePath && await fs.pathExists(this.ledgerFilePath)) {
        await fs.remove(this.ledgerFilePath);
      }

      console.log(`[ConversationLedger] 🗑️ Ledger cleared for chat ${this.currentChatId?.substring(0, 8) || 'unknown'}…`);
    } catch (err: any) {
      console.warn(`[ConversationLedger] ⚠️ clear() failed: ${err.message}`);
    }
  }

  // ── Flush control ───────────────────────────────────────────────────────────

  /**
   * Force flush any pending writes to disk immediately.
   * Called on graceful shutdown or chat switch.
   */
  public async flush(): Promise<void> {
    try {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      if (this.pendingWrites.length > 0) {
        await this.writeToDisk();
      }
    } catch (err: any) {
      console.warn(`[ConversationLedger] ⚠️ flush() failed: ${err.message}`);
    }
  }

  private scheduleDiskFlush(): void {
    this.flushPending = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.flushPending) {
        this.flushPending = false;
        this.writeToDisk().catch(() => {});
      }
    }, FLUSH_DEBOUNCE_MS);
  }

  private async writeToDisk(): Promise<void> {
    if (!this.ledgerFilePath || this.pendingWrites.length === 0) return;

    const toWrite = this.pendingWrites.splice(0);
    try {
      await fs.ensureDir(path.dirname(this.ledgerFilePath));
      await fs.appendFile(this.ledgerFilePath, toWrite.join('\n') + '\n', 'utf8');
    } catch (err: any) {
      console.warn(`[ConversationLedger] ⚠️ Disk write failed: ${err.message}`);
      // Re-queue failed writes for next attempt
      this.pendingWrites.unshift(...toWrite);
    }
  }
}

// ─── Per-chat instance registry ───────────────────────────────────────────────
// Each chat gets its own isolated ConversationLedger so that concurrent chats
// cannot overwrite each other's ledgerFilePath, entries, dedupCache, or
// pendingWrites.  An LRU of MAX_LEDGER_INSTANCES prevents unbounded memory use.

const _ledgerInstances: Map<string, ConversationLedger> = new Map();
const _ledgerAccessOrder: string[] = []; // front = oldest

/**
 * Return the ConversationLedger instance dedicated to `chatId`.
 * Creates and initializes a new one on first access.
 * Never throws — returns a fresh uninitialized instance on failure.
 */
export function getLedgerForChat(chatId: string): ConversationLedger {
  try {
    const existing = _ledgerInstances.get(chatId);
    if (existing) {
      // Refresh LRU position
      const idx = _ledgerAccessOrder.indexOf(chatId);
      if (idx !== -1) _ledgerAccessOrder.splice(idx, 1);
      _ledgerAccessOrder.push(chatId);
      return existing;
    }

    const instance = new ConversationLedger();
    _ledgerInstances.set(chatId, instance);
    _ledgerAccessOrder.push(chatId);

    // Evict oldest instance if over the LRU cap
    while (_ledgerAccessOrder.length > MAX_LEDGER_INSTANCES) {
      const oldest = _ledgerAccessOrder.shift();
      if (oldest) {
        const evicted = _ledgerInstances.get(oldest);
        if (evicted) {
          // Best-effort flush before eviction so no data is lost
          evicted.flush().catch(() => {});
        }
        _ledgerInstances.delete(oldest);
      }
    }

    return instance;
  } catch {
    return new ConversationLedger();
  }
}

/**
 * Force-flush the ledger for `chatId` to disk.
 * Safe to call from agent `finally` blocks — never throws.
 */
export async function flushLedgerForChat(chatId: string): Promise<void> {
  try {
    const instance = _ledgerInstances.get(chatId);
    if (instance) await instance.flush();
  } catch { /* never throw from a finally block */ }
}

/**
 * Flush then clear the ledger for `chatId`.
 * Guarantees no pending writes are discarded before clearing.
 */
export async function clearLedgerForChat(chatId: string): Promise<void> {
  try {
    const instance = _ledgerInstances.get(chatId);
    if (instance) {
      await instance.flush();  // write everything pending FIRST
      await instance.clear();
    }
  } catch { /* advisory — never throw */ }
}

// ─── Backward-compat shim ─────────────────────────────────────────────────────
// Code that uses the old `conversationLedger` singleton still works.
// It delegates to the most-recently-initialized per-chat instance, or to
// a dedicated fallback instance if no chat has been initialized yet.
const _fallbackLedger = new ConversationLedger();

export const conversationLedger: ConversationLedger = new Proxy(_fallbackLedger, {
  get(target, prop) {
    if (prop === 'initialize') {
      return async function(chatId: string) {
        const inst = getLedgerForChat(chatId);
        return inst.initialize(chatId);
      };
    }
    // Walk the LRU from newest to oldest to find the active instance
    for (let i = _ledgerAccessOrder.length - 1; i >= 0; i--) {
      const inst = _ledgerInstances.get(_ledgerAccessOrder[i]);
      if (inst) return (inst as any)[prop];
    }
    return (target as any)[prop];
  },
});
