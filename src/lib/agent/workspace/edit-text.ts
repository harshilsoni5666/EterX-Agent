export type TextEdit = {
  search?: string;
  replace: string;
  startLine?: number;
  endLine?: number;
  replaceAll?: boolean;
  replace_all?: boolean;
};

export const editLineCount = (text: string): number => text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;

function lineSpans(text: string) {
  const lines: Array<{ start: number; end: number; breakEnd: number }> = [];
  let start = 0;
  const breaks = /\r\n|\r|\n/g;
  let match: RegExpExecArray | null;
  while ((match = breaks.exec(text)) !== null) {
    lines.push({ start, end: match.index, breakEnd: breaks.lastIndex });
    start = breaks.lastIndex;
  }
  lines.push({ start, end: text.length, breakEnd: text.length });
  return lines;
}

/** LF matching view with reversible offsets; unrelated CRLF/mixed bytes stay put. */
function matchingView(text: string) {
  const removedAt: number[] = [];
  const breaks = /\r\n/g;
  let match: RegExpExecArray | null;
  while ((match = breaks.exec(text)) !== null) removedAt.push(match.index - removedAt.length);
  return {
    text: text.replace(/\r\n|\r/g, '\n'),
    originalOffset(offset: number): number {
      let low = 0;
      let high = removedAt.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (removedAt[middle] < offset) low = middle + 1;
        else high = middle;
      }
      return offset + low;
    },
  };
}

/** An explicit selection always bounds a replacement, including replaceAll. */
export function applyTextEdit(content: string, edit: TextEdit, label: string) {
  const lines = lineSpans(content);
  const ending = /\r\n|\r|\n/.exec(content)?.[0] || '\n';
  const replacement = edit.replace.replace(/\r\n|\r|\n/g, ending);
  let from = 0;
  let to = content.length;
  let hasFollowingLine = false;
  const hasRange = edit.startLine !== undefined || edit.endLine !== undefined;
  if (hasRange) {
    const start = edit.startLine;
    const end = edit.endLine === -1 ? lines.length : edit.endLine;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start! < 1 || end! < start! || end! > lines.length) {
      throw new Error(`${label}: invalid range ${start}-${edit.endLine}; current content has ${lines.length} lines. Supply both inclusive 1-based ends; use 1,-1 for an intentional full rewrite. No range is guessed or expanded.`);
    }
    from = lines[start! - 1].start;
    to = lines[end! - 1].breakEnd;
    hasFollowingLine = end! < lines.length;
  }
  if (edit.search === undefined) {
    if (!hasRange) {
      throw new Error(`${label}: existing content needs search+replace or startLine+endLine+replace. An intentional full rewrite uses {startLine:1,endLine:-1,replace:completeContent}; creation without a selector cannot overwrite it.`);
    }
    // Consume the selected line terminator once, not both it and a newline
    // supplied in replace. Preserve separation from an unselected suffix.
    const boundary = hasFollowingLine && replacement && !/[\r\n]$/.test(replacement) ? ending : '';
    return {
      content: content.slice(0, from) + replacement + boundary + content.slice(to),
      additions: editLineCount(replacement),
      deletions: editLineCount(content.slice(from, to)),
    };
  }

  const view = matchingView(content.slice(from, to));
  const search = edit.search.replace(/\r\n|\r/g, '\n');
  if (!search) throw new Error(`${label}: search must be non-empty.`);
  // Do not relax whitespace, indentation, quotes, or escapes. Even trailing
  // spaces may be literal data in a multiline string or a text fixture.
  const positions: number[] = [];
  let cursor = 0;
  const replaceAll = edit.replaceAll === true || edit.replace_all === true;
  while (cursor <= view.text.length - search.length) {
    const offset = view.text.indexOf(search, cursor);
    if (offset < 0) break;
    const previous = positions[positions.length - 1];
    if (previous !== undefined && offset < previous + search.length) {
      throw new Error(`${label}: search has overlapping matches. Select a larger unique block or a precise range.`);
    }
    positions.push(offset);
    if (!replaceAll && positions.length > 1) break;
    cursor = offset + 1;
  }
  if (positions.length === 0) {
    throw new Error(`${label}: search not found${hasRange ? ' inside the supplied range' : ''}. Read the current target section and copy a unique exact block; do not widen the edit to a full rewrite to bypass this failure.`);
  }
  if (positions.length > 1 && !replaceAll) {
    throw new Error(`${label}: search matched more than once${hasRange ? ' inside the supplied range' : ''}. Include unique surrounding context, restrict the range, or use replaceAll:true only if every match should change.`);
  }

  const parts = [content.slice(0, from)];
  let last = from;
  let deletions = 0;
  for (const position of positions) {
    const start = from + view.originalOffset(position);
    const end = from + view.originalOffset(position + search.length);
    parts.push(content.slice(last, start), replacement);
    deletions += editLineCount(content.slice(start, end));
    last = end;
  }
  parts.push(content.slice(last));
  return { content: parts.join(''), additions: editLineCount(replacement) * positions.length, deletions };
}
