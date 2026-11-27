'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { motion, useIsPresent, useReducedMotion } from 'framer-motion';
import { ArrowUpRight, Bot, Check, ChevronDown, ChevronRight, Circle, CircleAlert, CircleDashed, CircleSlash, FileDiff, Files, FileText, FolderClosed, Gauge, GitBranch, GitCommitHorizontal, GripVertical, History, ListChecks, Loader2, MoreHorizontal, Network, Pin, X } from 'lucide-react';
import type { readChatContextUsage } from '../../lib/chat-context-usage';
import { agentIdentitiesOverlap } from '../../lib/chat-feed-lifecycle';
import { isAppVisible, subscribeAppVisibility, useAppVisibility } from '../../lib/app-visibility';
import { GIT_CHANGED_EVENT, useGitPreferences } from '../../lib/git/client';
import { addWorkspaceTab, openWorkspaceGit, openWorkspaceReview, useSideWorkspace } from '../../lib/side-workspace-store';
import { useTraceSelection } from '../../lib/use-trace-selection';
import { useWorkspaceRoots } from '../../lib/use-workspace-roots';
import { watchWorkspaceFolder } from '../../lib/workspace-file-events';
import { isWithinWorkspace, resolveTouchPath, workspaceParent, workspacePathKey, workspaceRootForFile } from '../../lib/workspace-paths';
import { collectWorkspaceReviewFiles, isWorkspaceReviewTrace, readWorkspaceRepositoryReview, type RepositoryReview } from '../../lib/workspace-review-data';
import { ProjectFolderPicker, useProjectFolderBrowse } from '../layout/project-folder-picker';
import { AdaptiveMenu } from '../ui/adaptive-menu';
import { ActivityDisclosure } from './activity-disclosure';
import type { ChatMediaItem } from './chat-media';
import { openChatImage } from './image-gallery';
import { useLifecycleElapsedMs } from './lifecycle-clock';
import { openLocalFilePath } from './local-file-link';
import { WorkPanelDevelopment } from './work-panel-development';
import type { WorkspaceSubAgentsProps } from './workspace-sub-agents';

type WorkPanelAgent = WorkspaceSubAgentsProps['agents'][number] & {
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  turnScope?: string;
  runScope?: string;
};

type WorkPanelPlan = import('../../lib/task-plan-trace').TaskTrackerState;

type Source = {
  id: string;
  name: string;
  path: string;
  originalPath?: string;
  image?: string;
  pinned?: boolean;
  folder?: boolean;
  reviewPath?: string;
  added?: number;
  removed?: number;
};

const emptyFolders: string[] = [];
const emptyBaseRefs: Record<string, string> = {};
const runningStatuses = new Set(['running', 'working']);
const previousStatuses = new Set(['done', 'completed', 'error', 'failed', 'closed', 'cancelled', 'stopped', 'blocked']);
const statusLabels: Record<string, string> = {
  planned: 'Queued', queued: 'Queued', spawning: 'Starting', running: 'Running', working: 'Running',
  waiting: 'Waiting', paused: 'Paused', completed: 'Completed', done: 'Completed',
  failed: 'Failed', error: 'Failed', closed: 'Closed', cancelled: 'Cancelled', stopped: 'Stopped', blocked: 'Blocked',
};
const tokenCount = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const minPanelWidth = 240;
const defaultPanelWidth = 320;
const maxPanelWidth = 384;
const minChatWidth = 320;
const handleClearance = 12;

function useWorkingTreeSummary(roots: string[], enabled: boolean, autoDetect: boolean) {
  const visible = useAppVisibility();
  const rootKey = JSON.stringify(roots);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{ key: string; data: RepositoryReview }>();
  const summary = enabled && snapshot?.key === rootKey ? snapshot.data : undefined;
  useEffect(() => {
    const directories: string[] = JSON.parse(rootKey);
    if (!enabled || !visible || !directories.length) return;
    const controller = new AbortController();
    void readWorkspaceRepositoryReview(directories, 'working', emptyBaseRefs, controller.signal).then(data => {
      if (!controller.signal.aborted) setSnapshot({ key: rootKey, data });
    }).catch(() => {
      if (!controller.signal.aborted) setSnapshot(undefined);
    });
    return () => controller.abort();
  }, [enabled, rootKey, visible, revision]);

  const watched = JSON.stringify([...new Set([
    ...roots,
    ...(summary?.projects || []).map(project => project.gitDirectory),
    ...(summary?.files || []).map(file => workspaceParent(file.filepath)),
  ].filter(Boolean))].slice(0, 40));
  useEffect(() => {
    if (!enabled || !visible || !roots.length) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!isAppVisible()) return;
      clearTimeout(timeout);
      timeout = setTimeout(() => setRevision(value => value + 1), 500);
    };
    const stops = autoDetect ? (JSON.parse(watched) as string[]).map(path => watchWorkspaceFolder(path, schedule)) : [];
    const timer = autoDetect ? setInterval(schedule, 30_000) : undefined;
    const unsubscribeVisibility = subscribeAppVisibility(schedule);
    window.addEventListener(GIT_CHANGED_EVENT, schedule);
    if (autoDetect) window.addEventListener('focus', schedule);
    return () => {
      stops.forEach(stop => stop());
      clearTimeout(timeout);
      clearInterval(timer);
      unsubscribeVisibility();
      window.removeEventListener(GIT_CHANGED_EVENT, schedule);
      window.removeEventListener('focus', schedule);
    };
  }, [enabled, autoDetect, watched, visible, roots.length]);
  return summary;
}

function usePanelBounds(card: RefObject<HTMLElement | null>, chat: RefObject<HTMLElement | null>, trigger: RefObject<HTMLButtonElement | null>, attached: boolean) {
  const [bounds, setBounds] = useState({ minimum: minPanelWidth, maximum: maxPanelWidth, top: 8, right: 10 });
  useLayoutEffect(() => {
    const layout = card.current?.parentElement;
    if (!layout) return;
    const anchor = trigger.current;
    const measure = () => {
      const rect = layout.getBoundingClientRect();
      if (!rect.width || !layout.clientWidth) return;
      const scale = rect.width / layout.offsetWidth || 1;
      const anchorRect = attached ? anchor?.getBoundingClientRect() : undefined;
      const scrollbar = Number.parseFloat(getComputedStyle(layout).getPropertyValue('--eterx-sb-size')) || 9;
      const right = anchorRect?.width
        ? Math.max(10, Math.round((rect.right - anchorRect.right) / scale))
        : 10 + scrollbar;
      const top = anchorRect?.height ? Math.max(6, Math.round((anchorRect.bottom - rect.top + 8) / scale)) : 8;
      const visibleLimit = Math.max(0, Math.floor(layout.clientWidth - right - handleClearance));
      const dock = chat.current?.querySelector('.eterx-chat-input-dock');
      const gutter = dock ? Math.ceil(Number.parseFloat(getComputedStyle(dock).paddingLeft) || 16) : 16;
      const splitLimit = visibleLimit - minChatWidth - gutter;
      const maximum = Math.min(maxPanelWidth, !attached && splitLimit >= minPanelWidth ? splitLimit : visibleLimit);
      const minimum = Math.min(minPanelWidth, maximum);
      setBounds(previous => previous.minimum === minimum && previous.maximum === maximum && previous.top === top && previous.right === right
        ? previous : { minimum, maximum, top, right });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    if (anchor && attached) {
      observer.observe(anchor);
      const toolbar = anchor.closest('.eterx-main-header');
      if (toolbar) observer.observe(toolbar);
    }
    window.addEventListener('resize', measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [attached, card, chat, trigger]);
  return bounds;
}

function usePanelLayout(card: RefObject<HTMLElement | null>, chat: RefObject<HTMLElement | null>, attached: boolean) {
  useLayoutEffect(() => {
    const panel = card.current;
    const pane = chat.current;
    if (attached || !panel || !pane) return;
    let frame = 0;

    const insetFor = (container: HTMLElement, content: HTMLElement, cardLeft: number) => {
      const rect = container.getBoundingClientRect();
      const scale = rect.width / container.offsetWidth || 1;
      const width = container.clientWidth;
      const css = getComputedStyle(container);
      const start = parseFloat(css.paddingLeft) || 0;
      const maxWidth = getComputedStyle(content).maxWidth;
      const max = maxWidth.endsWith('px') ? parseFloat(maxWidth) : width;
      const limit = (cardLeft - rect.left) / scale - handleClearance;
      if (limit - start < minChatWidth - 1 || content.getBoundingClientRect().right <= cardLeft - handleClearance * scale) return 0;
      // A centered max-width column can move into its left gutter before it needs to get narrower.
      return Math.max(0, Math.ceil(Math.min(width - limit, width + start + max - 2 * limit)));
    };
    const measure = () => {
      pane.style.removeProperty('--eterx-work-panel-inset');
      const left = panel.getBoundingClientRect().left;
      const feed = pane.querySelector<HTMLElement>('.eterx-chat-feed-scroll');
      const feedColumn = feed?.querySelector<HTMLElement>('.eterx-chat-feed-content');
      const composer = pane.querySelector<HTMLElement>('.eterx-chat-input-dock');
      const composerColumn = composer?.querySelector<HTMLElement>('.eterx-composer-shell');
      const needed = Math.max(
        feed && feedColumn ? insetFor(feed, feedColumn, left) : 0,
        composer && composerColumn ? insetFor(composer, composerColumn, left) : 0,
      );
      if (needed) pane.style.setProperty('--eterx-work-panel-inset', needed + 'px');
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(pane);
    observer.observe(panel);
    window.addEventListener('resize', schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      pane.style.removeProperty('--eterx-work-panel-inset');
    };
  }, [attached, card, chat]);
}

function usePanelScrollEdges(enabled = true) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState('none');
  const sync = useCallback(() => {
    const list = scrollRef.current;
    if (!list) return;
    const overflow = list.scrollHeight - list.clientHeight;
    setEdges(overflow <= 2 ? 'none' : list.scrollTop <= 1 ? 'start' : list.scrollTop >= overflow - 1 ? 'end' : 'middle');
  }, []);
  useLayoutEffect(() => {
    if (!enabled) { setEdges('none'); return; }
    if (!scrollRef.current || !contentRef.current) return;
    const observer = new ResizeObserver(sync);
    observer.observe(scrollRef.current);
    observer.observe(contentRef.current);
    sync();
    return () => observer.disconnect();
  }, [enabled, sync]);
  return { scrollRef, contentRef, edges, sync };
}

function AgentTitle({ name }: { name: string }) {
  const viewport = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const box = viewport.current;
    const label = text.current;
    if (!box || !label) return;
    const measure = () => {
      const distance = Math.max(0, label.scrollWidth - box.clientWidth);
      box.style.setProperty('--work-agent-travel', distance + 'px');
      box.style.setProperty('--work-agent-travel-time', Math.max(360, distance * 20) + 'ms');
      setClipped(distance > 2);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(label);
    measure();
    return () => observer.disconnect();
  }, [name]);
  return <span ref={viewport} className="eterx-work-panel-agent-title" data-clipped={clipped}>
    <span ref={text} className="eterx-work-panel-agent-title-text">{name}</span>
    <span className="eterx-work-panel-agent-title-expanded" aria-hidden="true">{name}</span>
  </span>;
}

function AgentRow({ agent, selected, onSelect }: { agent: WorkPanelAgent; selected: boolean; onSelect: (id: string) => void }) {
  const id = agent.id || agent.subAgentChatId || agent.subAgentId || agent.name;
  const status = String(agent.status || '').toLowerCase();
  const live = runningStatuses.has(status) || status === 'waiting';
  const duration = useLifecycleElapsedMs({
    active: live, startedAt: agent.startedAt, endedAt: agent.completedAt,
    durationMs: previousStatuses.has(status) ? agent.durationMs || undefined : undefined,
    lifecycleKey: id, allowLiveFallback: false,
  });
  const seconds = duration === null ? null : Math.floor(duration / 1000);
  const elapsed = seconds === null ? '' : seconds < 60 ? seconds + 's' : seconds < 3600 ? Math.floor(seconds / 60) + 'm' : Math.floor(seconds / 3600) + 'h';
  const label = statusLabels[status] || 'Ready';
  return <button type="button" className="eterx-work-panel-row eterx-work-panel-agent" aria-current={selected ? 'true' : undefined} title={agent.name}
    aria-label={[agent.name, label, elapsed, selected ? 'viewing' : '', agent.unreadCount ? agent.unreadCount + ' unread' : ''].filter(Boolean).join(', ')} onClick={() => onSelect(id)}>
    <span className="eterx-work-panel-row-icon"><Bot size={15} strokeWidth={1.8} aria-hidden="true" /></span>
    <AgentTitle name={agent.name} />
    <span className="eterx-work-panel-agent-meta" data-status={status}>
      {agent.unreadCount ? <Circle size={6} fill="currentColor" className="eterx-work-panel-unread" aria-hidden="true" /> : null}
      <span className="eterx-work-panel-agent-status">{label}</span>{elapsed && <time dateTime={'PT' + seconds + 'S'}>{elapsed}</time>}
    </span>
  </button>;
}

function ChangeTotals({ added, removed }: { added?: number; removed?: number }) {
  if (added === undefined && removed === undefined) return null;
  return <span className="eterx-work-panel-counts" aria-label={`${added ?? 0} additions, ${removed ?? 0} deletions`}>
    <span data-change="added">+{added ?? 0}</span><span data-change="removed">−{removed ?? 0}</span>
  </span>;
}

function isNestedAgent(agent: WorkPanelAgent, agents: WorkPanelAgent[]) {
  if ((agent.depth || 0) > 1) return true;
  if (agent.parentAgentName && agent.parentAgentName.toLowerCase() !== 'main') return true;
  return Boolean(agent.parentAgentId && agents.some(parent => agentIdentitiesOverlap(parent, agent.parentAgentId)));
}

type WorkPanelProps = {
  cardRef: RefObject<HTMLElement | null>;
  chatRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  widthPreference: RefObject<number | null>;
  attached: boolean;
  panelId: string;
  owner: string;
  chatId: string;
  workspacePath: string | null;
  workspaceName: string;
  workspaceLocked: boolean;
  traceLogs: any[];
  media: ChatMediaItem[];
  mediaError: string;
  retryMedia: () => void;
  pins: Array<{ id: string; path: string; name: string; type?: 'file' | 'folder' }>;
  plan?: WorkPanelPlan | null;
  planRunning: boolean;
  agents: WorkPanelAgent[];
  activeAgentId: string | null;
  revealAgents: boolean;
  context: ReturnType<typeof readChatContextUsage>;
  onSelectWorkspace: (path: string | null) => void;
  onSelectAgent: (id: string) => void;
  onClose: (restoreFocus?: boolean) => void;
};

export function WorkPanel({
  cardRef, chatRef, triggerRef, widthPreference, attached, panelId, owner, chatId, workspacePath, workspaceName, workspaceLocked,
  traceLogs, media, mediaError, retryMedia, pins,
  plan, planRunning, agents, activeAgentId, revealAgents, context, onSelectWorkspace, onSelectAgent, onClose,
}: WorkPanelProps) {
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();
  const bounds = usePanelBounds(cardRef, chatRef, triggerRef, attached);
  usePanelLayout(cardRef, chatRef, attached);
  const [requestedWidth, setRequestedWidth] = useState(() => widthPreference.current ?? defaultPanelWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; scale: number; previousWidth: number; nextWidth?: number }>(null);
  const clampWidth = (width: number) => Math.round(Math.min(bounds.maximum, Math.max(bounds.minimum, width)));
  const width = clampWidth(requestedWidth);
  const canResize = bounds.maximum > bounds.minimum;
  const rememberWidth = (nextWidth: number) => {
    widthPreference.current = nextWidth;
    setRequestedWidth(nextWidth);
  };
  const finishResize = useCallback((pointerId: number, cancel = false) => {
    const active = drag.current;
    if (!active || active.pointerId !== pointerId) return;
    drag.current = null;
    setResizing(false);
    if (cancel) setRequestedWidth(active.previousWidth);
    else if (active.nextWidth !== undefined) widthPreference.current = active.nextWidth;
  }, [widthPreference]);
  useLayoutEffect(() => {
    if (attached && drag.current) finishResize(drag.current.pointerId, true);
  }, [attached, finishResize]);

  const [openMenu, setOpenMenu] = useState<'project' | 'sources' | 'agents' | null>(null);
  const [projectError, setProjectError] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [planOpen, setPlanOpen] = useState(true);
  const [previousOpen, setPreviousOpen] = useState(false);
  const projectOpen = present && openMenu === 'project' && !workspaceLocked;
  const sourcesOpen = present && openMenu === 'sources';
  const agentMenuOpen = present && openMenu === 'agents';
  const projectAnchor = useRef<HTMLDivElement>(null);
  const projectMenu = useRef<HTMLDivElement>(null);
  const sourcesAnchor = useRef<HTMLDivElement>(null);
  const sourcesMenu = useRef<HTMLDivElement>(null);
  const agentAnchor = useRef<HTMLDivElement>(null);
  const agentMenu = useRef<HTMLDivElement>(null);
  const panelScroll = usePanelScrollEdges();
  const sourceScroll = usePanelScrollEdges(sourcesOpen);
  const agentSection = useRef<HTMLElement>(null);
  const revealedAgents = useRef(false);
  const sourcesId = useId();
  const plansId = useId();
  const previousId = useId();
  const browse = useProjectFolderBrowse(owner, workspacePath, workspaceLocked, onSelectWorkspace, () => setProjectError('Folder picker unavailable. Try again or paste a path.'));

  useEffect(() => {
    if (!present) { setOpenMenu(null); return; }
    if (!openMenu) return;
    const [anchor, menu] = openMenu === 'project' ? [projectAnchor, projectMenu]
      : openMenu === 'sources' ? [sourcesAnchor, sourcesMenu] : [agentAnchor, agentMenu];
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!anchor.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpenMenu(null);
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [present, openMenu]);

  const hasAgents = agents.length > 0;
  useLayoutEffect(() => {
    const list = panelScroll.scrollRef.current;
    const section = agentSection.current;
    if (!revealAgents || !hasAgents || revealedAgents.current || !list || !section) return;
    revealedAgents.current = true;
    const bounds = list.getBoundingClientRect();
    const heading = section.getBoundingClientRect();
    if (heading.bottom <= bounds.bottom) return;
    const scale = bounds.height / list.offsetHeight || 1;
    list.scrollTo({
      top: list.scrollTop + (heading.top - bounds.top) / scale,
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  }, [hasAgents, revealAgents, panelScroll.scrollRef, reducedMotion]);

  const workspace = useSideWorkspace(owner);
  const openedPaths = useMemo(() => workspace.tabs.flatMap(tab => tab.kind === 'files' && tab.path ? [tab.path] : []), [workspace.tabs]);
  const rootState = useWorkspaceRoots(owner, workspacePath, traceLogs, openedPaths, workspace.folders || emptyFolders);
  const preferences = useGitPreferences();
  const summary = useWorkingTreeSummary(rootState.roots, preferences.ready && preferences.gitIntegration, preferences.gitAutoDetect);
  const reviewLogs = useTraceSelection(traceLogs, isWorkspaceReviewTrace);
  const editorChanges = useMemo(() => collectWorkspaceReviewFiles(reviewLogs, owner)
    .filter(file => !workspacePath || isWithinWorkspace(file.filepath, workspacePath)), [reviewLogs, owner, workspacePath]);
  const sources = useMemo(() => {
    const items: Source[] = media.map(item => ({
      id: 'attachment-' + item.id, name: item.name, path: item.path, originalPath: item.originalPath,
      image: item.mimeType?.startsWith('image/') ? item.previewUrl : undefined,
    }));
    const fileItems = new Map<string, Source>();
    const keyFor = (path: string) => workspacePathKey(resolveTouchPath(path, workspacePath || '') || path);
    for (const item of items) {
      fileItems.set(keyFor(item.path), item);
      if (item.originalPath) fileItems.set(keyFor(item.originalPath), item);
    }
    for (const item of pins) {
      const key = keyFor(item.path);
      const existing = fileItems.get(key);
      if (existing) { existing.pinned = true; continue; }
      const source: Source = { ...item, id: 'pin-' + item.id, pinned: true, folder: item.type === 'folder' };
      items.push(source);
      fileItems.set(key, source);
    }
    for (const file of editorChanges) {
      const key = keyFor(file.filepath);
      const existing = fileItems.get(key);
      const source = existing || { id: 'change-' + key, name: file.filename, path: file.filepath };
      source.reviewPath = file.filepath;
      source.added = file.linesAdded ?? (file.diffLines?.length ? file.diffLines.filter(line => line.type === 'added').length : undefined);
      source.removed = file.linesRemoved ?? (file.diffLines?.length ? file.diffLines.filter(line => line.type === 'removed').length : undefined);
      if (!existing) items.push(source);
    }
    return items;
  }, [media, pins, editorChanges, workspacePath]);

  const latestAgent = agents.at(-1);
  const recentAgents = latestAgent?.runScope ? agents.filter(agent => agent.runScope === latestAgent.runScope)
    : latestAgent?.turnScope ? agents.filter(agent => agent.turnScope === latestAgent.turnScope) : agents;
  const showSwarm = recentAgents.some(agent => isNestedAgent(agent, agents));
  const flatAgents = showSwarm ? [] : agents.filter(agent => !isNestedAgent(agent, agents));
  const currentAgents = flatAgents.filter(agent => !previousStatuses.has(String(agent.status || '').toLowerCase()));
  const previousAgents = flatAgents.filter(agent => previousStatuses.has(String(agent.status || '').toLowerCase())).reverse();
  const running = currentAgents.filter(agent => runningStatuses.has(String(agent.status || '').toLowerCase())).length;
  const failed = previousAgents.filter(agent => ['failed', 'error'].includes(String(agent.status || '').toLowerCase())).length;
  const steps = (plan?.steps || []).filter(step => step?.name && typeof step.status === 'string');
  const completeSteps = steps.filter(step => step.status === 'done').length;
  const totals = summary?.files.reduce((sum, file) => ({
    added: sum.added + (file.linesAdded || 0), removed: sum.removed + (file.linesRemoved || 0),
  }), { added: 0, removed: 0 });
  const hasTextStats = summary?.files.some(file => file.linesAdded !== undefined || file.linesRemoved !== undefined);
  const showGitActions = preferences.gitWorkspaceEnabled;
  const openSideAgents = () => { addWorkspaceTab(owner, 'subagents'); onClose(); };
  const openSource = async (event: MouseEvent<HTMLButtonElement>, item: Source) => {
    setSourceError('');
    if (item.reviewPath) {
      openWorkspaceReview(owner, { scope: 'chat', selected: item.reviewPath, filter: '', showTree: true, hideViewed: false });
      onClose();
      return;
    }
    if (item.image) {
      openChatImage(event.currentTarget, item.image, sources.flatMap(source => source.image ? [source.image] : []));
      setOpenMenu(null);
      return;
    }
    const path = resolveTouchPath(item.path, workspacePath || '') || resolveTouchPath(item.originalPath, workspacePath || '');
    if (!path) { setSourceError('Could not locate ' + item.name + '.'); return; }
    if (item.folder) {
      if (!await openLocalFilePath(path)) setSourceError('Could not open ' + item.name + '.');
      return;
    }
    addWorkspaceTab(owner, 'files', { path, root: workspaceRootForFile(rootState.roots, path), title: item.name });
    onClose();
  };
  const agentRow = (agent: WorkPanelAgent) => (
    <AgentRow key={agent.id || agent.subAgentChatId || agent.name} agent={agent}
      selected={Boolean(activeAgentId && agentIdentitiesOverlap(agent, activeAgentId))}
      onSelect={onSelectAgent} />
  );

  const offset = attached ? -8 : 8;
  return <motion.aside ref={cardRef} id={panelId} className="eterx-work-panel" aria-label="Work Panel"
    aria-hidden={!present || undefined} inert={!present || undefined}
    initial={reducedMotion ? false : { opacity: 0, y: offset }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: reducedMotion ? 0 : offset }}
    transition={{ duration: reducedMotion ? 0 : present ? 0.32 : 0.24, ease: [0.22, 0.8, 0.3, 1] }}
    data-placement={attached ? 'header' : 'center'} data-resizing={resizing}
    style={{ inlineSize: width, insetInlineEnd: bounds.right, ...(attached ? { insetBlockStart: bounds.top, maxBlockSize: `calc(100% - ${bounds.top + 12}px)` } : {}) }}
    onKeyDown={event => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      const anchor = projectOpen ? projectAnchor : sourcesOpen ? sourcesAnchor : agentMenuOpen ? agentAnchor : null;
      if (anchor) {
        setOpenMenu(null);
        anchor.current?.querySelector('button')?.focus({ preventScroll: true });
      } else onClose(true);
    }}>
    {!attached && <div className="eterx-work-panel-resize" role="separator" tabIndex={canResize ? 0 : -1}
      aria-label="Resize Work Panel" aria-controls={panelId} aria-orientation="vertical"
      aria-valuemin={bounds.minimum} aria-valuemax={bounds.maximum} aria-valuenow={width} aria-disabled={!canResize}
      title="Drag to resize. Double-click to reset."
      onPointerDown={event => {
        const panel = cardRef.current;
        if (!canResize || event.button !== 0 || !panel || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        const startWidth = panel.offsetWidth;
        const scale = panel.getBoundingClientRect().width / startWidth || 1;
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, scale, previousWidth: requestedWidth };
        setResizing(true);
      }}
      onPointerMove={event => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        const delta = (active.startX - event.clientX) / active.scale;
        if (active.nextWidth === undefined && Math.abs(delta) < 1) return;
        active.nextWidth = clampWidth(active.startWidth + delta);
        setRequestedWidth(active.nextWidth);
      }}
      onPointerUp={event => finishResize(event.pointerId)}
      onPointerCancel={event => finishResize(event.pointerId, true)}
      onLostPointerCapture={event => finishResize(event.pointerId)}
      onDoubleClick={() => { if (canResize) rememberWidth(defaultPanelWidth); }}
      onKeyDown={event => {
        const active = drag.current;
        if (event.key === 'Escape' && active) {
          event.preventDefault(); event.stopPropagation();
          finishResize(active.pointerId, true);
          if (event.currentTarget.hasPointerCapture(active.pointerId)) event.currentTarget.releasePointerCapture(active.pointerId);
        } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && !active) {
          event.preventDefault(); event.stopPropagation();
          const next = event.key === 'Home' ? bounds.minimum : event.key === 'End' ? bounds.maximum
            : clampWidth(width + (event.key === 'ArrowLeft' ? 16 : -16));
          rememberWidth(next);
        }
      }}><GripVertical size={14} aria-hidden="true" /></div>}
    <div className="eterx-work-panel-workspace">
      <div className="eterx-work-panel-toolbar">
        <div ref={projectAnchor} className="eterx-work-panel-workspace-picker">
          <button type="button" className="eterx-work-panel-row" disabled={workspaceLocked} title={workspacePath || 'Choose a workspace for this chat'}
            aria-label={`Workspace ${workspaceName}`} aria-haspopup="dialog" aria-expanded={projectOpen}
            onClick={() => { setProjectError(''); setOpenMenu(projectOpen ? null : 'project'); }}>
            <span className="eterx-work-panel-row-icon"><FolderClosed size={17} strokeWidth={1.8} aria-hidden="true" /></span>
            <span className="eterx-work-panel-label">{workspaceName}</span>
            <ChevronDown size={14} data-open={projectOpen} aria-hidden="true" />
          </button>
          {projectOpen && <ProjectFolderPicker workspacePath={workspacePath} workspaceName={workspaceName} locked={workspaceLocked}
            onSelect={onSelectWorkspace} onBrowse={() => void browse()} onClose={() => setOpenMenu(null)} portalAnchorRef={projectAnchor} menuRef={projectMenu} />}
        </div>
        <button type="button" className="eterx-work-panel-icon-button" aria-label="Close Work Panel" title="Close Work Panel" onClick={() => onClose(true)}><X size={16} aria-hidden="true" /></button>
      </div>
      {projectError && <p role="status" className="eterx-work-panel-notice">{projectError}</p>}
    </div>

    <div className="eterx-work-panel-body" data-scroll-edges={panelScroll.edges}>
      <div ref={panelScroll.scrollRef} className="eterx-work-panel-scroll" onScroll={event => {
        panelScroll.sync();
        if (!sourcesOpen || !sourcesAnchor.current) return;
        const anchor = sourcesAnchor.current.getBoundingClientRect();
        const visible = event.currentTarget.getBoundingClientRect();
        if (anchor.top < visible.top || anchor.bottom > visible.bottom) setOpenMenu(null);
      }}>
        <div ref={panelScroll.contentRef}>
          <section className="eterx-work-panel-section" aria-label="Sources">
            <div ref={sourcesAnchor}>
              <button type="button" className="eterx-work-panel-row" aria-haspopup="dialog" aria-expanded={sourcesOpen} aria-controls={sourcesOpen ? sourcesId : undefined}
                onClick={() => { setSourceError(''); setOpenMenu(sourcesOpen ? null : 'sources'); }}>
                <Files size={16} aria-hidden="true" />
                <span className="eterx-work-panel-label">Sources</span>
                {sources.length > 0 && <span className="eterx-work-panel-meta">{sources.length}</span>}
                <ChevronDown size={14} data-open={sourcesOpen} aria-hidden="true" />
              </button>
            </div>
            {sourcesOpen && <AdaptiveMenu id={sourcesId} role="dialog" aria-label="Sources" className="eterx-work-panel-sources-menu"
              portalAnchorRef={sourcesAnchor} menuRef={sourcesMenu} preferredSide="bottom" allowFlip={false} heightLimit={360} matchAnchorWidth>
              <div className="eterx-work-panel-body" data-scroll-edges={sourceScroll.edges}>
                <div ref={sourceScroll.scrollRef} className="eterx-work-panel-scroll" data-menu-scroll-region
                  tabIndex={sourceScroll.edges === 'none' ? undefined : 0} onScroll={sourceScroll.sync}>
                  <div ref={sourceScroll.contentRef} className="eterx-work-panel-sources-list">
                    {mediaError && <p role="status" className="eterx-work-panel-notice">{mediaError} <button type="button" onClick={retryMedia}>Retry</button></p>}
                    {sourceError && <p role="status" className="eterx-work-panel-notice">{sourceError}</p>}
                    {sources.map(item => <button key={item.id} type="button" className="eterx-work-panel-row" title={item.path}
                      aria-label={`${item.reviewPath ? 'Review' : 'Open'} ${item.path}`} onClick={event => void openSource(event, item)}>
                      {item.image ? <img src={item.image} className="eterx-work-panel-thumbnail" alt="" loading="lazy" />
                        : item.folder ? <FolderClosed size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
                      <span className="eterx-work-panel-label">{item.name}</span>
                      {item.pinned && <Pin size={12} aria-label="Pinned" />}
                      <ChangeTotals added={item.added} removed={item.removed} />
                    </button>)}
                    {!sources.length && !mediaError && <p className="eterx-work-panel-notice">No sources or file changes yet</p>}
                  </div>
                </div>
              </div>
            </AdaptiveMenu>}
          </section>

          {summary && <section className="eterx-work-panel-section" aria-label="Repository">
            <button type="button" className="eterx-work-panel-row" disabled={!showGitActions} title={summary.root} onClick={() => {
              openWorkspaceGit(owner, workspacePath || summary.root, 'branches'); onClose();
            }}><GitBranch size={16} aria-hidden="true" /><span className="eterx-work-panel-label">{summary.branch || 'Current branch'}</span>{showGitActions && <ChevronRight size={14} aria-hidden="true" />}</button>
            {showGitActions && <button type="button" className="eterx-work-panel-row" onClick={() => {
              openWorkspaceGit(owner, workspacePath || summary.root, 'changes', true); onClose();
            }}><GitCommitHorizontal size={16} aria-hidden="true" /><span className="eterx-work-panel-label">Commit</span><ChevronRight size={14} aria-hidden="true" /></button>}
            <button type="button" className="eterx-work-panel-row" onClick={() => {
              openWorkspaceReview(owner, { scope: 'working', selected: '', filter: '', showTree: true, hideViewed: false }); onClose();
            }}><FileDiff size={16} aria-hidden="true" /><span className="eterx-work-panel-label">Changes</span>
              {summary.files.length > 0 && <span className="eterx-work-panel-meta">{summary.files.length}{summary.truncated ? '+' : ''}</span>}
              {(hasTextStats || !summary.files.length) && <ChangeTotals added={totals?.added} removed={totals?.removed} />}
            </button>
          </section>}

          <WorkPanelDevelopment owner={owner} chatId={chatId} onOpen={onClose} />

          {plan && (steps.length > 0 || plan.document?.trim()) && <section className="eterx-work-panel-section" aria-label="Task Plan">
            <button type="button" className="eterx-work-panel-row" title={plan.goal} aria-expanded={planOpen} aria-controls={planOpen ? plansId : undefined} onClick={() => setPlanOpen(value => !value)}>
              <ListChecks size={16} aria-hidden="true" /><span className="eterx-work-panel-label">{plan.status === 'proposed' ? 'Proposed plan' : 'Task plan'}</span>
              {steps.length > 0 && <span className="eterx-work-panel-meta">{plan.status === 'proposed' ? `${steps.length} steps` : `${completeSteps}/${steps.length} done`}</span>}
              <ChevronDown size={14} data-open={planOpen} aria-hidden="true" />
            </button>
            <ActivityDisclosure id={plansId} open={planOpen}>
              <ul className="eterx-work-panel-plan">
                {steps.map(step => {
                  const active = planRunning && step.status === 'in_progress';
                  const Icon = step.status === 'done' ? Check : step.status === 'skipped' ? CircleSlash
                    : step.status === 'failed' ? CircleAlert : step.status === 'blocked' ? CircleDashed : active ? Loader2 : Circle;
                  return <li key={step.id || step.step} className="eterx-work-panel-row" data-status={step.status}
                    aria-current={active ? 'step' : undefined} aria-label={step.name + ', ' + step.status.replaceAll('_', ' ')} title={step.name}>
                    <Icon size={13} className={active ? 'motion-safe:animate-spin' : undefined} aria-hidden="true" /><span className="eterx-work-panel-label">{step.name}</span>
                  </li>;
                })}
              </ul>
              <button type="button" className="eterx-work-panel-row" onClick={() => { addWorkspaceTab(owner, 'plan', { plan, planChatId: owner }); onClose(); }}>
                <ArrowUpRight size={15} aria-hidden="true" /><span className="eterx-work-panel-label">Open full plan</span>
              </button>
            </ActivityDisclosure>
          </section>}

          {hasAgents && <section ref={agentSection} className="eterx-work-panel-section" aria-label="Sub-Agents">
            <div className="eterx-work-panel-heading">
              <Network size={15} aria-hidden="true" /><span className="eterx-work-panel-label">Sub-Agents</span>
              {!showSwarm && <><span className="eterx-work-panel-status" data-ready={running > 0}>{running} running</span>
                <div ref={agentAnchor}>
                  <button type="button" className="eterx-work-panel-icon-button" aria-label="Sub-agent options" title="Sub-agent options" aria-haspopup="dialog" aria-expanded={agentMenuOpen}
                    onClick={() => setOpenMenu(agentMenuOpen ? null : 'agents')}><MoreHorizontal size={17} aria-hidden="true" /></button>
                  {agentMenuOpen && <AdaptiveMenu portalAnchorRef={agentAnchor} menuRef={agentMenu} heightLimit={120}
                    className="eterx-composer-popout eterx-status-popout eterx-work-panel-agent-menu" role="dialog" aria-label="Sub-agent options">
                    <button type="button" className="eterx-status-menu-item" onClick={openSideAgents}><Network className="eterx-status-menu-icon" aria-hidden="true" />Open Sub-Agents panel</button>
                  </AdaptiveMenu>}
                </div>
              </>}
            </div>
            {showSwarm ? <button type="button" className="eterx-work-panel-row" onClick={openSideAgents}>
              <ArrowUpRight size={15} aria-hidden="true" /><span className="eterx-work-panel-label">Go to Swarm panel</span>
            </button> : <>
              {currentAgents.map(agentRow)}
              {previousAgents.length > 0 && <>
                <button type="button" className="eterx-work-panel-row" aria-expanded={previousOpen} aria-controls={previousOpen ? previousId : undefined} onClick={() => setPreviousOpen(value => !value)}>
                  <History size={16} aria-hidden="true" />
                  <span className="eterx-work-panel-label">Previous agents</span>
                  {failed > 0 && <span className="eterx-work-panel-failed">{failed} failed</span>}
                  <span className="eterx-work-panel-meta">{previousAgents.length}</span><ChevronDown size={14} data-open={previousOpen} aria-hidden="true" />
                </button>
                <ActivityDisclosure id={previousId} open={previousOpen}>{previousOpen && previousAgents.map(agentRow)}</ActivityDisclosure>
              </>}
            </>}
          </section>}
        </div>
      </div>
    </div>

    {context && context.contextWindow > 0 && <div className="eterx-work-panel-context" title={`${context.usedTokens.toLocaleString()} of ${context.contextWindow.toLocaleString()} tokens used`}>
      <Gauge size={14} aria-hidden="true" /><span>Context</span>
      <meter min={0} max={context.contextWindow} value={Math.min(context.usedTokens, context.contextWindow)} aria-label={context.isEstimated ? 'Estimated context usage' : 'Context usage'} />
      <span>{tokenCount.format(context.usedTokens)} / {tokenCount.format(context.contextWindow)}</span>
    </div>}
  </motion.aside>;
}
