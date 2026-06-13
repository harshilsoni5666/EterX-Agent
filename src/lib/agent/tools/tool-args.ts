import { normalizeRegistryToolName } from './registry';
import type { ToolDefinition } from '../schemas';

type ToolArgValidationResult =
  | { success: true; args: any }
  | { success: false; error: string };

export function normalizeRegistryToolArgs(toolName: string, args: any): any {
  const name = normalizeRegistryToolName(toolName);
  const input = args && typeof args === 'object' ? { ...args } : {};

  if (name === 'workspace_read_file' && input.path && !input.filename) input.filename = input.path;
  if (name === 'workspace_read_file' && input.file && !input.filename) input.filename = input.file;
  if (name === 'workspace_read_many_files' && input.paths && !input.files) {
    input.files = input.paths.map((p: string) => ({ filename: p }));
  }
  if (name === 'workspace_edit_many_files' && input.files && !input.edits) input.edits = input.files;
  if (name === 'workspace_search_text' && input.query && !input.pattern) input.pattern = input.query;
  if (name === 'workspace_find_files' && input.pattern && !input.glob) input.glob = input.pattern;
  if (name === 'workspace_run_command' && input.cmd && !input.command) input.command = input.cmd;
  if (name === 'workspace_apply_patch' && input.content && !input.patch) input.patch = input.content;
  if (name === 'workspace_apply_patch' && input.diff && !input.patch) input.patch = input.diff;
  if (name === 'workspace_str_replace') {
    if (input.path && !input.filename) input.filename = input.path;
    if (input.file && !input.filename) input.filename = input.file;
    if (input.search && !input.old_string) input.old_string = input.search;
    if (input.replace && !input.new_string) input.new_string = input.replace;
  }
  if (name === 'workspace_semantic_search') {
    if (input.question && !input.query) input.query = input.question;
    if (input.q && !input.query) input.query = input.q;
  }
  if (name === 'workspace_symbol_lookup') {
    if (input.name && !input.symbol) input.symbol = input.name;
    if (input.query && !input.symbol) input.symbol = input.query;
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
