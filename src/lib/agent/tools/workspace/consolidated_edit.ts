import { z } from 'zod';
import fs from 'fs/promises';
import fse from 'fs-extra';
import path from 'path';
import { swarmCoordinator } from '../../swarm-coordinator';
import type { ToolDefinition } from '../../schemas';
import { resolveWorkspacePathForContext } from '../../workspace/path_resolver';
import { acquireEditTransaction } from '../../workspace/edit-transaction-lock';
import { normalizeWorkspaceEditChunk } from '../../workspace/edit-input';
import { WORKSPACE_EDIT_DESCRIPTION } from '../../workspace-edit-contract';
import { assertNoNewDuplicateDeclarations } from '../../workspace/edit-source-safety';
import { applyTextEdit, editLineCount } from '../../workspace/edit-text';
import { completedEditReceipt, editInvocationKey, editRequestSignature, rememberCompletedEdit } from '../../workspace/edit-receipts';

const editChunkSchema = z.preprocess(normalizeWorkspaceEditChunk, z.object({
  search: z.string().min(1).optional().describe('Exact observed block. Only this text is replaced; code outside it remains. Copy source without display numbers/omissions. With startLine/endLine, match only inside those lines. Omit for creation or range-only replacement.'),
  replace: z.string().describe('Required literal text for ONLY the selected block/range, with JSON escaping exactly once. Empty string deletes it. No selector creates only a missing/zero-byte file. A stub or previously created file is existing: complete replacement requires startLine:1,endLine:-1. Write complete new files directly without a placeholder first. Never replace only a prefix with a complete class/file.'),
  replaceAll: z.boolean().optional().describe('Replace every exact match in the selected scope (whole file, or supplied range). Requires search; defaults to false.'),
  replace_all: z.boolean().optional().describe('Alias for replaceAll.'),
  startLine: z.number().int().min(1).optional().describe('First inclusive 1-based line; endLine is also required. Whole existing file: startLine:1,endLine:-1. Ranges refer to content after preceding edits.'),
  endLine: z.number().int().refine(value => value === -1 || value >= 1, 'endLine must be at least 1, or -1 for end of file.').optional().describe('Last inclusive 1-based line, or -1 for EOF. startLine is also required. Do not guess a large end line for a rewrite; use -1.'),
}).superRefine((edit, issues) => {
  if ((edit.startLine === undefined) !== (edit.endLine === undefined)) {
    issues.addIssue({ code: z.ZodIssueCode.custom, path: [edit.startLine === undefined ? 'startLine' : 'endLine'], message: 'Supply both range ends. One line: startLine:N,endLine:N. Whole existing file: startLine:1,endLine:-1.' });
  }
  if (edit.startLine !== undefined && edit.endLine !== undefined && edit.endLine !== -1 && edit.endLine < edit.startLine) {
    issues.addIssue({ code: z.ZodIssueCode.custom, path: ['endLine'], message: 'endLine must be >= startLine, or -1 for EOF. Reversed ranges are not rearranged.' });
  }
  if (edit.replaceAll !== undefined && edit.replace_all !== undefined && edit.replaceAll !== edit.replace_all) {
    issues.addIssue({ code: z.ZodIssueCode.custom, path: ['replaceAll'], message: 'replaceAll and replace_all disagree; use only replaceAll.' });
  }
  if ((edit.replaceAll === true || edit.replace_all === true) && edit.search === undefined) {
    issues.addIssue({ code: z.ZodIssueCode.custom, path: ['search'], message: 'replaceAll requires a non-empty search; omit replaceAll for creation and range-only replacement.' });
  }
}));

const editTargetSchema = z.object({
  filename: z.string().min(1).optional().describe('Absolute path or path relative to the active workspace. A one-item files array may inherit the top-level filename.'),
  edits: z.array(editChunkSchema).min(1).max(50).optional().describe('Sequential edits for this file. Create: [{replace:completeContent}]. Existing full rewrite: [{startLine:1,endLine:-1,replace:completeContent}]. Partial replacement covers only its selected block/range. Omit when delete=true.'),
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
  originalBytes: Buffer;
  mode?: number;
};

type StagedTarget = PreparedTarget & {
  nextContent: string | null;
  result: Record<string, any>;
};

const changedLineCount = editLineCount;

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

async function writeUtf8Atomic(
  filePath: string,
  content: string | Buffer,
  expected: Buffer | null,
  mode?: number,
  assertNotCancelled: () => void = () => undefined,
): Promise<void> {
  await fse.ensureDir(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx', ...(mode !== undefined ? { mode } : {}) });
    // Retry only a temporarily blocked Windows rename, not the edit itself.
    // Re-check the expected bytes before every attempt so an editor/save made
    // during the wait is preserved. Never unlink the destination as a fallback.
    const delays = [40, 120, 280];
    for (let attempt = 0; ; attempt++) {
      assertNotCancelled();
      await assertExpectedFile(filePath, expected);
      assertNotCancelled();
      try {
        await fs.rename(tempPath, filePath);
        break;
      } catch (error: any) {
        if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes(error?.code) || attempt >= delays.length) throw error;
        await new Promise<void>(resolve => setTimeout(resolve, delays[attempt]));
      }
    }
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}

async function physicalEditPath(filePath: string): Promise<string> {
  try { return await fs.realpath(filePath); } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    const parent = path.dirname(filePath);
    if (parent === filePath) throw error;
    return path.join(await physicalEditPath(parent), path.basename(filePath));
  }
}

async function assertExpectedFile(filePath: string, expected: Buffer | null): Promise<void> {
  let current: Buffer | null;
  try { current = await fs.readFile(filePath); } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    current = null;
  }
  if (expected === null ? current !== null : current === null || !current.equals(expected)) {
    throw new Error(`File changed while the edit was being prepared: ${filePath}. Re-read this target before retrying.`);
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
      const normalizePath = (value: unknown) => {
        const filename = String(value || '').trim().replace(/\\/g, '/');
        return process.platform === 'win32' ? filename.toLowerCase() : filename;
      };
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
    throw new Error(`Create ${target.filename} with exactly one edit: [{replace:completeContent}]. Multiple selector-free chunks are not concatenated.`);
  }
  if (target.edits.some(edit => edit.search !== undefined || edit.startLine !== undefined || edit.endLine !== undefined)) {
    throw new Error(`Cannot apply an existing-file selector to missing file ${target.filename}. Correct the path, or create it with selector-free complete content.`);
  }
  return target.edits[0].replace;
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
  let additions = 0;
  let deletions = 0;

  const selectorFree = target.edits.every(edit =>
    edit.search === undefined && edit.startLine === undefined && edit.endLine === undefined
  );
  if (selectorFree) {
    const replacement = newFileContent(target);
    // A retry can arrive after creation succeeded, or after an interrupted
    // creation left an empty file. Tolerate both without permitting a
    // selector-free overwrite of existing user content.
    if (content === replacement) {
      return {
        success: true,
        message: `Requested content is already present; file unchanged: ${target.filePath}`,
        path: target.filePath,
        filename: target.filename,
        editsApplied: 0,
        additions: 0,
        deletions: 0,
        totalLines: changedLineCount(content),
        size: Buffer.byteLength(content, 'utf8'),
      };
    }
    if (content.length === 0) {
      await onPrepared?.(replacement, { additions: changedLineCount(replacement), deletions: 0 });
      return {
        success: true,
        message: `Filled empty file ${target.filePath}`,
        path: target.filePath,
        filename: target.filename,
        editsApplied: target.edits.length,
        additions: changedLineCount(replacement),
        deletions: 0,
        totalLines: changedLineCount(replacement),
        size: Buffer.byteLength(replacement, 'utf8'),
      };
    }
    throw new Error(`Existing non-empty file ${target.filename} cannot use the create-file format, even if it is a stub or was created earlier in this task. Current size: ${Buffer.byteLength(content, 'utf8')} bytes. If complete replacement is intended and current full-file context is known, use edits:[{startLine:1,endLine:-1,replace:completeContent}]. For a partial change use search:exactCurrentBlock plus replace. Do not repeat the selector-free call. Nothing was written.`);
  }

  for (let editIndex = 0; editIndex < target.edits.length; editIndex++) {
    const applied = applyTextEdit(content, target.edits[editIndex], `${target.filename}, edit #${editIndex + 1}`);
    content = applied.content;
    additions += applied.additions;
    deletions += applied.deletions;
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
      totalLines: changedLineCount(content),
      size: Buffer.byteLength(content, 'utf8'),
    };
  }

  const finalContent = content;
  await onPrepared?.(finalContent, { additions, deletions });
  return {
    success: true,
    message: `Applied ${target.edits.length} edits to ${target.filePath}`,
    path: target.filePath,
    filename: target.filename,
    editsApplied: target.edits.length,
    additions,
    deletions,
    totalLines: changedLineCount(finalContent),
    size: Buffer.byteLength(finalContent, 'utf8'),
  };
}

async function rollbackTargets(committed: StagedTarget[]): Promise<string[]> {
  const errors: string[] = [];
  for (const target of [...committed].reverse()) {
    try {
      // Never undo a newer edit made outside this transaction.
      await assertExpectedFile(target.filePath, target.nextContent === null ? null : Buffer.from(target.nextContent, 'utf8'));
      if (target.existed) await writeUtf8Atomic(target.filePath, target.originalBytes,
        target.nextContent === null ? null : Buffer.from(target.nextContent, 'utf8'), target.mode);
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
  modelDescription: WORKSPACE_EDIT_DESCRIPTION,
  description: WORKSPACE_EDIT_DESCRIPTION,
  category: 'workspace',
  inputSchema: z.object({
    filename: z.string().optional().describe('Single-file mode: absolute path or path relative to the active workspace.'),
    edits: z.array(editChunkSchema).min(1).max(50).optional().describe('Sequential edits. Create: [{replace:completeContent}]. Rewrite an existing file: [{startLine:1,endLine:-1,replace:completeContent}]. Partial changes replace only the selected block/range. Use bottom-up order for disjoint original line ranges.'),
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
    if (hasMultiFiles) {
      if (value.edits !== undefined || value.delete !== undefined) {
        issueContext.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: 'Conflicting single-file and files[] mutations. Put all changes in files[] once; do not supply top-level edits/delete.' });
      }
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
    const assertNotCancelled = () => {
      if (context?.signal?.aborted || context?.abortSignal?.aborted || context?.isCancelled?.()) {
        throw new Error('CANCELLED_BY_USER');
      }
    };
    let targets: EditTarget[];
    try {
      // Direct callers and provider callers obey the same schema/preprocessing.
      const parsed = workspaceEditFileTool.inputSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((issue: any) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
      }
      targets = normalizeTargets(parsed.data);
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
    const invocationKey = editInvocationKey(context);
    const signature = editRequestSignature(targets);
    let releaseTransaction: (() => void) | undefined;
    try {
      assertNotCancelled();
      const resolvedTargets: Array<EditTarget & { filePath: string }> = [];
      for (const target of targets) {
        const targetFilename = String(target.filename || '').trim();
        if (!targetFilename) throw new Error('Each workspace edit target requires a filename.');
        const requestedPath = resolveWorkspacePathForContext(targetFilename, context);
        const filePath = await physicalEditPath(requestedPath);
        resolveWorkspacePathForContext(filePath, context);
        resolvedTargets.push({ ...target, filePath });
      }
      // The synthetic key is only an in-memory mutex key, never a disk path.
      // Reserve it with the targets so even conflicting concurrent replays
      // cannot race their receipt or commit separate payloads under one ID.
      releaseTransaction = await acquireEditTransaction([
        ...resolvedTargets.map(target => target.filePath),
        ...(invocationKey ? [`\0edit-invocation:${invocationKey}`] : []),
      ]);
      const releaseFiles = releaseTransaction;
      const releaseOwnership = swarmCoordinator.holdWrites(context || {}, resolvedTargets.map(target => target.filePath));
      releaseTransaction = () => { releaseOwnership(); releaseFiles(); };
      assertNotCancelled();
      const receipt = completedEditReceipt(invocationKey, signature);
      if (receipt) {
        releaseTransaction();
        releaseTransaction = undefined;
        return receipt;
      }
      for (const target of resolvedTargets) {
        const ownershipConflict = swarmCoordinator.writeConflict(context || {}, [target.filePath]);
        if (ownershipConflict) throw new Error(ownershipConflict);
        const { filePath } = target;
        const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
        const duplicateIndex = preparedIndexByPath.get(key);
        if (duplicateIndex !== undefined) {
          const previous = prepared[duplicateIndex];
          if ((previous.delete === true) !== (target.delete === true)) {
            throw new Error(`Conflicting edit and delete operations for ${target.filename}. Use one operation per target.`);
          }
          if (JSON.stringify(previous.edits) !== JSON.stringify(target.edits)) {
            throw new Error(`Multiple different edit entries resolve to ${target.filename}. Put this file's edits in one ordered edits array; repeated target payloads are not concatenated.`);
          }
          continue;
        }

        const existed = await fse.pathExists(filePath);
        const originalBytes = existed ? await fs.readFile(filePath) : Buffer.alloc(0);
        const originalContent = originalBytes.toString('utf8');
        const mode = existed ? (await fs.stat(filePath)).mode : undefined;
        if (target.delete !== true && (originalBytes.includes(0) || !Buffer.from(originalContent, 'utf8').equals(originalBytes))) {
          throw new Error(`Cannot text-edit binary or non-UTF-8 file ${target.filename}. Preserve its format with an appropriate artifact tool.`);
        }
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
        preparedIndexByPath.set(key, prepared.length);
        prepared.push({ ...target, filePath, existed, originalContent, originalBytes, mode });
      }
    } catch (error: any) {
      releaseTransaction?.();
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

    const staged: StagedTarget[] = [];
    const committed: StagedTarget[] = [];
    const results: any[] = [];
    try {
      // Prepare all content before publishing any mutation. Invalid selectors
      // in a later target cannot leave earlier files temporarily half-edited.
      for (const target of prepared) {
        assertNotCancelled();
        if (target.delete === true) {
          staged.push({ ...target, nextContent: null, result: {
            success: true,
            deleted: true,
            action: 'deleted',
            path: target.filePath,
            filename: target.filename,
            editsApplied: 1,
            additions: 0,
            deletions: changedLineCount(target.originalContent),
          } });
        } else if (!target.existed) {
          const content = newFileContent(target);
          staged.push({ ...target, nextContent: content, result: {
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
          } });
        } else {
          let nextContent = target.originalContent;
          const result = await applyExistingFileEdits(target, async content => { nextContent = content; });
          if (!result || result.success === false || result.error) {
            throw new Error(formatEditError(result?.error ?? result?.message, `Edit failed for ${target.filename}`));
          }
          staged.push({ ...target, nextContent, result: { ...result, action: 'modified' } });
        }
      }
      // Inspect only the staged text, without executing it, resolving imports,
      // launching checks, or touching the user's other source files.
      for (const target of staged) {
        if (target.nextContent !== null && target.nextContent !== target.originalContent) {
          await assertNoNewDuplicateDeclarations(target.filePath, target.originalContent, target.nextContent);
        }
      }
      for (const target of staged) {
        assertNotCancelled();
        await assertExpectedFile(target.filePath, target.existed ? target.originalBytes : null);
      }
      for (const target of staged) {
        assertNotCancelled();
        if (Number(target.result.editsApplied || 0) > 0) {
          await assertExpectedFile(target.filePath, target.existed ? target.originalBytes : null);
          assertNotCancelled();
          if (target.nextContent === null) await fs.unlink(target.filePath);
          else await writeUtf8Atomic(target.filePath, target.nextContent,
            target.existed ? target.originalBytes : null, target.mode, assertNotCancelled);
          committed.push(target);
        }
        results.push(target.result);
      }
      assertNotCancelled();
      rememberCompletedEdit(invocationKey, signature, prepared.map(target => target.filePath));
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
        rolledBack: committed.length > 0 && rollbackErrors.length === 0,
        rollbackIncomplete: rollbackErrors.length > 0,
        stateChanged: rollbackErrors.length > 0,
        results: results.map(result => ({ ...result, success: false, rolledBack: rollbackErrors.length === 0 })),
      };
    } finally {
      releaseTransaction?.();
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
