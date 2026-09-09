/** Normalize spelling/serialization, never guess the extent of a mutation. */
export function normalizeWorkspaceEditChunk(value: unknown): unknown {
  if (typeof value === 'string') return { replace: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const chunk = { ...(value as Record<string, any>) };
  if (chunk.search === undefined) {
    chunk.search = chunk.old_string ?? chunk.oldString ?? chunk.oldText ?? chunk.old_content
      ?? chunk.oldContent ?? chunk.searchText ?? chunk.match ?? chunk.before ?? chunk.find;
  }
  if (chunk.replace === undefined) {
    chunk.replace = chunk.new_string ?? chunk.newString ?? chunk.newText ?? chunk.replacement ?? chunk.newContent
      ?? chunk.new_content ?? chunk.replacementText ?? chunk.after ?? chunk.new_file_content
      ?? chunk.fileContent ?? chunk.content ?? chunk.code ?? chunk.body;
  }
  // Empty provider placeholders never authorize overwriting an existing file.
  if (chunk.search === null || chunk.search === '') delete chunk.search;
  for (const key of ['replaceAll', 'replace_all']) {
    if (typeof chunk[key] === 'string' && /^(true|false)$/i.test(chunk[key].trim())) {
      chunk[key] = chunk[key].trim().toLowerCase() === 'true';
    }
  }
  if (chunk.replaceAll === undefined && chunk.replace_all !== undefined) chunk.replaceAll = chunk.replace_all;
  const range = chunk.range ?? chunk.lineRange ?? chunk.line_range;
  const rangeStart = Array.isArray(range) ? range[0] : range?.start ?? range?.startLine ?? range?.from;
  const rangeEnd = Array.isArray(range) ? range[1] : range?.end ?? range?.endLine ?? range?.to;
  const singleLine = chunk.lineNumber ?? chunk.line;
  chunk.startLine ??= chunk.start_line ?? chunk.lineStart ?? chunk.line_start ?? singleLine ?? rangeStart;
  chunk.endLine ??= chunk.end_line ?? chunk.lineEnd ?? chunk.line_end ?? rangeEnd;
  // The explicit "line" alias means one line. A lone startLine does NOT mean
  // one line, EOF, zero-based indexing, or a reversed range.
  if (chunk.endLine === undefined && singleLine !== undefined && chunk.startLine === singleLine) {
    chunk.endLine = singleLine;
  }
  for (const key of ['startLine', 'endLine']) {
    if (typeof chunk[key] === 'string' && /^-?\d+$/.test(chunk[key].trim())) chunk[key] = Number(chunk[key]);
  }
  if (typeof chunk.endLine === 'string' && /^(eof|end)$/i.test(chunk.endLine.trim())) chunk.endLine = -1;
  // Keep invalid source strings/types intact so the schema can explain them;
  // stringify/coercion here can silently write a different program.
  return chunk;
}
