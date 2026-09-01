import { z } from 'zod';
import fs from 'fs/promises';
import fse from 'fs-extra';
import path from 'path';
import type { ToolDefinition } from '../../schemas';
import { checkEterXProtection, resolveWorkspacePathForContext } from '../../workspace/path_resolver';

const normalizeEditChunkInput = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const range = input.range ?? input.lineRange ?? input.line_range;
  const rangeStart = Array.isArray(range)
    ? range[0]
    : range && typeof range === 'object'
      ? (range as any).start ?? (range as any).startLine ?? (range as any).from
      : undefined;
  const rangeEnd = Array.isArray(range)
    ? range[1]
    : range && typeof range === 'object'
      ? (range as any).end ?? (range as any).endLine ?? (range as any).to
      : undefined;
  let startLine = input.startLine ?? input.start_line ?? input.lineStart ?? input.line_start ?? input.lineNumber ?? input.line ?? rangeStart;
  let endLine = input.endLine ?? input.end_line ?? input.lineEnd ?? input.line_end ?? rangeEnd;
  if (typeof startLine === 'string' && /^\d+$/.test(startLine.trim())) startLine = Number(startLine);
  if (typeof endLine === 'string' && /^-?\d+$/.test(endLine.trim())) endLine = Number(endLine);
  if (typeof endLine === 'string' && /^(?:eof|end)$/i.test(endLine.trim())) endLine = -1;
  // A few provider adapters serialize the first line as zero even though the
  // public schema is 1-indexed. This is unambiguous and safe to normalize.
  if (startLine === 0) startLine = 1;
  if (endLine === 0) endLine = startLine ?? 1;
  if (typeof startLine === 'number' && typeof endLine === 'number' && endLine > 0 && startLine > endLine) {
    [startLine, endLine] = [endLine, startLine];
  }
  // Providers occasionally express a one-line replacement with only one end
  // of the range. Treat that as the same line instead of rejecting a mutation
  // whose intent is otherwise unambiguous.
  return {
    ...input,
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : startLine !== undefined ? { endLine: startLine } : {}),
    ...(startLine === undefined && endLine !== undefined ? { startLine: endLine } : {}),
  };
};

const editChunkSchema = z.preprocess(normalizeEditChunkInput, z.object({
  search: z.string().min(1).optional().describe('Exact non-empty text to find in an existing file. It must match whitespace and line endings.'),
  replace: z.string().describe('Replacement text. For a new file, this is the complete file content.'),
  replaceAll: z.boolean().optional().describe('Replace every exact occurrence. Defaults to false.'),
  replace_all: z.boolean().optional().describe('Alias for replaceAll.'),
  startLine: z.number().int().min(1).optional().describe('First 1-indexed line to replace in an existing file.'),
  endLine: z.number().int().refine(value => value === -1 || value >= 1, 'endLine must be at least 1, or -1 for end of file.').optional().describe('Last 1-indexed line to replace. Use -1 for end of file.'),
}));

const editTargetSchema = z.object({
  filename: z.string().min(1).optional().describe('Absolute path or path relative to the active workspace. A one-item files array may inherit the top-level filename.'),
  edits: z.array(editChunkSchema).min(1).max(50).optional().describe('All edits for this file, applied in array order. Omit when delete=true.'),
  delete: z.boolean().optional().describe('Delete this file. Do not provide edits when true.'),
}).superRefine((target, issueContext) => {
  const hasEdits = Array.isArray(target.edits) && target.edits.length > 0;
  if (target.delete === true && hasEdits) {
    issueContext.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['edits'],
      message: 'Do not provide edits when delete=true.',
    });
  } else if (target.delete !== true && !hasEdits) {
    issueContext.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['edits'],
      message: 'Provide at least one edit, or set delete=true.',
    });
  }
});

type EditChunk = z.infer<typeof editChunkSchema>;
type EditTarget = z.infer<typeof editTargetSchema>;

type PreparedTarget = EditTarget & {
  filePath: string;
  existed: boolean;
  originalContent: string;
};

const changedLineCount = (value: string): number => value.length === 0 ? 0 : value.split(/\r?\n/).length;

const formatEditError = (value: unknown, fallback = 'Workspace edit failed.'): string => {
  if (value instanceof Error) return value.message || fallback;
  if (typeof value === 'string') return value.trim() || fallback;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const candidate of [record.message, record.error, record.detail, record.reason]) {
      const nested = formatEditError(candidate, '');
      if (nested) return nested;
    }
    try {
      const serialized = JSON.stringify(value);
      if (serialized && serialized !== '{}') return serialized;
    } catch { }
  }
  const text = String(value ?? '').trim();
  return text && text !== '[object Object]' ? text : fallback;
};

async function writeUtf8Atomic(filePath: string, content: string): Promise<void> {
  await fse.ensureDir(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await fs.writeFile(tempPath, content, 'utf8');
  try {
    await fse.move(tempPath, filePath, { overwrite: true });
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function normalizeTargets(input: { filename?: string; edits?: EditChunk[]; files?: EditTarget[]; delete?: boolean }): EditTarget[] {
  if (Array.isArray(input.files) && input.files.length > 0) {
    const targets = input.files.map(target => ({ ...target }));
    const filename = String(input.filename || '').trim();
    const hasSingleMutation = (Array.isArray(input.edits) && input.edits.length > 0) || input.delete !== undefined;
    if (targets.length === 1 && !String(targets[0]?.filename || '').trim() && filename) {
      targets[0] = {
        ...targets[0],
        filename,
        ...((!Array.isArray(targets[0].edits) || targets[0].edits.length === 0) && Array.isArray(input.edits)
          ? { edits: input.edits }
          : {}),
        ...(targets[0].delete === undefined && input.delete !== undefined ? { delete: input.delete } : {}),
      };
    }
    if (filename && hasSingleMutation) {
      const normalizePath = (value: unknown) => String(value || '').trim().replace(/\\/g, '/').toLowerCase();
      const matchingIndex = targets.findIndex(target => normalizePath(target.filename) === normalizePath(filename));
      if (matchingIndex >= 0) {
        const matching = targets[matchingIndex];
        targets[matchingIndex] = {
          ...matching,
          ...((!Array.isArray(matching.edits) || matching.edits.length === 0) && Array.isArray(input.edits)
            ? { edits: input.edits }
            : {}),
          ...(matching.delete === undefined && input.delete !== undefined ? { delete: input.delete } : {}),
        };
      } else {
        targets.push({ filename, edits: input.edits, delete: input.delete });
      }
    }
    return targets;
  }
  if (!input.filename) {
    throw new Error('Provide filename for one file, or files for a multi-file operation.');
  }
  return [{ filename: input.filename, edits: input.edits, delete: input.delete }];
}

function newFileContent(target: EditTarget): string {
  if (!Array.isArray(target.edits) || target.edits.length !== 1) {
    throw new Error(`New file ${target.filename} requires exactly one edit containing the complete file content.`);
  }
  const edit = target.edits[0];
  // Creation is determined from the filesystem, not from which equivalent
  // edit shape a provider selected. Search/range selectors cannot identify
  // content in a missing file, so the sole replacement is unambiguously the
  // complete new content and is safe to accept.
  return edit.replace;
}

async function applyExistingFileEdits(
  target: PreparedTarget,
  onPrepared?: (content: string, stats: { additions: number; deletions: number }) => Promise<void>,
): Promise<Record<string, any>> {
  if (!Array.isArray(target.edits) || target.edits.length === 0) {
    throw new Error(`Existing file ${target.filename} requires at least one edit unless delete=true.`);
  }
  let content = target.originalContent;
  const originalContent = content;
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  let lines = content.split(/\r?\n/);
  let additions = 0;
  let deletions = 0;

  for (let editIndex = 0; editIndex < target.edits.length; editIndex++) {
    const edit = target.edits[editIndex];
    const startLine = edit.startLine;
    const endLine = edit.endLine === -1 ? lines.length : edit.endLine;
    const hasStartLine = startLine !== undefined;
    const hasEndLine = endLine !== undefined;
    if (hasStartLine !== hasEndLine) {
      throw new Error(`Edit #${editIndex + 1} in ${target.filename} must provide both startLine and endLine.`);
    }
    // Mixed provider shapes occasionally include stale range metadata beside
    // an exact search block. Exact content is the stronger, safer selector;
    // use it and ignore the advisory range instead of rejecting a valid edit.
    if (startLine !== undefined && endLine !== undefined && edit.search === undefined) {
      const startIndex = Math.max(0, startLine - 1);
      const endIndex = Math.min(lines.length - 1, endLine - 1);
      if (startIndex === lines.length && endLine === startLine && edit.replace.length > 0) {
        const replacementLines = edit.replace.split(/\r?\n/);
        additions += replacementLines.length;
        lines.push(...replacementLines);
        content = lines.join(lineEnding);
        continue;
      }
      if (startIndex > endIndex || startIndex >= lines.length) {
        throw new Error(`Invalid line range: ${startLine}-${endLine} (file has ${lines.length} lines)`);
      }
      const replacementLines = edit.replace.length === 0 ? [] : edit.replace.split(/\r?\n/);
      deletions += endIndex - startIndex + 1;
      additions += replacementLines.length;
      lines.splice(startIndex, endIndex - startIndex + 1, ...replacementLines);
      content = lines.join(lineEnding);
      lines = content.split(/\r?\n/);
      continue;
    }

    if (edit.search === undefined) {
      // Existing files must always use an explicit selector. A selector-free
      // replace is reserved for creating a missing file, preventing an
      // accidental whole-file overwrite when a provider omits edit context.
      throw new Error('Edit chunk must have either a "search" string or "startLine" and "endLine" numbers.');
    }
    content = lines.join(lineEnding);
    // Provider JSON normally uses LF even when the Windows file is CRLF.
    // Line-ending style is not semantic edit intent, so normalize both exact
    // selectors and replacements to the existing file before matching.
    const searchText = edit.search.replace(/\r?\n/g, lineEnding);
    const replacementText = edit.replace.replace(/\r?\n/g, lineEnding);
    if (!content.includes(searchText)) {
      const searchPreview = edit.search.length > 100 ? `${edit.search.slice(0, 100)}...` : edit.search;
      throw new Error(
        `Could not find search block in ${target.filename} (edit #${editIndex + 1}).\n` +
        `Searched for: "${searchPreview}"\n` +
        'Make sure it matches EXACTLY including whitespace, indentation, and line endings.\n' +
        'TIP: Inspect the file first with workspace_run_command, then copy the exact text.',
      );
    }

    const occurrences = content.split(searchText).length - 1;
    const replaceAll = edit.replaceAll === true || edit.replace_all === true;
    if (occurrences > 1 && !replaceAll) {
      return {
        success: false,
        error: `Search text matched ${occurrences} times in ${target.filename} (edit #${editIndex + 1}). Add more context, use startLine/endLine, or set replaceAll=true intentionally.`,
        path: target.filePath,
        filename: target.filename,
        occurrences,
        editsApplied: 0,
      };
    }
    const replacements = replaceAll ? occurrences : 1;
    deletions += changedLineCount(searchText) * replacements;
    additions += changedLineCount(replacementText) * replacements;
    content = replaceAll
      ? content.split(searchText).join(replacementText)
      : content.replace(searchText, replacementText);
    lines = content.split(/\r?\n/);
  }

  if (content === originalContent) {
    return {
      success: true,
      message: `No changes detected; file unchanged: ${target.filePath}`,
      warning: 'The search and replace values may be the same.',
      path: target.filePath,
      filename: target.filename,
      editsApplied: 0,
      additions: 0,
      deletions: 0,
      totalLines: content.split(/\r?\n/).length,
      size: Buffer.byteLength(content, 'utf8'),
    };
  }

  const finalContent = lines.join(lineEnding);
  await onPrepared?.(finalContent, { additions, deletions });
  await writeUtf8Atomic(target.filePath, finalContent);
  return {
    success: true,
    message: `Applied ${target.edits.length} edits to ${target.filePath}`,
    path: target.filePath,
    filename: target.filename,
    editsApplied: target.edits.length,
    additions,
    deletions,
    totalLines: finalContent.split(/\r?\n/).length,
    size: Buffer.byteLength(finalContent, 'utf8'),
  };
}

async function rollbackTargets(committed: PreparedTarget[]): Promise<string[]> {
  const errors: string[] = [];
  for (const target of [...committed].reverse()) {
    try {
      if (target.existed) await writeUtf8Atomic(target.filePath, target.originalContent);
      else await fs.unlink(target.filePath).catch((error: any) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    } catch (error: any) {
      errors.push(`${target.filename}: ${formatEditError(error)}`);
    }
  }
  return errors;
}

/**
 * The one model-facing file mutation tool. It owns create, edit, delete, and
 * rollback-safe multi-file operations under one stable UI tool identity.
 */
export const workspaceEditFileTool: ToolDefinition = {
  name: 'workspace_edit_file',
  description: 'Create, edit, replace, or delete files. Single: filename plus edits/delete. Multiple: files=[{filename, edits/delete}]. A missing file uses one selector-free replace edit as its complete content; existing files use exact search or startLine/endLine selectors.',
  category: 'workspace',
  inputSchema: z.object({
    filename: z.string().optional().describe('Single-file mode: absolute path or path relative to the active workspace.'),
    edits: z.array(editChunkSchema).min(1).max(50).optional().describe('Single-file mode: edits applied in array order.'),
    delete: z.boolean().optional().describe('Single-file mode: delete the file. Do not also provide edits.'),
    files: z.array(editTargetSchema).min(1).max(50).optional().describe('Multi-file mode: all create, edit, or delete targets. Do not also provide single-file fields.'),
  }).superRefine((value, issueContext) => {
    const hasSingleFields = Boolean(value.filename || value.edits || value.delete !== undefined);
    const hasMultiFiles = Array.isArray(value.files) && value.files.length > 0;
    if (!hasSingleFields && !hasMultiFiles) {
      issueContext.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filename'],
        message: 'Provide filename plus edits/delete for one file, or provide files for multiple files.',
      });
      return;
    }
    // The normalizer/executor tolerantly reconciles a provider call that mixes
    // both shapes. A valid files[] payload is sufficient at the schema layer.
    if (hasMultiFiles) {
      value.files!.forEach((target, index) => {
        if (!String(target.filename || '').trim() && !(value.files!.length === 1 && String(value.filename || '').trim())) {
          issueContext.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['files', index, 'filename'],
            message: 'filename is required for each multi-file target.',
          });
        }
      });
      return;
    }
    if (hasSingleFields && !value.filename) {
      issueContext.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filename'],
        message: 'filename is required in single-file mode.',
      });
    }
    if (value.delete === true && Array.isArray(value.edits) && value.edits.length > 0) {
      issueContext.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['edits'],
        message: 'Do not provide edits when delete=true.',
      });
    } else if (value.delete !== true && hasSingleFields && (!Array.isArray(value.edits) || value.edits.length === 0)) {
      issueContext.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['edits'],
        message: 'Provide at least one edit, or set delete=true.',
      });
    }
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string().optional(),
    error: z.string().optional(),
    path: z.string().optional(),
    filename: z.string().optional(),
    editsApplied: z.number().optional(),
    totalLines: z.number().optional(),
    size: z.number().optional(),
    filesModified: z.array(z.string()).optional(),
    filesCreated: z.array(z.string()).optional(),
    filesDeleted: z.array(z.string()).optional(),
    operation: z.enum(['created', 'edited', 'deleted', 'mixed', 'none']).optional(),
    changes: z.array(z.any()).optional(),
    rolledBack: z.boolean().optional(),
    errors: z.array(z.string()).optional(),
    results: z.array(z.any()).optional(),
  }).passthrough(),
  execute: async (input: { filename?: string; edits?: EditChunk[]; files?: EditTarget[]; delete?: boolean }, context?: any) => {
    let targets: EditTarget[];
    try {
      targets = normalizeTargets(input);
    } catch (error: any) {
      const message = formatEditError(error);
      return {
        success: false,
        error: message,
        errors: [message],
        filesModified: [],
        filesCreated: [],
        filesDeleted: [],
        operation: 'none',
        changes: [],
        rolledBack: false,
        results: [],
      };
    }

    const prepared: PreparedTarget[] = [];
    const preparedIndexByPath = new Map<string, number>();
    try {
      for (const target of targets) {
        const targetFilename = String(target.filename || '').trim();
        if (!targetFilename) throw new Error('Each workspace edit target requires a filename.');
        const filePath = resolveWorkspacePathForContext(targetFilename, context);
        const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;

        const protection = checkEterXProtection(filePath);
        if (protection.blocked) throw new Error(protection.reason);

        const existed = await fse.pathExists(filePath);
        const originalContent = existed ? await fs.readFile(filePath, 'utf8') : '';
        if (target.delete === true) {
          if (Array.isArray(target.edits) && target.edits.length > 0) {
            throw new Error(`Delete target ${target.filename} cannot also contain edits.`);
          }
          if (!existed) throw new Error(`Cannot delete missing file: ${target.filename}`);
        } else if (!existed) {
          newFileContent(target);
        } else if (!Array.isArray(target.edits) || target.edits.length === 0) {
          throw new Error(`Existing file ${target.filename} requires edits or delete=true.`);
        }
        const duplicateIndex = preparedIndexByPath.get(key);
        if (duplicateIndex !== undefined) {
          // Mixed single+multi provider payloads can name one file once as a
          // relative path and once as an absolute path. The later target is
          // the provider's final shape; replace the earlier interpretation
          // instead of executing both mutations or rejecting the whole batch.
          prepared[duplicateIndex] = { ...target, filePath, existed, originalContent };
        } else {
          preparedIndexByPath.set(key, prepared.length);
          prepared.push({ ...target, filePath, existed, originalContent });
        }
      }
    } catch (error: any) {
      const message = formatEditError(error);
      return {
        success: false,
        error: message,
        errors: [message],
        filesModified: [],
        filesCreated: [],
        filesDeleted: [],
        operation: 'none',
        changes: [],
        rolledBack: false,
        results: [],
      };
    }

    const committed: PreparedTarget[] = [];
    const results: any[] = [];
    const assertNotCancelled = () => {
      if (context?.signal?.aborted || context?.abortSignal?.aborted || context?.isCancelled?.()) {
        throw new Error('CANCELLED_BY_USER');
      }
    };
    const emitLiveFileContent = async (
      target: PreparedTarget,
      targetIndex: number,
      content: string,
      operation: 'created' | 'edited',
      stats: { additions: number; deletions: number },
    ): Promise<void> => {
      // File writes are atomic and usually complete faster than a useful
      // preview frame. Publishing staged partial snapshots made cards appear,
      // disappear, and replace guessed line counts before the real result.
      // The authoritative post-write preview emitted by Agent owns this UI.
      void target;
      void targetIndex;
      void content;
      void operation;
      void stats;
    };
    try {
      for (let targetIndex = 0; targetIndex < prepared.length; targetIndex++) {
        const target = prepared[targetIndex];
        assertNotCancelled();
        if (target.delete === true) {
          await fs.unlink(target.filePath);
          committed.push(target);
          results.push({
            success: true,
            deleted: true,
            action: 'deleted',
            path: target.filePath,
            filename: target.filename,
            editsApplied: 1,
            additions: 0,
            deletions: target.originalContent.length ? target.originalContent.split(/\r?\n/).length : 0,
          });
          continue;
        }
        if (!target.existed) {
          const content = newFileContent(target);
          await emitLiveFileContent(target, targetIndex, content, 'created', {
            additions: changedLineCount(content),
            deletions: 0,
          });
          assertNotCancelled();
          await writeUtf8Atomic(target.filePath, content);
          committed.push(target);
          results.push({
            success: true,
            created: true,
            action: 'created',
            path: target.filePath,
            filename: target.filename,
            editsApplied: 1,
            totalLines: changedLineCount(content),
            size: Buffer.byteLength(content, 'utf8'),
            additions: changedLineCount(content),
            deletions: 0,
          });
          continue;
        }

        const result = await applyExistingFileEdits(target, (content, stats) =>
          emitLiveFileContent(target, targetIndex, content, 'edited', stats)
        );
        if (!result || result.success === false || result.error) {
          throw new Error(formatEditError(result?.error ?? result?.message, `Edit failed for ${target.filename}`));
        }
        if (Number(result.editsApplied || 0) > 0) committed.push(target);
        results.push({ ...result, action: 'modified' });
      }
    } catch (error: any) {
      const rollbackErrors = await rollbackTargets(committed);
      const message = formatEditError(error);
      return {
        success: false,
        error: message,
        errors: [message, ...rollbackErrors.map(value => `Rollback warning: ${value}`)],
        filesModified: [],
        filesCreated: [],
        filesDeleted: [],
        operation: 'none',
        changes: [],
        rolledBack: committed.length > 0,
        results,
      };
    }

    const filesCreated = prepared.filter(target => !target.existed).map(target => target.filePath);
    const filesModified = prepared
      .filter((target, index) => target.existed && target.delete !== true && Number(results[index]?.editsApplied || 0) > 0)
      .map(target => target.filePath);
    const filesDeleted = prepared.filter(target => target.delete === true).map(target => target.filePath);
    const editsApplied = results.reduce((sum, result) => sum + Number(result?.editsApplied || 0), 0);
    const single = results.length === 1 ? results[0] : undefined;
    const operationKinds = [filesCreated.length > 0, filesModified.length > 0, filesDeleted.length > 0].filter(Boolean).length;
    const operation = operationKinds > 1
      ? 'mixed'
      : filesCreated.length > 0
        ? 'created'
        : filesModified.length > 0
          ? 'edited'
          : filesDeleted.length > 0
            ? 'deleted'
            : 'none';
    const changes = results.flatMap((result, index) => {
      if (result.action === 'modified' && Number(result.editsApplied || 0) === 0) return [];
      return [{
        path: prepared[index].filePath,
        action: result.action || (prepared[index].delete ? 'deleted' : prepared[index].existed ? 'modified' : 'created'),
        additions: Number(result.additions ?? (result.created ? result.totalLines : 0)) || 0,
        deletions: Number(result.deletions || 0),
      }];
    });

    return {
      success: true,
      message: filesCreated.length || filesModified.length || filesDeleted.length
        ? `Created ${filesCreated.length}, edited ${filesModified.length}, and deleted ${filesDeleted.length} file(s).`
        : 'No file content changed.',
      ...(single || {}),
      filesModified,
      filesCreated,
      filesDeleted,
      operation,
      changes,
      editsApplied,
      results,
      rolledBack: false,
    };
  },
};
