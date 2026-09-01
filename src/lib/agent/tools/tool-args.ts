import { normalizeRegistryToolName } from './registry';
import type { ToolDefinition } from '../schemas';

type ToolArgValidationResult = {
  success: boolean;
  args?: any;
  error?: string;
  missing?: string[];
};

export function getRecoverableToolArgumentGaps(toolName: string, args: any): string[] {
  if (normalizeRegistryToolName(toolName) !== 'workspace_edit_file') return [];
  const files = Array.isArray(args?.files) ? args.files : [];
  const missing: string[] = [];
  if (files.length > 0) {
    files.forEach((target: any, index: number) => {
      if (!String(target?.filename || '').trim()) missing.push(`files.${index}.filename`);
      if (target?.delete !== true && (!Array.isArray(target?.edits) || target.edits.length === 0)) {
        missing.push(`files.${index}.edits or delete`);
      }
    });
    return missing;
  }
  if (!String(args?.filename || '').trim()) missing.push('filename or files');
  if (args?.delete !== true && (!Array.isArray(args?.edits) || args.edits.length === 0)) {
    missing.push('edits or delete');
  }
  return missing;
}

function normalizeFilenameArgs(input: any): void {
  if (!input || typeof input !== 'object') return;
  if (input.path && !input.filename) input.filename = input.path;
  if (input.file && !input.filename) input.filename = input.file;
  if (input.fileName && !input.filename) input.filename = input.fileName;
  if (input.file_name && !input.filename) input.filename = input.file_name;
  if (input['file-name'] && !input.filename) input.filename = input['file-name'];
  if (input.filePath && !input.filename) input.filename = input.filePath;
  if (input.filepath && !input.filename) input.filename = input.filepath;
  if (input.file_path && !input.filename) input.filename = input.file_path;
  if (input.outputPath && !input.filename) input.filename = input.outputPath;
  if (input.output_path && !input.filename) input.filename = input.output_path;
  if (input.targetPath && !input.filename) input.filename = input.targetPath;
  if (input.target_path && !input.filename) input.filename = input.target_path;
  if (input.target && !input.filename) input.filename = input.target;
  if (input.name && !input.filename) input.filename = input.name;
}

function normalizeFileSpec(value: any): any {
  if (typeof value === 'string') return { filename: value };
  if (!value || typeof value !== 'object') return value;
  const spec = { ...value };
  normalizeFilenameArgs(spec);
  normalizeEditArgs(spec);
  return spec;
}

function normalizeEditChunk(value: any): any {
  if (typeof value === 'string') return { replace: value };
  if (!value || typeof value !== 'object') return value;
  const chunk = { ...value };
  if (chunk.search === undefined) {
    chunk.search = chunk.old_string ?? chunk.oldString ?? chunk.oldText ?? chunk.find;
  }
  if (chunk.replace === undefined) {
    chunk.replace = chunk.new_string ?? chunk.newString ?? chunk.newText ?? chunk.replacement ?? chunk.newContent ?? chunk.content;
  }
  if (chunk.replaceAll === undefined && chunk.replace_all !== undefined) chunk.replaceAll = chunk.replace_all;
  const range = chunk.range ?? chunk.lineRange ?? chunk.line_range;
  const rangeStart = Array.isArray(range)
    ? range[0]
    : range && typeof range === 'object'
      ? range.start ?? range.startLine ?? range.from
      : undefined;
  const rangeEnd = Array.isArray(range)
    ? range[1]
    : range && typeof range === 'object'
      ? range.end ?? range.endLine ?? range.to
      : undefined;
  if (chunk.startLine === undefined) {
    chunk.startLine = chunk.start_line ?? chunk.lineStart ?? chunk.line_start ?? chunk.lineNumber ?? chunk.line ?? rangeStart;
  }
  if (chunk.endLine === undefined) {
    chunk.endLine = chunk.end_line ?? chunk.lineEnd ?? chunk.line_end ?? rangeEnd;
  }
  return chunk;
}

function normalizeEditArgs(spec: any): void {
  if (!spec || typeof spec !== 'object') return;
  if (spec.delete === undefined) {
    const operation = String(spec.operation || spec.action || '').trim().toLowerCase();
    if (['delete', 'deleted', 'remove', 'removed', 'unlink'].includes(operation)) spec.delete = true;
  }

  const rawEdits = spec.edits ?? spec.changes ?? spec.patches;
  if (Array.isArray(rawEdits)) {
    spec.edits = rawEdits.map(normalizeEditChunk);
    return;
  }
  if (rawEdits && typeof rawEdits === 'object') {
    spec.edits = [normalizeEditChunk(rawEdits)];
    return;
  }

  const hasInlineEdit = [
    'search', 'old_string', 'oldString', 'oldText', 'find',
    'replace', 'new_string', 'newString', 'newText', 'replacement', 'newContent', 'content',
    'startLine', 'start_line', 'lineStart', 'line_start', 'lineNumber', 'line',
    'endLine', 'end_line', 'lineEnd', 'line_end', 'range', 'lineRange', 'line_range',
  ].some(key => spec[key] !== undefined);
  if (hasInlineEdit) spec.edits = [normalizeEditChunk(spec)];
}

function normalizeFileSpecArray(value: any): any[] {
  if (Array.isArray(value)) return value.map(normalizeFileSpec);
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/\s*,\s*/)
      .filter(Boolean)
      .map(filename => ({ filename }));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, any>;
    const hasNamedTarget = ['filename', 'path', 'file', 'fileName', 'file_path', 'filePath'].some(key => record[key]);
    if (!hasNamedTarget) {
      const mappedTargets = Object.entries(record)
        .filter(([filename, content]) => Boolean(String(filename).trim()) && (
          typeof content === 'string' || Boolean(content && typeof content === 'object' && !Array.isArray(content))
        ))
        .map(([filename, content]) => {
          if (typeof content === 'string') return { filename, edits: [{ replace: content }] };
          const normalized = normalizeFileSpec(content);
          return {
            ...normalized,
            filename: String(normalized?.filename || '').trim() || filename,
          };
        });
      if (mappedTargets.length > 0) return mappedTargets;
    }
    return [normalizeFileSpec(value)];
  }
  return [];
}

function reconcileMixedWorkspaceEditModes(input: any): void {
  if (!Array.isArray(input?.files) || input.files.length === 0) return;
  const filename = String(input.filename || '').trim();
  const hasSingleMutation = (Array.isArray(input.edits) && input.edits.length > 0) || input.delete !== undefined;
  if (input.files.length === 1) {
    const onlyTarget = { ...input.files[0] };
    if (!String(onlyTarget.filename || '').trim() && filename) onlyTarget.filename = filename;
    if (hasSingleMutation && (!filename || String(onlyTarget.filename || '').trim() === filename)) {
      if ((!Array.isArray(onlyTarget.edits) || onlyTarget.edits.length === 0) && Array.isArray(input.edits)) {
        onlyTarget.edits = input.edits;
      }
      if (onlyTarget.delete === undefined && input.delete !== undefined) onlyTarget.delete = input.delete;
    }
    input.files[0] = onlyTarget;
  }
  if (filename && hasSingleMutation) {
    const normalizePath = (value: unknown) => String(value || '').trim().replace(/\\/g, '/').toLowerCase();
    const matchingIndex = input.files.findIndex((target: any) =>
      normalizePath(target?.filename) === normalizePath(filename)
    );
    if (matchingIndex >= 0) {
      // files[] is authoritative. Single-file fields commonly leak from an
      // earlier draft of the same call, so fill only missing target fields and
      // never apply duplicate edit chunks twice.
      const target = { ...input.files[matchingIndex] };
      if ((!Array.isArray(target.edits) || target.edits.length === 0) && Array.isArray(input.edits)) {
        target.edits = input.edits;
      }
      if (target.delete === undefined && input.delete !== undefined) target.delete = input.delete;
      input.files[matchingIndex] = target;
    } else {
      // A distinct filename with a complete mutation is real work, not an
      // invalid mode collision. Preserve it as another atomic target.
      input.files.push({ filename, edits: input.edits, delete: input.delete });
    }
  }

  // Once reconciled, expose one canonical multi-file shape to Zod and the
  // executor. Alias fields remain harmless because object parsing strips them.
  delete input.filename;
  delete input.edits;
  delete input.delete;
}

export function normalizeRegistryToolArgs(toolName: string, args: any): any {
  const name = normalizeRegistryToolName(toolName);
  const input = args && typeof args === 'object' ? { ...args } : {};

  if (name === 'workspace_edit_file') {
    if (!input.files) input.files = input.targets ?? input.fileChanges ?? input.file_changes;
    normalizeFilenameArgs(input);
    normalizeEditArgs(input);
  }
  if (name === 'workspace_edit_file' && input.files) {
    input.files = normalizeFileSpecArray(input.files);
    reconcileMixedWorkspaceEditModes(input);
  }
  if (name === 'workspace_run_command') {
    if (input.cmd && !input.command) input.command = input.cmd;
    if (Array.isArray(input.commands)) {
      input.commands = input.commands.map((entry: any) => {
        if (!entry || typeof entry !== 'object') return entry;
        return entry.cmd && !entry.command ? { ...entry, command: entry.cmd } : entry;
      });
    }
  }
  return input;
}

function hasSafeParse(schema: unknown): schema is { safeParse: (value: unknown) => any } {
  return Boolean(schema && typeof (schema as any).safeParse === 'function');
}

function formatIssuePath(pathValue: unknown): string {
  if (!Array.isArray(pathValue) || pathValue.length === 0) return 'args';
  return pathValue.map(part => String(part)).join('.');
}

function formatValidationIssues(error: any): string {
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  if (issues.length === 0) {
    return error?.message ? String(error.message) : 'Input did not match the tool schema.';
  }

  const shown = issues.slice(0, 8).map((issue: any) => {
    const path = formatIssuePath(issue?.path);
    const message = issue?.message ? String(issue.message) : 'Invalid value';
    return `${path}: ${message}`;
  });

  if (issues.length > shown.length) {
    shown.push(`...and ${issues.length - shown.length} more issue(s)`);
  }

  return shown.join('; ');
}

export function validateRegistryToolArgs(
  tool: Pick<ToolDefinition, 'name' | 'inputSchema'>,
  args: any,
): ToolArgValidationResult {
  if (!hasSafeParse(tool.inputSchema)) {
    return { success: true, args };
  }

  try {
    const result = tool.inputSchema.safeParse(args ?? {});
    if (result.success) {
      return { success: true, args: result.data };
    }

    return {
      success: false,
      error: `Invalid arguments for ${tool.name} after alias normalization: ${formatValidationIssues(result.error)}`,
      missing: getRecoverableToolArgumentGaps(tool.name, args),
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Invalid arguments for ${tool.name}: ${err?.message || 'Tool schema validation failed.'}`,
    };
  }
}
