import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import fs from 'fs/promises';
import fse from 'fs-extra';
import path from 'path';
import {
  checkEterXProtection,
  resolveWorkspacePathForContext,
} from '../../workspace/path_resolver';
import { editTracker, buildEditReadback } from '@/lib/code/edit-tracker';

// ════════════════════════════════════════════════════════════════════════
// workspace_apply_patch — THE core file editing primitive for EterX
//
// Patch format:
//   *** Begin Patch
//   *** Update File: path/to/file.ts
//    context line (space prefix = unchanged)
//   -removed line (dash prefix)
//   +added line (plus prefix)
//    more context
//   *** Add File: path/to/new-file.ts
//   +new file line 1
//   +new file line 2
//   *** Delete File: path/to/remove.ts
//   *** End Patch
//
// Why this is better than string.replace():
//  1. Context-line matching — locates exact position using surrounding lines
//  2. Multi-hunk support — multiple change blocks in one file
//  3. Multi-file support — add, update, delete in one call
//  4. Validation — verifies context lines match before writing
//  5. Atomic writes — temp file → rename (never half-written files)
//  6. Backup — .bak files before destructive edits
//  7. CRLF/LF handling — transparent line-ending normalization
//  8. Fuzzy fallback — ignores leading whitespace if exact match fails
// ════════════════════════════════════════════════════════════════════════

interface PatchHunk {
  contextBefore: string[];
  removedLines: string[];
  addedLines: string[];
  contextAfter: string[];
}

interface FileOperation {
  type: 'add' | 'update' | 'delete';
  filePath: string;
  hunks: PatchHunk[];
  newFileContent?: string[];   // For add operations
}

interface PatchChange {
  path: string;
  action: 'modified' | 'created' | 'deleted';
  additions: number;
  deletions: number;
  hunks: number;
  diff: string;
  readback?: string;
}

interface PreparedOperation {
  operation: FileOperation;
  resolvedPath: string;
  existed: boolean;
  mode?: number;
  beforeContent: string;
  afterContent: string | null;
  change: PatchChange;
}

function normalizePatchPath(filePath: string): string {
  const trimmed = filePath.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!trimmed || path.isAbsolute(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+/g, path.sep);
}

function splitTextContent(content: string): { lines: string[]; bom: string; lineEnding: '\r\n' | '\n' } {
  const bom = content.charCodeAt(0) === 0xfeff ? '\uFEFF' : '';
  const body = bom ? content.slice(1) : content;
  const crlfCount = (body.match(/\r\n/g) || []).length;
  const lfCount = (body.match(/(?<!\r)\n/g) || []).length;
  return {
    lines: body.replace(/\r\n/g, '\n').split('\n'),
    bom,
    lineEnding: crlfCount > lfCount ? '\r\n' : '\n',
  };
}

async function canonicalizePatchTarget(targetPath: string, context?: any): Promise<string> {
  if (await fse.pathExists(targetPath)) {
    const canonical = await fs.realpath(targetPath);
    return resolveWorkspacePathForContext(canonical, context);
  }

  const missingSegments: string[] = [];
  let existingAncestor = path.resolve(targetPath);
  while (!await fse.pathExists(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  const canonicalAncestor = await fs.realpath(existingAncestor);
  return resolveWorkspacePathForContext(
    path.join(canonicalAncestor, ...missingSegments),
    context,
  );
}

function comparablePath(filePath: string): string {
  const normalized = path.resolve(filePath).normalize('NFC');
  return process.platform === 'linux' ? normalized : normalized.toLowerCase();
}

function makeTemporaryPath(targetPath: string, sequence: number): string {
  return path.join(
    path.dirname(targetPath),
    `.eterx-patch-${process.pid}-${Date.now()}-${sequence}.tmp`,
  );
}

async function writeTargetAtomically(
  targetPath: string,
  content: string,
  mode: number | undefined,
  sequence: number,
): Promise<void> {
  const tempPath = makeTemporaryPath(targetPath, sequence);
  try {
    await fs.writeFile(tempPath, content, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: mode === undefined ? undefined : mode & 0o777,
    });
    if (mode !== undefined && process.platform !== 'win32') {
      await fs.chmod(tempPath, mode & 0o777);
    }
    try {
      await fs.rename(tempPath, targetPath);
    } catch (error: any) {
      if (!['EEXIST', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(String(error?.code || ''))) {
        throw error;
      }
      await fse.move(tempPath, targetPath, { overwrite: true });
    }
  } finally {
    try { await fs.unlink(tempPath); } catch { /* already moved or best-effort cleanup */ }
  }
}

function buildOperationDiff(operation: FileOperation, beforeContent: string): string {
  if (operation.type === 'add') {
    return (operation.newFileContent || []).map(line => `+${line}`).join('\n');
  }
  if (operation.type === 'delete') {
    return beforeContent.replace(/\r\n/g, '\n').split('\n').map(line => `-${line}`).join('\n');
  }
  return operation.hunks.map((hunk, index) => [
    `@@ hunk ${index + 1} @@`,
    ...hunk.contextBefore.map(line => ` ${line}`),
    ...hunk.removedLines.map(line => `-${line}`),
    ...hunk.addedLines.map(line => `+${line}`),
    ...hunk.contextAfter.map(line => ` ${line}`),
  ].join('\n')).join('\n');
}

/**
 * Parse a *** Begin Patch / *** End Patch block into structured FileOperations.
 */
function parsePatch(patchText: string): FileOperation[] {
  const lines = patchText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const operations: FileOperation[] = [];
  let i = 0;

  // Find *** Begin Patch (optional — tolerate patches without it)
  while (i < lines.length && !lines[i].trim().startsWith('*** Begin Patch')) {
    i++;
  }
  if (i < lines.length) i++; // skip the Begin Patch line

  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.startsWith('*** End Patch') || line === '') {
      i++;
      if (line.startsWith('*** End Patch')) break;
      continue;
    }

    // *** Add File: path
    if (line.startsWith('*** Add File:')) {
      const filePath = normalizePatchPath(line.substring('*** Add File:'.length));
      i++;
      const contentLines: string[] = [];
      while (i < lines.length) {
        const cl = lines[i];
        if (cl.trim().startsWith('*** ')) break;
        // Add file lines must start with + (or be empty for blank lines)
        if (cl.startsWith('+')) {
          contentLines.push(cl.substring(1));
        } else if (cl === '' || cl === '\r') {
          contentLines.push('');
        } else {
          // Tolerate lines without + prefix for robustness
          contentLines.push(cl);
        }
        i++;
      }
      operations.push({ type: 'add', filePath, hunks: [], newFileContent: contentLines });
      continue;
    }

    // *** Delete File: path
    if (line.startsWith('*** Delete File:')) {
      const filePath = normalizePatchPath(line.substring('*** Delete File:'.length));
      i++;
      operations.push({ type: 'delete', filePath, hunks: [] });
      continue;
    }

    // *** Update File: path
    if (line.startsWith('*** Update File:')) {
      const filePath = normalizePatchPath(line.substring('*** Update File:'.length));
      i++;
      const hunks: PatchHunk[] = [];
      let currentHunk: PatchHunk | null = null;
      let inPostContext = false;

      while (i < lines.length) {
        const hl = lines[i];
        if (hl.trim().startsWith('*** ')) break;

        // Skip @@ hunk headers (optional, for compatibility)
        if (hl.startsWith('@@')) {
          // Start new hunk
          if (currentHunk) hunks.push(currentHunk);
          currentHunk = { contextBefore: [], removedLines: [], addedLines: [], contextAfter: [] };
          inPostContext = false;
          i++;
          continue;
        }

        // Auto-create hunk if none exists
        if (!currentHunk) {
          currentHunk = { contextBefore: [], removedLines: [], addedLines: [], contextAfter: [] };
          inPostContext = false;
        }

        if (hl.startsWith('-')) {
          // If we were collecting post-context, that means a NEW hunk is starting
          if (inPostContext && currentHunk.contextAfter.length > 0) {
            hunks.push(currentHunk);
            // The post-context of the previous hunk becomes pre-context of the new one
            const carryContext: string[] = [...currentHunk.contextAfter];
            currentHunk = { contextBefore: carryContext, removedLines: [], addedLines: [], contextAfter: [] };
            inPostContext = false;
          }
          currentHunk.removedLines.push(hl.substring(1));
          inPostContext = false;
        } else if (hl.startsWith('+')) {
          if (inPostContext && currentHunk.contextAfter.length > 0 && currentHunk.removedLines.length === 0 && currentHunk.addedLines.length === 0) {
            // Pure add after context-only region — this is still the same hunk
          }
          currentHunk.addedLines.push(hl.substring(1));
          inPostContext = false;
        } else if (hl.startsWith(' ') || hl === '') {
          const contextLine = hl.startsWith(' ') ? hl.substring(1) : '';
          if (currentHunk.removedLines.length > 0 || currentHunk.addedLines.length > 0) {
            // After changes → post-context
            currentHunk.contextAfter.push(contextLine);
            inPostContext = true;
          } else {
            // Before changes → pre-context
            currentHunk.contextBefore.push(contextLine);
          }
        }
        i++;
      }

      if (currentHunk) hunks.push(currentHunk);
      operations.push({ type: 'update', filePath, hunks });
      continue;
    }

    // Unknown line — skip
    i++;
  }

  return operations;
}

/**
 * Find the position in fileLines where a context block matches.
 * Returns the index of the first context line, or -1 if not found.
 */
function findContextMatch(
  fileLines: string[],
  contextLines: string[],
  startSearchFrom: number = 0,
  fuzzy: boolean = false
): number {
  if (contextLines.length === 0) return startSearchFrom;

  const normalize = fuzzy
    ? (s: string) => s.trimStart()
    : (s: string) => s;

  for (let i = startSearchFrom; i <= fileLines.length - contextLines.length; i++) {
    let match = true;
    for (let j = 0; j < contextLines.length; j++) {
      if (normalize(fileLines[i + j]) !== normalize(contextLines[j])) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }

  return -1;
}

/**
 * Apply a single hunk to fileLines. Returns the modified lines and the position after the applied hunk.
 */
function applyHunk(
  fileLines: string[],
  hunk: PatchHunk,
  searchFrom: number
): { lines: string[]; nextSearchFrom: number } {
  // Build the full expected block: contextBefore + removedLines + contextAfter
  const expectedBlock = [...hunk.contextBefore, ...hunk.removedLines];

  // Find where the expected block starts
  let matchPos = findContextMatch(fileLines, expectedBlock, searchFrom, false);

  // Fuzzy fallback: ignore leading whitespace
  if (matchPos === -1) {
    matchPos = findContextMatch(fileLines, expectedBlock, searchFrom, true);
    if (matchPos !== -1) {
      console.log(`[apply_patch] Fuzzy whitespace match at line ${matchPos + 1}`);
    }
  }

  // If context-before alone is provided but no removed lines, try matching just context
  if (matchPos === -1 && hunk.contextBefore.length > 0 && hunk.removedLines.length === 0) {
    matchPos = findContextMatch(fileLines, hunk.contextBefore, searchFrom, false);
    if (matchPos === -1) {
      matchPos = findContextMatch(fileLines, hunk.contextBefore, searchFrom, true);
    }
    if (matchPos !== -1) {
      // Insert added lines after the context
      const insertPos = matchPos + hunk.contextBefore.length;
      const result = [
        ...fileLines.slice(0, insertPos),
        ...hunk.addedLines,
        ...fileLines.slice(insertPos),
      ];
      return { lines: result, nextSearchFrom: insertPos + hunk.addedLines.length };
    }
  }

  if (matchPos === -1) {
    // Build a meaningful error
    const searchSnippet = expectedBlock.slice(0, 4).map(l => `  "${l}"`).join('\n');
    throw new Error(
      `Patch context mismatch — could not find the expected lines in the file.\n` +
      `Searched for (first ${Math.min(4, expectedBlock.length)} lines):\n${searchSnippet}\n` +
      `Make sure you read the latest file content before patching. The file may have changed.`
    );
  }

  // Build the replacement: contextBefore (kept) + addedLines (new) — removedLines are dropped
  const duplicateExact = findContextMatch(fileLines, expectedBlock, matchPos + 1, false);
  const duplicateFuzzy = duplicateExact === -1
    ? findContextMatch(fileLines, expectedBlock, matchPos + 1, true)
    : duplicateExact;
  if (expectedBlock.length > 0 && duplicateFuzzy !== -1) {
    throw new Error(
      `Patch context is ambiguous: the same block also matches at line ${duplicateFuzzy + 1}. ` +
      `Include more unique context lines around this change.`
    );
  }

  const beforeMatch = fileLines.slice(0, matchPos);
  const afterMatch = fileLines.slice(matchPos + expectedBlock.length);

  // Verify contextAfter matches what follows
  if (hunk.contextAfter.length > 0) {
    const postPos = findContextMatch(afterMatch, hunk.contextAfter, 0, false) === 0;
    if (!postPos) {
      const postPosFuzzy = findContextMatch(afterMatch, hunk.contextAfter, 0, true) === 0;
      if (!postPosFuzzy) {
        throw new Error('Patch post-context does not match the current file. Read the latest surrounding lines and retry.');
      }
    }
  }

  const result = [
    ...beforeMatch,
    ...hunk.contextBefore,      // Keep unchanged context
    ...hunk.addedLines,          // Insert new lines
    ...afterMatch,               // Keep everything after the removed block
  ];

  return {
    lines: result,
    nextSearchFrom: beforeMatch.length + hunk.contextBefore.length + hunk.addedLines.length,
  };
}

/**
 * Apply all operations from a parsed patch.
 * Returns a summary of what was done.
 */
async function applyOperationsLegacy(
  operations: FileOperation[],
  context?: any
): Promise<{ filesModified: string[]; filesCreated: string[]; filesDeleted: string[]; errors: string[] }> {
  const result = { filesModified: [] as string[], filesCreated: [] as string[], filesDeleted: [] as string[], errors: [] as string[] };

  for (const op of operations) {
    const resolvedPath = resolveWorkspacePathForContext(op.filePath, context);

    // Protection check
    const protection = checkEterXProtection(resolvedPath);
    if (protection.blocked) {
      result.errors.push(`🛡️ BLOCKED: ${resolvedPath} — ${protection.reason}`);
      continue;
    }

    try {
      switch (op.type) {
        case 'add': {
          if (await fse.pathExists(resolvedPath)) {
            result.errors.push(`File already exists for add operation: ${resolvedPath}. Use *** Update File to modify existing files.`);
            continue;
          }
          await fse.ensureDir(path.dirname(resolvedPath));
          const content = (op.newFileContent || []).join('\n');
          await fs.writeFile(resolvedPath, content, 'utf-8');
          result.filesCreated.push(resolvedPath);
          console.log(`[apply_patch] ✅ Created: ${resolvedPath} (${content.length} chars)`);
          try {
            editTracker.recordEdit({
              filePath: resolvedPath,
              beforeContent: '',
              afterContent: content,
              toolName: 'workspace_apply_patch',
              editType: 'create',
            });
          } catch { /* tracker is best-effort */ }
          break;
        }

        case 'delete': {
          if (await fse.pathExists(resolvedPath)) {
            // Create backup before deleting
            const backupPath = resolvedPath + '.bak';
            try { await fs.copyFile(resolvedPath, backupPath); } catch { /* best effort */ }
            await fs.unlink(resolvedPath);
            result.filesDeleted.push(resolvedPath);
            console.log(`[apply_patch] 🗑️ Deleted: ${resolvedPath}`);
          } else {
            result.errors.push(`File not found for deletion: ${resolvedPath}`);
          }
          break;
        }

        case 'update': {
          if (!await fse.pathExists(resolvedPath)) {
            result.errors.push(`File not found for update: ${resolvedPath}. Use *** Add File for new files.`);
            continue;
          }

          // Read current content
          const rawContent = await fs.readFile(resolvedPath, 'utf-8');
          let fileLines = rawContent.replace(/\r\n/g, '\n').split('\n');

          // Create backup
          const backupPath = resolvedPath + '.bak';
          try { await fs.writeFile(backupPath, rawContent, 'utf-8'); } catch { /* best effort */ }

          // Apply each hunk sequentially
          let searchFrom = 0;
          for (let hi = 0; hi < op.hunks.length; hi++) {
            const hunk = op.hunks[hi];
            // Skip empty hunks (no actual changes)
            if (hunk.removedLines.length === 0 && hunk.addedLines.length === 0) {
              continue;
            }
            try {
              const applied = applyHunk(fileLines, hunk, searchFrom);
              fileLines = applied.lines;
              searchFrom = applied.nextSearchFrom;
            } catch (hunkErr: any) {
              result.errors.push(`Hunk ${hi + 1} failed in ${op.filePath}: ${hunkErr.message}`);
              // Restore from backup on failure
              try { await fs.copyFile(backupPath, resolvedPath); } catch { /* best effort */ }
              throw hunkErr;
            }
          }

          // Detect original line ending style and preserve it
          const useCRLF = rawContent.includes('\r\n');
          const newContent = fileLines.join(useCRLF ? '\r\n' : '\n');

          // Atomic write: write to temp, then rename
          const tempPath = resolvedPath + '.patch_tmp';
          await fs.writeFile(tempPath, newContent, 'utf-8');
          await fs.rename(tempPath, resolvedPath);

          // Clean up backup on success
          try { await fs.unlink(backupPath); } catch { /* best effort */ }

          // Record in edit tracker for undo/checkpoint support
          try {
            editTracker.recordEdit({
              filePath: resolvedPath,
              beforeContent: rawContent,
              afterContent: newContent,
              toolName: 'workspace_apply_patch',
              editType: 'patch',
            });
          } catch { /* tracker is best-effort */ }

          result.filesModified.push(resolvedPath);
          console.log(`[apply_patch] ✅ Updated: ${resolvedPath} (${op.hunks.length} hunks)`);
          break;
        }
      }
    } catch (err: any) {
      if (!result.errors.some(e => e.includes(op.filePath))) {
        result.errors.push(`${op.type} failed for ${op.filePath}: ${err.message}`);
      }
    }
  }

  return result;
}

async function applyOperations(
  operations: FileOperation[],
  context?: any
): Promise<{ filesModified: string[]; filesCreated: string[]; filesDeleted: string[]; errors: string[]; changes: PatchChange[]; rolledBack: boolean }> {
  const emptyResult = { filesModified: [] as string[], filesCreated: [] as string[], filesDeleted: [] as string[], errors: [] as string[], changes: [] as PatchChange[], rolledBack: false };
  const prepared: PreparedOperation[] = [];
  const seenPaths = new Set<string>();

  // Resolve and calculate the entire patch before touching the filesystem.
  for (const operation of operations) {
    let resolvedPath: string;
    try {
      resolvedPath = resolveWorkspacePathForContext(operation.filePath, context);
      resolvedPath = await canonicalizePatchTarget(resolvedPath, context);
    } catch (error: any) {
      emptyResult.errors.push(`${operation.filePath}: ${error.message}`);
      continue;
    }

    const pathKey = comparablePath(resolvedPath);
    if (seenPaths.has(pathKey)) {
      emptyResult.errors.push(`Duplicate file operation for ${operation.filePath}. Combine changes for a file under one patch header.`);
      continue;
    }
    seenPaths.add(pathKey);

    const protection = checkEterXProtection(resolvedPath);
    if (protection.blocked) {
      emptyResult.errors.push(`BLOCKED: ${resolvedPath} - ${protection.reason}`);
      continue;
    }

    try {
      const existed = await fse.pathExists(resolvedPath);
      if (operation.type === 'add' && existed) throw new Error('File already exists. Use *** Update File instead.');
      if (operation.type !== 'add' && !existed) throw new Error('File not found. Use *** Add File for new files.');

      const beforeContent = existed ? await fs.readFile(resolvedPath, 'utf-8') : '';
      if (existed && (beforeContent.includes('\0') || beforeContent.includes('\uFFFD'))) {
        throw new Error('Binary or non-UTF-8 files are not supported by the text patch editor.');
      }
      const mode = existed ? (await fs.stat(resolvedPath)).mode : undefined;
      let afterContent: string | null = null;
      let appliedHunks = 0;

      if (operation.type === 'add') {
        afterContent = (operation.newFileContent || []).join('\n');
      } else if (operation.type === 'update') {
        const textFormat = splitTextContent(beforeContent);
        let fileLines = textFormat.lines;
        let searchFrom = 0;
        for (let hunkIndex = 0; hunkIndex < operation.hunks.length; hunkIndex++) {
          const hunk = operation.hunks[hunkIndex];
          if (hunk.removedLines.length === 0 && hunk.addedLines.length === 0) continue;
          try {
            const applied = applyHunk(fileLines, hunk, searchFrom);
            fileLines = applied.lines;
            searchFrom = applied.nextSearchFrom;
            appliedHunks++;
          } catch (error: any) {
            throw new Error(`Hunk ${hunkIndex + 1}: ${error.message}`);
          }
        }
        if (appliedHunks === 0) throw new Error('Update contains no changed lines.');
        afterContent = `${textFormat.bom}${fileLines.join(textFormat.lineEnding)}`;
        if (afterContent === beforeContent) throw new Error('Patch produced no content change.');
      }

      const action: PatchChange['action'] = operation.type === 'add' ? 'created' : operation.type === 'delete' ? 'deleted' : 'modified';
      const diff = buildOperationDiff(operation, beforeContent);
      const stats = operation.type === 'add'
        ? { additions: operation.newFileContent?.length || 0, deletions: 0 }
        : operation.type === 'delete'
          ? { additions: 0, deletions: beforeContent ? beforeContent.replace(/\r\n/g, '\n').split('\n').length : 0 }
          : {
              additions: operation.hunks.reduce((sum, hunk) => sum + hunk.addedLines.length, 0),
              deletions: operation.hunks.reduce((sum, hunk) => sum + hunk.removedLines.length, 0),
            };
      prepared.push({
        operation,
        resolvedPath,
        existed,
        mode,
        beforeContent,
        afterContent,
        change: {
          path: resolvedPath,
          action,
          additions: stats.additions,
          deletions: stats.deletions,
          hunks: appliedHunks,
          diff,
          readback: afterContent === null ? undefined : buildEditReadback(afterContent, 0, 12).slice(0, 2400),
        },
      });
    } catch (error: any) {
      emptyResult.errors.push(`${operation.type} failed for ${operation.filePath}: ${error.message}`);
    }
  }

  if (emptyResult.errors.length > 0 || prepared.length !== operations.length) return emptyResult;

  // Commit as one transaction and restore already-written targets on failure.
  const committed: PreparedOperation[] = [];
  try {
    for (let itemIndex = 0; itemIndex < prepared.length; itemIndex++) {
      const item = prepared[itemIndex];
      const existsNow = await fse.pathExists(item.resolvedPath);
      if (item.existed !== existsNow) {
        throw new Error(`${item.operation.filePath} changed after patch validation (existence mismatch).`);
      }
      if (existsNow) {
        const currentContent = await fs.readFile(item.resolvedPath, 'utf-8');
        if (currentContent !== item.beforeContent) {
          throw new Error(`${item.operation.filePath} changed after patch validation. Read it again and retry.`);
        }
      }
      await fse.ensureDir(path.dirname(item.resolvedPath));
      // Track before mutating so rollback also covers a partially failed write.
      committed.push(item);
      if (item.afterContent === null) {
        await fs.unlink(item.resolvedPath);
      } else {
        await writeTargetAtomically(
          item.resolvedPath,
          item.afterContent,
          item.mode,
          itemIndex,
        );
      }
    }
  } catch (error: any) {
    const rollbackErrors: string[] = [];
    const rollbackItems = [...committed].reverse();
    for (let rollbackIndex = 0; rollbackIndex < rollbackItems.length; rollbackIndex++) {
      const item = rollbackItems[rollbackIndex];
      try {
        if (item.existed) {
          await fse.ensureDir(path.dirname(item.resolvedPath));
          await writeTargetAtomically(
            item.resolvedPath,
            item.beforeContent,
            item.mode,
            prepared.length + rollbackIndex,
          );
        }
        else if (await fse.pathExists(item.resolvedPath)) await fs.unlink(item.resolvedPath);
      } catch (rollbackError: any) {
        rollbackErrors.push(`${item.resolvedPath}: ${rollbackError.message}`);
      }
    }
    return {
      ...emptyResult,
      rolledBack: true,
      errors: [`Patch commit failed and was rolled back: ${error.message}`, ...rollbackErrors.map(message => `Rollback warning: ${message}`)],
    };
  }

  const result = { ...emptyResult, changes: prepared.map(item => item.change) };
  for (const item of prepared) {
    if (item.change.action === 'created') result.filesCreated.push(item.resolvedPath);
    else if (item.change.action === 'deleted') result.filesDeleted.push(item.resolvedPath);
    else result.filesModified.push(item.resolvedPath);
    try {
      editTracker.recordEdit({
        filePath: item.resolvedPath,
        beforeContent: item.beforeContent,
        afterContent: item.afterContent || '',
        toolName: 'workspace_apply_patch',
        editType: item.operation.type === 'update' ? 'patch' : item.operation.type,
      });
    } catch { /* tracker is best-effort */ }
  }
  return result;
}

export const workspaceApplyPatchTool: ToolDefinition = {
  name: 'workspace_apply_patch',
  description: 'Apply precise, atomic patch changes across one or more files using context-matched hunks. Supports updating, creating, and deleting files, and returns per-file diffs and readbacks. Prefer workspace_edit_file for a small targeted edit in one existing file.',
  category: 'workspace',
  inputSchema: z.object({
    patch: z.string().describe(
      'The patch content in *** Begin Patch / *** End Patch format.\n' +
      'Relative paths may use / or \\\\ separators and are normalized for Windows, macOS, and Linux.\n' +
      'Use "*** Update File: path" for editing existing files with context-based matching.\n' +
      'Use "*** Add File: path" to create new files (lines start with +).\n' +
      'Use "*** Delete File: path" to remove files.\n' +
      'For Update: prefix unchanged lines with space, removed with -, added with +.\n' +
      'Include 2-3 context lines before and after each change for reliable matching.'
    ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    filesModified: z.array(z.string()),
    filesCreated: z.array(z.string()),
    filesDeleted: z.array(z.string()),
    errors: z.array(z.string()),
    changes: z.array(z.object({
      path: z.string(),
      action: z.enum(['modified', 'created', 'deleted']),
      additions: z.number(),
      deletions: z.number(),
      hunks: z.number(),
      diff: z.string(),
      readback: z.string().optional(),
    })).optional(),
    rolledBack: z.boolean().optional(),
    readbacks: z.record(z.string()).optional(),
    summary: z.string().optional(),
  }),
  execute: async (input: { patch: string }, context?: any) => {
    if (!input.patch || typeof input.patch !== 'string' || input.patch.trim().length < 10) {
      return {
        success: false,
        filesModified: [],
        filesCreated: [],
        filesDeleted: [],
        errors: ['Invalid patch: patch content is empty or too short. Use the *** Begin Patch / *** End Patch format.'],
      };
    }

    try {
      const operations = parsePatch(input.patch);

      if (operations.length === 0) {
        return {
          success: false,
          filesModified: [],
          filesCreated: [],
          filesDeleted: [],
          errors: [
            'No file operations found in patch. Expected format:\n' +
            '*** Begin Patch\n*** Update File: path/to/file\n context line\n-old line\n+new line\n*** End Patch',
          ],
        };
      }

      const result = await applyOperations(operations, context);

      const totalChanges = result.filesModified.length + result.filesCreated.length + result.filesDeleted.length;
      const success = totalChanges > 0 && result.errors.length === 0;

      // Keep the compatibility map, but key it by full path so duplicate
      // basenames in different directories never hide each other in the UI.
      const readbacks: Record<string, string> = {};
      for (const change of result.changes) {
        if (change.readback) readbacks[change.path] = change.readback;
      }

      return {
        success,
        filesModified: result.filesModified,
        filesCreated: result.filesCreated,
        filesDeleted: result.filesDeleted,
        errors: result.errors,
        changes: result.changes,
        rolledBack: result.rolledBack,
        readbacks,
        summary: success
          ? `Applied patch: ${result.filesModified.length} modified, ${result.filesCreated.length} created, ${result.filesDeleted.length} deleted`
          : `${result.rolledBack ? 'Patch rolled back' : 'Patch rejected'}: ${result.errors.join('; ')}`,
      };
    } catch (err: any) {
      return {
        success: false,
        filesModified: [],
        filesCreated: [],
        filesDeleted: [],
        errors: [`Patch parsing/application failed: ${err.message}`],
      };
    }
  },
};
