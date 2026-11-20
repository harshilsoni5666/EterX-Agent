import { diff } from 'fast-myers-diff';

export type DiffLine = {
  type: 'added' | 'removed' | 'context';
  content: string;
  oldLine?: number;
  newLine?: number;
  isGap?: boolean;
  skipped?: number;
};

// Keep the terminator on the comparison token so an empty file has zero
// lines and a change to the final newline belongs to the actual last line.
function lineTokens(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').match(/[^\n]*\n|[^\n]+$/g) || [];
}

function sharedPositions(lines: string[], start: number, end: number, other: Set<string>): number[] {
  const positions: number[] = [];
  for (let i = start; i < end; i++) {
    if (other.has(lines[i])) positions.push(i);
  }
  return positions;
}

type Range = [oldStart: number, oldEnd: number, newStart: number, newEnd: number];

function* changedRanges(before: string[], after: string[]): Generator<Range | null> {
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  if (start === oldEnd || start === newEnd) {
    if (oldEnd !== newEnd) yield [start, oldEnd, start, newEnd];
    return;
  }
  // Lines absent from the other version cannot be in a common subsequence.
  // Excluding them makes a genuine whole-file rewrite cheap as well.
  const oldMatches = sharedPositions(before, start, oldEnd, new Set(after.slice(start, newEnd)));
  const newMatches = sharedPositions(after, start, newEnd, new Set(before.slice(start, oldEnd)));
  // A massive reorder of repeated lines can still take quadratic time. Bound
  // that search independently of the size of a linear scan of matching text.
  let remaining = 4_000_000 + oldMatches.length + newMatches.length;
  const comparisonLimit = Symbol();
  const equal = (i: number, j: number) => {
    if (--remaining < 0) throw comparisonLimit;
    return before[oldMatches[i]] === after[newMatches[j]];
  };
  let oldMatch = 0, newMatch = 0;
  let oldStart = start, newStart = start;

  function* consumeMatches(end: number): Generator<Range> {
    while (oldMatch < end) {
      const oldLine = oldMatches[oldMatch++];
      const newLine = newMatches[newMatch++];
      if (oldLine > oldStart || newLine > newStart) yield [oldStart, oldLine, newStart, newLine];
      oldStart = oldLine + 1;
      newStart = newLine + 1;
    }
  }

  try {
    for (const [matchStart, end, , otherEnd] of diff(oldMatches, newMatches, equal)) {
      yield* consumeMatches(matchStart);
      oldMatch = end;
      newMatch = otherEnd;
    }
  } catch (error) {
    if (error !== comparisonLimit) throw error;
    yield null;
    return;
  }
  yield* consumeMatches(oldMatches.length);
  if (oldStart < oldEnd || newStart < newEnd) yield [oldStart, oldEnd, newStart, newEnd];
}

type PreviewLimits = { rows: number; chars: number };

export function buildLineDiffPreview(beforeText: string, afterText: string, limits?: PreviewLimits) {
  if (beforeText === afterText) return { diffLines: [] as DiffLine[], added: 0, removed: 0, truncated: false };
  return diffLineSequences(lineTokens(beforeText), lineTokens(afterText), limits);
}

// Imported snapshots already contain source lines and may have no record of
// the EOF terminator. Compare the evidence at its original granularity.
export function diffLineSequences(before: string[], after: string[], limits?: PreviewLimits) {
  const diffLines: DiffLine[] = [];
  let added = 0, removed = 0, chars = 0, truncated = false;
  let oldEnd = 0, newEnd = 0;

  function append(line: DiffLine) {
    if (truncated) return;
    if (limits && (diffLines.length >= limits.rows || chars + line.content.length > limits.chars)) {
      truncated = true;
      return;
    }
    chars += line.content.length;
    diffLines.push(line);
  }
  function context(start: number, end: number) {
    for (let i = start; i < end && !truncated; i++) {
      append({ type: 'context', content: before[i].replace(/\n$/, ''), oldLine: i + 1, newLine: newEnd + (i - oldEnd) + 1 });
    }
  }

  for (const change of changedRanges(before, after)) {
    if (!change) return { diffLines: [] as DiffLine[], added: undefined, removed: undefined, truncated: true };
    const [oldStart, nextOld, newStart, nextNew] = change;
    const hasPreviousHunk = added + removed > 0;
    if (!truncated) {
      const left = hasPreviousHunk ? Math.min(oldEnd + 3, oldStart) : oldEnd;
      const right = Math.max(left, oldStart - 3);
      context(oldEnd, left);
      if (hasPreviousHunk && right > left) {
        const skipped = right - left;
        append({ type: 'context', content: `${skipped} unchanged line${skipped === 1 ? '' : 's'}`, isGap: true, skipped,
          oldLine: left + 1, newLine: newEnd + (left - oldEnd) + 1 });
      }
      context(right, oldStart);
      for (let i = oldStart; i < nextOld && !truncated; i++) {
        append({ type: 'removed', content: before[i].replace(/\n$/, ''), oldLine: i + 1 });
      }
      for (let i = newStart; i < nextNew && !truncated; i++) {
        append({ type: 'added', content: after[i].replace(/\n$/, ''), newLine: i + 1 });
      }
    }
    removed += nextOld - oldStart;
    added += nextNew - newStart;
    oldEnd = nextOld;
    newEnd = nextNew;
  }
  if (added || removed) context(oldEnd, Math.min(before.length, oldEnd + 3));
  return { diffLines, added, removed, truncated };
}
