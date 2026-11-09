import { numberDiffLines, type NumberedDiffLine } from '../diff-line-numbers';
import { buildLineDiffPreview } from '../agent/tool-trace';
import { recordedResult } from './actions';
import { recordedPowerShellReplacements, type RecordedReplacements } from './recorded-replacements';

type Snapshot = { lines: string[]; start: number; complete: boolean };
type Event = { index: number; read?: Snapshot; edit?: boolean; barrier?: boolean };
const key = (value: unknown) => {
  const path = String(value || '').replace(/\\/g, '/').replace(/\/\.\//g, '/');
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
};
const textLines = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
const snapshot = (log: any): Snapshot | undefined => typeof log.content === 'string' && log.content.length <= 2_000_000 && !log.truncated
  ? { lines: textLines(log.content), start: Number(log.startLine || 1), complete: Boolean(log.sourceFileComplete) } : undefined;

function advanceSearchAnchors(known: Map<number, string>, lines: NumberedDiffLine[]): Map<number, string> | undefined {
  const hunks: Array<{ start: number; end: number; delta: number; rows: NumberedDiffLine[] }> = [];
  let precedingDelta = 0;
  for (let at = 0; at < lines.length;) {
    if (lines[at].isGap) { at++; continue; }
    const start = at;
    while (at < lines.length && !lines[at].isGap) at++;
    const rows = lines.slice(start, at);
    if (rows.some(row => row.type !== 'added' && row.oldLine === undefined || row.type !== 'removed' && row.newLine === undefined)) return undefined;
    const oldRows = rows.filter(row => row.type !== 'added'), newRows = rows.filter(row => row.type !== 'removed');
    const oldStart = oldRows[0]?.oldLine ?? (newRows[0]?.newLine === undefined ? undefined : newRows[0].newLine - precedingDelta);
    if (oldStart === undefined || oldStart < 1) return undefined;
    const delta = newRows.length - oldRows.length;
    hunks.push({ start: oldStart, end: oldStart + oldRows.length, delta, rows }); precedingDelta += delta;
  }
  const next = new Map<number, string>();
  for (const [number, content] of known) {
    let shift = 0, replacement: number | undefined, covered = false;
    for (const hunk of hunks) {
      if (number < hunk.start) break;
      if (number >= hunk.end) { shift += hunk.delta; continue; }
      covered = true;
      replacement = hunk.rows.find(row => row.oldLine === number && row.type !== 'removed')?.newLine;
      break;
    }
    if (!covered) next.set(number + shift, content);
    else if (replacement !== undefined) next.set(replacement, content);
  }
  for (const row of lines) if (!row.isGap && row.newLine !== undefined && next.size < 30_000) next.set(row.newLine, row.content);
  return next;
}

/** Search output keeps exact path:line:text anchors even when a source exec
 * wrapper combines several command results. No result-to-command guess is
 * required to recover those explicitly named file positions. */
function restoreSearchAnchors(source: any[]): any[] {
  const anchors = new Map<string, Map<number, string>>();
  const previews = new Set(source.filter(log => log.importedFrom && log.type === 'file_preview').map(log => `${log.ownerTraceId}:${key(log.filepath)}`));
  return source.map(log => {
    if (!log.importedFrom) return log;
    if (log.type === 'file_edit' && log.status !== 'failed') {
      for (const change of Array.isArray(log.toolResult?.changes) ? log.toolResult.changes : []) {
        if (!previews.has(`${log.id}:${key(change.path)}`)) anchors.delete(key(change.path));
      }
    }
    if (['command', 'exploration'].includes(log.type)) {
      const command = String(log.toolArgs?.cmd || log.toolArgs?.command || '');
      const isCombined = log.sourceToolName === 'imported_action_results';
      const readOnly = /^(?:\s*(?:rg|grep|Get-Content|Select-String|cat|sed|head|tail)\b)/i.test(command);
      if (command && !readOnly) anchors.clear();
      if (readOnly || isCombined) {
        const output = String(recordedResult(log.toolResult ?? log.output).output || '');
        const cwd = String(log.toolArgs?.workdir || log.toolArgs?.cwd || log.workspacePath || '');
        for (const line of output.slice(0, 2_000_000).split(/\r?\n/)) {
          const match = line.match(/^((?:[A-Za-z]:)?[^\r\n]+?):(\d+):(.*)$/);
          if (!match || !/[.][A-Za-z0-9]{1,12}$/.test(match[1]) || /^(?:https?|data):/i.test(match[1])) continue;
          const name = key(/^(?:[A-Za-z]:[\\/]|\/)/.test(match[1]) ? match[1] : cwd ? `${cwd.replace(/[\\/]$/, '')}/${match[1]}` : '');
          const lineNumber = Number(match[2]);
          if (!name || !Number.isSafeInteger(lineNumber) || lineNumber < 1) continue;
          if (!anchors.has(name)) anchors.set(name, new Map());
          if (anchors.get(name)!.size < 30_000) anchors.get(name)!.set(lineNumber, match[3]);
        }
      }
    }
    if (log.type !== 'file_preview') return log;
    if (!log.diffLines?.some((line: NumberedDiffLine) => ['added', 'removed'].includes(line.type))) {
      if (log.isEdit || log.created || ['edited', 'deleted', 'created'].includes(log.operation)) anchors.delete(key(log.filepath));
      return log;
    }
    const known = anchors.get(key(log.filepath)) || new Map<number, string>();
    anchors.delete(key(log.filepath));
    const byText = new Map<string, number[]>();
    for (const [number, content] of known) {
      if (!byText.has(content)) byText.set(content, []);
      byText.get(content)!.push(number);
    }
    const lines: NumberedDiffLine[] = log.diffLines.slice();
    let delta = 0;
    for (let at = 0; at < lines.length;) {
      if (lines[at].isGap) { at++; continue; }
      const start = at;
      while (at < lines.length && !lines[at].isGap) at++;
      let offset = 0, candidates: Set<number> | undefined;
      for (const row of lines.slice(start, at)) {
        if (row.type === 'added') continue;
        const matches = row.oldLine !== undefined ? [row.oldLine] : row.content.trim().length >= 12 ? byText.get(row.content) : undefined;
        if (matches?.length) {
          const possible = new Set(matches.map(number => number - offset).filter(number => number > 0));
          candidates = candidates ? new Set([...candidates].filter(number => possible.has(number))) : possible;
        }
        offset++;
      }
      if (candidates?.size === 1) {
        let oldLine = [...candidates][0], newLine = oldLine + delta;
        if (newLine > 0) for (let index = start; index < at; index++) {
          const row = lines[index];
          lines[index] = { ...row, oldLine: row.type !== 'added' ? oldLine++ : undefined, newLine: row.type !== 'removed' ? newLine++ : undefined };
        }
      }
      delta += lines.slice(start, at).reduce((sum, row) => sum + (row.type === 'added' ? 1 : row.type === 'removed' ? -1 : 0), 0);
    }
    const advanced = advanceSearchAnchors(known, lines);
    if (advanced) anchors.set(key(log.filepath), advanced);
    return { ...log, diffLines: numberDiffLines(lines) };
  });
}

/** Locate a hunk only in a recorded version of the file. Reading today's file
 * would give plausible but incorrect historical coordinates after later edits. */
function locate(state: Snapshot, pattern: string[], budget: { remaining: number }, expected?: number, minimum = 0, maximum = state.lines.length - pattern.length, first = false): number | undefined {
  const matches = (at: number) => at >= minimum && at <= maximum && at >= 0 && at + pattern.length <= state.lines.length && pattern.every((line, offset) => --budget.remaining > 0 && state.lines[at + offset] === line);
  if (expected !== undefined) return matches(expected - state.start) ? expected - state.start : undefined;
  if (!pattern.length || !pattern.some(line => line.trim())) return undefined;
  let found: number | undefined;
  for (let at = minimum; at <= maximum && at + pattern.length <= state.lines.length; at++) {
    if (--budget.remaining <= 0) return undefined;
    if (!matches(at)) continue;
    if (first) return at;
    if (found !== undefined) return undefined;
    found = at;
  }
  return found;
}

function applyRecordedDiff(input: NumberedDiffLine[], state: Snapshot | undefined, reverse: boolean, budget: { remaining: number }, orderedPatch = false): { lines: NumberedDiffLine[]; state?: Snapshot } {
  const lines = numberDiffLines(input).slice();
  if (!state || !lines.length || lines.length > 20_000 || state.lines.length > 30_000 || budget.remaining <= 0) return { lines };
  const hunks: Array<{ start: number; end: number; delta: number }> = [];
  let delta = 0;
  for (let at = 0; at < lines.length;) {
    if (lines[at].isGap) { at++; continue; }
    const start = at;
    while (at < lines.length && !lines[at].isGap) at++;
    hunks.push({ start, end: at, delta });
    delta += lines.slice(start, at).reduce((sum, line) => sum + (line.type === 'added' ? 1 : line.type === 'removed' ? -1 : 0), 0);
  }
  // apply_patch searches forward from the previous section, including sections
  // containing only context. Repeating `};` is deterministic after a recorded
  // function anchor; a global uniqueness search loses that source information.
  let cursor = 0, ordered = orderedPatch && !reverse && state.start === 1;
  const plans = hunks.map(hunk => {
    const rows = lines.slice(hunk.start, hunk.end);
    const before = rows.filter(line => line.type !== 'added').map(line => line.content);
    const after = rows.filter(line => line.type !== 'removed').map(line => line.content);
    const anchor = rows.find(line => reverse ? line.type !== 'removed' : line.type !== 'added');
    const expected = reverse ? anchor?.newLine : anchor?.oldLine;
    const pattern = reverse ? after : before;
    const context = hunk.start > 0 ? lines[hunk.start - 1].patchContext : undefined;
    if (ordered && context) {
      const at = state.lines[cursor] === context ? cursor : locate(state, [context], budget, undefined, cursor, state.lines.length - 1, true);
      if (at === undefined) ordered = false;
      else cursor = at + 1;
    }
    const end = rows.some(row => row.patchEndOfFile) && state.complete ? state.lines.length - pattern.length : undefined;
    const at = locate(state, pattern, budget, expected ?? (end === undefined ? undefined : state.start + end), ordered ? cursor : 0, undefined, ordered);
    if (at !== undefined) cursor = at + pattern.length;
    else ordered = false;
    return { ...hunk, pattern, replacement: reverse ? before : after, expected, at };
  });
  // Short contexts such as `};` repeat throughout a file. A patch's neighboring
  // hunks constrain the search interval; only a unique match in that interval
  // supplies an offset, never the first arbitrary occurrence in the file.
  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index];
    if (plan.at !== undefined) continue;
    const previous = plans.slice(0, index).reverse().find(item => item.at !== undefined);
    const next = plans.slice(index + 1).find(item => item.at !== undefined);
    if (!previous && !next) continue;
    plan.at = locate(state, plan.pattern, budget, plan.expected, previous ? previous.at! + previous.pattern.length : 0,
      next ? next.at! - plan.pattern.length : state.lines.length - plan.pattern.length);
  }
  const mutations: Array<{ at: number; count: number; replacement: string[] }> = [];
  for (const hunk of plans) {
    const at = hunk.at;
    if (at === undefined) continue;
    let oldLine = state.start + at - (reverse ? hunk.delta : 0);
    let newLine = state.start + at + (reverse ? 0 : hunk.delta);
    if (oldLine < 1 || newLine < 1) continue;
    for (let index = hunk.start; index < hunk.end; index++) {
      const line = lines[index];
      lines[index] = { ...line, oldLine: line.type !== 'added' ? oldLine++ : undefined,
        newLine: line.type !== 'removed' ? newLine++ : undefined, displayOldLine: undefined, displayNewLine: undefined };
    }
    mutations.push({ at, count: hunk.pattern.length, replacement: hunk.replacement });
  }
  // A partial read can locate some hunks without containing all of them. Keep
  // those coordinates, but do not carry an incomplete reconstruction forward.
  if (!hunks.length) return { lines };
  if (mutations.length !== hunks.length) {
    // An ambiguous later hunk must not discard a proven file prefix (imports,
    // declarations, etc.). Carry only the part before that unknown edit, with
    // every preceding change applied, so later prefix edits keep real offsets.
    const unknown = plans.findIndex(plan => plan.at === undefined);
    const prior = unknown > 0 ? plans[unknown - 1] : undefined;
    if (!prior || prior.at === undefined) return { lines };
    const end = prior.at + prior.pattern.length;
    const prefix = { ...state, complete: false, lines: state.lines.slice(0, end) };
    for (const plan of plans.slice(0, unknown).reverse()) {
      if (plan.at === undefined || plan.at + plan.pattern.length > end) return { lines };
      prefix.lines.splice(plan.at, plan.pattern.length, ...plan.replacement);
    }
    return { lines, state: prefix };
  }
  const orderedMutations = mutations.slice().sort((left, right) => left.at - right.at);
  if (orderedMutations.some((item, index) => index > 0 && item.at < orderedMutations[index - 1].at + orderedMutations[index - 1].count)) return { lines };
  const current = { ...state, lines: state.lines.slice() };
  for (const mutation of orderedMutations.reverse()) current.lines.splice(mutation.at, mutation.count, ...mutation.replacement);
  const before = reverse ? current : state, after = reverse ? state : current;
  // Use the very same diff generator as workspace_edit_file: native context
  // rows, compacted gaps, insertion/deletion order and line-number semantics.
  const native = buildLineDiffPreview(before.lines.join('\n'), after.lines.join('\n'));
  return { lines: native.diffLines.map(line => ({ ...line,
    ...(line.oldLine !== undefined ? { oldLine: line.oldLine + before.start - 1 } : {}),
    ...(line.newLine !== undefined ? { newLine: line.newLine + after.start - 1 } : {}) })), state: current };
}

/** Recover file offsets from source reads and intervening edits, in both
 * directions. Runs during import/repair, never on each streaming render. */
export function restoreImportedDiffContext(source: any[]): any[] {
  // Native history can keep a diff on the action after dropping its redundant
  // preview event. Include that diff in reconstruction as well; otherwise the
  // next edit incorrectly appears to have no preceding file version.
  const previewOwners = new Set(source.filter(log => log.importedFrom && log.type === 'file_preview').map(log => `${log.ownerTraceId}:${key(log.filepath)}`));
  const records = source.flatMap(log => {
    if (log.importedFrom && log.type === 'command' && log.status !== 'failed') {
      const script = String(log.toolArgs?.cmd || log.toolArgs?.command || '');
      const replacement = recordedPowerShellReplacements(script, String(log.toolArgs?.workdir || log.toolArgs?.cwd || log.workspacePath || ''));
      if (replacement) return [log, { ...log, id: `${log.id}-literal-edit-context`, type: 'file_preview', ownerTraceId: log.id,
        filepath: replacement.path, isEdit: true, _importReplacements: replacement, _importDiffContextOnly: true }];
    }
    if (!log.importedFrom || log.type !== 'file_edit' || log.status === 'failed' || !Array.isArray(log.toolResult?.changes)) return [log];
    return [log, ...log.toolResult.changes.flatMap((change: any, index: number) => {
      if (previewOwners.has(`${log.id}:${key(change.path)}`) || !change.diffLines?.length && typeof change.readback !== 'string' && !change.sourceLineTransform) return [];
      return [{ ...log, id: `${log.id}-context-${index}`, type: 'file_preview', ownerTraceId: log.id, filepath: change.path,
        diffLines: change.diffLines || [], content: change.readback || '', sourceFileComplete: typeof change.readback === 'string',
        sourcePatchFormat: change.sourcePatchFormat,
        sourceLineTransform: change.sourceLineTransform,
        created: change.action === 'created', isEdit: change.action !== 'created', operation: change.action === 'deleted' ? 'deleted' : change.action === 'created' ? 'created' : 'edited',
        linesAdded: change.additions, linesRemoved: change.deletions, _importDiffContextOnly: true }];
    })];
  });
  let logs = restoreSearchAnchors(records);
  const budget = { remaining: 10_000_000 };
  const events = new Map<string, Event[]>();
  const previews = new Set(logs.filter(log => log.importedFrom && log.type === 'file_preview').map(log => `${log.ownerTraceId}:${key(log.filepath)}`));
  const add = (path: unknown, event: Event) => {
    const name = key(path); if (!name) return;
    if (!events.has(name)) events.set(name, []);
    events.get(name)!.push(event);
  };
  logs.forEach((log, index) => {
    if (!log.importedFrom) return;
    if (log.type === 'file_edit' && log.status !== 'failed') {
      for (const change of Array.isArray(log.toolResult?.changes) ? log.toolResult.changes : []) {
        if (!previews.has(`${log.id}:${key(change.path)}`)) add(change.path, { index, barrier: true });
      }
    }
    if (log.type !== 'file_preview') return;
    if (log.isEdit || log.created || ['edited', 'created', 'deleted'].includes(log.operation) || log.diffLines?.some((line: NumberedDiffLine) => ['added', 'removed'].includes(line.type))) {
      add(log.filepath, { index, edit: true });
    } else if (log.sourceFileSnapshot || String(log.id).endsWith('-read-preview')) {
      const read = snapshot(log);
      if (read) add(log.filepath, { index, read });
    }
  });
  for (const history of events.values()) {
    for (const reverse of [false, true]) {
      let state: Snapshot | undefined;
      for (const event of reverse ? history.slice().reverse() : history) {
        if (event.barrier) { state = undefined; continue; }
        if (event.read) { state = event.read; continue; }
        if (!event.edit) continue;
        const log = logs[event.index];
        if (log.sourceLineTransform) {
          if (reverse) { state = log._recordedBeforeTransform; continue; }
          if (!state) { if (log.sourceFileComplete) state = snapshot(log); continue; }
          const transform = log.sourceLineTransform;
          if (typeof transform.includes !== 'string' || typeof transform.before !== 'string' || !transform.before || typeof transform.after !== 'string'
            || /[\r\n]/.test(transform.includes + transform.before + transform.after)) { state = undefined; continue; }
          const next = { ...state, lines: state.lines.map(line => line.includes(transform.includes) ? line.split(transform.before).join(transform.after) : line) };
          const diff = buildLineDiffPreview(state.lines.join('\n'), next.lines.join('\n'));
          logs[event.index] = { ...log, _recordedBeforeTransform: state,
            ...(state.complete ? { content: next.lines.join('\n'), sourceFileComplete: true, diffLines: diff.diffLines.map(line => ({ ...line,
              ...(line.oldLine !== undefined ? { oldLine: line.oldLine + state!.start - 1 } : {}),
              ...(line.newLine !== undefined ? { newLine: line.newLine + next.start - 1 } : {}) })),
              linesAdded: diff.added, linesRemoved: diff.removed } : {}) };
          state = next;
          continue;
        }
        if (log._importReplacements) {
          if (reverse) { state = log._recordedBeforeReplacement; continue; }
          const edits = (log._importReplacements as RecordedReplacements).edits;
          if (!state || !state.complete && edits.some(edit => /[\r\n]/.test(edit.before + edit.after))) { state = undefined; continue; }
          let content = state.lines.join('\n');
          for (const edit of edits) content = content.split(edit.before).join(edit.after);
          logs[event.index] = { ...log, _recordedBeforeReplacement: state };
          state = { ...state, lines: content.split('\n') };
          continue;
        }
        const created = log.created || log.operation === 'created';
        if (created) {
          const lines = numberDiffLines(log.diffLines || [], { newLine: 1 });
          logs[event.index] = { ...log, diffLines: lines };
          state = reverse ? undefined : log.sourceFileComplete ? snapshot(log) : lines.length && lines.every(line => line.type === 'added')
            ? { start: 1, complete: true, lines: lines.map(line => line.content) } : undefined;
          continue;
        }
        if (reverse && log.sourceFileComplete) state = snapshot(log);
        const after = reverse ? state : undefined;
        const recovered = applyRecordedDiff(log.diffLines || [], state, reverse, budget, log.sourcePatchFormat === 'apply_patch');
        const recordedAfter = reverse ? after : recovered.state;
        logs[event.index] = { ...log, diffLines: recovered.lines,
          linesAdded: recovered.lines.filter(line => line.type === 'added').length,
          linesRemoved: recovered.lines.filter(line => line.type === 'removed').length,
          ...(recordedAfter?.complete ? { content: recordedAfter.lines.join('\n'), sourceFileComplete: true } : {}) };
        state = !reverse && log.sourceFileComplete ? snapshot(log) : recovered.state;
      }
    }
  }
  // Snapshot recovery can locate an earlier insertion that shifts later search
  // results. Carry those proven shifts into immediately following edits too.
  logs = restoreSearchAnchors(logs);
  const byId = new Map(logs.map((log, index) => [log.id, index]));
  const unchangedTransforms = new Set<string>();
  for (const preview of logs) {
    if (!preview.importedFrom || preview.type !== 'file_preview' || !preview.diffLines?.length && !(preview.sourceLineTransform && preview.sourceFileComplete)) continue;
    const ownerIndex = byId.get(preview.ownerTraceId);
    if (ownerIndex === undefined) continue;
    const owner = logs[ownerIndex], result = owner.toolResult;
    if (!Array.isArray(result?.changes)) continue;
    if (preview.sourceLineTransform && preview.sourceFileComplete && !preview.diffLines?.some((line: NumberedDiffLine) => ['added', 'removed'].includes(line.type))) {
      unchangedTransforms.add(preview.id);
      const changes = result.changes.filter((change: any) => key(change.path) !== key(preview.filepath));
      const files = changes.map((change: any) => change.path);
      logs[ownerIndex] = { ...owner, files, filepath: files[0], filename: files[0]?.split(/[\\/]/).pop(), fileCount: files.length,
        ...(!files.length ? { type: 'command', toolName: 'imported_action', tool: 'imported_action', iconCategory: 'code', text: 'No file changes' } : {}),
        toolResult: { ...result, changes, filesModified: (result.filesModified || []).filter((file: string) => key(file) !== key(preview.filepath)) } };
      continue;
    }
    logs[ownerIndex] = { ...owner, toolResult: { ...result, changes: result.changes.map((change: any) => key(change.path) === key(preview.filepath)
      ? { ...change, diffLines: preview.diffLines, additions: preview.linesAdded, deletions: preview.linesRemoved,
        ...(preview.sourceFileComplete ? { readback: preview.content } : {}) } : change) } };
  }
  return logs.filter(log => !log._importDiffContextOnly && !unchangedTransforms.has(log.id)).map(log => {
    if (!log._recordedBeforeTransform) return log;
    const { _recordedBeforeTransform, ...saved } = log;
    return saved;
  });
}

/** A project can be created in one imported chat and edited in another.
 * Consult only already-imported histories for the same files, in source time
 * order, then update only the chats being imported/repaired in this operation. */
export function restoreProjectDiffContext(prepared: Map<string, any[]>, existing: any[]): void {
  const logPaths = (log: any): string[] => !log.importedFrom ? [] : log.type === 'file_preview' ? [key(log.filepath)]
    : log.type === 'file_edit' && Array.isArray(log.toolResult?.changes) ? log.toolResult.changes.map((change: any) => key(change.path)) : [];
  const paths = new Set([...prepared.values()].flatMap(logs => logs.flatMap(logPaths)).filter(Boolean));
  if (!paths.size) return;
  const histories = new Map<string, any[]>();
  for (const chat of existing) {
    if (!chat.importOrigin || prepared.has(chat.id)) continue;
    const logs = Array.isArray(chat.traceLogs) ? chat.traceLogs : [];
    if (logs.some((log: any) => logPaths(log).some(name => paths.has(name)))) histories.set(chat.id, logs);
  }
  for (const [id, logs] of prepared) histories.set(id, logs);
  const ordered = [...histories.values()].flat().filter(log => log.importedFrom).map((log, index) => ({ log, index }))
    .sort((left, right) => Number(left.log.timestamp || left.log.startTime || 0) - Number(right.log.timestamp || right.log.startTime || 0) || left.index - right.index);
  const repaired = new Map(restoreImportedDiffContext(ordered.map(item => item.log)).map(log => [log.id, log]));
  for (const [id, logs] of prepared) prepared.set(id, logs.map(log => repaired.get(log.id) || log));
}
