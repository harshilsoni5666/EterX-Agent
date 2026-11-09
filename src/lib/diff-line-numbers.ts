export type NumberedDiffLine = {
  type: string;
  content: string;
  isGap?: boolean;
  skipped?: number;
  oldLine?: number;
  newLine?: number;
  displayOldLine?: number;
  displayNewLine?: number;
  /** Source apply_patch navigation, used only while reconstructing history. */
  patchContext?: string;
  patchEndOfFile?: boolean;
};

const position = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined;

/** Preserve real file coordinates. A missing source offset must never become
 * an invented 1, 2, 3 file gutter. Legacy excerpt counters are discarded. */
export function numberDiffLines<T extends NumberedDiffLine>(lines: T[], start: { oldLine?: number; newLine?: number } = {}): T[] {
  let oldStart = position(start.oldLine), newStart = position(start.newLine);
  const result: T[] = [];
  let changed = false;
  for (let index = 0; index < lines.length;) {
    const gap = lines[index];
    if (gap.isGap) {
      const header = String(gap.content || '').match(/^(?:@@\s*)?-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?(?:\s+@@)?/);
      if (header) {
        oldStart = Number(header[1]) || 1; newStart = Number(header[2]) || 1;
      } else if (gap.skipped && gap.skipped > 0) {
        oldStart = position(gap.oldLine) ?? oldStart;
        newStart = position(gap.newLine) ?? newStart;
        if (oldStart !== undefined) oldStart += gap.skipped;
        if (newStart !== undefined) newStart += gap.skipped;
      } else { oldStart = undefined; newStart = undefined; }
      result.push(gap); index++; continue;
    }
    let end = index;
    while (end < lines.length && !lines[end].isGap) end++;
    let oldOffset = 0, newOffset = 0;
    let oldAnchor: number | undefined, newAnchor: number | undefined;
    for (let at = index; at < end; at++) {
      const line = lines[at];
      if (line.type !== 'added') {
        const actual = position(line.oldLine);
        if (actual !== undefined && oldAnchor === undefined) oldAnchor = actual - oldOffset;
        oldOffset++;
      }
      if (line.type !== 'removed') {
        const actual = position(line.newLine);
        if (actual !== undefined && newAnchor === undefined) newAnchor = actual - newOffset;
        newOffset++;
      }
    }
    oldStart = position(oldAnchor) ?? oldStart; newStart = position(newAnchor) ?? newStart;
    oldOffset = 0; newOffset = 0;
    for (let at = index; at < end; at++) {
      const line = lines[at];
      const oldLine = line.type !== 'added' ? position(line.oldLine) ?? (oldStart !== undefined ? oldStart + oldOffset : undefined) : undefined;
      const newLine = line.type !== 'removed' ? position(line.newLine) ?? (newStart !== undefined ? newStart + newOffset : undefined) : undefined;
      const displayOldLine = undefined;
      const displayNewLine = undefined;
      if (oldLine !== line.oldLine || newLine !== line.newLine || displayOldLine !== line.displayOldLine || displayNewLine !== line.displayNewLine) {
        result.push({ ...line, oldLine, newLine, displayOldLine, displayNewLine }); changed = true;
      } else result.push(line);
      if (line.type !== 'added') oldOffset++;
      if (line.type !== 'removed') newOffset++;
    }
    if (oldStart !== undefined) oldStart += oldOffset;
    if (newStart !== undefined) newStart += newOffset;
    index = end;
  }
  return changed ? result : lines;
}

export function diffLineNumber(line: NumberedDiffLine, side: 'old' | 'new' = line.type === 'removed' ? 'old' : 'new'): number | '' {
  if (line.isGap || side === 'old' && line.type === 'added' || side === 'new' && line.type === 'removed') return '';
  return (side === 'old' ? position(line.oldLine) : position(line.newLine)) ?? '';
}

export function diffLineNumberTitle(line: NumberedDiffLine, side: 'old' | 'new' = line.type === 'removed' ? 'old' : 'new'): string | undefined {
  const value = diffLineNumber(line, side);
  if (value === '') return line.isGap || side === 'old' && line.type === 'added' || side === 'new' && line.type === 'removed'
    ? undefined : 'The source did not record enough file context to recover this line number';
  return `${side === 'old' ? 'Original' : 'Updated'} file line ${value}`;
}
