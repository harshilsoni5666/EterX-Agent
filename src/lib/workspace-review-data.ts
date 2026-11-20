import type { FilePanelProps } from '../components/chat/file-panel';
import { isWithinWorkspace, resolveTouchPath, workspacePathKey } from './workspace-paths';
import { numberDiffLines } from './diff-line-numbers';
type ReviewChange = FilePanelProps & { status?: string };
type Line = NonNullable<FilePanelProps['diffLines']>[number];

export type WorkspaceReviewScope = 'chat' | 'working' | 'branch';
export type RepositoryReviewFile = FilePanelProps & { relativePath?: string; status?: string; directory?: boolean; repositoryRoot?: string; baseRef?: string };
type ReviewProject = { root: string; branch: string; upstream: string; baseRef: string; references: string[]; gitDirectory: string };
export type RepositoryReview = ReviewProject & {
  projects?: Array<ReviewProject & { scopeRoot: string }>;
  warnings?: string[];
  files: RepositoryReviewFile[];
  truncated?: boolean;
};

export async function readWorkspaceRepositoryReview(
  roots: string[], scope: Exclude<WorkspaceReviewScope, 'chat'>, baseRefs: Record<string, string>, signal: AbortSignal,
): Promise<RepositoryReview> {
  const api = (window as any).electronAPI;
  if (!api?.workspaceReviewList) throw new Error('Open the EterX desktop app to review project changes.');
  const files = new Map<string, RepositoryReviewFile>();
  const projects: NonNullable<RepositoryReview['projects']> = [];
  const warnings: string[] = [];
  let truncated = false;
  for (const directory of roots) {
    signal.throwIfAborted();
    try {
      const result: RepositoryReview = await api.workspaceReviewList(directory, scope, baseRefs[directory] || '');
      const { root, branch, upstream, baseRef, references, gitDirectory } = result;
      projects.push({ root, branch, upstream, baseRef, references, gitDirectory, scopeRoot: directory });
      truncated ||= Boolean(result.truncated);
      for (const file of result.files) {
        if (isWithinWorkspace(file.filepath, directory)) {
          files.set(workspacePathKey(file.filepath), { ...file, repositoryRoot: root, baseRef });
        }
      }
    } catch (error) {
      warnings.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  signal.throwIfAborted();
  if (!projects.length) throw new Error(warnings.join('\n') || 'No repository in this workspace.');
  return { ...projects[0], projects, files: [...files.values()], warnings, truncated };
}

// Only settled previews and explicit mutation results are evidence of an
// edit. Reading a file or mentioning it in prose must not create a change row.
export function isWorkspaceReviewTrace(log: any): boolean {
  return Boolean(log && !log.isLive && !log.isStreaming && log.streamState !== 'open' &&
    !['running', 'pending', 'error', 'failed', 'cancelled'].includes(log.status) &&
    (log.type === 'file_preview' || log.fileOperationResult || log.toolResult || log.result));
}

export function collectWorkspaceReviewFiles(logs: any[], owner?: string): ReviewChange[] {
  const files = new Map<string, ReviewChange>();
  for (const log of logs) {
    if (!isWorkspaceReviewTrace(log) || (owner && log.ownerChatId && log.ownerChatId !== owner)) continue;
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
    if (log.importedFrom && Array.isArray(result.changes)) for (const change of result.changes) {
      if (!change || !['created', 'modified', 'deleted'].includes(change.action)) continue;
      const filepath = resolveTouchPath(change.path, cwd);
      if (!filepath) continue;
      files.set(workspacePathKey(filepath), { filepath, filename: filepath.split(/[\\/]/).pop() || filepath,
        diffLines: Array.isArray(change.diffLines) ? change.diffLines : [], content: change.readback,
        linesAdded: change.additions, linesRemoved: change.deletions, isEdit: true, updatedAt: log.timestamp,
        status: change.action === 'created' ? 'A' : change.action === 'deleted' ? 'D' : 'M' });
    }
    if (log.type !== 'file_preview') continue;
    const filepath = typeof log.filepath === 'string' ? log.filepath : log.filePath;
    if (!filepath || typeof filepath !== 'string') continue;
    const changed = log.isEdit || ['created', 'edited', 'deleted'].includes(log.operation) || log.linesAdded > 0 || log.linesRemoved > 0 || log.diffLines?.some((line: any) => line.type === 'added' || line.type === 'removed');
    if (!changed) continue;
    files.set(workspacePathKey(filepath), { filepath, filename: log.filename || filepath.split(/[\\/]/).pop() || filepath, content: log.content, language: log.language, diffLines: log.diffLines, linesAdded: log.linesAdded, linesRemoved: log.linesRemoved, totalLines: log.totalLines || log.lineCount, status: log.operation === 'created' ? 'A' : log.operation === 'deleted' ? 'D' : 'M', isEdit: true, updatedAt: log.timestamp, truncated: Boolean(log.truncated || log._diffLinesStripped) });
  }
  return [...files.values()];
}

// Chat traces call numbered source context "context"; Git uses that word for
// hunk headers. Normalize the two formats before rendering or tokenizing.
// Missing context is filled only from this edit's recorded after-snapshot,
// never from today's on-disk file, which another chat may have changed.
export function workspaceChatDiffLines(file: ReviewChange | undefined, full: boolean): Line[] {
  if (!file) return [];
  const compact = numberDiffLines((file.diffLines || []).map(line => line.type === 'context' && !line.isGap ? { ...line, type: 'unchanged' as const } : line));
  if (!full || typeof file.content !== 'string' || !file.content || file.truncated) return compact;
  const after = file.content.replace(/\r\n?/g, '\n').split('\n');
  if (after.length > 10000 || (file.totalLines && after.length < file.totalLines)) return compact;
  if (after[after.length - 1] === '') after.pop();
  if (file.status === 'A') return after.map((content, index) => ({ type: 'added', content, newLine: index + 1 }));
  if (!compact.some(line => line.type === 'added' || line.type === 'removed')) return compact;
  // Relative display numbers cannot locate a hunk in a full file snapshot.
  if (compact.some(line => !line.isGap && (line.type !== 'added' && line.oldLine == null || line.type !== 'removed' && line.newLine == null))) return compact;
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
