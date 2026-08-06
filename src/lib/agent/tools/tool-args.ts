import { normalizeRegistryToolName } from './registry';
import type { ToolDefinition } from '../schemas';

type ToolArgValidationResult = {
  success: boolean;
  args?: any;
  error?: string;
};

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
  if (input.target && !input.filename) input.filename = input.target;
  if (input.name && !input.filename) input.filename = input.name;
}

function normalizeContentArgs(input: any): void {
  if (!input || typeof input !== 'object' || input.content) return;
  for (const key of ['text', 'body', 'code', 'source', 'contents', 'textContent', 'data']) {
    if (typeof input[key] === 'string' && input[key].length > 0) {
      input.content = input[key];
      return;
    }
  }
}

function normalizeFileSpec(value: any): any {
  if (typeof value === 'string') return { filename: value };
  if (!value || typeof value !== 'object') return value;
  const spec = { ...value };
  normalizeFilenameArgs(spec);
  return spec;
}

function normalizeFileSpecArray(value: any): any[] {
  if (Array.isArray(value)) return value.map(normalizeFileSpec);
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/\s*,\s*/)
      .filter(Boolean)
      .map(filename => ({ filename }));
  }
  if (value && typeof value === 'object') return [normalizeFileSpec(value)];
  return [];
}

export function normalizeRegistryToolArgs(toolName: string, args: any): any {
  const name = normalizeRegistryToolName(toolName);
  const input = args && typeof args === 'object' ? { ...args } : {};

  if (name === 'workspace_read_file' || name === 'workspace_write_file' || name === 'workspace_edit_file') {
    normalizeFilenameArgs(input);
  }
  if (name === 'workspace_write_file') normalizeContentArgs(input);
  if (name === 'workspace_read_many_files' && input.paths && !input.files) {
    input.files = normalizeFileSpecArray(input.paths);
  }
  if (name === 'workspace_read_many_files' && input.files) {
    input.files = normalizeFileSpecArray(input.files);
  }
  if (name === 'workspace_edit_many_files' && input.files && !input.edits) input.edits = input.files;
  if (name === 'workspace_edit_many_files' && input.edits) {
    input.edits = normalizeFileSpecArray(input.edits);
  }
  if (name === 'workspace_search_text' && input.query && !input.pattern) input.pattern = input.query;
  if (name === 'workspace_find_files' && input.pattern && !input.glob) input.glob = input.pattern;
  if (name === 'workspace_run_command' && input.cmd && !input.command) input.command = input.cmd;
  if (name === 'workspace_apply_patch' && input.content && !input.patch) input.patch = input.content;
  if (name === 'workspace_apply_patch' && input.diff && !input.patch) input.patch = input.diff;
  if (name === 'workspace_str_replace') {
    normalizeFilenameArgs(input);
    if (input.search && !input.old_string) input.old_string = input.search;
    if (input.replace && !input.new_string) input.new_string = input.replace;
  }
  if (name === 'workspace_semantic_search') {
    if (input.question && !input.query) input.query = input.question;
    if (input.q && !input.query) input.query = input.q;
  }
  if (name === 'workspace_file_outline') {
    if (input.path && !input.filename) input.filename = input.path;
    if (input.file && !input.filename) input.filename = input.file;
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
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Invalid arguments for ${tool.name}: ${err?.message || 'Tool schema validation failed.'}`,
    };
  }
}
