'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpLeft, Folder, Loader2, Search } from 'lucide-react';
import { MessagesCircle } from './workspace-icons';
import { PremiumEdit } from '../ui/premium-icons';
import { ChatFeed } from './chat-feed';
import { ChatInput, type ChatInputProps } from '../layout/chat-input';
import type { MainAgentMode, MainAgentThinkingLevel } from '../../lib/agent/model-routing';
import { updateWorkspaceTab, type WorkspaceTab } from '../../lib/side-workspace-store';
import { FilePanelReveal } from '../../contexts/FilePanelContext';
import { Tooltip } from '../ui/tooltip';
import { readChatContextUsage } from '../../lib/chat-context-usage';
import { summarizeChatUsage } from '../../lib/chat-command-state';
import { selectMainContextLogs, traceBelongsToUsageChat } from '../../lib/chat-usage-scope';
import { MODEL_PROVIDER_MODE, parseModelEntryKey } from '../../lib/agent/model-selector-store';
import { FOLDER_STORAGE_READY_EVENT } from '../../lib/client-storage';
import { useLocalDictation } from '../../lib/use-local-dictation';
import { useLiveChat, type LiveChatLedger } from '../../lib/live-chat-ledger';
import { normalizeChatAgentSelection } from '../../lib/chat-agent-selection';
import { isFeedTurnBoundary } from '../../lib/chat-feed-lifecycle';
import { useChatMedia } from './chat-media';
import type { ProxyAgentControlState } from './proxy-agent-controls';
import { WorkspaceProxyControls, type WorkspaceProxyRequest } from './workspace-proxy-controls';
import type { ProxyManagerSnapshot } from '../../lib/proxy-chat-client';
export type SideChatSession = { id: string; title: string; traceLogs: any[]; workspacePath?: string | null; modelSelection?: string; updatedAt: number; isFavorite?: boolean };
export type SideChatSettings = { modelSelection: string; selectedAgent: { agentId: string | null; agentName: string; chatMode?: boolean }; thinkingLevel: MainAgentThinkingLevel; agentMode: MainAgentMode; workspacePath: string | null; runLocation: 'local' | 'sandbox' | 'worktree' };
export type SideChatDraft = { text: string; attachments: any[]; pinnedItems: any[]; settings: SideChatSettings };
type SideChatControls = Pick<ChatInputProps,
  'queuedFollowUps' | 'onSendQueuedFollowUp' | 'onRemoveQueuedFollowUp' |
  'onOpenAgents' | 'onOpenProjects' | 'onOpenAgentBuilder' | 'onOpenPet' | 'onOpenSettingsTab' |
  'onPlanModeChange' | 'onSwarmModeChange' | 'onCompact' | 'compacting' |
  'isNetworkPaused' | 'onNetworkPausedAction' | 'proxyEnabled' | 'onProxyToggle' |
  'liveState' | 'hasBackgroundLiveSession' | 'liveError' | 'onLiveStop' | 'onLiveSendText' |
  'liveOutputText' | 'liveInputText' | 'liveMicVolume' | 'liveModelVolume' | 'liveActiveTool' |
  'isMicMuted' | 'onToggleMicMute' | 'isSpeakerMuted' | 'onToggleSpeakerMute'
>;
export type SideChatActions = {
  hydrate: (id: string) => Promise<void>;
  draft: (id: string) => SideChatDraft;
  saveDraft: (id: string, draft: SideChatDraft, persist?: boolean) => void;
  controls: (id: string, settings: SideChatSettings) => SideChatControls;
  proxyControls: (id: string, settings: SideChatSettings) => ProxyAgentControlState;
  loadProxy: (id: string) => Promise<ProxyManagerSnapshot>;
  syncProxyModel: (id: string) => Promise<void>;
  sendProxy: (id: string, request: WorkspaceProxyRequest, onProgress: (event: { text?: string }) => void) => Promise<void>;
  refreshProxyRun: (id: string) => Promise<void>;
  workspace: (id: string, path: string | null) => void;
  openMain: (id: string) => void;
  send: (id: string, text: string, attachments: any[], settings: SideChatSettings, pinnedItems: any[]) => Promise<boolean | void>;
  stop: (id: string) => Promise<boolean>;
  answer: (id: string, timestamp: number, answer: string, responseKey?: string) => void;
  read: (id: string) => void;
  startLive?: (id: string, settings: SideChatSettings) => void;
};
const emptyLogs: any[] = [];
const ignore = () => {};

const Conversation = memo(function Conversation({ id, tabId, workspaceOwner, chat, running, actions }: { id: string; tabId: string; workspaceOwner: string; chat?: SideChatSession; running: boolean; actions: SideChatActions }) {
  const actionsRef = useRef(actions); actionsRef.current = actions;
  const initial = useRef<SideChatDraft | null>(null);
  if (!initial.current) initial.current = actions.draft(id);
  const latest = useRef(initial.current);
  const edited = useRef(false);
  const alive = useRef(true);
  const [text, setTextState] = useState(initial.current.text);
  const textRef = useRef(initial.current.text);
  const [textRevision, setTextRevision] = useState(0);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [attachments, setAttachmentsState] = useState<any[]>(initial.current.attachments);
  const [pinnedItems, setPinnedItemsState] = useState<any[]>(initial.current.pinnedItems);
  const [settings, setSettingsState] = useState(initial.current.settings);
  const saveDraft = useCallback((draft: SideChatDraft, persist = true) => {
    edited.current = true;
    latest.current = draft;
    actionsRef.current.saveDraft(id, draft, persist);
  }, [id]);
  const setText = useCallback((value: string | ((previous: string) => string)) => {
    if (draftTimer.current !== null) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    const current = alive.current ? latest.current : actionsRef.current.draft(id);
    const next = typeof value === 'function' ? value(current.text) : value;
    textRef.current = next;
    saveDraft({ ...current, text: next });
    if (alive.current) {
      setTextState(next);
      setTextRevision(revision => revision + 1);
    }
  }, [id, saveDraft]);
  const setAttachments = useCallback((value: any[] | ((previous: any[]) => any[])) => {
    const current = alive.current ? latest.current : actionsRef.current.draft(id);
    const next = typeof value === 'function' ? value(current.attachments) : value;
    saveDraft({ ...current, attachments: next });
    if (alive.current) setAttachmentsState(next);
  }, [id, saveDraft]);
  const setPinnedItems = useCallback((value: any[] | ((previous: any[]) => any[])) => {
    const current = alive.current ? latest.current : actionsRef.current.draft(id);
    const next = typeof value === 'function' ? value(current.pinnedItems) : value;
    saveDraft({ ...current, pinnedItems: next });
    if (alive.current) setPinnedItemsState(next);
  }, [id, saveDraft]);
  const updateSettings = useCallback((patch: Partial<SideChatSettings>) => {
    const current = alive.current ? latest.current : actionsRef.current.draft(id);
    const next = { ...current.settings, ...patch };
    saveDraft({ ...current, settings: next });
    if (alive.current) setSettingsState(next);
  }, [id, saveDraft]);
  const restoreDraft = useCallback(() => {
    if (!alive.current || edited.current) return;
    const draft = actionsRef.current.draft(id);
    latest.current = draft;
    textRef.current = draft.text;
    setTextState(draft.text);
    setTextRevision(revision => revision + 1);
    setAttachmentsState(draft.attachments);
    setPinnedItemsState(draft.pinnedItems);
    setSettingsState(draft.settings);
  }, [id]);
  const [loading, setLoading] = useState(Boolean(chat));
  const [error, setError] = useState('');
  const dictation = useLocalDictation({ getText: () => textRef.current, onText: setText, onError: setError });
  const [sending, setSending] = useState(false);
  const [showBottom, setShowBottom] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const submitLock = useRef(false);
  const submitSequence = useRef(0);
  const updateTextDraft = useCallback((value: string) => {
    dictation.reset(value);
    textRef.current = value;
    // Publish the owner immediately for Send/navigation, without rerendering
    // the main chat or serializing every draft on each keystroke.
    saveDraft({ ...latest.current, text: value }, false);
    if (draftTimer.current !== null) clearTimeout(draftTimer.current);
    // Keep keystrokes local to the textarea; the feed and context meter only
    // need a draft snapshot after typing pauses. Send reads the ref immediately.
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null;
      setTextState(textRef.current);
      actionsRef.current.saveDraft(id, latest.current);
    }, 180);
  }, [id, dictation.reset, saveDraft]);
  const answerQuestion = useCallback((timestamp: number, answer: string, responseKey?: string) => {
    actionsRef.current.answer(id, timestamp, answer, responseKey);
  }, [id]);
  useLayoutEffect(() => {
    const surface = pane.current, feed = surface?.querySelector<HTMLElement>('.eterx-chat-feed-scroll');
    if (!surface || !feed) return;
    const sync = () => surface.style.setProperty('--ws-chat-scrollbar-space', Math.max(0, feed.offsetWidth - feed.clientWidth) + 'px');
    const observer = new ResizeObserver(sync); observer.observe(feed); sync();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    alive.current = true;
    if (chat) {
      void actionsRef.current.hydrate(id).then(restoreDraft).catch(error => { if (alive.current) setError(String(error.message || error)); }).finally(() => { if (alive.current) setLoading(false); });
      actionsRef.current.read(id);
    }
    return () => {
      alive.current = false;
      if (draftTimer.current !== null) {
        clearTimeout(draftTimer.current);
        draftTimer.current = null;
        actionsRef.current.saveDraft(id, latest.current);
      }
    };
  }, [id, restoreDraft]);
  useEffect(() => { if (running) { submitLock.current = false; setSending(false); } }, [running]);
  const submit = () => {
    const current = { ...latest.current, text: textRef.current };
    if (loading || submitLock.current || (!current.text.trim() && !current.attachments.length)) return;
    dictation.stop();
    const sequence = ++submitSequence.current;
    submitLock.current = true; setSending(true); setError(''); setText(''); setAttachments([]);
    void actionsRef.current.send(id, current.text, current.attachments, current.settings, current.pinnedItems).then(accepted => {
      if (accepted === false) throw new Error('Message was not accepted. Your draft has been restored.');
    }).catch(error => {
      setText(value => value || current.text);
      setAttachments(value => value.length ? value : current.attachments);
      if (alive.current) setError(String(error.message || error));
    }).finally(() => { if (sequence === submitSequence.current) { submitLock.current = false; if (alive.current) setSending(false); } });
  };
  const [contextSettingsRevision, setContextSettingsRevision] = useState(0);
  useEffect(() => {
    const refresh = () => { restoreDraft(); setContextSettingsRevision(revision => revision + 1); };
    const events = ['focus', 'eterx-settings-updated', FOLDER_STORAGE_READY_EVENT, 'eterx-folder-storage-updated'];
    events.forEach(event => window.addEventListener(event, refresh));
    return () => events.forEach(event => window.removeEventListener(event, refresh));
  }, [restoreDraft]);
  const ownedLogs = useMemo(() => (chat?.traceLogs || emptyLogs).filter(log =>
    traceBelongsToUsageChat(log, id)
  ), [chat?.traceLogs, id]);
  const controls = actions.controls(id, settings);
  const proxyControls = actions.proxyControls(id, settings);
  const [proxyConnectionError, setProxyConnectionError] = useState('');
  const [proxyConnectionRevision, setProxyConnectionRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let connecting = false;
    const connect = async () => {
      if (cancelled || connecting) return;
      connecting = true;
      try {
        const snapshot = await actionsRef.current.loadProxy(id);
        if (cancelled) return;
        await actionsRef.current.syncProxyModel(id);
        if (cancelled) return;
        if (snapshot.context?.run?.runId || snapshot.context?.run?.status === 'running') {
          await actionsRef.current.refreshProxyRun(id);
        }
        if (!cancelled) setProxyConnectionError('');
      } catch (failure) {
        if (!cancelled) setProxyConnectionError(failure instanceof Error ? failure.message : 'Could not connect to Proxy.');
      } finally { connecting = false; }
    };
    const refresh = () => { void connect(); };
    const events = ['focus', 'eterx-settings-updated', FOLDER_STORAGE_READY_EVENT];
    events.forEach(event => window.addEventListener(event, refresh));
    refresh();
    return () => { cancelled = true; events.forEach(event => window.removeEventListener(event, refresh)); };
  }, [id, settings.modelSelection, proxyConnectionRevision, proxyControls.enabled]);
  const taskTracker = useMemo(() => {
    for (let index = ownedLogs.length - 1; index >= 0; index--) {
      const log = ownedLogs[index];
      if (log?.type === 'task_plan' && !log.subAgentId && !log.subAgentChatId && !log.auxiliaryRuntime) {
        return { ...log, steps: Array.isArray(log.steps) ? log.steps : [] };
      }
      if (isFeedTurnBoundary(log)) break;
    }
    return null;
  }, [ownedLogs]);
  const attachmentRevision = useMemo(() => [...ownedLogs, ...(controls.queuedFollowUps || [])].flatMap(log => [
    ...(Array.isArray(log.attachments) ? log.attachments.map((item: any) => `${item.id || ''}:${item.localPath || item.path || ''}`) : []),
    ...((log.toolName || log.tool || log.name) === 'image_generator' && (log.result || log.output)
      ? [`image:${log.id || log.toolCallId || ''}:${JSON.stringify(log.result || log.output)}`] : []),
  ]).join('|'), [ownedLogs, controls.queuedFollowUps]);
  const { items: chatMedia } = useChatMedia(chat ? id : null, attachmentRevision, false);
  const chatUsage = useMemo(() => summarizeChatUsage(ownedLogs), [ownedLogs]);
  const contextUsage = useMemo(() => {
    if (!ownedLogs.length) return null;
    return readChatContextUsage({
      logs: selectMainContextLogs(ownedLogs, id),
      chatId: id,
      draft: text,
      selectedModel: parseModelEntryKey(settings.modelSelection),
      running,
    });
  }, [ownedLogs, id, running, settings.modelSelection, text, contextSettingsRevision]);
  const scrollBottom = () => pane.current?.querySelector('.eterx-chat-feed-scroll')?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'smooth' });
  const selectWorkspace = (workspacePath: string | null) => {
    // A native picker may finish after this side conversation has unmounted.
    updateSettings({ workspacePath });
    actionsRef.current.workspace(id, workspacePath);
  };
  const startLive = () => {
    dictation.stop();
    if (actionsRef.current.startLive) actionsRef.current.startLive(id, latest.current.settings);
    else actionsRef.current.openMain(id);
  };
  return <FilePanelReveal value={() => actions.openMain(id)}><div className="eterx-conversation-layout eterx-workspace-side-layout">
    {proxyControls.enabled && <WorkspaceProxyControls key={id} chatId={id} controls={proxyControls} load={() => actionsRef.current.loadProxy(id)} send={(request, onProgress) => actionsRef.current.sendProxy(id, request, onProgress)} refreshRun={() => actionsRef.current.refreshProxyRun(id)} />}
    <div ref={pane} className="eterx-workspace-side-conversation eterx-conversation-pane">
    {loading && <div className="eterx-workspace-chat-loading"><Loader2 size={15} className="animate-spin" /> Loading conversation…</div>}
    {proxyConnectionError && <div className="eterx-workspace-inline-error" role="alert">{proxyConnectionError}<button onClick={() => setProxyConnectionRevision(revision => revision + 1)}>Retry Proxy connection</button></div>}
    {error && <div className="eterx-workspace-inline-error" role="alert">{error}{loading === false && chat && !chat.traceLogs.length && <button onClick={() => { setError(''); setLoading(true); void actions.hydrate(id).then(restoreDraft).catch(error => setError(String(error))).finally(() => setLoading(false)); }}>Retry</button>}</div>}
    <ChatFeed workspaceOwner={workspaceOwner} scrollContainerId={`side-chat-${tabId}`} traceLogs={ownedLogs} chatId={id} isThinking={running || sending} messagesEndRef={end} setSidebarOpen={ignore} sidebarOpen={false} handleScroll={event => { const node = event.currentTarget; setShowBottom(node.scrollHeight - node.scrollTop - node.clientHeight > 100); }} showScrollBottom={false} isCompressed workspacePath={settings.workspacePath} onEditUserMessage={setText} onAnswerAskUser={answerQuestion} media={chatMedia} liveState={controls.liveState} />
    <ChatInput
      {...controls}
      inputValue={text}
      inputValueRevision={textRevision}
      onInputValueChange={updateTextDraft}
      setInputValue={setText}
      isThinking={running || sending}
      canStop={running}
      isRecording={dictation.isRecording}
      dictationPhase={dictation.phase}
      toggleSpeech={() => void dictation.toggle()}
      showVoiceControls
      showComposerControls
      allowModelSelectionWhileThinking
      contextUsage={contextUsage}
      chatUsage={chatUsage}
      taskTracker={taskTracker}
      chatTitle={chat?.title || 'New side chat'}
      onLiveStart={startLive}
      handleSend={submit}
      handleSteer={submit}
      handleStop={() => actions.stop(id)}
      attachments={attachments}
      setAttachments={setAttachments}
      pinnedItems={pinnedItems}
      setPinnedItems={setPinnedItems}
      chatMedia={chatMedia}
      greeting=""
      traceLogsLength={Math.max(1, ownedLogs.length)}
      activeChatId={id}
      isCompressed
      modelSelectionScope="surface"
      chatModelSelection={settings.modelSelection}
      onModelSelectionChange={modelSelection => {
        const entry = parseModelEntryKey(modelSelection);
        updateSettings({ modelSelection, agentMode: entry ? MODEL_PROVIDER_MODE[entry.provider] : latest.current.settings.agentMode });
      }}
      selectedAgent={settings.selectedAgent.agentId}
      selectedAgentName={settings.selectedAgent.agentName}
      chatMode={settings.selectedAgent.chatMode}
      onAgentChange={(agentId, agentName, chatMode) => updateSettings({ selectedAgent: normalizeChatAgentSelection({ agentId, agentName, chatMode }) })}
      thinkingLevel={settings.thinkingLevel}
      onThinkingLevelChange={thinkingLevel => updateSettings({ thinkingLevel })}
      agentMode={settings.agentMode}
      onModeChange={agentMode => updateSettings({ agentMode })}
      workspacePath={settings.workspacePath}
      workspaceOwnerId={id}
      onWorkspacePathChange={selectWorkspace}
      runLocation={settings.runLocation}
      onRunLocationChange={runLocation => updateSettings({ runLocation })}
      onProxyToggle={async () => {
        try { await controls.onProxyToggle?.(); }
        catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)); }
        finally { if (alive.current) setContextSettingsRevision(revision => revision + 1); }
      }}
      showScrollBottom={showBottom}
      onScrollToBottom={scrollBottom}
    />
  </div></div></FilePanelReveal>;
});

export function WorkspaceSideChat({ owner, tab, chats, liveChatLedger, mainChatId, runningChats, actions }: { owner: string; tab: WorkspaceTab; chats: SideChatSession[]; liveChatLedger?: LiveChatLedger; mainChatId: string | null; runningChats: Set<string>; actions: SideChatActions }) {
  const [search, setSearch] = useState('');
  const history = tab.chatHistory || (tab.chatId ? ['', tab.chatId] : ['']);
  const position = tab.chatPosition ?? history.length - 1;
  const liveChat = useLiveChat(liveChatLedger, tab.chatId || '');
  const current = liveChatLedger ? liveChat : chats.find(chat => chat.id === tab.chatId);
  const selected = tab.chatId && tab.chatId !== mainChatId ? tab.chatId : null;
  const select = (id: string) => {
    const nextHistory = [...history.slice(0, position + 1), id];
    updateWorkspaceTab(owner, tab.id, { chatId: id || undefined, title: id ? chats.find(item => item.id === id)?.title || 'New side chat' : 'Side chat', chatHistory: nextHistory, chatPosition: nextHistory.length - 1 });
  };
  const navigate = (offset: number) => {
    const next = position + offset;
    if (next < 0 || next >= history.length) return;
    const id = history[next];
    updateWorkspaceTab(owner, tab.id, { chatId: id || undefined, title: id ? chats.find(chat => chat.id === id)?.title || 'New side chat' : 'Side chat', chatHistory: history, chatPosition: next });
  };
  return <div className="eterx-workspace-side-chat">
    <div className="eterx-workspace-chat-navigation">
      <button aria-label="Back in side chat" disabled={position <= 0} onClick={() => navigate(-1)}><ArrowLeft size={16} /></button>
      <button aria-label="Forward in side chat" disabled={position >= history.length - 1} onClick={() => navigate(1)}><ArrowRight size={16} /></button>
      <button className="eterx-workspace-chat-title" onClick={() => selected && select('')}><MessagesCircle size={15} /><span>{selected ? current?.title || 'New side chat' : 'Conversations'}</span>{selected && runningChats.has(selected) && <Loader2 size={14} className="animate-spin" />}</button>
      <Tooltip text="New side chat"><button aria-label="New side chat" onClick={() => select(crypto.randomUUID())}><PremiumEdit className="w-4 h-4 text-current" strokeWidth={1.8} /></button></Tooltip>
      {selected && current && <Tooltip text="Open in main chat"><button aria-label="Open conversation in main chat" onClick={() => actions.openMain(selected)}><ArrowUpLeft size={17} /></button></Tooltip>}
    </div>
    {selected ? <Conversation key={selected} id={selected} tabId={tab.id} workspaceOwner={selected} chat={current} running={runningChats.has(selected)} actions={actions} /> : <div className="eterx-workspace-chat-picker">
      <div className="eterx-workspace-search"><Search size={16} /><input aria-label="Search conversations" placeholder="Find a conversation…" value={search} onChange={event => setSearch(event.target.value)} /></div>
      <div className="eterx-workspace-chat-list eterx-scrollbar">{chats.filter(chat => chat.id !== mainChatId && chat.title.toLowerCase().includes(search.toLowerCase())).map(chat => <button key={chat.id} onClick={() => select(chat.id)} className="eterx-workspace-chat-row"><MessagesCircle size={17} /><span><strong>{chat.title}</strong></span>{chat.workspacePath && <span className="eterx-workspace-chat-folder" title={chat.workspacePath}><Folder size={12} /><span>{chat.workspacePath.split(/[\\/]/).filter(Boolean).pop()}</span></span>}{runningChats.has(chat.id) ? <Loader2 size={15} className="animate-spin" /> : <span className="eterx-workspace-chat-time">{new Date(chat.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}</button>)}{!chats.some(chat => chat.id !== mainChatId && chat.title.toLowerCase().includes(search.toLowerCase())) && <div className="eterx-workspace-empty"><p>No conversations found.</p><button onClick={() => select(crypto.randomUUID())}>Start a side chat</button></div>}</div>
    </div>}
  </div>;
}
