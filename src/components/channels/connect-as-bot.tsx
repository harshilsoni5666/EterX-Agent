"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Bot, Check, ChevronRight, Copy, Eye, EyeOff, FileText, HelpCircle, Loader2, Monitor, Plus, Search, Settings2, ShieldCheck, X } from 'lucide-react';
import { appStorage, appStorageReady } from '../../lib/client-storage';
import { safeCopyTextToClipboard } from '../ui/copy-button';
import { MODEL_SELECTOR_STORAGE_KEY, MODEL_CATALOG_STORAGE_KEY, normalizeModelSelectorEntries, modelEntryKey, parseModelEntryKey, type ModelSelectorEntry } from '../../lib/agent/model-selector-store';
import { normalizeTelegramToken, TELEGRAM_CLIENT_VERSION } from '../../lib/agent/gateways/telegram-token.cjs';

type BotProfile = {
  id?: string; name: string; username?: string; token?: string; enabled: boolean;
  instructions: string; model: { provider: string; modelId: string }; agentType: string;
  workspacePath: string; allowBrowserControl: boolean; allowHostControl: boolean;
  thinkingLevel: string; state?: string; lastError?: string; paired?: boolean;
  ownerName?: string; conversationCount?: number;
};
const freshBot = (): BotProfile => ({ name: '', token: '', enabled: true, instructions: '', model: { provider: '', modelId: '' }, agentType: 'general', workspacePath: '', allowBrowserControl: true, allowHostControl: false, thinkingLevel: 'low' });
const field = 'w-full rounded-xl border border-black/10 bg-white px-3.5 py-3 text-[13px] outline-none transition focus:border-[#2388dc] dark:border-white/10 dark:bg-white/[0.04]';
const muted = 'text-black/50 dark:text-white/50';
const panel = 'rounded-2xl border border-black/[0.08] bg-white dark:border-white/[0.09] dark:bg-white/[0.035]';
const action = 'inline-flex items-center justify-center gap-2 rounded-xl border border-black/10 px-3.5 py-2.5 text-[12px] font-semibold transition hover:bg-black/[0.035] disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/[0.06]';
const primary = `${action} bg-[#302f2c] text-white hover:bg-[#46443f] dark:bg-white dark:text-black dark:hover:bg-white/90`;

function ConnectionError({ message, diagnostic }: { message: string; diagnostic: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [message, diagnostic]);
  return <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-[12px] leading-5 text-red-600 dark:text-red-300">
    <p>{message}</p>
    {diagnostic && <details className="mt-3"><summary className="cursor-pointer font-medium">Connection details</summary><pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-[11px]">{diagnostic}</pre><button type="button" className={`${action} mt-3`} onClick={() => void safeCopyTextToClipboard(`${message}\n\n${diagnostic}`).then(setCopied)}><Copy className="h-3.5 w-3.5" />{copied ? 'Copied' : 'Copy error details'}</button><p className="mt-2 text-[11px]">These details contain no bot token.</p></details>}
  </div>;
}

export function ConnectAsBot({ onBack, onChanged }: { onBack: () => void; onChanged?: () => void }) {
  const api = typeof window !== 'undefined' ? (window as any).electronAPI : null;
  const [bots, setBots] = useState<BotProfile[]>([]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<BotProfile | null>(null);
  const [models, setModels] = useState<ModelSelectorEntry[]>([]);
  const [customAgents, setCustomAgents] = useState<Array<{ agentId: string; name: string }>>([]);
  const [search, setSearch] = useState('');
  const [guide, setGuide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [diagnostic, setDiagnostic] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [pairing, setPairing] = useState<{ id: string; url: string; expiresAt: number } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!api?.getGatewayState) { setLoading(false); return; }
    try {
      const state = await api.getGatewayState();
      setBots(state.status?.bots || state.config?.telegramBots || []);
      setRunning(state.status?.running === true);
    } catch { setError('Could not read the desktop connection. Try again in a moment.'); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => {
    void refresh();
    const off = api?.onGatewayStatus?.((status: any) => { setBots(status.bots || []); setRunning(status.running === true); });
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => { off?.(); window.clearInterval(timer); };
  }, [api, refresh]);
  useEffect(() => {
    const read = () => {
      try { setModels(normalizeModelSelectorEntries(JSON.parse(appStorage.getItem(MODEL_SELECTOR_STORAGE_KEY) || 'null'), JSON.parse(appStorage.getItem(MODEL_CATALOG_STORAGE_KEY) || '{}'))); } catch { setModels([]); }
    };
    let active = true;
    void appStorageReady.then(() => { if (active) read(); });
    read(); window.addEventListener('focus', read); return () => { active = false; window.removeEventListener('focus', read); };
  }, [draft?.id]);
  useEffect(() => {
    let live = true;
    void fetch('/api/agents/list').then(response => response.json()).then(data => {
      if (live) setCustomAgents((data.agents || []).filter((agent: any) => agent.kind === 'agent' && agent.status === 'ready' && agent.hasPrompt));
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  useEffect(() => { if (pairing && bots.find(bot => bot.id === pairing.id)?.paired) { setPairing(null); setNotice('Your Telegram account is paired. Send your bot its first task.'); } }, [bots, pairing]);
  useEffect(() => { setShowToken(false); setDiagnostic(''); }, [draft?.id, Boolean(draft)]);

  const pair = async (id: string) => {
    setError(''); setDiagnostic(''); setBusy(true);
    try {
      const result = await api.pairTelegramBot(id);
      if (!result?.ok) throw new Error(result?.error || 'Could not create pairing link.');
      setPairing({ id, url: result.url, expiresAt: result.expiresAt });
    } catch (reason: any) { setError(reason.message); }
    finally { setBusy(false); }
  };
  const save = async (value: BotProfile, reconnect = false) => {
    setBusy(true); setError(''); setDiagnostic(''); setNotice('');
    try {
      const desktop = await api.getGatewayState();
      if (desktop?.telegramClientVersion !== TELEGRAM_CLIENT_VERSION) {
        setDiagnostic(`Step: Load desktop connection\nCode: TELEGRAM_DESKTOP_RESTART\nExpected client: ${TELEGRAM_CLIENT_VERSION}`);
        throw new Error('The window and desktop connection code are from different versions. Fully quit EterX, including its tray app, and reopen it to finish this update. Then paste the token again.');
      }
      const result = await api.saveTelegramBot(value);
      if (!result?.ok) {
        setDiagnostic(result?.diagnostic ? JSON.stringify(result.diagnostic, null, 2) : 'Connection details are unavailable from this desktop process. Fully quit and reopen EterX to load the updated connection code.');
        throw new Error(result?.error || 'Could not save bot.');
      }
      setDraft(null); await refresh(); onChanged?.();
      const savedBot = result.status?.bots?.find((item: BotProfile) => item.id === result.id);
      if (!savedBot?.paired && value.enabled) await pair(result.id);
      else setNotice(reconnect ? 'Reconnecting. The connection status will update here.' : value.enabled ? 'Bot saved. Model and role changes apply to its next task.' : 'Bot paused. Its active work will stop.');
    } catch (reason: any) { setError(reason.message); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError(''); setDiagnostic('');
    try {
      const result = await api.removeTelegramBot(removing);
      if (!result?.ok) throw new Error(result?.error || 'Could not disconnect bot.');
      setRemoving(null); await refresh(); onChanged?.(); setNotice('Bot disconnected. Its Telegram messages remain in Telegram.');
    } catch (reason: any) { setError(reason.message); }
    finally { setBusy(false); }
  };
  const patch = (value: Partial<BotProfile>) => setDraft(current => current ? { ...current, ...value } : current);
  const pasteToken = (event: React.ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    setError(''); setDiagnostic('');
    try {
      // Read the clipboard before the password input strips its line breaks.
      // Replace with the complete credential, never append a second token.
      const token = normalizeTelegramToken(event.clipboardData.getData('text/plain'));
      patch({ token });
    } catch (reason: any) {
      patch({ token: '' });
      setError(reason.message || 'Copy the token itself from @BotFather and paste it again.');
    }
  };
  const visible = bots.filter(bot => `${bot.name} ${bot.username || ''} ${bot.instructions}`.toLowerCase().includes(search.toLowerCase()));
  const active = bots.filter(bot => bot.enabled && bot.paired && bot.state === 'connected').length;

  return <div className="eterx-channels-view h-full min-h-0 w-full overflow-y-auto bg-[var(--eterx-channel-surface)] px-5 pb-12 pt-5 text-[#353230] dark:text-white/90 md:px-8">
    <div className="mx-auto w-full max-w-[1180px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={onBack} className={`${action} bg-white dark:bg-white/[0.04]`}><ArrowLeft className="h-4 w-4" />Channels</button>
        <div className="flex items-center gap-2"><span className={`mr-2 text-[12px] ${muted}`}>{active} connected · {bots.length} bots</span><button type="button" onClick={() => setGuide(value => !value)} className={action}><HelpCircle className="h-4 w-4" />Setup guide</button><button type="button" disabled={!api?.saveTelegramBot || busy} onClick={() => { setDraft(freshBot()); setError(''); }} className={primary}><Plus className="h-4 w-4" />New bot</button></div>
      </div>
      <div className="mb-8 mt-9 flex flex-wrap items-start justify-between gap-5">
        <div><div className={`mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.15em] ${muted}`}><img src="/icons/connectors/telegram.svg" alt="" className="h-4 w-4" />Telegram · your computer</div><h1 className="text-[34px] font-semibold tracking-[-0.04em]">Connect as bot</h1><p className={`mt-3 max-w-[660px] text-[14px] leading-6 ${muted}`}>Give your agent a name and a job. Message it from Telegram, shape the work as it happens, and get the finished files back in your chat.</p></div>
        <div className={`${panel} flex items-center gap-3 px-4 py-3`}><Monitor className={`h-5 w-5 ${muted}`} /><div><p className="text-[12px] font-semibold">This computer</p><p className={`mt-1 flex items-center gap-1.5 text-[11px] ${muted}`}><span className={`h-1.5 w-1.5 rounded-full ${running ? 'bg-emerald-500' : 'bg-black/25 dark:bg-white/25'}`} />{!api?.saveTelegramBot ? 'Desktop app required' : running ? 'Gateway running' : 'Ready to connect'}</p></div></div>
      </div>
      {error && !draft && !removing && <div className="mb-5"><ConnectionError message={error} diagnostic={diagnostic} /></div>}
      {notice && <div role="status" className="mb-5 flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-[13px] text-emerald-700 dark:text-emerald-300"><Check className="h-4 w-4" />{notice}</div>}
      {!api?.saveTelegramBot && <div className={`${panel} mb-5 p-5 text-[13px] leading-6`}>Open EterX on the Mac, Windows, or Linux computer where you want the work to run. This page will connect its existing agent, models, apps, and files to Telegram.</div>}
      {pairing && <section className={`${panel} mb-6 border-[#2388dc]/30 p-6`}><div className="flex items-start gap-3"><ShieldCheck className="mt-1 h-6 w-6 text-[#2388dc]" /><div className="flex-1"><h2 className="text-[17px] font-semibold">One last step: pair your Telegram account</h2><p className={`mt-2 text-[13px] leading-6 ${muted}`}>Open this private link using your own Telegram account and tap Start. Only that account can ask this bot to work on your computer. The link expires in 10 minutes.</p><div className="mt-4 flex flex-wrap gap-2"><a href={pairing.url} target="_blank" rel="noreferrer" className={primary}>Pair in Telegram<ArrowUpRight className="h-4 w-4" /></a><button type="button" className={action} onClick={() => void safeCopyTextToClipboard(pairing.url).then(ok => setNotice(ok ? 'Private pairing link copied.' : 'Could not copy the link.'))}><Copy className="h-3.5 w-3.5" />Copy link</button><button type="button" className={action} disabled={busy} onClick={() => void pair(pairing.id)}>Renew link</button></div></div><button type="button" aria-label="Close pairing instructions" className="p-1" onClick={() => setPairing(null)}><X className="h-4 w-4" /></button></div></section>}
      {(guide || !bots.length) && <section className={`${panel} mb-7 p-6`}>
        <div className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2388dc]/10"><img src="/icons/connectors/telegram.svg" alt="" className="h-5 w-5" /></span><h2 className="text-[16px] font-semibold">Your first bot, in three steps</h2></div>
        <div className="mt-5 grid gap-6 md:grid-cols-3">{[
          ['01', 'Create it in Telegram', <>Open <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="font-semibold text-[#2388dc]">@BotFather</a>, send <code>/newbot</code>, and choose a display name and a unique username ending in “bot”. Copy the token it gives you.</>],
          ['02', 'Give it a role', <>Choose New bot. Paste the token, select one of your configured models and an agent type, then describe what it should help with. Create another bot for another role.</>],
          ['03', 'Pair, then send a task', <>Save the bot and open its private pairing link. Tap Start in Telegram. Send a task or file, answer its questions, and send corrections while it works.</>],
        ].map(([number, title, copy]) => <div key={String(number)}><p className={`text-[11px] font-medium ${muted}`}>{number}</p><h3 className="mt-2 text-[14px] font-semibold">{title}</h3><p className={`mt-2 text-[12px] leading-6 ${muted}`}>{copy}</p></div>)}</div>
        <div className={`mt-6 grid gap-4 border-t border-black/[0.07] pt-4 text-[12px] leading-6 dark:border-white/[0.07] sm:grid-cols-2 ${muted}`}>
          <p><span className="font-semibold text-black/80 dark:text-white/80">Keep work moving.</span> Send a correction at any time. Reply to an update or file to continue its conversation. Use <code>/peek</code> for the latest activity or <code>/stop</code> to stop the task.</p>
          <p><span className="font-semibold text-black/80 dark:text-white/80">Make it comfortable.</span> Answer with buttons, polls or a reply. Use <code>/quiet</code> for results and necessary questions, and <code>/updates</code> to bring work updates back. Photos and related files can travel together as albums.</p>
        </div>
        <div className={`mt-6 border-t border-black/[0.07] pt-4 text-[12px] leading-6 dark:border-white/[0.07] ${muted}`}>Keep this computer awake and online. Connecting a bot keeps EterX running in the tray when the window closes; quitting EterX or sleeping the computer stops work. Enable “Starts at sign-in” in Gateway if you want EterX to launch when you log in. Telegram retains incoming updates for up to 24 hours.</div>
      </section>}
      <div className="mb-4 flex items-center justify-between gap-4"><h2 className="text-[17px] font-semibold">Your bots <span className={`ml-1 text-[12px] font-normal ${muted}`}>{bots.length}</span></h2><label className="flex max-w-[260px] items-center gap-2 rounded-xl border border-black/10 bg-white px-3 py-2 dark:border-white/10 dark:bg-white/[0.04]"><Search className={`h-4 w-4 ${muted}`} /><input aria-label="Search bots" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search bots" className="min-w-0 bg-transparent text-[12px] outline-none" /></label></div>
      {loading ? <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin" /></div> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visible.map((bot, index) => <article key={bot.id} className={`${panel} flex flex-col p-5`}>
        <div className="flex items-start gap-3"><span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${['bg-[#eae5ff] text-[#7560ab]', 'bg-[#def0e9] text-[#467b69]', 'bg-[#f9e9d6] text-[#ac7440]'][index % 3]}`}><Bot className="h-6 w-6" /></span><div className="min-w-0 flex-1"><h3 className="truncate text-[16px] font-semibold">{bot.name}</h3><p className={`mt-1 truncate text-[11px] ${muted}`}>@{bot.username}</p></div><button type="button" aria-label={`Edit ${bot.name}`} onClick={() => { setDraft({ ...bot, token: '' }); setError(''); }} className={`p-1 ${muted}`}><Settings2 className="h-4 w-4" /></button></div>
        <p className={`mb-5 mt-4 line-clamp-2 min-h-[40px] text-[12px] leading-5 ${muted}`}>{bot.instructions || 'Ready to help with your next task.'}</p>
        <div className={`space-y-2 border-t border-black/[0.06] pt-4 text-[11px] dark:border-white/[0.06] ${muted}`}><p className="flex justify-between gap-3"><span>Model</span><span className="truncate text-black/75 dark:text-white/75" title={`${bot.model.provider} / ${bot.model.modelId}`}>{bot.model.modelId}</span></p><p className="flex justify-between"><span>Agent</span><span className="capitalize text-black/75 dark:text-white/75">{bot.agentType.replace('-', ' ')}</span></p><p className="flex justify-between"><span>Conversations</span><span>{bot.conversationCount || 0}</span></p></div>
        <div className="mb-4 mt-4 flex items-center gap-1.5 text-[11px]"><span className={`h-1.5 w-1.5 rounded-full ${bot.state === 'connected' && bot.paired ? 'bg-emerald-500' : 'bg-amber-500'}`} /><span>{!bot.enabled ? 'Paused' : !bot.paired ? 'Pair your account' : bot.state === 'connected' ? `Connected${bot.ownerName ? ' · ' + bot.ownerName : ''}` : bot.state || 'Offline'}</span></div>
        {bot.lastError && <p className="mb-3 text-[11px] leading-5 text-red-500">{bot.lastError}</p>}
        {bot.enabled && bot.state !== 'connected' && <button type="button" disabled={busy} onClick={() => void save(bot, true)} className={`${action} mb-3 self-start`}>Reconnect</button>}
        <div className="mt-auto flex flex-wrap gap-2">{bot.paired ? <a href={`https://t.me/${bot.username}`} target="_blank" rel="noreferrer" className={action}>Open Telegram<ArrowUpRight className="h-3.5 w-3.5" /></a> : <button type="button" disabled={busy || !bot.enabled} onClick={() => void pair(bot.id!)} className={action}>Pair account<ChevronRight className="h-3.5 w-3.5" /></button>}<button type="button" disabled={busy} onClick={() => void save({ ...bot, enabled: !bot.enabled })} className={action}>{bot.enabled ? 'Pause' : 'Resume'}</button></div>
      </article>)}{!bots.length && <button type="button" disabled={!api?.saveTelegramBot} onClick={() => setDraft(freshBot())} className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-black/15 p-6 text-center transition hover:bg-white/60 disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[0.04]"><Plus className="h-6 w-6" /><span className="text-[14px] font-semibold">Create your first teammate</span><span className={`text-[12px] ${muted}`}>Research, documents, coding, or everyday work.</span></button>}{bots.length > 0 && !visible.length && <p className={`py-10 text-[13px] ${muted}`}>No bots match your search.</p>}</div>}
      <div className="mt-8 grid gap-4 md:grid-cols-3">{[[Bot, 'Work together in real time', 'Send another message to steer the task in progress. Use /stop whenever you need to stop.'], [FileText, 'Results arrive in your chat', 'Receive documents, images and visual previews. Send files and photos for your bot to work with.'], [ShieldCheck, 'A private place for each task', 'Use /new, /chats and /switch in Telegram. Working context is saved on this device, outside your desktop chat list. Enable Topics in BotFather for separate Telegram threads.']].map(([Icon, title, copy]: any[]) => <div key={title} className="px-1 py-3"><Icon className={`h-5 w-5 ${muted}`} /><h3 className="mt-3 text-[13px] font-semibold">{title}</h3><p className={`mt-2 text-[12px] leading-6 ${muted}`}>{copy}</p></div>)}</div>
      {draft && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/35 p-4 backdrop-blur-sm" onClick={event => { if (event.target === event.currentTarget && !busy) setDraft(null); }}><section role="dialog" aria-modal="true" aria-labelledby="bot-editor-title" className="max-h-[90vh] w-full max-w-[690px] overflow-y-auto rounded-[24px] border border-black/10 bg-[#faf9f7] p-6 shadow-xl dark:border-white/10 dark:bg-[#202020]">
        <div className="flex items-center justify-between"><div><h2 id="bot-editor-title" className="text-[23px] font-semibold tracking-tight">{draft.id ? 'Edit your bot' : 'Meet your next teammate'}</h2><p className={`mt-1 text-[12px] ${muted}`}>One Telegram bot. Your existing EterX agent.</p></div><button type="button" disabled={busy} aria-label="Close bot editor" onClick={() => setDraft(null)} className="p-2"><X className="h-5 w-5" /></button></div>
        <form className="mt-6 space-y-5" onSubmit={event => { event.preventDefault(); void save(draft); }}>
          <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-2 text-[12px] font-semibold"><span>Bot name</span><input required maxLength={64} autoFocus value={draft.name} onChange={event => patch({ name: event.target.value })} placeholder="Research partner" className={field} /></label><label className="space-y-2 text-[12px] font-semibold"><span>BotFather token</span><div className="relative"><input required={!draft.id} disabled={busy} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} type={showToken ? 'text' : 'password'} value={draft.token || ''} onPaste={pasteToken} onChange={event => { patch({ token: event.target.value }); setError(''); setDiagnostic(''); }} placeholder={draft.id ? 'Saved securely · leave blank to keep' : '123456789:AA…'} className={`${field} pr-11`} /><button type="button" disabled={busy} aria-label={showToken ? 'Hide bot token' : 'Show bot token'} aria-pressed={showToken} onClick={() => setShowToken(value => !value)} className={`absolute right-3 top-1/2 -translate-y-1/2 p-1 ${muted}`}>{showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></label></div>
          <p className={`-mt-2 text-[11px] leading-5 ${muted}`}>The name is your bot’s EterX identity. Set its Telegram profile name in <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-[#2388dc]">BotFather</a>. Tokens are stored in the desktop credential store.</p>
          <p className={`text-[11px] leading-5 ${muted}`}>In BotFather, open /mybots → your bot → API Token and copy the token itself. Pasting the full BotFather message also extracts its token before filling this field. EterX verifies it directly with Telegram when you connect. Connection errors keep your draft here so you can retry.</p>
          <label className="block space-y-2 text-[12px] font-semibold"><span>What should this bot do?</span><textarea rows={4} maxLength={16000} value={draft.instructions} onChange={event => patch({ instructions: event.target.value })} placeholder="Help me research and write. Give me concise updates, cite original sources, and send finished documents. Remember my preferences as we work." className={`${field} resize-y font-normal leading-6`} /></label>
          <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-2 text-[12px] font-semibold"><span>Model</span><select required value={draft.model.provider ? modelEntryKey(draft.model.provider, draft.model.modelId) : ''} onChange={event => { const model = parseModelEntryKey(event.target.value); if (model) patch({ model }); }} className={field}><option value="">Select a configured model</option>{models.map(model => <option key={modelEntryKey(model.provider, model.modelId)} value={modelEntryKey(model.provider, model.modelId)}>{model.provider} · {model.modelId}</option>)}{draft.model.provider && !models.some(item => item.provider === draft.model.provider && item.modelId === draft.model.modelId) && <option value={modelEntryKey(draft.model.provider, draft.model.modelId)}>{draft.model.provider} · {draft.model.modelId} (saved)</option>}</select></label><label className="space-y-2 text-[12px] font-semibold"><span>Agent type</span><select value={draft.agentType} onChange={event => patch({ agentType: event.target.value })} className={field}><option value="general">General · full agent toolkit</option><option value="coding-lite">Coding Lite · terminal and files</option><option value="coding-heavy">Coding Heavy · coding and research</option>{customAgents.map(agent => <option key={agent.agentId} value={`custom:${agent.agentId}`}>{agent.name} · custom agent</option>)}</select></label></div>
          {!models.length && <p className="text-[12px] leading-5 text-amber-600 dark:text-amber-300">Add a provider and model in EterX Settings first, then return here. Each bot uses its chosen model and your existing provider credentials.</p>}
          <details className={`${panel} p-4`}><summary className="cursor-pointer text-[12px] font-semibold">Computer and execution settings</summary><div className="mt-4 space-y-4"><label className="block space-y-2 text-[12px]"><span>Working folder (optional)</span><input value={draft.workspacePath} onChange={event => patch({ workspacePath: event.target.value })} placeholder="Absolute path on this computer" className={field} /></label><label className="flex items-center justify-between text-[12px]">Thinking effort<select value={draft.thinkingLevel} onChange={event => patch({ thinkingLevel: event.target.value })} className={`${field} !w-32`}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><label className="flex items-center justify-between gap-4 text-[12px]">Use connected browser<input type="checkbox" checked={draft.allowBrowserControl} onChange={event => patch({ allowBrowserControl: event.target.checked })} className="h-4 w-4 accent-[#2388dc]" /></label><label className="flex items-center justify-between gap-4 text-[12px]">Control this computer and share requested screenshots<input type="checkbox" checked={draft.allowHostControl} onChange={event => patch({ allowHostControl: event.target.checked })} className="h-4 w-4 accent-[#2388dc]" /></label><p className={`text-[11px] leading-5 ${muted}`}>The selected agent’s enabled tools and device permissions still apply. Coding modes keep their focused toolsets. Model and role changes apply to the next task.</p></div></details>
          {error && <ConnectionError message={error} diagnostic={diagnostic} />}
          <div className="flex items-center justify-between gap-3 border-t border-black/[0.08] pt-5 dark:border-white/[0.08]">{draft.id ? <button type="button" disabled={busy} onClick={() => { setRemoving(draft.id!); setDraft(null); }} className="text-[12px] text-red-500">Disconnect bot</button> : <span className={`text-[11px] ${muted}`}>Pair your account after saving.</span>}<button type="submit" disabled={busy || !draft.model.modelId} className={primary}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{busy ? 'Connecting…' : draft.id ? 'Save changes' : 'Connect bot'}</button></div>
        </form>
      </section></div>}
      {removing && <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/35 p-4"><section role="dialog" aria-modal="true" aria-label="Disconnect bot" className="w-full max-w-md rounded-2xl bg-white p-6 dark:bg-[#242424]"><h2 className="text-lg font-semibold">Disconnect this bot?</h2><p className={`mt-3 text-[13px] leading-6 ${muted}`}>It will stop receiving tasks and its account pairing will be removed. Telegram messages and saved working context remain.</p>{error && <p className="mt-3 text-[12px] text-red-500">{error}</p>}<div className="mt-5 flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => setRemoving(null)} className={action}>Cancel</button><button type="button" disabled={busy} onClick={() => void remove()} className={primary}>{busy ? 'Disconnecting…' : 'Disconnect'}</button></div></section></div>}
    </div>
  </div>;
}
