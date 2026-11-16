/** Divide one output allowance fairly, letting small results donate unused space. */
function outputAllowances(lengths: number[], budget: number): number[] {
  const allowances = lengths.map(() => 0);
  let remaining = Math.max(0, Math.floor(budget));
  const ordered = lengths.map((length, index) => ({ length, index })).sort((a, b) => a.length - b.length);
  ordered.forEach((item, index) => {
    allowances[item.index] = Math.min(item.length, Math.floor(remaining / (ordered.length - index)));
    remaining -= allowances[item.index];
  });
  return allowances;
}

function logTail(text: string, allowance: number): { text: string; dropped: number } {
  if (text.length <= allowance) return { text, dropped: 0 };
  if (allowance <= 0) return { text: '', dropped: text.length };
  const marker = '...[earlier output omitted]...\n';
  const retained = Math.max(0, allowance - marker.length);
  return retained > 0
    ? { text: marker + text.slice(-retained), dropped: text.length - retained }
    : { text: text.slice(-allowance), dropped: text.length - allowance };
}

/**
 * Structured batches carry each output once. Read cursors describe only the
 * verbatim prefix actually delivered; log tails keep their observed end offset.
 * This also works below the per-command minimum when many tasks share a budget.
 */
export function boundTerminalBatchEntries(entries: any[], maxOutputChars: number): any[] {
  const texts = entries.flatMap(entry => [String(entry.stdout || ''), String(entry.stderr || '')]);
  const allowances = outputAllowances(texts.map(text => text.length), maxOutputChars);
  return entries.map((entry, index) => {
    const stdout = texts[index * 2];
    const stderr = texts[index * 2 + 1];
    const exactRead = entry.outputKind === 'read' && entry.taskId && !entry.outputReadError && !stderr;
    const out = exactRead
      ? { text: stdout.slice(0, allowances[index * 2]), dropped: 0 }
      : logTail(stdout, allowances[index * 2]);
    const err = logTail(stderr, allowances[index * 2 + 1]);
    const trimmed = out.text !== stdout || err.text !== stderr;
    const result = { ...entry, stdout: out.text, stderr: err.text };
    if (exactRead) {
      const outputEnd = Number(entry.outputStart || 0) + out.text.length;
      const hasMoreOutput = outputEnd < Number(entry.totalOutputChars ?? entry.outputEnd ?? outputEnd);
      Object.assign(result, {
        outputEnd, hasMoreOutput, nextOutputOffset: hasMoreOutput ? outputEnd : undefined,
        hasNewOutput: out.text.length > 0, outputLimited: entry.outputLimited || hasMoreOutput,
      });
      // A prior per-task hint may contain a cursor for text just removed here.
      if (trimmed) result.nextActionNote = undefined;
    } else if (trimmed) {
      result.outputLimited = true;
      result.droppedOutputChars = Number(entry.droppedOutputChars || 0) + out.dropped + err.dropped;
    }
    return result;
  });
}

/**
 * Convert the existing launch-batch presentation into per-task model output.
 * Recorded section lengths (or legacy exact read lengths) frame the text; never
 * search inside output for a delimiter that a source file could also contain.
 * Unrecognized/older formats are left intact for the existing recovery path.
 */
export function structuredTerminalBatch(result: any): any {
  if (!result?.batch || !Array.isArray(result.results)) return result;
  if (result.results.every((entry: any) => typeof entry.stdout === 'string')) return result;
  if (result.results.every((entry: any) => Array.isArray(entry._outputSectionChars)
    && entry._outputSectionChars.length === 2
    && entry._outputSectionChars.every((length: number) => Number.isSafeInteger(length) && length >= 0))) {
    const sources = [String(result.stdout || ''), String(result.stderr || '')];
    const cursors = [0, 0];
    const entries = [];
    for (let index = 0; index < result.results.length; index++) {
      const { _outputSectionChars: lengths, ...entry } = result.results[index];
      const texts = ['', ''];
      for (let field = 0; field < 2; field++) {
        if (lengths[field] === 0) continue;
        if (cursors[field] > 0) {
          if (!sources[field].startsWith('\n\n', cursors[field])) return result;
          cursors[field] += 2;
        }
        const end = cursors[field] + lengths[field];
        if (end > sources[field].length) return result;
        const section = sources[field].slice(cursors[field], end);
        const header = `[command ${index + 1}] ${entry.command}\n`;
        texts[field] = section.startsWith(header) ? section.slice(header.length) : section;
        cursors[field] = end;
      }
      entries.push({ ...entry, stdout: texts[0], stderr: texts[1] });
    }
    if (cursors.some((cursor, field) => cursor !== sources[field].length)) return result;
    return { ...result, stdout: '', stderr: '', results: entries };
  }
  if (result.outputKind !== 'read' || result.stderr || !result.results.every((entry: any) =>
    entry.taskId && !entry.outputReadError && Number.isFinite(entry.outputStart) && Number.isFinite(entry.outputEnd))) return result;
  const source = String(result.stdout || '');
  let cursor = 0;
  const entries = [];
  for (let index = 0; index < result.results.length; index++) {
    const entry = result.results[index];
    const length = entry.outputEnd - entry.outputStart;
    if (!Number.isSafeInteger(length) || length < 0) return result;
    let stdout = '';
    if (length > 0) {
      const header = `${cursor ? '\n\n' : ''}[command ${index + 1}] ${entry.command}\n`;
      if (!source.startsWith(header, cursor) || cursor + header.length + length > source.length) return result;
      cursor += header.length;
      stdout = source.slice(cursor, cursor + length);
      cursor += length;
    }
    entries.push({ ...entry, stdout, stderr: '' });
  }
  if (cursor !== source.length) return result;
  return { ...result, stdout: '', stderr: '', results: entries };
}
