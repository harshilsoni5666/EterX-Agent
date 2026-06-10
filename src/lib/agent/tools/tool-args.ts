import { normalizeRegistryToolName } from './registry';

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
