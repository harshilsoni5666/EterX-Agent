import { z } from 'zod';
import fs from 'fs/promises';
import fse from 'fs-extra';
import path from 'path';
import type { ToolDefinition } from '../../schemas';
import { checkEterXProtection, resolveWorkspacePathForContext } from '../../workspace/path_resolver';

const editChunkSchema = z.object({
  search: z.string().min(1).optional().describe('Exact non-empty text to find in an existing file. It must match whitespace and line endings.'),
  replace: z.string().describe('Replacement text. For a new file, this is the complete file content.'),
  replaceAll: z.boolean().optional().describe('Replace every exact occurrence. Defaults to false.'),
  replace_all: z.boolean().optional().describe('Alias for replaceAll.'),
  startLine: z.number().int().min(1).optional().describe('First 1-indexed line to replace in an existing file.'),
  endLine: z.number().int().min(1).optional().describe('Last 1-indexed line to replace in an existing file.'),
});

const editTargetSchema = z.object({
  filename: z.string().min(1).describe('Absolute path or path relative to the active workspace.'),
  edits: z.array(editChunkSchema).min(1).max(50).optional().describe('All edits for this file, applied in array order. Omit when delete=true.'),
  delete: z.boolean().optional().describe('Delete this file. Do not provide edits when true.'),
});

type EditChunk = z.infer<typeof editChunkSchema>;
type EditTarget = z.infer<typeof editTargetSchema>;

type PreparedTarget = EditTarget & {
  filePath: string;
  existed: boolean;
  originalContent: string;
};

const changedLineCount = (value: string): number => value.length === 0 ? 0 : value.split(/\r?\n/).length;

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
    if (input.filename || input.edits || input.delete !== undefined) {
      throw new Error('Use either single-file fields or files for a multi-file operation, not both.');
    }
    return input.files;
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
  if (edit.search !== undefined || edit.startLine !== undefined || edit.endLine !== undefined) {
    throw new Error(`New file ${target.filename} must use one edit with only the replace field.`);
  }
  return edit.replace;
}

async function applyExistingFileEdits(target: PreparedTarget): Promise<Record<string, any>> {
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
    const endLine = edit.endLine;
    const hasStartLine = startLine !== undefined;
    const hasEndLine = endLine !== undefined;
    if (hasStartLine !== hasEndLine) {
      throw new Error(`Edit #${editIndex + 1} in ${target.filename} must provide both startLine and endLine.`);
    }
    if (hasStartLine && edit.search !== undefined) {
      throw new Error(`Edit #${editIndex + 1} in ${target.filename} must use either a line range or search text, not both.`);
    }
    if (startLine !== undefined && endLine !== undefined) {
      const startIndex = Math.max(0, startLine - 1);
      const endIndex = Math.min(lines.length - 1, endLine - 1);
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
      throw new Error('Edit chunk must have either a "search" string or "startLine" and "endLine" numbers.');
    }
    content = lines.join(lineEnding);
    if (!content.includes(edit.search)) {
      const searchPreview = edit.search.length > 100 ? `${edit.search.slice(0, 100)}...` : edit.search;
      throw new Error(
        `Could not find search block in ${target.filename} (edit #${editIndex + 1}).\n` +
        `Searched for: "${searchPreview}"\n` +
        'Make sure it matches EXACTLY including whitespace, indentation, and line endings.\n' +
        'TIP: Inspect the file first with workspace_run_command, then copy the exact text.',
      );
    }

    const occurrences = content.split(edit.search).length - 1;
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
    deletions += changedLineCount(edit.search) * replacements;
    additions += changedLineCount(edit.replace) * replacements;
    content = replaceAll
      ? content.split(edit.search).join(edit.replace)
      : content.replace(edit.search, edit.replace);
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
      errors.push(`${target.filename}: ${String(error?.message || error)}`);
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
  description: 'Create, edit, or delete one or many files with real UI diffs. For one file use filename plus edits, or filename plus delete=true. For several files use files. Existing files support exact search/replace or line ranges. A missing file is created by one edit whose replace value is the complete content. Delete targets use delete=true with no edits.',
  category: 'workspace',
  inputSchema: z.object({
    filename: z.string().optional().describe('Single-file mode: absolute path or path relative to the active workspace.'),
    edits: z.array(editChunkSchema).min(1).max(50).optional().describe('Single-file mode: edits applied in array order.'),
    delete: z.boolean().optional().describe('Single-file mode: delete the file. Do not also provide edits.'),
    files: z.array(editTargetSchema).min(1).max(50).optional().describe('Multi-file mode: all create, edit, or delete targets. Do not also provide single-file fields.'),
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
      const message = String(error?.message || error);
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
    const seen = new Set<string>();
    try {
      for (const target of targets) {
        const filePath = resolveWorkspacePathForContext(target.filename, context);
        const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
        if (seen.has(key)) throw new Error(`Duplicate file target: ${target.filename}`);
        seen.add(key);

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
        prepared.push({ ...target, filePath, existed, originalContent });
      }
    } catch (error: any) {
      const message = String(error?.message || error);
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
    try {
      for (const target of prepared) {
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

        const result = await applyExistingFileEdits(target);
        if (!result || result.success === false || result.error) {
          throw new Error(String(result?.error || result?.message || `Edit failed for ${target.filename}`));
        }
        if (Number(result.editsApplied || 0) > 0) committed.push(target);
        results.push({ ...result, action: 'modified' });
      }
    } catch (error: any) {
      const rollbackErrors = await rollbackTargets(committed);
      const message = String(error?.message || error);
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
