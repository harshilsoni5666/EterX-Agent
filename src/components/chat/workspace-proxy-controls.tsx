'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Maximize2, Minimize2, Minus, Plus, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { ProxyAgentControls, type ProxyAgentControlState } from './proxy-agent-controls';
import { ProxyChatActions } from './proxy-chat-actions';
import { markdownComponents, normalizeMarkdownForRendering, rehypePlugins, replyRemarkPlugins } from './markdown-renderer';
import { localAwareUrlTransform } from './local-file-link';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';
import type { ProxyManagerSnapshot } from '../../lib/proxy-chat-client';
import { modelEntryKey } from '../../lib/agent/model-selector-store';
import { useLocalDictation } from '../../lib/use-local-dictation';

export type WorkspaceProxyRequest = { message: string; requestId: string; attachments: File[] };
type Message = ProxyManagerSnapshot['messages'][number];
type Draft = { text: string; attachments: File[]; requestId?: string };
const drafts = new Map<string, Draft>();

export function WorkspaceProxyControls({ chatId, controls, load, send, refreshRun }: {
  chatId: string;
  controls: ProxyAgentControlState;
  load: () => Promise<ProxyManagerSnapshot>;
  send: (request: WorkspaceProxyRequest, onProgress: (event: { text?: string }) => void) => Promise<void>;
  refreshRun: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => drafts.get(chatId) || { text: '', attachments: [] });
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const alive = useRef(true);
  const pending = useRef(false);
  const autoScroll = useRef(true);
  const feed = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const actions = useRef({ load, send, refreshRun });
  actions.current = { load, send, refreshRun };
  const refresh = useRef<() => Promise<void>>(async () => {});
  const observedRun = useRef('');

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const saveDraft = (next: Draft) => {
    draftRef.current = next;
    if (next.text || next.attachments.length) drafts.set(chatId, next);
    else drafts.delete(chatId);
    if (alive.current) setDraft(next);
  };
  const dictation = useLocalDictation({
    getText: () => draftRef.current.text,
    onText: text => saveDraft({ ...draftRef.current, text, requestId: undefined }),
    onError: setError,
  });
  useEffect(() => {
    if (!open) dictation.stop();
  }, [open, dictation.stop]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let reading = false;
    let readAgain = false;
    setLoading(true);
    const read = async (force = false) => {
      if (cancelled || (!force && !isAppVisible())) return;
      if (reading) { readAgain ||= force; return; }
      reading = true;
      try {
        const data = await actions.current.load();
        if (cancelled) return;
        setMessages(data.messages);
        setProcessing(data.processing);
        const savedDraft = drafts.get(chatId) || draftRef.current;
        if (savedDraft.requestId && data.messages.some(message => message.role === 'proxy' && message.requestId === savedDraft.requestId && message.delivery !== 'unavailable')) {
          // A disconnected send can finish while this tab is closed. Clear
          // only the matching draft, preserving any text edited afterwards.
          if (drafts.get(chatId)?.requestId === savedDraft.requestId) drafts.delete(chatId);
          setDraft(current => current.requestId === savedDraft.requestId ? { text: '', attachments: [] } : current);
          setError('');
        }
        const runId = String(data.context?.run?.runId || '');
        if (data.context?.run?.status === 'running' || (runId && observedRun.current !== runId)) {
          await actions.current.refreshRun();
          if (!cancelled) observedRun.current = runId;
        }
        if (!cancelled) setHistoryError('');
      } catch (failure) {
        if (!cancelled) setHistoryError(failure instanceof Error ? failure.message : 'Could not load Proxy messages.');
      } finally {
        reading = false;
        if (!cancelled) setLoading(false);
        if (readAgain && !cancelled) { readAgain = false; void read(true); }
      }
    };
    refresh.current = () => read(true);
    void read();
    const timer = window.setInterval(() => void read(), 4000);
    const stopVisibility = subscribeAppVisibility(() => void read());
    const previousFocus = document.activeElement;
    textarea.current?.focus({ preventScroll: true });
    return () => {
      cancelled = true;
      refresh.current = async () => {};
      window.clearInterval(timer);
      stopVisibility();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [chatId, open]);

  useEffect(() => {
    if (open && autoScroll.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [open, messages, progress, expanded]);
  useEffect(() => {
    const input = textarea.current;
    if (!input || !open) return;
    const resize = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(240, input.scrollHeight)}px`;
    };
    const observer = new ResizeObserver(resize);
    const window = input.closest('.eterx-proxy-chat-window');
    if (window) observer.observe(window);
    resize();
    return () => observer.disconnect();
  }, [draft.text, expanded, open]);

  const submit = async () => {
    if (pending.current || loading || processing || controls.paused || !controls.enabled || (!draft.text.trim() && !draft.attachments.length)) return;
    if (!controls.modelEntries.some(entry => modelEntryKey(entry.provider, entry.modelId) === controls.modelSelection)) {
      setError('Select a configured model for Proxy before sending this message.');
      return;
    }
    dictation.stop();
    const requestId = draftRef.current.requestId || crypto.randomUUID();
    const submitted = { ...draftRef.current, requestId };
    saveDraft(submitted);
    pending.current = true;
    setSending(true);
    setError('');
    setProgress('Working…');
    autoScroll.current = true;
    try {
      await actions.current.send({ message: submitted.text.trim(), attachments: submitted.attachments, requestId }, event => {
        if (alive.current && event.text) setProgress(event.text);
      });
      // The request belongs to this chat even if its tab was closed meanwhile.
      if (drafts.get(chatId)?.requestId === requestId) saveDraft({ text: '', attachments: [] });
      if (alive.current) await refresh.current();
    } catch (failure) {
      // Retain the request ID on retry: an interrupted response may already
      // have been accepted, and retrying must not start the same task twice.
      if (alive.current) setError(failure instanceof Error ? failure.message : 'Could not send this message.');
    } finally {
      pending.current = false;
      if (alive.current) { setSending(false); setProgress(''); }
    }
  };

  return <>
    <ProxyAgentControls paused={controls.paused} intervention={controls.intervention} modelSelection={controls.modelSelection} modelEntries={controls.modelEntries} onPauseToggle={controls.onPauseToggle} onInterventionChange={controls.onInterventionChange} chatOpen={open} onTalk={() => setOpen(value => !value)} />
    {open && <div role="dialog" aria-label="Talk with Proxy" className="eterx-proxy-chat-window eterx-workspace-proxy-chat pointer-events-auto flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[24px] border border-white/[0.12] bg-[#171717]" data-expanded={expanded} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); }
    }}>
      <div className="eterx-proxy-chat-header flex shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#191919] px-5 py-3">
        <span className="min-w-0 truncate text-[13.5px] font-semibold text-white/90">Talk with Proxy</span>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" aria-label={expanded ? 'Compact proxy chat' : 'Expand proxy chat'} onClick={() => setExpanded(value => !value)} className="eterx-workspace-proxy-icon">{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          <button type="button" aria-label="Minimize proxy chat" onClick={() => setOpen(false)} className="eterx-workspace-proxy-icon"><Minus size={15} /></button>
        </div>
      </div>
      <div ref={feed} className="eterx-proxy-message-feed flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden p-4 eterx-scrollbar" onScroll={event => { const node = event.currentTarget; autoScroll.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64; }}>
        {loading && !messages.length ? <span role="status" className="text-[12px] text-white/50">Loading Proxy messages…</span> : !messages.length && <div className="m-auto px-3 py-6 text-center"><p className="text-[14px] font-semibold text-white/75">{controls.paused ? 'Proxy is paused' : 'Coordinate the work'}</p><p className="mt-2 text-[12px] leading-relaxed text-white/45">{controls.paused ? 'Autonomous remains on. Resume Proxy to continue coordinating from the current progress.' : 'Add a goal, guide the active run, schedule what comes next, or ask for a status update.'}</p></div>}
        {messages.map(message => <div key={message.id} className={`eterx-proxy-message-bubble min-w-0 max-w-[92%] text-[12.5px] leading-relaxed [overflow-wrap:anywhere] ${message.role === 'user' ? 'self-end rounded-xl border border-white/[0.08] bg-[#242424] px-3 py-2 text-white/90 whitespace-pre-wrap' : 'self-start text-white/80'}`}>
          {message.role === 'user' ? message.text : <div className="proxy-manager-markdown min-w-0 max-w-full"><ReactMarkdown urlTransform={localAwareUrlTransform} remarkPlugins={replyRemarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>{normalizeMarkdownForRendering(message.text)}</ReactMarkdown></div>}
        </div>)}
        {(sending || processing) && <div role="status" className="flex min-w-0 items-start gap-2 text-[11px] text-white/50"><Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" /><span className="min-w-0 [overflow-wrap:anywhere]">{progress || 'Proxy is responding…'}</span></div>}
      </div>
      <form className="eterx-proxy-composer shrink-0 border-t border-white/[0.06] p-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className="eterx-proxy-input-wrapper flex min-w-0 flex-col gap-1.5 rounded-2xl border border-white/[0.08] bg-[#262626] p-2">
          {draft.attachments.length > 0 && <div className="flex min-w-0 gap-2 overflow-x-auto pb-1">{draft.attachments.map((file, index) => <span key={`${file.name}-${index}`} className="flex max-w-[180px] shrink-0 items-center gap-1 rounded-lg bg-white/10 px-2 py-1 text-[11px] text-white/80"><span className="truncate">{file.name}</span><button type="button" disabled={sending} aria-label={`Remove ${file.name}`} onClick={() => saveDraft({ ...draft, attachments: draft.attachments.filter((_, i) => i !== index), requestId: undefined })}><X size={12} /></button></span>)}</div>}
          <textarea ref={textarea} rows={1} aria-label="Message the proxy agent" value={draft.text} disabled={sending} onChange={event => { dictation.reset(event.target.value); saveDraft({ ...draftRef.current, text: event.target.value, requestId: undefined }); }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} placeholder={controls.paused ? 'Draft a message, then resume Proxy to send…' : 'Guide the task or ask for an update…'} className="eterx-proxy-textarea min-h-[32px] w-full resize-none bg-transparent px-1 py-1 text-[12.5px] leading-relaxed text-white outline-hidden placeholder:text-white/30 eterx-scrollbar" />
          <div className="eterx-proxy-composer-toolbar">
            <input ref={files} type="file" multiple className="hidden" onChange={event => { const selected = Array.from(event.currentTarget.files || []); saveDraft({ ...draft, attachments: [...draft.attachments, ...selected], requestId: undefined }); event.currentTarget.value = ''; }} />
            <button type="button" disabled={sending} aria-label="Attach files" onClick={() => files.current?.click()} className="eterx-workspace-proxy-icon"><Plus size={16} /></button>
            <ProxyChatActions
              selection={controls.modelSelection}
              entries={controls.modelEntries}
              onSelect={selection => { void controls.onModelSelectionChange(selection).catch(failure => { if (alive.current) setError(failure instanceof Error ? failure.message : 'Could not change the Proxy model.'); }); }}
              dictationPhase={dictation.phase}
              onDictation={() => void dictation.toggle()}
              busy={sending || processing}
              sendDisabled={loading || controls.paused || !controls.enabled || !controls.modelEntries.some(entry => modelEntryKey(entry.provider, entry.modelId) === controls.modelSelection) || (!draft.text.trim() && !draft.attachments.length)}
            />
          </div>
        </div>
        {error && <div role="alert" className="mt-2 flex min-w-0 items-start gap-2 text-[11px] text-red-400"><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</span><button type="button" aria-label="Dismiss proxy error" onClick={() => setError('')}><X size={13} /></button></div>}
        {historyError && <div role="alert" className="mt-2 flex min-w-0 items-start gap-2 text-[11px] text-red-400"><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{historyError}</span><button type="button" onClick={() => void refresh.current()}>Retry</button></div>}
      </form>
    </div>}
  </>;
}
