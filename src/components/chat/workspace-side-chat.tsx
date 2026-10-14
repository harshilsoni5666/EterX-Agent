'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpLeft, Folder, Loader2, Search } from 'lucide-react';
import { MessagesCircle } from './workspace-icons';
import { PremiumEdit } from '../ui/premium-icons';
import { ChatFeed } from './chat-feed';
import { ChatInput } from '../layout/chat-input';
import type { MainAgentMode, MainAgentThinkingLevel } from '../../lib/agent/model-routing';
import { updateWorkspaceTab, type WorkspaceTab } from '../../lib/side-workspace-store';
import { FilePanelReveal } from '../../contexts/FilePanelContext';
import { Tooltip } from '../ui/tooltip';
import { readChatContextUsage } from '../../lib/chat-context-usage';
import { summarizeChatUsage } from '../../lib/chat-command-state';
import { selectMainContextLogs, traceBelongsToUsageChat } from '../../lib/chat-usage-scope';
import { parseModelEntryKey } from '../../lib/agent/model-selector-store';
import { FOLDER_STORAGE_READY_EVENT } from '../../lib/client-storage';
import { useLocalDictation } from '../../lib/use-local-dictation';
export type SideChatSession = { id: string; title: string; traceLogs: any[]; workspacePath?: string | null; modelSelection?: string; updatedAt: number; isFavorite?: boolean };
export type SideChatSettings = { modelSelection: string; selectedAgent: { agentId: string | null; agentName: string; chatMode?: boolean }; thinkingLevel: MainAgentThinkingLevel; agentMode: MainAgentMode; workspacePath: string | null; runLocation: 'local' | 'sandbox' | 'worktree' };
export type SideChatActions = {
  hydrate: (id: string) => Promise<void>;
  settings: (id: string) => SideChatSettings;
  workspace: (id: string, path: string | null) => void;
  openMain: (id: string) => void;
  send: (id: string, text: string, attachments: any[], settings: SideChatSettings) => Promise<boolean | void>;
  stop: (id: string) => Promise<boolean>;
  answer: (id: string, timestamp: number, answer: string, responseKey?: string) => void;
  read: (id: string) => void;
  startLive?: (id: string) => void;
};
type Draft = { text: string; attachments: any[]; settings: SideChatSettings };
const drafts = new Map<string, Draft>();
const emptyLogs: any[] = [];
const ignore = () => {};

const Conversation = memo(function Conversation({ id, tabId, workspaceOwner, chat, running, actions }: { id: string; tabId: string; workspaceOwner: string; chat?: SideChatSession; running: boolean; actions: SideChatActions }) {
  const hadSavedDraft = useRef(drafts.has(id));
  const initial = useRef(drafts.get(id) || { text: '', attachments: [], settings: actions.settings(id) });
  const [text, setTextState] = useState(initial.current.text);
  const textRef = useRef(initial.current.text);
  const [textRevision, setTextRevision] = useState(0);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setText = useCallback((value: string | ((previous: string) => string)) => {
    if (draftTimer.current !== null) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    const next = typeof value === 'function' ? value(textRef.current) : value;
    textRef.current = next;
    setTextState(next);
    setTextRevision(revision => revision + 1);
  }, []);
  const [attachments, setAttachments] = useState<any[]>(initial.current.attachments);
  const [settings, setSettings] = useState(initial.current.settings);
  const [loading, setLoading] = useState(Boolean(chat));
  const [error, setError] = useState('');
  const dictation = useLocalDictation({ getText: () => textRef.current, onText: setText, onError: setError });
  const [sending, setSending] = useState(false);
  const [showBottom, setShowBottom] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const submitLock = useRef(false);
  const submitSequence = useRef(0);
  const alive = useRef(true);
  const latest = useRef({ text, attachments, settings }); latest.current = { text: textRef.current, attachments, settings };
  const updateTextDraft = useCallback((value: string) => {
    dictation.reset(value);
    textRef.current = value;
    latest.current = { ...latest.current, text: value };
    drafts.set(id, latest.current);
    if (draftTimer.current !== null) clearTimeout(draftTimer.current);
    // Keep keystrokes local to the textarea; the feed and context meter only
    // need a draft snapshot after typing pauses. Send reads the ref immediately.
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null;
      setTextState(textRef.current);
    }, 180);
  }, [id, dictation.reset]);
  const actionsRef = useRef(actions); actionsRef.current = actions;
  useLayoutEffect(() => {
    const surface = pane.current, feed = surface?.querySelector<HTMLElement>('.eterx-chat-feed-scroll');
    if (!surface || !feed) return;
    const sync = () => surface.style.setProperty('--ws-chat-scrollbar-space', Math.max(0, feed.offsetWidth - feed.clientWidth) + 'px');
    const observer = new ResizeObserver(sync); observer.observe(feed); sync();
    return () => observer.disconnect();
  }, []);
  useEffect(() => { drafts.set(id, latest.current); }, [id, text, attachments, settings]);
  useEffect(() => {
    alive.current = true;
    if (chat) {
      void actionsRef.current.hydrate(id).catch(error => { if (alive.current) setError(String(error.message || error)); }).finally(() => { if (alive.current) setLoading(false); });
      actionsRef.current.read(id);
    }
    return () => {
      alive.current = false;
      if (draftTimer.current !== null) clearTimeout(draftTimer.current);
      drafts.set(id, { ...latest.current, text: textRef.current });
    };
  }, [id]);
  useEffect(() => { if (running) { submitLock.current = false; setSending(false); } }, [running]);
  useEffect(() => {
    if (!loading && chat && !hadSavedDraft.current) {
      // Hydration can supply project/model settings after the first render.
      // Preserve any choice the user has already made in this composer.
      hadSavedDraft.current = true;
      setSettings(current => current === initial.current.settings ? actionsRef.current.settings(id) : current);
    }
  }, [loading, chat, id]);
  const submit = () => {
    const current = { ...latest.current, text: textRef.current };
    if (loading || submitLock.current || (!current.text.trim() && !current.attachments.length)) return;
    dictation.stop();
    const sequence = ++submitSequence.current;
    submitLock.current = true; setSending(true); setError(''); setText(''); setAttachments([]);
    void actionsRef.current.send(id, current.text, current.attachments, current.settings).then(accepted => {
      if (accepted === false) throw new Error('Message was not accepted. Your draft has been restored.');
    }).catch(error => {
      const draft = drafts.get(id);
      if (!draft?.text) drafts.set(id, { ...current });
      if (alive.current) { setError(String(error.message || error)); setText(value => value || current.text); setAttachments(value => value.length ? value : current.attachments); }
    }).finally(() => { if (sequence === submitSequence.current) { submitLock.current = false; if (alive.current) setSending(false); } });
  };
  const [contextSettingsRevision, setContextSettingsRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setContextSettingsRevision(revision => revision + 1);
    const events = ['focus', 'eterx-settings-updated', FOLDER_STORAGE_READY_EVENT, 'eterx-folder-storage-updated'];
    events.forEach(event => window.addEventListener(event, refresh));
    return () => events.forEach(event => window.removeEventListener(event, refresh));
  }, []);
  const ownedLogs = useMemo(() => (chat?.traceLogs || emptyLogs).filter(log =>
    traceBelongsToUsageChat(log, id)
  ), [chat?.traceLogs, id]);
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
    const current = alive.current ? latest.current : drafts.get(id) || latest.current;
    drafts.set(id, { ...current, settings: { ...current.settings, workspacePath } });
    if (alive.current) setSettings(previous => ({ ...previous, workspacePath }));
    actionsRef.current.workspace(id, workspacePath);
  };
  return <FilePanelReveal value={() => actions.openMain(id)}><div ref={pane} className="eterx-workspace-side-conversation eterx-conversation-pane">
    {loading && <div className="eterx-workspace-chat-loading"><Loader2 size={15} className="animate-spin" /> Loading conversation…</div>}
    {error && <div className="eterx-workspace-inline-error" role="alert">{error}{loading === false && chat && !chat.traceLogs.length && <button onClick={() => { setError(''); setLoading(true); void actions.hydrate(id).catch(error => setError(String(error))).finally(() => setLoading(false)); }}>Retry</button>}</div>}
    <ChatFeed workspaceOwner={workspaceOwner} scrollContainerId={`side-chat-${tabId}`} traceLogs={chat?.traceLogs || emptyLogs} chatId={id} isThinking={running || sending} messagesEndRef={end} setSidebarOpen={ignore} sidebarOpen={false} handleScroll={event => { const node = event.currentTarget; setShowBottom(node.scrollHeight - node.scrollTop - node.clientHeight > 100); }} showScrollBottom={false} isCompressed workspacePath={settings.workspacePath} onEditUserMessage={setText} onAnswerAskUser={(timestamp, answer, responseKey) => actions.answer(id, timestamp, answer, responseKey)} />
    <ChatInput inputValue={text} inputValueRevision={textRevision} onInputValueChange={updateTextDraft} setInputValue={setText} isThinking={running || sending} canStop={running} isRecording={dictation.isRecording} dictationStatus={dictation.status} toggleSpeech={() => void dictation.toggle()} showVoiceControls contextUsage={contextUsage} chatUsage={chatUsage} chatTitle={chat?.title || 'New side chat'} onLiveStart={() => { dictation.stop(); if (actions.startLive) actions.startLive(id); else actions.openMain(id); }} handleSend={submit} handleSteer={submit} handleStop={() => actions.stop(id)} attachments={attachments} setAttachments={setAttachments} greeting="" traceLogsLength={Math.max(1, chat?.traceLogs.length || 0)} activeChatId={id} isCompressed modelSelectionScope="surface" chatModelSelection={settings.modelSelection} onModelSelectionChange={modelSelection => setSettings(previous => ({ ...previous, modelSelection }))} selectedAgent={settings.selectedAgent.agentId} selectedAgentName={settings.selectedAgent.agentName} chatMode={settings.selectedAgent.chatMode} onAgentChange={(agentId, agentName, chatMode) => setSettings(previous => ({ ...previous, selectedAgent: { agentId, agentName, chatMode } }))} thinkingLevel={settings.thinkingLevel} onThinkingLevelChange={thinkingLevel => setSettings(previous => ({ ...previous, thinkingLevel }))} agentMode={settings.agentMode} onModeChange={agentMode => setSettings(previous => ({ ...previous, agentMode }))} workspacePath={settings.workspacePath} onWorkspacePathChange={selectWorkspace} runLocation={settings.runLocation} onRunLocationChange={runLocation => setSettings(previous => ({ ...previous, runLocation }))} showScrollBottom={showBottom} onScrollToBottom={scrollBottom} />
  </div></FilePanelReveal>;
});

export function WorkspaceSideChat({ owner, tab, chats, mainChatId, runningChats, actions }: { owner: string; tab: WorkspaceTab; chats: SideChatSession[]; mainChatId: string | null; runningChats: Set<string>; actions: SideChatActions }) {
  const [search, setSearch] = useState('');
  const history = tab.chatHistory || (tab.chatId ? ['', tab.chatId] : ['']);
  const position = tab.chatPosition ?? history.length - 1;
  const current = chats.find(chat => chat.id === tab.chatId);
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
