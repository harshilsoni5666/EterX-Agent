/**
 * Edit Session Tracker — tracks all file edits during a coding session.
 * Supports undo, checkpoints, rollback, and compact session summaries
 * for long-task context compression.
 */
import fs from 'fs/promises';
import fse from 'fs-extra';
import crypto from 'crypto';
import path from 'path';

export interface EditRecord {
  id: string;
  filePath: string;
  timestamp: number;
  /** Content hash before edit */
  beforeHash: string;
  /** Content hash after edit */
  afterHash: string;
  /** Full content before edit (for undo) */
  beforeContent: string;
  /** Compact diff snippet for display */
  diffSnippet: string;
  /** Tool that made the edit */
  toolName: string;
  /** Number of lines changed */
  linesChanged: number;
  /** Edit type: replace, insert, delete, patch, create, multi */
  editType: string;
}

export interface SessionCheckpoint {
  name: string;
  timestamp: number;
  editIndex: number;
  /** Map of filePath -> content at checkpoint time */
  fileSnapshots: Map<string, string>;
}

const MAX_EDITS = 200;
const MAX_BEFORE_CONTENT_SIZE = 512 * 1024; // 512KB max per before-content
const MAX_DIFF_SNIPPET_LENGTH = 800;

class EditSessionTracker {
  private edits: EditRecord[] = [];
  private checkpoints: Map<string, SessionCheckpoint> = new Map();
  private sessionStartTime: number = Date.now();

  /**
   * Record a file edit. Called by edit tools after successful writes.
   */
  recordEdit(opts: {
    filePath: string;
    beforeContent: string;
    afterContent: string;
    toolName: string;
    editType?: string;
  }): EditRecord {
    const { filePath, beforeContent, afterContent, toolName, editType } = opts;

    // Prune oldest if at capacity
    if (this.edits.length >= MAX_EDITS) {
      // Remove oldest, but keep beforeContent of most recent per file
      const oldest = this.edits.shift();
      if (oldest) {
        console.log(`[EditTracker] Pruned oldest edit: ${oldest.filePath}`);
      }
    }

    const beforeLines = beforeContent.split('\n');
    const afterLines = afterContent.split('\n');
    const linesChanged = Math.abs(afterLines.length - beforeLines.length) +
      countDifferingLines(beforeLines, afterLines);

    const record: EditRecord = {
      id: `edit_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      filePath,
      timestamp: Date.now(),
      beforeHash: hashContent(beforeContent),
      afterHash: hashContent(afterContent),
      beforeContent: beforeContent.length <= MAX_BEFORE_CONTENT_SIZE
        ? beforeContent
        : beforeContent.slice(0, MAX_BEFORE_CONTENT_SIZE),
      diffSnippet: buildCompactDiff(beforeContent, afterContent, MAX_DIFF_SNIPPET_LENGTH),
      toolName,
      linesChanged,
      editType: editType || 'replace',
    };

    this.edits.push(record);
    return record;
  }

  /**
   * Get all edits for a specific file.
   */
  getFileHistory(filePath: string): EditRecord[] {
    return this.edits.filter(e => normalizePath(e.filePath) === normalizePath(filePath));
  }

  /**
   * Get compact summary of all edits in this session.
   * Used for context injection in long loops.
   */
  getEditSummary(): {
    totalEdits: number;
    filesChanged: string[];
    summary: string;
    edits: Array<{ file: string; tool: string; lines: number; time: string }>;
  } {
    const fileMap = new Map<string, { edits: number; totalLines: number; lastTool: string; lastTime: number }>();

    for (const edit of this.edits) {
      const key = normalizePath(edit.filePath);
      const existing = fileMap.get(key) || { edits: 0, totalLines: 0, lastTool: '', lastTime: 0 };
      existing.edits++;
      existing.totalLines += edit.linesChanged;
      existing.lastTool = edit.toolName;
      existing.lastTime = edit.timestamp;
      fileMap.set(key, existing);
    }

    const filesChanged = Array.from(fileMap.keys());
    const editDetails = Array.from(fileMap.entries()).map(([file, info]) => ({
      file: shortenPath(file),
      tool: info.lastTool,
      lines: info.totalLines,
      time: timeAgo(info.lastTime),
    }));

    const summaryLines = editDetails.map(e =>
      `  ${e.file}: ${e.lines} lines via ${e.tool} (${e.time})`
    );

    return {
      totalEdits: this.edits.length,
      filesChanged,
      summary: `Session: ${this.edits.length} edits across ${filesChanged.length} files\n${summaryLines.join('\n')}`,
      edits: editDetails,
    };
  }

  /**
   * Undo the last edit to a specific file.
   * Returns the restored content or null if no edit found.
   */
  async undoLastEdit(filePath: string): Promise<{ success: boolean; message: string; restoredContent?: string }> {
    const normalized = normalizePath(filePath);
    const fileEdits = this.edits.filter(e => normalizePath(e.filePath) === normalized);

    if (fileEdits.length === 0) {
      return { success: false, message: `No edits recorded for ${filePath}` };
    }

    const lastEdit = fileEdits[fileEdits.length - 1];
    if (!lastEdit.beforeContent) {
      return { success: false, message: `Before-content was too large to store for undo` };
    }

    try {
      await fs.writeFile(lastEdit.filePath, lastEdit.beforeContent, 'utf-8');
      // Remove this edit from history
      const idx = this.edits.indexOf(lastEdit);
      if (idx >= 0) this.edits.splice(idx, 1);
      return {
        success: true,
        message: `Reverted ${shortenPath(filePath)} to state before ${lastEdit.toolName} (${lastEdit.linesChanged} lines)`,
        restoredContent: lastEdit.beforeContent.slice(0, 500),
      };
    } catch (err: any) {
      return { success: false, message: `Undo failed: ${err.message}` };
    }
  }

  /**
   * Create a named checkpoint of current file states.
   */
  async createCheckpoint(name: string, filePaths?: string[]): Promise<{ success: boolean; message: string }> {
    const paths = filePaths || this.getChangedFilePaths();
    const snapshots = new Map<string, string>();

    for (const fp of paths) {
      try {
        if (await fse.pathExists(fp)) {
          snapshots.set(fp, await fs.readFile(fp, 'utf-8'));
        }
      } catch { /* skip unreadable */ }
    }

    this.checkpoints.set(name, {
      name,
      timestamp: Date.now(),
      editIndex: this.edits.length,
      fileSnapshots: snapshots,
    });

    return {
      success: true,
      message: `Checkpoint "${name}" created with ${snapshots.size} file snapshots at edit #${this.edits.length}`,
    };
  }

  /**
   * Rollback to a named checkpoint.
   */
  async rollbackToCheckpoint(name: string): Promise<{ success: boolean; message: string; filesRestored: string[] }> {
    const checkpoint = this.checkpoints.get(name);
    if (!checkpoint) {
      return { success: false, message: `Checkpoint "${name}" not found`, filesRestored: [] };
    }

    const restored: string[] = [];
    for (const [filePath, content] of checkpoint.fileSnapshots) {
      try {
        await fse.ensureDir(path.dirname(filePath));
        await fs.writeFile(filePath, content, 'utf-8');
        restored.push(filePath);
      } catch (err: any) {
        console.warn(`[EditTracker] Rollback failed for ${filePath}: ${err.message}`);
      }
    }

    // Remove edits after checkpoint
    this.edits.splice(checkpoint.editIndex);

    return {
      success: true,
      message: `Rolled back to "${name}": ${restored.length} files restored, ${this.edits.length} edits retained`,
      filesRestored: restored,
    };
  }

  /**
   * Get full session diff report for final answer.
   */
  getSessionDiffReport(): string {
    if (this.edits.length === 0) return 'No edits in this session.';

    const byFile = new Map<string, EditRecord[]>();
    for (const edit of this.edits) {
      const key = normalizePath(edit.filePath);
      const arr = byFile.get(key) || [];
      arr.push(edit);
      byFile.set(key, arr);
    }

    const parts: string[] = [`Session diff report (${this.edits.length} edits, ${byFile.size} files):`];

    for (const [file, edits] of byFile) {
      parts.push(`\n--- ${shortenPath(file)} (${edits.length} edits) ---`);
      for (const edit of edits.slice(-3)) { // Show last 3 diffs per file
        parts.push(edit.diffSnippet || `  ${edit.toolName}: ${edit.linesChanged} lines changed`);
      }
    }

    return parts.join('\n').slice(0, 8000);
  }

  /**
   * List checkpoint names.
   */
  listCheckpoints(): Array<{ name: string; timestamp: number; editIndex: number; fileCount: number }> {
    return Array.from(this.checkpoints.values()).map(cp => ({
      name: cp.name,
      timestamp: cp.timestamp,
      editIndex: cp.editIndex,
      fileCount: cp.fileSnapshots.size,
    }));
  }

  /**
   * Get all unique changed file paths.
   */
  getChangedFilePaths(): string[] {
    const paths = new Set<string>();
    for (const edit of this.edits) paths.add(edit.filePath);
    return Array.from(paths);
  }

  /**
   * Reset session (new conversation).
   */
  reset(): void {
    this.edits = [];
    this.checkpoints.clear();
    this.sessionStartTime = Date.now();
  }

  get editCount(): number {
    return this.edits.length;
  }

  get fileCount(): number {
    return new Set(this.edits.map(e => normalizePath(e.filePath))).size;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.length > 3 ? `.../${parts.slice(-3).join('/')}` : p;
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function countDifferingLines(a: string[], b: string[]): number {
  const minLen = Math.min(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff;
}

/**
 * Build a compact unified diff snippet between before and after content.
 * Shows only changed regions with ±2 lines of context.
 */
export function buildCompactDiff(before: string, after: string, maxLength: number = MAX_DIFF_SNIPPET_LENGTH): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // Find first and last differing line
  let firstDiff = 0;
  const minLen = Math.min(beforeLines.length, afterLines.length);
  while (firstDiff < minLen && beforeLines[firstDiff] === afterLines[firstDiff]) {
    firstDiff++;
  }

  let lastDiffBefore = beforeLines.length - 1;
  let lastDiffAfter = afterLines.length - 1;
  while (lastDiffBefore > firstDiff && lastDiffAfter > firstDiff &&
         beforeLines[lastDiffBefore] === afterLines[lastDiffAfter]) {
    lastDiffBefore--;
    lastDiffAfter--;
  }

  if (firstDiff >= minLen && beforeLines.length === afterLines.length) {
    return '(no changes detected)';
  }

  const contextLines = 2;
  const startLine = Math.max(0, firstDiff - contextLines);
  const endBefore = Math.min(beforeLines.length - 1, lastDiffBefore + contextLines);
  const endAfter = Math.min(afterLines.length - 1, lastDiffAfter + contextLines);

  const parts: string[] = [`@@ -${startLine + 1},${endBefore - startLine + 1} +${startLine + 1},${endAfter - startLine + 1} @@`];

  // Context before
  for (let i = startLine; i < firstDiff; i++) {
    parts.push(` ${beforeLines[i]}`);
  }

  // Removed lines
  for (let i = firstDiff; i <= lastDiffBefore; i++) {
    parts.push(`-${beforeLines[i]}`);
  }

  // Added lines
  for (let i = firstDiff; i <= lastDiffAfter; i++) {
    parts.push(`+${afterLines[i]}`);
  }

  // Context after
  for (let i = lastDiffBefore + 1; i <= endBefore && i < beforeLines.length; i++) {
    if (afterLines[i - lastDiffBefore + lastDiffAfter]) {
      parts.push(` ${beforeLines[i]}`);
    }
  }

  const result = parts.join('\n');
  return result.length > maxLength
    ? result.slice(0, maxLength) + '\n...[diff truncated]'
    : result;
}

/**
 * Build a readback of ±N lines around an edit location.
 */
export function buildEditReadback(
  content: string,
  editStartLine: number,
  contextLines: number = 5
): string {
  const lines = content.split('\n');
  const start = Math.max(0, editStartLine - contextLines);
  const end = Math.min(lines.length - 1, editStartLine + contextLines);

  const numbered = lines
    .slice(start, end + 1)
    .map((line, idx) => `${start + idx + 1}| ${line}`)
    .join('\n');

  return `[Readback: lines ${start + 1}-${end + 1} of ${lines.length}]\n${numbered}`;
}

/** Singleton edit tracker for the current coding session */
export const editTracker = new EditSessionTracker();
