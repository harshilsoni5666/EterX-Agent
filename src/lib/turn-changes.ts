import type { FilePanelProps } from '../components/chat/file-panel';
import { resolveTouchPath, workspacePathKey } from './workspace-paths';

export type TurnFileChange = FilePanelProps & {
  status: 'A' | 'M' | 'D';
  revisions: FilePanelProps[];
};
export type TurnChanges = { id: string; files: TurnFileChange[]; selected?: string };

const resultObject = (value: any): any => {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' ? value : {};
};
const lineCount = (value: unknown) => {
  if (value === undefined || value === null || value === '') return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
};

/** Consume only the owning query's logs. Never read the current working tree. */
export function collectTurnChanges(logs: any[], workspacePath?: string | null): TurnFileChange[] {
  const files = new Map<string, TurnFileChange>();
  const previews = new Map<string, any>();
  for (const log of logs) {
    if (!log || log.isLive || log.isStreaming || log.staged || log.streamState === 'open'
      || ['running', 'pending', 'error', 'failed', 'cancelled'].includes(log.status)) continue;
    const result = resultObject(log.fileOperationResult || log.toolResult || log.result);
    if (result.success === false || result.error || result.rolledBack || result.operation === 'none') continue;
    const cwd = result.cwd || log.cwd || log.toolArgs?.cwd || log.workspacePath || workspacePath || '';
    for (const [field, status] of [['filesCreated', 'A'], ['filesModified', 'M'], ['filesDeleted', 'D']] as const) {
      for (const item of Array.isArray(result[field]) ? result[field] : []) {
        const filepath = resolveTouchPath(typeof item === 'string' ? item : item?.path || item?.filepath, cwd);
        if (!filepath) continue;
        const key = workspacePathKey(filepath);
        if (!files.has(key)) files.set(key, { filepath, filename: filepath.split(/[\\/]/).pop() || filepath, status, revisions: [], isEdit: true });
      }
    }
    // Imported source histories may retain the native action receipt without
    // a separate preview event. Its recorded diff is the same edit evidence.
    if (log.importedFrom && Array.isArray(result.changes)) for (const change of result.changes) {
      if (!change || !['created', 'modified', 'deleted'].includes(change.action)) continue;
      const filepath = resolveTouchPath(change.path, cwd);
      if (!filepath) continue;
      const diffLines = Array.isArray(change.diffLines) ? change.diffLines : [];
      if (!diffLines.length && typeof change.readback !== 'string') continue;
      const identity = String(log.id || log.traceId || `${log.runId || ''}:${log.timestamp || ''}`);
      previews.set(`${workspacePathKey(filepath)}:${identity}`, { ...log, filepath,
        filename: filepath.split(/[\\/]/).pop() || filepath, ownerTraceId: identity, diffLines,
        content: change.readback, operation: change.action === 'created' ? 'created' : change.action === 'deleted' ? 'deleted' : 'edited',
        linesAdded: change.additions, linesRemoved: change.deletions });
    }
    if (log.type !== 'file_preview') continue;
    const filepath = resolveTouchPath(log.filepath || log.filePath, cwd);
    if (!filepath) continue;
    const explicitPaths = ['filesCreated', 'filesModified', 'filesDeleted'].flatMap(field =>
      (Array.isArray(result[field]) ? result[field] : []).map((item: any) => resolveTouchPath(typeof item === 'string' ? item : item?.path || item?.filepath, cwd)));
    const hasReceipt = ['filesCreated', 'filesModified', 'filesDeleted'].some(field => Array.isArray(result[field]));
    if (hasReceipt && !explicitPaths.some(path => path && workspacePathKey(path) === workspacePathKey(filepath))) continue;
    const diffLines = Array.isArray(log.diffLines) ? log.diffLines.filter((line: any) => line && typeof line.content === 'string' && ['added', 'removed', 'unchanged', 'context'].includes(line.type)) : undefined;
    const hasTextChange = diffLines?.some((line: any) => line.type === 'added' || line.type === 'removed');
    if (!hasReceipt && log.operation === 'edited' && lineCount(log.linesAdded) === 0 && lineCount(log.linesRemoved) === 0 && !hasTextChange) continue;
    const changed = ['created', 'edited', 'deleted'].includes(log.operation)
      || log.linesAdded > 0 || log.linesRemoved > 0
      || hasTextChange;
    if (!changed) continue;
    // Streaming snapshots and replayed receipts replace the same edit, while
    // separate edits to one path remain visible in chronological order.
    const identity = String(log.ownerTraceId || log.id || log.traceId || `${log.runId || ''}:${log.timestamp || ''}`);
    previews.set(`${workspacePathKey(filepath)}:${identity}`, { ...log, filepath, diffLines });
  }
  for (const log of previews.values()) {
    const filepath = log.filepath;
    const key = workspacePathKey(filepath);
    const previous = files.get(key);
    const revision: FilePanelProps = {
      filepath, filename: log.filename || filepath.split(/[\\/]/).pop() || filepath,
      content: log.content, language: log.language, diffLines: Array.isArray(log.diffLines) ? log.diffLines.map((line: any) => ({ ...line })) : undefined,
      linesAdded: lineCount(log.linesAdded) ?? (log.diffLines?.length ? log.diffLines.filter((line: any) => line.type === 'added').length : undefined),
      linesRemoved: lineCount(log.linesRemoved) ?? (log.diffLines?.length ? log.diffLines.filter((line: any) => line.type === 'removed').length : undefined),
      totalLines: log.totalLines ?? log.lineCount, updatedAt: log.timestamp,
      truncated: Boolean(log.truncated || log._diffLinesStripped), isEdit: true,
    };
    const revisions = [...(previous?.revisions || []), revision];
    files.set(key, {
      ...revision, revisions,
      status: log.operation === 'deleted' ? 'D' : previous?.status === 'A' || log.operation === 'created' ? 'A' : 'M',
      linesAdded: revisions.some(item => item.linesAdded != null) ? revisions.reduce((sum, item) => sum + (item.linesAdded || 0), 0) : undefined,
      linesRemoved: revisions.some(item => item.linesRemoved != null) ? revisions.reduce((sum, item) => sum + (item.linesRemoved || 0), 0) : undefined,
    });
  }
  return [...files.values()];
}
