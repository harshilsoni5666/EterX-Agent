import type { FilePanelProps } from '../components/chat/file-panel';
import { resolveTouchPath, workspacePathKey } from './workspace-paths';
type ReviewChange = FilePanelProps & { status?: string };
type Line = NonNullable<FilePanelProps['diffLines']>[number];

// Only settled previews and explicit mutation results are evidence of an
// edit. Reading a file or mentioning it in prose must not create a change row.
export function collectWorkspaceReviewFiles(logs: any[], owner?: string): ReviewChange[] {
  const files = new Map<string, ReviewChange>();
  for (const log of logs) {
    if (!log || (owner && log.ownerChatId && log.ownerChatId !== owner) || log.isLive || log.isStreaming || ['running', 'pending', 'error', 'failed', 'cancelled'].includes(log.status) || log.streamState === 'open') continue;
    let result = log.fileOperationResult || log.toolResult || log.result || {};
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch { result = {}; } }
    if (!result || result.success === false || result.rolledBack || result.operation === 'none') continue;
    const cwd = result.cwd || log.cwd || log.toolArgs?.cwd || log.workspacePath || '';
    for (const [field, status] of [['filesCreated', 'A'], ['filesModified', 'M'], ['filesDeleted', 'D']] as const) {
      for (const item of Array.isArray(result[field]) ? result[field] : []) {
        const path = resolveTouchPath(typeof item === 'string' ? item : item?.path || item?.filepath, cwd);
        if (!path || files.has(workspacePathKey(path))) continue;
        files.set(workspacePathKey(path), { filepath: path, filename: path.split(/[\\/]/).pop() || path, status, isEdit: true, updatedAt: log.timestamp });
      }
    }
    if (log.type !== 'file_preview') continue;
    const filepath = typeof log.filepath === 'string' ? log.filepath : log.filePath;
    if (!filepath || typeof filepath !== 'string') continue;
    const changed = log.isEdit || ['created', 'edited', 'deleted'].includes(log.operation) || log.linesAdded > 0 || log.linesRemoved > 0 || log.diffLines?.some((line: any) => line.type === 'added' || line.type === 'removed');
    if (!changed) continue;
    files.set(workspacePathKey(filepath), { filepath, filename: log.filename || filepath.split(/[\\/]/).pop() || filepath, content: log.content, language: log.language, diffLines: log.diffLines, linesAdded: log.linesAdded, linesRemoved: log.linesRemoved, totalLines: log.totalLines || log.lineCount, status: log.operation === 'created' ? 'A' : log.operation === 'deleted' ? 'D' : 'M', isEdit: true, updatedAt: log.timestamp, truncated: log.truncated });
  }
  return [...files.values()];
}

// Chat traces call numbered source context "context"; Git uses that word for
// hunk headers. Normalize the two formats before rendering or tokenizing.
// Missing context is filled only from this edit's recorded after-snapshot,
// never from today's on-disk file, which another chat may have changed.
export function workspaceChatDiffLines(file: ReviewChange | undefined, full: boolean): Line[] {
  if (!file) return [];
  const compact = (file.diffLines || []).map(line => line.type === 'context' && !line.isGap && line.oldLine != null && line.newLine != null ? { ...line, type: 'unchanged' as const } : line);
  if (!full || typeof file.content !== 'string' || !file.content || file.truncated) return compact;
  const after = file.content.replace(/\r\n/g, '\n').split('\n');
  if (after.length > 10000 || (file.totalLines && after.length < file.totalLines)) return compact;
  if (file.status === 'A') return after.map((content, index) => ({ type: 'added', content, newLine: index + 1 }));
  if (!compact.some(line => line.type === 'added' || line.type === 'removed')) return compact;
  if (compact.some(line => !line.isGap && line.newLine != null && after[line.newLine - 1] !== line.content.replace(/\r$/, ''))) return compact;
  const result: Line[] = [];
  let oldLine = 1, newLine = 1;
  const fill = (count: number) => {
    if (count < 0 || newLine - 1 + count > after.length) return false;
    for (let i = 0; i < count; i++) result.push({ type: 'unchanged', content: after[newLine - 1], oldLine: oldLine++, newLine: newLine++ });
    return true;
  };
  for (const line of compact) {
    if (line.isGap) continue;
    const count = line.type === 'removed' && line.oldLine != null ? line.oldLine - oldLine : line.newLine != null ? line.newLine - newLine : 0;
    if (!fill(count)) return compact;
    if (line.oldLine != null && line.oldLine !== oldLine) return compact;
    result.push(line);
    if (line.type === 'added' || line.type === 'unchanged') newLine++;
    if (line.type === 'removed' || line.type === 'unchanged') oldLine++;
  }
  return fill(after.length - newLine + 1) ? result : compact;
}
