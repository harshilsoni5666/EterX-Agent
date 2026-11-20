import type { NumberedDiffLine } from './diff-line-numbers';
import { diffLineSequences } from './line-diff';

type Recovered = ReturnType<typeof diffLineSequences>;
const recoveredBlocks = new WeakMap<NumberedDiffLine[], Recovered | null>();

function recoverBlock(lines: NumberedDiffLine[]): Recovered | null {
  // The old large-file fallback saved at most three context rows on either
  // end of one numbered block of removals followed by one block of additions.
  let start = 0;
  while (lines[start]?.type === 'context') start++;
  let middle = start;
  while (lines[middle]?.type === 'removed') middle++;
  let end = middle;
  while (lines[end]?.type === 'added') end++;
  if (start > 3 || lines.length - end > 3 || start === middle || middle === end) return null;
  const oldCount = middle - start, newCount = end - middle;
  if (oldCount < 1000 && newCount < 1000 && oldCount * newCount < 250_000) return null;

  const oldBase = lines[0].oldLine, newBase = lines[start ? 0 : middle].newLine;
  if (oldBase == null || newBase == null || oldBase < 1 || newBase < 1) return null;
  const before: string[] = [], after: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.isGap || typeof line.content !== 'string' || (i >= end && line.type !== 'context')) return null;
    if (line.type !== 'added') {
      if (line.oldLine !== oldBase + before.length) return null;
      before.push(line.content);
    }
    if (line.type !== 'removed') {
      if (line.newLine !== newBase + after.length) return null;
      after.push(line.content);
    }
  }
  const recovered = diffLineSequences(before, after);
  if (recovered.removed === undefined || recovered.removed >= oldCount) return null;
  for (const line of recovered.diffLines) {
    if (line.oldLine !== undefined) line.oldLine += oldBase - 1;
    if (line.newLine !== undefined) line.newLine += newBase - 1;
  }
  return recovered;
}

function recordedBlock(lines: NumberedDiffLine[] | undefined, additions?: number, deletions?: number) {
  if (!Array.isArray(lines) || lines.length < 1000) return null;
  // A shortened old transport record is insufficient to recover a total.
  if ((additions ?? 0) + (deletions ?? 0) > lines.length) return null;
  if (!recoveredBlocks.has(lines)) recoveredBlocks.set(lines, recoverBlock(lines));
  return recoveredBlocks.get(lines);
}

/** Reopen old complete traces using only their own recorded file versions. */
export function recoverRecordedEditTrace(log: any) {
  if (!log || log._diffLinesStripped || log.diffTruncated != null || log.isLive || log.isStreaming) return log;
  if (log.type === 'file_preview') {
    const fixed = recordedBlock(log.diffLines, log.linesAdded, log.linesRemoved);
    if (fixed) return { ...log, diffLines: fixed.diffLines, linesAdded: fixed.added, linesRemoved: fixed.removed };
  }
  if (log.type !== 'file_edit' || !Array.isArray(log.toolResult?.changes)) return log;
  let changed = false;
  const changes = log.toolResult.changes.map((change: any) => {
    const fixed = change?.action === 'modified' && recordedBlock(change.diffLines, change.additions, change.deletions);
    if (!fixed) return change;
    changed = true;
    return { ...change, diffLines: fixed.diffLines, additions: fixed.added, deletions: fixed.removed };
  });
  return changed ? { ...log, toolResult: { ...log.toolResult, changes } } : log;
}
