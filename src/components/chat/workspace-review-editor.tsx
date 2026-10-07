'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Columns2,
  Copy,
  FileCode2,
  FileText,
  Monitor,
  Search,
  TerminalSquare,
  X,
} from 'lucide-react';
import { Shimmer } from '../ui/shimmer';
import { safeCopyTextToClipboard } from '../ui/copy-button';

export type WorkspaceReviewMode = 'overview' | 'review' | 'code';
type WorkspaceInternalMode = WorkspaceReviewMode | 'subagent';

export type WorkspaceDiffLine = {
  type: 'added' | 'removed' | 'unchanged' | 'context';
  content: string;
  oldLine?: number;
  newLine?: number;
};

export type WorkspaceReviewFile = {
  id?: string;
  filename: string;
  filepath: string;
  content?: string;
  language?: string;
  diffLines?: WorkspaceDiffLine[];
  isEdit?: boolean;
  linesAdded?: number;
  linesRemoved?: number;
  added?: number;
  removed?: number;
  lineCount?: number;
  totalLines?: number;
  loadedLines?: number;
  startLine?: number;
  endLine?: number;
  truncated?: boolean;
  size?: number;
  loadError?: string;
  artifactKind?: 'code' | 'document' | 'media' | 'preview' | 'terminal' | 'task' | 'other';
  updatedAt?: string | number | Date;
};

export type WorkspaceReviewArtifact = {
  id?: string;
  title: string;
  kind?: 'code' | 'document' | 'media' | 'preview' | 'terminal' | 'task' | 'other';
  path?: string;
  fileId?: string;
  timestamp?: string | number | Date;
};

export type WorkspaceReviewSubagent = {
  id?: string;
  name: string;
  status?: 'idle' | 'running' | 'complete' | 'failed';
  role?: string;
  task?: string;
  progress?: string;
  result?: string;
  durationMs?: number;
  startedAt?: number;
  completedAt?: number;
  updatedAt?: number;
  events?: Array<{
    type?: string;
    text: string;
    secondary?: string;
    timestamp?: number;
  }>;
};

export type WorkspaceReviewBackgroundTask = {
  id?: string;
  title: string;
  status?: 'queued' | 'running' | 'complete' | 'failed';
};

export type WorkspaceReviewEditorProps = {
  files: WorkspaceReviewFile[];
  artifacts?: WorkspaceReviewArtifact[];
  subagents?: WorkspaceReviewSubagent[];
  backgroundTasks?: WorkspaceReviewBackgroundTask[];
  activeFileId?: string;
  initialMode?: WorkspaceReviewMode;
  title?: string;
  className?: string;
  onModeChange?: (mode: WorkspaceReviewMode) => void;
  onSelectFile?: (file: WorkspaceReviewFile, index: number) => void;
  onOpenDiff?: (file: WorkspaceReviewFile, index: number) => void;
  onCopyPath?: (file: WorkspaceReviewFile) => void;
  onClose?: () => void;
};

type FileStats = {
  added: number;
  removed: number;
  changed: boolean;
};

type CompactDiffRow =
  | { kind: 'line'; line: WorkspaceDiffLine; key: string }
  | { kind: 'gap'; count: number; key: string };

const EMPTY_FILES: WorkspaceReviewFile[] = [];
const EMPTY_ARTIFACTS: WorkspaceReviewArtifact[] = [];
const EMPTY_SUBAGENTS: WorkspaceReviewSubagent[] = [];
const EMPTY_TASKS: WorkspaceReviewBackgroundTask[] = [];
const MAX_REVIEW_ROWS_PER_FILE = 520;
const MAX_CODE_LINES = 1600;

const REVIEW_KEYWORDS = new Set([
  'if', 'else', 'elif', 'for', 'while', 'switch', 'case', 'break', 'continue',
  'return', 'try', 'catch', 'finally', 'throw', 'raise', 'with', 'match', 'do',
  'const', 'let', 'var', 'function', 'class', 'async', 'await', 'import', 'export',
  'from', 'as', 'type', 'interface', 'enum', 'extends', 'implements', 'static',
  'abstract', 'override', 'def', 'lambda', 'pass', 'yield', 'del', 'require', 'fn',
  'pub', 'use', 'struct',
]);
const REVIEW_VALUES = new Set([
  'true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'NaN', 'Infinity', 'void',
  'this', 'self', 'super', 'new', 'typeof', 'instanceof', 'in', 'of', 'is', 'not', 'and',
  'or', 'delete', 'readonly', 'keyof', 'number', 'string', 'boolean', 'object', 'any', 'never',
]);

function highlightReviewSyntax(code: string): string {
  if (!code) return '';
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tokenPattern = /(\/\/[^\n]*|#[^!\n][^\n]*|\/\*[\s\S]*?\*\/)|(["'`])(?:(?!\2)[^\\]|\\.)*\2|(0x[0-9A-Fa-f]+|\b\d+\.?\d*(?:e[+-]?\d+)?\b)|([A-Z][a-zA-Z0-9_]*)|([a-z_][a-zA-Z0-9_]*)|(--?[a-zA-Z][a-zA-Z0-9-]*)/g;
  let output = '';
  let lastIndex = 0;

  for (const match of escaped.matchAll(tokenPattern)) {
    const [full, comment, , number, typeName, identifier, flag] = match;
    output += escaped.slice(lastIndex, match.index!);
    lastIndex = match.index! + full.length;

    if (comment) output += `<span class="eterx-syntax-comment">${full}</span>`;
    else if (match[2]) output += `<span class="eterx-syntax-string">${full}</span>`;
    else if (number) output += `<span class="eterx-syntax-number">${full}</span>`;
    else if (typeName) output += `<span class="eterx-syntax-type">${full}</span>`;
    else if (identifier) {
      if (REVIEW_KEYWORDS.has(identifier)) output += `<span class="eterx-syntax-keyword eterx-syntax-declaration">${full}</span>`;
      else if (REVIEW_VALUES.has(identifier)) output += `<span class="eterx-syntax-value">${full}</span>`;
      else output += escaped.slice(lastIndex).trimStart().startsWith('(')
        ? `<span class="eterx-syntax-function">${full}</span>`
        : full;
    } else if (flag) output += `<span class="eterx-syntax-flag">${full}</span>`;
    else output += full;
  }

  return output + escaped.slice(lastIndex);
}
const MIN_VISIBLE_TAB_WIDTH = 94;
const MAX_TAB_RAIL_WIDTH_BEFORE_SCROLL = 520;
const SECTION_SCROLL_CLASS = 'eterx-review-scrollbar max-h-[min(34vh,340px)] overflow-y-auto overflow-x-hidden overscroll-contain rounded-[14px] border border-white/[0.045] bg-white/[0.014] py-1.5 pr-1 shadow-none [scrollbar-gutter:stable]';

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function numberFrom(...values: any[]) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function fileKey(file: WorkspaceReviewFile, index: number) {
  return file.id || file.filepath || `${file.filename}:${index}`;
}

function basename(pathValue: string) {
  const cleaned = pathValue.replace(/\\/g, '/');
  return cleaned.split('/').filter(Boolean).pop() || pathValue || 'Untitled';
}

function dirname(pathValue: string) {
  const cleaned = pathValue.replace(/\\/g, '/');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  const tail = parts.slice(Math.max(0, parts.length - 3), parts.length - 1).join('/');
  return tail ? `../${tail}` : '';
}

function extensionOf(name: string) {
  const clean = basename(name);
  const dot = clean.lastIndexOf('.');
  return dot > -1 ? clean.slice(dot + 1).toLowerCase() : '';
}

function languageLabel(file: WorkspaceReviewFile) {
  const lang = file.language?.trim().toLowerCase();
  const knownLangs: Record<string, string> = {
    python: 'PY',
    py: 'PY',
    typescript: 'TS',
    ts: 'TS',
    tsx: 'TSX',
    javascript: 'JS',
    js: 'JS',
    jsx: 'JSX',
    markdown: 'MD',
    md: 'MD',
    html: 'HTML',
    css: 'CSS',
    json: 'JSON',
    shell: 'SH',
    bash: 'SH',
    powershell: 'PS',
  };
  if (lang) return knownLangs[lang] || lang.slice(0, 4).toUpperCase();
  const ext = extensionOf(file.filename || file.filepath);
  if (!ext) return 'FILE';
  if (ext === 'tsx' || ext === 'jsx') return 'React';
  if (ext === 'ts') return 'TS';
  if (ext === 'js') return 'JS';
  if (ext === 'md' || ext === 'mdx') return 'MD';
  if (ext === 'html') return 'HTML';
  if (ext === 'css') return 'CSS';
  if (ext === 'json') return 'JSON';
  return ext.toUpperCase();
}

function getStats(file: WorkspaceReviewFile): FileStats {
  const lines = file.diffLines || [];
  const countedAdded = lines.filter(line => line.type === 'added').length;
  const countedRemoved = lines.filter(line => line.type === 'removed').length;
  const added = countedAdded || numberFrom(file.added, file.linesAdded);
  const removed = countedRemoved || numberFrom(file.removed, file.linesRemoved);
  return {
    added,
    removed,
    changed: !!file.isEdit || added > 0 || removed > 0 || lines.length > 0,
  };
}

function compactDiff(lines: WorkspaceDiffLine[], context = 2): CompactDiffRow[] {
  if (lines.length === 0) return [];

  const changedIndexes = lines
    .map((line, index) => (line.type === 'added' || line.type === 'removed' ? index : -1))
    .filter(index => index >= 0);

  if (changedIndexes.length === 0) {
    const head = lines.slice(0, 140).map((line, index) => ({
      kind: 'line' as const,
      line,
      key: `line-${index}`,
    }));
    return lines.length > head.length
      ? [...head, { kind: 'gap', count: lines.length - head.length, key: 'gap-tail' }]
      : head;
  }

  const ranges = changedIndexes.map(index => ({
    start: Math.max(0, index - context),
    end: Math.min(lines.length - 1, index + context),
  }));

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end + 1) {
      merged.push({ ...range });
    } else {
      last.end = Math.max(last.end, range.end);
    }
  }

  const rows: CompactDiffRow[] = [];
  let cursor = 0;
  merged.forEach((range, rangeIndex) => {
    if (range.start > cursor) {
      rows.push({ kind: 'gap', count: range.start - cursor, key: `gap-${rangeIndex}-${cursor}` });
    }
    for (let index = range.start; index <= range.end; index += 1) {
      rows.push({ kind: 'line', line: lines[index], key: `line-${index}` });
    }
    cursor = range.end + 1;
  });
  if (cursor < lines.length) {
    rows.push({ kind: 'gap', count: lines.length - cursor, key: `gap-tail-${cursor}` });
  }
  return rows;
}

function getDisplayDiffLines(file: WorkspaceReviewFile): WorkspaceDiffLine[] {
  if (file.diffLines?.length) return file.diffLines;
  const stats = getStats(file);
  if (!file.content || (stats.added === 0 && stats.removed === 0)) return [];
  const startLine = file.startLine && file.startLine > 0 ? file.startLine : 1;
  return file.content.split(/\r?\n/).slice(0, MAX_CODE_LINES).map((content, index) => {
    const lineNumber = startLine + index;
    return {
      type: stats.removed > 0 ? 'context' : 'added',
      content,
      oldLine: stats.removed > 0 ? lineNumber : undefined,
      newLine: lineNumber,
    };
  });
}

function iconForKind(kind?: WorkspaceReviewArtifact['kind']) {
  if (kind === 'preview') return Monitor;
  if (kind === 'terminal') return TerminalSquare;
  if (kind === 'document' || kind === 'task') return FileText;
  return FileCode2;
}

function isCodeArtifact(artifact: WorkspaceReviewArtifact) {
  if (artifact.kind === 'code') return true;
  const ext = extensionOf(artifact.title || artifact.path || '');
  return ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'cpp', 'c', 'h', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt'].includes(ext);
}

function statusTone(status?: string) {
  if (status === 'complete') return 'text-[#75D990]';
  if (status === 'failed') return 'text-[#FF7A70]';
  if (status === 'running') return 'text-[#8AB4FF]';
  return 'text-white/42';
}

function formatDuration(ms?: number) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return '';
  const total = Math.max(1, Math.round(Number(ms) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function Section({
  title,
  count,
  children,
  defaultOpen = true,
  bounded = false,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
  bounded?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen, title]);

  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [open, count, title]);

  return (
    <section className="min-h-0 border-b border-white/[0.055] py-2.5 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="group flex min-h-[32px] w-full items-center gap-2 rounded-[10px] px-4 text-left text-[13px] font-semibold tracking-normal text-white/52 transition-colors hover:bg-white/[0.025] hover:text-white/78"
      >
        <span>{title}</span>
        <span className="eterx-professional-number rounded-full bg-white/[0.055] px-2 py-0.5 text-[11px] font-semibold text-white/34">{count}</span>
        {open ? <ChevronDown className="h-3.5 w-3.5 opacity-70" /> : <ChevronRight className="h-3.5 w-3.5 opacity-70" />}
      </button>
      {open && (
        <div className="relative mt-1.5 min-h-0 px-3">
          <div
            ref={bodyRef}
            className={cx(
              'min-h-0 space-y-1',
              bounded ? SECTION_SCROLL_CLASS : 'px-0'
            )}
          >
            {children}
          </div>
          {bounded && (
            <>
              <div className="pointer-events-none absolute inset-x-3 top-0 h-4 rounded-t-[14px] bg-gradient-to-b from-[#0B0B0C] to-transparent" />
              <div className="pointer-events-none absolute inset-x-3 bottom-0 h-4 rounded-b-[14px] bg-gradient-to-t from-[#0B0B0C] to-transparent" />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function FileBadge({ file }: { file: WorkspaceReviewFile }) {
  const label = languageLabel(file);
  const isReact = label === 'React';
  return (
    <span
      className={cx(
        'inline-flex h-5 min-w-[22px] items-center justify-center rounded-[5px] px-1 text-[9.5px] font-black leading-none tracking-[-0.01em]',
        isReact ? 'text-[#4AA3FF]' : 'text-[#58A6FF]'
      )}
    >
      {isReact ? <Code2 className="h-3.5 w-3.5" strokeWidth={2.35} /> : label}
    </span>
  );
}

function StatsButton({
  stats,
  onClick,
}: {
  stats: FileStats;
  onClick?: () => void;
}) {
  if (!stats.changed || (stats.added === 0 && stats.removed === 0)) return null;
  const label = `Review changes: +${stats.added} -${stats.removed}`;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={event => {
        event.stopPropagation();
        onClick?.();
      }}
      className="eterx-professional-number inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-[11.5px] font-bold transition-all hover:bg-white/[0.08] hover:shadow-none focus:outline-none focus:ring-1 focus:ring-white/18"
    >
      <span className="text-[#4BE37B]">+{stats.added}</span>
      <span className="text-[#FF6C63]">-{stats.removed}</span>
    </button>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-white/[0.055] bg-white/[0.022] px-4 py-3">
      <div className="text-[13px] font-semibold text-white/58">{title}</div>
      <div className="mt-1 text-[12px] leading-5 text-white/38">{body}</div>
    </div>
  );
}

function SubagentDetailPanel({
  agent,
  onBack,
}: {
  agent: WorkspaceReviewSubagent | null;
  onBack: () => void;
}) {
  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <EmptyState title="No subagent selected" body="Choose a subagent from Overview to inspect its live work stream." />
      </div>
    );
  }

  const running = agent.status === 'running';
  const duration = formatDuration(agent.durationMs || (agent.startedAt && agent.completedAt ? agent.completedAt - agent.startedAt : undefined));
  const events = agent.events || [];

  return (
    <div className="eterx-review-panel flex h-full min-h-0 flex-col">
      <div className="flex min-h-[58px] shrink-0 items-center gap-3 border-b border-white/[0.055] px-4">
        <button
          type="button"
          onClick={onBack}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] px-2.5 text-[11.5px] font-semibold text-white/46 transition-colors hover:bg-white/[0.06] hover:text-white/82"
          title="Back to main agent overview"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={2.1} />
          Main agent
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cx(
              'h-2 w-2 shrink-0 rounded-full',
              running ? 'bg-[#8AB4FF] shadow-none' : agent.status === 'complete' ? 'bg-[#75D990]' : agent.status === 'failed' ? 'bg-[#FF7A70]' : 'bg-white/26'
            )} />
            <h3 className="truncate text-[15px] font-semibold text-white/86">{agent.name}</h3>
            <span className={cx('rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em]', running ? 'bg-[#8AB4FF]/10 text-[#9CC2FF]' : agent.status === 'complete' ? 'bg-[#75D990]/10 text-[#75D990]' : agent.status === 'failed' ? 'bg-[#FF7A70]/10 text-[#FF7A70]' : 'bg-white/[0.055] text-white/40')}>
              {running ? 'Live' : agent.status || 'Idle'}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-white/38">{agent.task || agent.role || 'Parallel agent'}</div>
        </div>
        {duration && <div className="eterx-professional-number shrink-0 rounded-full border border-white/[0.07] px-2 py-1 text-[11px] font-semibold text-white/42">{duration}</div>}
      </div>

      <div className="eterx-scrollbar eterx-review-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain p-4 [scrollbar-gutter:stable]">
        <div className="rounded-[16px] border border-white/[0.07] bg-white/[0.018] p-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/32">Current work</div>
          <div className="mt-2 text-[14px] font-semibold leading-6 text-white/76">
            {running
              ? <Shimmer>{agent.progress || 'Working'}</Shimmer>
              : agent.progress || (agent.status === 'complete' ? 'Completed' : 'No live progress yet')}
          </div>
          {agent.task && agent.progress && agent.task !== agent.progress && (
            <div className="mt-2 text-[12.5px] leading-5 text-white/42">{agent.task}</div>
          )}
        </div>

        <div className="mt-4">
          <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-white/50">
            <span>Live timeline</span>
            <span className="rounded-full bg-white/[0.055] px-1.5 py-0.5 text-[10px] text-white/32">{events.length}</span>
          </div>
          {events.length > 0 ? (
            <div className="space-y-1.5">
              {events.slice().reverse().map((event, index) => (
                <div key={`${event.timestamp || index}-${index}`} className="rounded-[12px] border border-white/[0.055] bg-[#101010]/72 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-white/[0.045] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-white/34">{event.type || 'trace'}</span>
                    {event.secondary && <span className="min-w-0 truncate font-mono text-[10.5px] text-white/28">{event.secondary}</span>}
                  </div>
                  <div className="mt-1.5 whitespace-pre-wrap break-words text-[12.5px] leading-5 text-white/62">{event.text}</div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No events yet" body="Live trace entries will appear here as this subagent reports work." />
          )}
        </div>

        {agent.result && (
          <div className="mt-4 rounded-[16px] border border-white/[0.07] bg-[#101010]/78 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/32">Result</div>
            <div className="eterx-scrollbar eterx-review-scrollbar mt-2 max-h-[36vh] overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words pr-2 text-[12.5px] leading-5 text-white/62 [scrollbar-gutter:stable]">
              {agent.result}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function OverviewPanel({
  files,
  changedFiles,
  artifacts,
  subagents,
  backgroundTasks,
  onSelectFile,
  onOpenDiff,
  onSelectSubagent,
}: {
  files: WorkspaceReviewFile[];
  changedFiles: WorkspaceReviewFile[];
  artifacts: WorkspaceReviewArtifact[];
  subagents: WorkspaceReviewSubagent[];
  backgroundTasks: WorkspaceReviewBackgroundTask[];
  onSelectFile: (file: WorkspaceReviewFile, index: number) => void;
  onOpenDiff: (file: WorkspaceReviewFile, index: number) => void;
  onSelectSubagent: (agent: WorkspaceReviewSubagent) => void;
}) {
  return (
    <div className="eterx-scrollbar eterx-review-scrollbar h-full max-h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-2 pr-3 [scrollbar-gutter:stable]">
      <Section
        title="Subagents"
        count={subagents.length}
        defaultOpen={subagents.length > 0 && subagents.length <= 6}
        bounded={subagents.length > 3}
      >
        {subagents.length > 0 ? (
          subagents.map((agent, index) => {
            const running = agent.status === 'running';
            const subtitle = agent.progress || agent.task || agent.role || 'Parallel worker';
            return (
              <button
                key={agent.id || `${agent.name}-${index}`}
                type="button"
                onClick={() => onSelectSubagent(agent)}
                className="group flex min-h-[48px] w-full items-center gap-2.5 rounded-[11px] px-2.5 py-2 text-left transition-colors hover:bg-white/[0.055]"
              >
                <span className={cx(
                  'relative h-2 w-2 shrink-0 rounded-full',
                  running ? 'bg-[#8AB4FF] shadow-none' : agent.status === 'complete' ? 'bg-[#75D990]' : agent.status === 'failed' ? 'bg-[#FF7A70]' : 'bg-white/24'
                )}>
                  {running && <span className="absolute inset-0 animate-ping rounded-full bg-[#8AB4FF]/45" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[12.8px] font-semibold text-white/74 group-hover:text-white/88">{agent.name}</span>
                    {running && <span className="rounded-full bg-[#8AB4FF]/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.1em] text-[#9CC2FF]">Live</span>}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] leading-4 text-white/38">{subtitle}</div>
                  {agent.task && agent.progress && agent.task !== agent.progress && (
                    <div className="truncate text-[10.5px] leading-4 text-white/25">{agent.task}</div>
                  )}
                </div>
                {running ? (
                  <span className="h-4 w-4 shrink-0 rounded-full border border-white/18 border-t-white/62 animate-spin" />
                ) : agent.status === 'complete' ? (
                  <Check className="h-4 w-4 shrink-0 text-[#75D990]" strokeWidth={2.2} />
                ) : agent.status === 'failed' ? (
                  <X className="h-4 w-4 shrink-0 text-[#FF7A70]" strokeWidth={2.2} />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-white/28 group-hover:text-white/58" strokeWidth={2.2} />
                )}
              </button>
            );
          })
        ) : (
          <EmptyState title="No subagents yet" body="This run has not reported subagent activity." />
        )}
      </Section>

      <Section
        title="Files changed"
        count={changedFiles.length}
        defaultOpen={changedFiles.length > 0 && changedFiles.length <= 8}
        bounded={changedFiles.length > 5}
      >
        {changedFiles.length > 0 ? (
          changedFiles.map(file => {
            const index = files.indexOf(file);
            const stats = getStats(file);
            return (
              <button
                key={fileKey(file, index)}
                type="button"
                onClick={() => onSelectFile(file, index)}
                className="group flex min-h-[52px] w-full items-center gap-2.5 rounded-[11px] px-2.5 py-2 text-left transition-colors hover:bg-white/[0.055]"
              >
                <FileBadge file={file} />
                <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5">
                  <span className="truncate text-[13.5px] font-semibold leading-5 text-[#DCEFFF] group-hover:text-white">{basename(file.filename || file.filepath)}</span>
                  <div className="row-span-2 flex justify-end">
                    <StatsButton stats={stats} onClick={() => onOpenDiff(file, index)} />
                  </div>
                  <div className="min-w-0 truncate text-[10.5px] leading-4 text-white/34">{dirname(file.filepath)}</div>
                </div>
              </button>
            );
          })
        ) : (
          <EmptyState title="No changed files" body="Changed file cards appear here when the agent creates or edits workspace files." />
        )}
      </Section>

      <Section
        title="Artifacts"
        count={artifacts.length}
        defaultOpen={artifacts.length > 0 && artifacts.length <= 6}
        bounded={artifacts.length > 4}
      >
        {artifacts.length > 0 ? (
          artifacts.map((artifact, index) => {
            const Icon = iconForKind(artifact.kind);
            const linkedFileIndex = files.findIndex(file => file.id === artifact.fileId || file.filepath === artifact.path);
            return (
              <button
                key={artifact.id || `${artifact.title}-${index}`}
                type="button"
                onClick={() => {
                  if (linkedFileIndex >= 0) onSelectFile(files[linkedFileIndex], linkedFileIndex);
                }}
                className="group flex min-h-[44px] w-full items-center gap-2.5 rounded-[11px] px-2.5 py-2 text-left transition-colors hover:bg-white/[0.055]"
              >
                <Icon className="h-4 w-4 shrink-0 text-white/42 group-hover:text-white/68" strokeWidth={2.05} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-white/64 group-hover:text-white/78">{artifact.title}</div>
                  {artifact.path && <div className="truncate text-[10.5px] text-white/32">{dirname(artifact.path)}</div>}
                </div>
              </button>
            );
          })
        ) : (
          <EmptyState title="No artifacts yet" body="Previews, media, documents, and task artifacts appear here separately from code files." />
        )}
      </Section>

      <Section
        title="Background tasks"
        count={backgroundTasks.length}
        defaultOpen={backgroundTasks.length > 0 && backgroundTasks.length <= 5}
        bounded={backgroundTasks.length > 4}
      >
        {backgroundTasks.length > 0 ? (
          backgroundTasks.map((task, index) => (
            <div key={task.id || `${task.title}-${index}`} className="flex min-h-[44px] items-center gap-2.5 rounded-[11px] px-2.5 py-2 transition-colors hover:bg-white/[0.045]">
              <TerminalSquare className="h-4 w-4 text-white/38" strokeWidth={2.05} />
              <div className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-white/62">{task.title}</div>
              <span className={cx('text-[11px] font-semibold capitalize', statusTone(task.status))}>{task.status || 'idle'}</span>
            </div>
          ))
        ) : (
          <EmptyState title="No background tasks" body="Long-running background work will be listed here when task metadata is available." />
        )}
      </Section>
    </div>
  );
}

function ReviewPanel({
  files,
  changedFiles,
  activeKey,
  loadingKey,
  loadErrorsByKey,
  onSelectFile,
  onOpenDiff,
}: {
  files: WorkspaceReviewFile[];
  changedFiles: WorkspaceReviewFile[];
  activeKey: string;
  loadingKey?: string | null;
  loadErrorsByKey?: Record<string, string>;
  onSelectFile: (file: WorkspaceReviewFile, index: number) => void;
  onOpenDiff: (file: WorkspaceReviewFile, index: number) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const totals = useMemo(() => changedFiles.reduce(
    (acc, file) => {
      const stats = getStats(file);
      acc.added += stats.added;
      acc.removed += stats.removed;
      return acc;
    },
    { added: 0, removed: 0 }
  ), [changedFiles]);

  useEffect(() => {
    if (!activeKey) return;
    setExpanded(prev => ({ ...prev, [activeKey]: true }));
  }, [activeKey]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-white/[0.055] px-5">
        <div className="text-[14px] font-semibold text-white/76">Review changes</div>
        <div className="eterx-professional-number rounded-full bg-white/[0.045] px-2 py-0.5 text-[11px] font-semibold text-white/38">{changedFiles.length}</div>
        {changedFiles.length > 0 && (
          <div className="eterx-professional-number hidden items-center gap-1.5 rounded-full border border-white/[0.055] bg-white/[0.025] px-2 py-1 text-[11px] font-bold text-white/42 sm:flex">
            <span className="text-[#4BE37B]">+{totals.added}</span>
            <span className="text-[#FF6C63]">-{totals.removed}</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5 text-white/38">
          <button type="button" className="rounded-lg p-1.5 transition-colors hover:bg-white/[0.055] hover:text-white/70" title="Grouped view">
            <Columns2 className="h-4 w-4" strokeWidth={2} />
          </button>
          <button type="button" className="rounded-lg p-1.5 transition-colors hover:bg-white/[0.055] hover:text-white/70" title="Search diffs">
            <Search className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="eterx-review-panel-scroll eterx-review-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain p-3 pr-2 [scrollbar-gutter:stable]">
        {changedFiles.length > 0 ? (
          <div className="space-y-2">
            {changedFiles.map(file => {
              const index = files.indexOf(file);
              const key = fileKey(file, index);
              const open = expanded[key] ?? false;
              const stats = getStats(file);
              const compactRows = compactDiff(getDisplayDiffLines(file));
              const isLoadingFile = loadingKey === key;
              const loadError = loadErrorsByKey?.[key] || file.loadError;
              const hiddenRows = Math.max(0, compactRows.length - MAX_REVIEW_ROWS_PER_FILE);
              const rows = hiddenRows > 0
                ? [
                    ...compactRows.slice(0, MAX_REVIEW_ROWS_PER_FILE),
                    { kind: 'gap' as const, count: hiddenRows, key: `gap-capped-${key}` },
                  ]
                : compactRows;
              return (
                <div key={key} className={cx(
                  'eterx-review-file-card',
                  'overflow-hidden rounded-[16px] border bg-[#101010]/78 transition-colors',
                  open ? 'border-white/[0.11] shadow-none' : 'border-white/[0.07] hover:border-white/[0.12]'
                )}>
                  <button
                    type="button"
                    onClick={() => setExpanded(prev => ({ ...prev, [key]: !open }))}
                    className={cx(
                      'eterx-review-file-card-head group flex min-h-[52px] w-full items-center gap-3 px-4 text-left transition-colors hover:bg-white/[0.04]',
                      open && 'border-b border-white/[0.055]'
                    )}
                  >
                    <FileBadge file={file} />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[14px] font-semibold text-[#DCEFFF]">{basename(file.filename || file.filepath)}</span>
                        <StatsButton stats={stats} onClick={() => onOpenDiff(file, index)} />
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-white/34">{dirname(file.filepath)}</div>
                    </div>
                    {open ? <ChevronDown className="h-4 w-4 text-white/42" /> : <ChevronRight className="h-4 w-4 text-white/42" />}
                  </button>

                  {open && (
                    <div className="eterx-review-diff-body eterx-review-scrollbar max-h-[58vh] overflow-y-auto overflow-x-hidden overscroll-contain bg-[#0B0B0C] py-2 pr-1 font-mono text-[12px] leading-5 [scrollbar-gutter:stable]">
                      {rows.length > 0 ? (
                        rows.map(row => {
                          if (row.kind === 'gap') {
                            return (
                              <div key={row.key} className="relative my-1 flex items-center justify-center px-4 text-[11px] text-white/38">
                                <div className="h-px flex-1 bg-white/[0.08]" />
                                <span className="mx-2 rounded-lg border border-white/[0.07] bg-white/[0.04] px-2 py-1">+{row.count} more lines</span>
                                <div className="h-px flex-1 bg-white/[0.08]" />
                              </div>
                            );
                          }

                          const { line } = row;
                          const isAdded = line.type === 'added';
                          const isRemoved = line.type === 'removed';
                          return (
                            <div
                              key={row.key}
                              className={cx(
                                'eterx-review-diff-row grid grid-cols-[44px_44px_22px_minmax(0,1fr)] gap-0 px-3',
                                isAdded && 'bg-[#20361F]',
                                isRemoved && 'bg-[#441A1A]'
                              )}
                            >
                              <span className="select-none text-right text-[#74809B]">{line.oldLine ?? ''}</span>
                              <span className="select-none text-right text-[#74809B]">{line.newLine ?? ''}</span>
                              <span className={cx('select-none text-center', isAdded ? 'text-[#75D990]' : isRemoved ? 'text-[#FF7A70]' : 'text-white/20')}>
                                {isAdded ? '+' : isRemoved ? '-' : ''}
                              </span>
                              <span
                                className="eterx-review-diff-content min-w-0 whitespace-pre-wrap break-words text-[#D6D3CC]"
                                dangerouslySetInnerHTML={{ __html: highlightReviewSyntax(line.content || ' ') }}
                              />
                            </div>
                          );
                        })
                      ) : isLoadingFile ? (
                        <div className="mx-3 my-2">
                          <EmptyState title="Preparing review" body="Reading the file so count-only changes can be inspected with current content and line numbers." />
                        </div>
                      ) : loadError ? (
                        <div className="mx-3 my-2">
                          <EmptyState title="Could not prepare review" body={loadError} />
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onSelectFile(file, index)}
                          className="eterx-review-empty-diff mx-3 my-2 rounded-xl border border-white/[0.055] bg-white/[0.025] px-4 py-3 text-left text-[12px] text-white/48 transition-colors hover:bg-white/[0.045] hover:text-white/70"
                        >
                          Only change counts were supplied for this file. Open the file to inspect the current artifact.
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState title="No reviewable changes" body="Files with additions, removals, or hydrated change metadata will appear here." />
        )}
      </div>
    </div>
  );
}

function CodePanel({
  file,
  isLoading = false,
  loadError,
  onCopyPath,
}: {
  file: WorkspaceReviewFile | null;
  isLoading?: boolean;
  loadError?: string;
  onCopyPath: (file: WorkspaceReviewFile) => void;
}) {
  const [copied, setCopied] = useState(false);

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <EmptyState title="No file selected" body="Choose a file from Overview or Review to inspect its current content." />
      </div>
    );
  }

  const lines = (file.content || '').split(/\r?\n/);
  const shownLines = lines.length === 1 && lines[0] === '' ? [] : lines;
  const visibleLines = shownLines.slice(0, MAX_CODE_LINES);
  const totalLines = file.totalLines ?? file.lineCount ?? shownLines.length;
  const startLine = file.startLine && file.startLine > 0 ? file.startLine : 1;
  const loadedEndLine = file.endLine ?? (shownLines.length > 0 ? startLine + shownLines.length - 1 : 0);
  const hiddenLineCount = file.truncated
    ? Math.max(0, totalLines - loadedEndLine)
    : Math.max(0, shownLines.length - visibleLines.length);
  const rangeLabel = file.truncated
    ? `Lines ${startLine}-${loadedEndLine} of ${totalLines}`
    : `${totalLines} lines`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.055] px-4">
        <FileBadge file={file} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-[#DCEFFF]">{basename(file.filename || file.filepath)}</div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[11px] text-white/34">{file.filepath}</span>
            <span className={cx(
              'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums',
              file.truncated ? 'bg-amber-500/10 text-amber-200/78' : 'bg-white/[0.045] text-white/34'
            )}>
              {rangeLabel}
            </span>
          </div>
        </div>
        <button
          type="button"
          title="Copy path"
          onClick={() => {
            onCopyPath(file);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
          className="rounded-lg border border-white/[0.08] bg-white/[0.035] p-2 text-white/44 transition-colors hover:bg-white/[0.07] hover:text-white/78"
        >
          {copied ? <Check className="h-4 w-4 text-white" strokeWidth={2.2} /> : <Copy className="h-4 w-4" strokeWidth={2.2} />}
        </button>
      </div>

      <div className="eterx-scrollbar eterx-review-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain bg-[#0B0B0C] p-4 font-mono text-[13px] leading-6 [scrollbar-gutter:stable]">
        {shownLines.length > 0 ? (
          visibleLines.map((line, index) => (
            <div key={`${index}-${line.slice(0, 20)}`} className="grid grid-cols-[48px_minmax(0,1fr)] gap-4">
              <span className="select-none text-right text-[#6F7890]">{startLine + index}</span>
              <span
                className="eterx-review-code-content min-w-0 whitespace-pre-wrap break-words text-[#D6D3CC]"
                dangerouslySetInnerHTML={{ __html: highlightReviewSyntax(line || ' ') }}
              />
            </div>
          ))
        ) : isLoading ? (
          <EmptyState title="Preparing file" body="Reading this file from the workspace." />
        ) : loadError ? (
          <EmptyState title="Could not load content" body={loadError} />
        ) : (
          <EmptyState title="No content loaded" body="This file is indexed for the run. Open it again to request the latest readable content." />
        )}
        {hiddenLineCount > 0 && (
          <div className="mt-4 flex items-center justify-center gap-3 text-[11px] text-white/34">
            <div className="h-px flex-1 bg-white/[0.08]" />
            <span className="rounded-lg border border-white/[0.07] bg-white/[0.04] px-2.5 py-1">
              +{hiddenLineCount} additional lines hidden for performance
            </span>
            <div className="h-px flex-1 bg-white/[0.08]" />
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkspaceReviewEditor({
  files = EMPTY_FILES,
  artifacts = EMPTY_ARTIFACTS,
  subagents = EMPTY_SUBAGENTS,
  backgroundTasks = EMPTY_TASKS,
  activeFileId,
  initialMode = 'overview',
  className,
  onModeChange,
  onSelectFile,
  onOpenDiff,
  onCopyPath,
  onClose,
}: WorkspaceReviewEditorProps) {
  const [mode, setMode] = useState<WorkspaceInternalMode>(initialMode);
  const [lastReviewMode, setLastReviewMode] = useState<WorkspaceReviewMode>(initialMode);
  const [activeSubagentId, setActiveSubagentId] = useState<string>('');
  const [hiddenTabKeys, setHiddenTabKeys] = useState<Set<string>>(() => new Set());
  const [loadedContentByKey, setLoadedContentByKey] = useState<Record<string, {
    content: string;
    language?: string;
    totalLines?: number;
    loadedLines?: number;
    startLine?: number;
    endLine?: number;
    truncated?: boolean;
    size?: number;
  }>>({});
  const [loadingContentKey, setLoadingContentKey] = useState<string | null>(null);
  const [loadErrorsByKey, setLoadErrorsByKey] = useState<Record<string, string>>({});
  const [isCompactTabs, setIsCompactTabs] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const shellRef = useRef<HTMLElement | null>(null);
  const tabRailRef = useRef<HTMLDivElement | null>(null);
  const [activeKey, setActiveKey] = useState<string>(() => {
    const initialIndex = Math.max(0, files.findIndex(file => file.id === activeFileId || file.filepath === activeFileId));
    return files[initialIndex] ? fileKey(files[initialIndex], initialIndex) : '';
  });

  const hydratedFiles = useMemo(() => files.map((file, index) => {
    const loaded = loadedContentByKey[fileKey(file, index)];
    return loaded
      ? { ...file, ...loaded, language: file.language || loaded.language }
      : file;
  }), [files, loadedContentByKey]);
  const changedFiles = useMemo(() => hydratedFiles.filter(file => getStats(file).changed), [hydratedFiles]);
  const fileEntries = useMemo(
    () => hydratedFiles.map((file, index) => ({ file, index, key: fileKey(file, index) })),
    [hydratedFiles]
  );
  const tabEntries = useMemo(
    () => fileEntries.filter(entry => !hiddenTabKeys.has(entry.key)),
    [fileEntries, hiddenTabKeys]
  );

  const reviewArtifacts = useMemo<WorkspaceReviewArtifact[]>(() => {
    return artifacts.filter(artifact => !isCodeArtifact(artifact));
  }, [artifacts]);

  const activeIndex = useMemo(() => {
    if (!hydratedFiles.length) return -1;
    const keyMatch = hydratedFiles.findIndex((file, index) => fileKey(file, index) === activeKey);
    if (keyMatch >= 0 && !hiddenTabKeys.has(fileKey(hydratedFiles[keyMatch], keyMatch))) return keyMatch;
    if (activeFileId) {
      const activeMatch = hydratedFiles.findIndex((file, index) => {
        const key = fileKey(file, index);
        return !hiddenTabKeys.has(key) && (file.id === activeFileId || file.filepath === activeFileId);
      });
      if (activeMatch >= 0) return activeMatch;
    }
    return tabEntries[0]?.index ?? 0;
  }, [activeFileId, activeKey, hydratedFiles, hiddenTabKeys, tabEntries]);

  const activeFileBase = activeIndex >= 0 ? hydratedFiles[activeIndex] : null;
  const activeFileKey = activeFileBase ? fileKey(activeFileBase, activeIndex) : '';
  const activeLoadedContent = activeFileKey ? loadedContentByKey[activeFileKey] : undefined;
  const activeFile = activeFileBase && activeLoadedContent
    ? { ...activeFileBase, ...activeLoadedContent, language: activeFileBase.language || activeLoadedContent.language }
    : activeFileBase;
  const visibleTabs = useMemo(() => {
    if (!isCompactTabs) return tabEntries;
    const activeEntry = tabEntries.find(entry => entry.key === activeKey) || tabEntries[0];
    return activeEntry ? [activeEntry] : [];
  }, [activeKey, isCompactTabs, tabEntries]);

  useEffect(() => {
    const node = tabRailRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      setIsCompactTabs(false);
      return;
    }

    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width || 0;
      const compactThreshold = Math.min(MAX_TAB_RAIL_WIDTH_BEFORE_SCROLL, Math.round(MIN_VISIBLE_TAB_WIDTH * 3.25));
      setIsCompactTabs(tabEntries.length > 1 && width > 0 && width < compactThreshold);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [tabEntries.length]);

  useEffect(() => {
    setFilePickerOpen(false);
  }, [activeKey, mode]);

  useEffect(() => {
    if (!files.length) {
      setActiveKey('');
      return;
    }
    if (activeFileId) {
      const index = files.findIndex(file => file.id === activeFileId || file.filepath === activeFileId);
      if (index >= 0) {
        const nextKey = fileKey(files[index], index);
        if (!hiddenTabKeys.has(nextKey)) {
          setActiveKey(nextKey);
          return;
        }
      }
    }
    if (!files.some((file, index) => fileKey(file, index) === activeKey) || hiddenTabKeys.has(activeKey)) {
      const nextEntry = tabEntries[0] || fileEntries[0];
      setActiveKey(nextEntry ? nextEntry.key : '');
    }
  }, [activeFileId, activeKey, fileEntries, files, hiddenTabKeys, tabEntries]);

  const chooseMode = (nextMode: WorkspaceReviewMode) => {
    setMode(nextMode);
    setLastReviewMode(nextMode);
    onModeChange?.(nextMode);
  };

  const selectSubagent = (agent: WorkspaceReviewSubagent) => {
    setActiveSubagentId(agent.id || agent.name);
    setMode('subagent');
  };

  const selectFile = (file: WorkspaceReviewFile, index: number) => {
    setActiveKey(fileKey(file, index));
    chooseMode('code');
    onSelectFile?.(file, index);
  };

  const openDiff = (file: WorkspaceReviewFile, index: number) => {
    setActiveKey(fileKey(file, index));
    chooseMode('review');
    onOpenDiff?.(file, index);
  };

  const closeFileTab = (file: WorkspaceReviewFile, index: number) => {
    const key = fileKey(file, index);
    setHiddenTabKeys(prev => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    if (activeKey === key) {
      const nextEntry = tabEntries.find(entry => entry.key !== key);
      if (nextEntry) {
        setActiveKey(nextEntry.key);
        chooseMode('code');
      } else {
        chooseMode('overview');
      }
    }
  };

  useEffect(() => {
    const shouldLoadForMode = mode === 'code' || (mode === 'review' && !activeFileBase?.diffLines?.length);
    if (!shouldLoadForMode || !activeFileBase || !activeFileKey) return;
    if (typeof activeFileBase.content === 'string' || loadedContentByKey[activeFileKey] || loadingContentKey === activeFileKey) return;

    const controller = new AbortController();
    setLoadingContentKey(activeFileKey);
    setLoadErrorsByKey(prev => {
      if (!prev[activeFileKey]) return prev;
      const next = { ...prev };
      delete next[activeFileKey];
      return next;
    });

    fetch('/api/code/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: activeFileBase.filepath, limit: MAX_CODE_LINES }),
      signal: controller.signal,
    })
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || 'File could not be read.');
        setLoadedContentByKey(prev => ({
          ...prev,
          [activeFileKey]: {
            content: String(data.content || ''),
            language: typeof data.language === 'string' ? data.language : undefined,
            totalLines: typeof data.totalLines === 'number' ? data.totalLines : undefined,
            loadedLines: typeof data.loadedLines === 'number' ? data.loadedLines : undefined,
            startLine: typeof data.startLine === 'number' ? data.startLine : undefined,
            endLine: typeof data.endLine === 'number' ? data.endLine : undefined,
            truncated: Boolean(data.truncated),
            size: typeof data.size === 'number' ? data.size : undefined,
          },
        }));
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        setLoadErrorsByKey(prev => ({
          ...prev,
          [activeFileKey]: error?.message || 'File could not be read.',
        }));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoadingContentKey(current => current === activeFileKey ? null : current);
        }
      });

    return () => controller.abort();
  }, [activeFileBase, activeFileKey, loadedContentByKey, loadingContentKey, mode]);

  const copyPath = async (file: WorkspaceReviewFile) => {
    const didCopy = await safeCopyTextToClipboard(file.filepath);
    if (didCopy) onCopyPath?.(file);
  };

  const activeSubagent = useMemo(() => {
    if (!subagents.length) return null;
    return subagents.find(agent => (agent.id || agent.name) === activeSubagentId) || subagents[0] || null;
  }, [activeSubagentId, subagents]);

  return (
    <aside ref={shellRef} className={cx('eterx-workspace-review flex h-full min-h-0 w-full flex-col overflow-hidden border-l border-white/[0.07] bg-[#0B0B0C] text-[#D8D5CF]', className)}>
      <div className="eterx-workspace-review-topbar flex h-[48px] shrink-0 items-center gap-1.5 border-b border-white/[0.055] bg-[#0A0A0B]/96 px-2 shadow-none">
        <button
          type="button"
          onClick={() => chooseMode('overview')}
          className={cx(
            'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] px-2.5 text-[12.5px] font-semibold transition-colors',
            mode === 'overview' ? 'bg-white/[0.14] text-white shadow-none' : 'text-white/50 hover:bg-white/[0.055] hover:text-white/82'
          )}
        >
          <FileText className="h-3.5 w-3.5" strokeWidth={2.05} />
          Overview
        </button>
        <button
          type="button"
          onClick={() => chooseMode('review')}
          className={cx(
            'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] px-2.5 text-[12.5px] font-semibold transition-colors',
            mode === 'review' ? 'bg-white/[0.14] text-white shadow-none' : 'text-white/50 hover:bg-white/[0.055] hover:text-white/82'
          )}
        >
          <FileCode2 className="h-3.5 w-3.5" strokeWidth={2.05} />
          Review
        </button>

        <div className="mx-0.5 h-6 w-px bg-white/[0.08]" />

        <div ref={tabRailRef} className="relative min-w-0 flex-1 overflow-visible">
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-5 bg-gradient-to-r from-[#0A0A0B] to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-[#0A0A0B] to-transparent" />
          <div className={cx(
            'eterx-tab-strip-scroll flex min-w-0 items-center gap-0.5 px-1',
            isCompactTabs ? 'overflow-visible' : 'overflow-x-auto overflow-y-hidden'
          )}>
          {isCompactTabs && tabEntries.length > 1 && (
            <div className="relative z-20 shrink-0">
              <button
                type="button"
                onClick={() => setFilePickerOpen(value => !value)}
                className={cx(
                  'inline-flex h-7 items-center gap-1.5 rounded-[9px] border px-2 text-[11px] font-semibold transition-colors',
                  filePickerOpen ? 'border-white/[0.12] bg-white/[0.12] text-white' : 'border-transparent text-white/52 hover:bg-white/[0.06] hover:text-white/84'
                )}
                title="Open files"
              >
                <FileText className="h-3.5 w-3.5" strokeWidth={2.1} />
                <span>{tabEntries.length}</span>
                <ChevronDown className="h-3 w-3" strokeWidth={2.2} />
              </button>
              {filePickerOpen && (
                <div className="absolute left-0 top-9 z-50 w-[min(360px,calc(100vw-40px))] overflow-hidden rounded-[14px] border border-white/[0.095] bg-[#151515]/98 shadow-none backdrop-blur-xl">
                  <div className="border-b border-white/[0.06] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/36">Open files</div>
                  <div className="eterx-scrollbar eterx-review-scrollbar max-h-[46vh] overflow-y-auto overflow-x-hidden overscroll-contain p-1.5 [scrollbar-gutter:stable]">
                    {tabEntries.map(({ file, index, key }) => {
                      const selected = key === activeKey;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => {
                            selectFile(file, index);
                            setFilePickerOpen(false);
                          }}
                          className={cx(
                            'flex min-h-[34px] w-full items-center gap-2 rounded-[9px] px-2 text-left transition-colors',
                            selected ? 'bg-white/[0.08] text-white' : 'text-white/58 hover:bg-white/[0.045] hover:text-white/82'
                          )}
                        >
                          <FileBadge file={file} />
                          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{basename(file.filename || file.filepath)}</span>
                          <span className="max-w-[110px] truncate text-[10.5px] text-white/30">{dirname(file.filepath)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          {visibleTabs.map(({ file, index, key }) => {
            const selected = mode === 'code' && key === activeKey;
            return (
              <div
                key={key}
                className={cx(
                  'group/tab inline-flex h-7 max-w-[104px] shrink-0 items-center rounded-[9px] border transition-colors lg:max-w-[118px]',
                  selected ? 'border-white/[0.12] bg-white/[0.13] text-white shadow-none' : 'border-transparent text-white/48 hover:bg-white/[0.055] hover:text-white/82'
                )}
                title={file.filepath}
              >
                <button
                  type="button"
                  onClick={() => selectFile(file, index)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1.5 pr-1 text-[11px] font-semibold"
                >
                  <FileBadge file={file} />
                  <span className="min-w-0 truncate">{basename(file.filename || file.filepath)}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Close ${basename(file.filename || file.filepath)}`}
                  onClick={event => {
                    event.stopPropagation();
                    closeFileTab(file, index);
                  }}
                  className={cx(
                    'mr-1 flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full text-white/38 opacity-0 transition-all hover:bg-white/[0.10] hover:text-white group-hover/tab:opacity-100',
                    selected && 'opacity-100'
                  )}
                >
                  <X className="h-3 w-3" strokeWidth={2.35} />
                </button>
              </div>
            );
          })}
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-white/48 transition-colors hover:bg-white/[0.06] hover:text-white/82 active:scale-[0.98]"
          title="Close review panel"
          aria-label="Close review panel"
        >
          <Columns2 className="h-[18px] w-[18px]" strokeWidth={2.05} />
        </button>
      </div>

      <div className="eterx-workspace-review-body min-h-0 flex-1 overflow-hidden">
        {mode === 'overview' ? (
          <OverviewPanel
            files={hydratedFiles}
            changedFiles={changedFiles}
            artifacts={reviewArtifacts}
            subagents={subagents}
            backgroundTasks={backgroundTasks}
            onSelectFile={selectFile}
            onOpenDiff={openDiff}
            onSelectSubagent={selectSubagent}
          />
        ) : mode === 'review' ? (
          <ReviewPanel
            files={hydratedFiles}
            changedFiles={changedFiles}
            activeKey={activeKey}
            loadingKey={loadingContentKey}
            loadErrorsByKey={loadErrorsByKey}
            onSelectFile={selectFile}
            onOpenDiff={openDiff}
          />
        ) : mode === 'subagent' ? (
          <SubagentDetailPanel
            agent={activeSubagent}
            onBack={() => chooseMode(lastReviewMode === 'code' ? 'overview' : lastReviewMode)}
          />
        ) : (
          <CodePanel
            file={activeFile}
            isLoading={loadingContentKey === activeFileKey}
            loadError={activeFileKey ? loadErrorsByKey[activeFileKey] : undefined}
            onCopyPath={copyPath}
          />
        )}
      </div>
    </aside>
  );
}

export default WorkspaceReviewEditor;
