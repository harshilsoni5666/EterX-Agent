'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Select from '@radix-ui/react-select';
import { ArrowDownToLine, ArrowRight, BookOpen, Check, CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Folder, FolderOpen, FolderPlus, Loader2, MessageSquare, Plug, RefreshCw, Search, Settings2, ShieldCheck, Upload, Users, X } from 'lucide-react';
import { importRequest, IMPORT_UPDATED_EVENT, notifyImportChange, waitForImportJob } from '../../lib/imports/client';
import { CATEGORY_LABELS, DEFAULT_IMPORT_SELECTION, IMPORT_CATEGORIES, IMPORT_LABELS, IMPORT_PROVIDERS, type ImportCategory, type ImportItemSummary, type ImportJob, type ImportPreview, type ImportProvider, type ImportReport, type ImportSelection, type ImportStatus } from '../../lib/imports/types';
import { safeCopyTextToClipboard } from '../ui/copy-button';
import styles from './import-settings.module.css';

const CATEGORY_DESCRIPTIONS: Record<ImportCategory, string> = {
  chats: 'Continue conversations with their history and original project context.',
  instructions: 'Bring over relevant instructions, project rules, and saved memory.',
  skills: 'Add compatible workflows to EterX’s live skill catalog, with support files.',
  agents: 'Make imported agent instructions available in your agent picker.',
  mcp: 'Save compatible server definitions. Connect each server after importing.',
};
const CategoryIcon = { chats: MessageSquare, instructions: BookOpen, skills: BookOpen, agents: Users, mcp: Plug };
const sourceDescription: Record<ImportProvider, string> = {
  codex: 'Local sessions, project instructions, skills, and MCP setup',
  claude: 'Claude Code sessions, Claude exports, skills, and agents',
  cursor: 'Local chats, project rules, skills, and MCP setup',
};
const shortPath = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() || value;
const formatTime = (value?: number) => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never synced';

function SourceMark({ provider, small = false }: { provider: ImportProvider; small?: boolean }) {
  return <span className={`${styles.sourceMark} ${small ? styles.smallMark : ''}`} data-provider={provider} aria-hidden="true">
    {provider === 'cursor' ? <>
      <img className={styles.cursorLogoDark} src="/icons/import-providers/cursor-dark.png" alt="" draggable={false} />
      <img className={styles.cursorLogoLight} src="/icons/import-providers/cursor-light.png" alt="" draggable={false} />
    </> : <img className={styles.sourceLogo} src={provider === 'codex' ? '/icons/import-providers/codex.png' : '/icons/import-providers/claude.png'} alt="" draggable={false} />}
  </span>;
}
function Checkbox({ checked, mixed, label, onChange, disabled }: { checked: boolean; mixed?: boolean; label: string; onChange: (checked: boolean) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = Boolean(mixed); }, [mixed]);
  return <input ref={ref} className={styles.checkbox} type="checkbox" checked={checked} aria-label={label} onChange={event => onChange(event.target.checked)} disabled={disabled} />;
}
function Toggle({ checked, label, onChange, disabled }: { checked: boolean; label: string; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <button type="button" className={styles.toggle} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} disabled={disabled}><span /></button>;
}
function Notices({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return <details className={styles.notices}><summary><CircleAlert size={14} /> {warnings.length} import note{warnings.length === 1 ? '' : 's'} <ChevronDown size={13} /></summary><ul>{warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>;
}

export function ImportSettings() {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selection, setSelection] = useState<ImportSelection>({ ...DEFAULT_IMPORT_SELECTION });
  const [sourceDialog, setSourceDialog] = useState<ImportProvider | null>(null);
  const [rootsInput, setRootsInput] = useState('');
  const [search, setSearch] = useState('');
  const [destination, setDestination] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [setupSearch, setSetupSearch] = useState('');
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadProvider = useRef<ImportProvider>('codex');
  const lock = useRef(false);
  const resumedJob = useRef<string | null>(null);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const load = useCallback(async () => {
    const next = await importRequest<ImportStatus>(undefined, controller.current?.signal);
    if (mounted.current) setStatus(next);
    return next;
  }, []);
  useEffect(() => {
    mounted.current = true;
    controller.current = new AbortController();
    const refresh = () => { void load().catch(reason => { if (mounted.current && reason.name !== 'AbortError') setError(reason.message); }); };
    refresh();
    window.addEventListener(IMPORT_UPDATED_EVENT, refresh);
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('eterx-imports') : null;
    if (channel) channel.onmessage = refresh;
    const timer = window.setInterval(refresh, 15_000);
    return () => { mounted.current = false; controller.current?.abort(); window.clearInterval(timer); window.removeEventListener(IMPORT_UPDATED_EVENT, refresh); channel?.close(); };
  }, [load]);

  const run = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await work(); }
    catch (reason) { if (mounted.current && (reason as Error).name !== 'AbortError') setError(reason instanceof Error ? reason.message : 'Could not complete this operation.'); }
    finally { lock.current = false; if (mounted.current) { setBusy(false); setJob(null); } }
  };
  const openPreview = (next: ImportPreview) => {
    const source = statusRef.current?.sources[next.provider];
    setPreview(next); setSearch(''); setError('');
    setSelection(!next.uploaded && source?.selection ? source.selection : { ...DEFAULT_IMPORT_SELECTION });
    setDestination(source?.folder || ''); setNewFolder('');
  };
  const closePreview = () => {
    if (busy || !preview) return;
    const id = preview.id;
    void run(async () => { await importRequest({ action: 'discard', previewId: id }); setPreview(null); await load(); });
  };
  const track = async (initial: ImportJob) => {
    if (mounted.current) setJob(initial);
    if (initial.kind !== 'scan') notifyImportChange();
    const finished = await waitForImportJob(initial, next => { if (mounted.current) setJob(next); }, controller.current?.signal);
    if (finished.preview && mounted.current) {
      openPreview(finished.preview);
    }
    if (finished.report) {
      if (mounted.current) { setReport(finished.report); setPreview(null); }
      notifyImportChange(finished.report);
    }
    await load();
  };
  useEffect(() => {
    const active = status?.activeJob;
    if (!active || lock.current || resumedJob.current === active.id) return;
    resumedJob.current = active.id;
    void run(() => track(active));
    // Recover a server-side job after returning to this tab. Normal actions already hold the lock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.activeJob?.id]);
  const scan = (provider: ImportProvider, roots?: string[]) => run(async () => {
    setSourceDialog(null);
    const data = await importRequest<{ job: ImportJob }>({ action: 'scan', provider, roots: roots || status?.sources[provider]?.roots || [] });
    await track(data.job);
  });
  const configure = (body: Record<string, unknown>) => run(async () => {
    await importRequest({ action: 'configure', ...body }); await load(); notifyImportChange();
  });
  const sync = (provider: ImportProvider) => run(async () => {
    const data = await importRequest<{ job: ImportJob | null }>({ action: 'sync', provider });
    if (data.job) await track(data.job);
  });
  const upload = (provider: ImportProvider) => { uploadProvider.current = provider; fileInput.current?.click(); };
  const handleUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []); event.target.value = '';
    if (!files.length) return;
    void run(async () => {
      if (files.reduce((total, file) => total + file.size, 0) > 64 * 1024 * 1024) throw new Error('Choose export files totaling less than 64 MB.');
      const form = new FormData(); form.set('provider', uploadProvider.current);
      files.forEach(file => form.append('files', file));
      const response = await fetch('/api/imports', { method: 'POST', body: form, signal: controller.current?.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not read this export.');
      setSourceDialog(null); await track(data.job);
    });
  };

  const chats = useMemo(() => preview?.items.filter(item => item.category === 'chats') || [], [preview]);
  const selectedIds = useMemo(() => new Set(selection.chatIds || []), [selection.chatIds]);
  const selectedProjects = useMemo(() => new Set(selection.projectPaths || []), [selection.projectPaths]);
  const isChatSelected = (item: ImportItemSummary) => selection.chatIds === null || selectedIds.has(item.id) || Boolean(item.workspace && selectedProjects.has(item.workspace));
  const selectedChatItems = chats.filter(isChatSelected);
  const selectedWorkspaces = new Set(selectedChatItems.map(item => item.workspace).filter(Boolean));
  const relevantSetup = (item: ImportItemSummary) => !item.workspace || !selection.chats || selection.chatIds === null || selectedWorkspaces.has(item.workspace);
  const isSetupSelected = (item: ImportItemSummary) => selection[item.category] && relevantSetup(item) && !selection.excludedIds?.includes(item.id);
  const selectedCount = (selection.chats ? selectedChatItems.length : 0) + (preview?.items.filter(item => item.category !== 'chats' && isSetupSelected(item)).length || 0);
  const groups = useMemo(() => {
    const grouped = new Map<string, ImportItemSummary[]>();
    for (const chat of chats) {
      const key = chat.workspace || '';
      const items = grouped.get(key) || [];
      items.push(chat); grouped.set(key, items);
    }
    return [...grouped].sort((a, b) => a[0].localeCompare(b[0]));
  }, [chats]);
  const visibleGroups = groups.map(([workspace, items]) => [workspace, items.filter(item => `${item.name} ${workspace}`.toLowerCase().includes(search.toLowerCase()))] as const).filter(([, items]) => items.length);
  const setChat = (item: ImportItemSummary, checked: boolean) => {
    const ids = new Set(selectedChatItems.map(chat => chat.id));
    if (checked) ids.add(item.id); else ids.delete(item.id);
    setSelection(current => ({ ...current, chatIds: [...ids], projectPaths: (current.projectPaths || []).filter(folder => folder !== item.workspace) }));
  };
  const setProject = (workspace: string, items: ImportItemSummary[], checked: boolean) => {
    const ids = new Set(selectedChatItems.map(chat => chat.id));
    for (const item of items) { if (checked) ids.add(item.id); else ids.delete(item.id); }
    setSelection(current => ({ ...current, chatIds: [...ids], projectPaths: [...(current.projectPaths || []).filter(folder => folder !== workspace), ...(checked && workspace ? [workspace] : [])] }));
  };
  const activeJob = job || status?.activeJob;
  const pending = busy || activeJob?.status === 'running';
  const configuredSources = Object.values(status?.sources || {});
  const lastReport = report || configuredSources.map(source => source?.lastReport).filter((value): value is ImportReport => Boolean(value)).sort((a, b) => b.completedAt - a.completedAt)[0];
  const folderName = destination === '__new__' ? newFolder.trim() : destination;
  const setupItems = (status?.setup || []).filter(item => `${item.name} ${item.provider} ${item.category}`.toLowerCase().includes(setupSearch.toLowerCase()));
  const destinationFolders = Array.from(new Set([
    ...(destination && destination !== '__new__' ? [destination] : []),
    ...(status?.folders || []),
  ]));
  const destinationValue = destination === '__new__' ? 'new-folder' : destination ? `folder:${encodeURIComponent(destination)}` : 'recents';

  return <div className={styles.root}>
    <p className={styles.intro}>Bring your conversations, projects, and familiar workflows into EterX. Pick exactly what comes with you.</p>
    <input ref={fileInput} type="file" multiple accept=".json,.jsonl,.md,.txt,.mdc,.toml,.zip" hidden onChange={handleUpload} />
    {error && <div className={styles.error} role="alert"><CircleAlert size={16} /><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X size={14} /></button></div>}
    {!status && !error && <div className={styles.loading} role="status"><Loader2 size={17} className={styles.spin} /> Finding local sources…</div>}
    {!status && error && <button className={styles.secondary} type="button" onClick={() => { setError(''); void run(async () => { await load(); }); }}>Try again</button>}

    <section className={styles.section}>
      <div className={styles.sectionHeading}><h4>Automatic sync</h4><span className={styles.eyebrow}>Local &amp; Private</span></div>
      <div className={styles.card}>
        <div className={styles.settingRow}>
          <span className={styles.settingIcon}><RefreshCw size={17} /></span>
          <div className={styles.grow}><strong>Keep imports in sync</strong><p>{status?.autoSync ? 'Selected sources refresh while EterX is open.' : 'Paused. Your imported content and selections are kept.'}</p></div>
          <Toggle checked={Boolean(status?.autoSync)} label="Keep imports in sync" disabled={!status || busy || !configuredSources.some(source => source && !source.uploaded)} onChange={value => { void configure({ autoSync: value }); }} />
        </div>
        <div className={styles.syncFootnote}><ShieldCheck size={13} /><span>One-way sync. Your EterX replies, local edits, and deleted chats are preserved.</span></div>
      </div>
    </section>

    <section className={styles.section}>
      <div className={styles.sectionHeading}><h4>Import from another AI app</h4><button type="button" className={styles.textButton} disabled={busy} onClick={() => { void run(async () => { await load(); }); }} aria-label="Refresh detected sources"><RefreshCw size={13} /> Refresh</button></div>
      <div className={styles.card}>
        {IMPORT_PROVIDERS.map(provider => {
          const source = status?.sources[provider];
          const detected = status?.available[provider]?.detected;
          return <div className={styles.provider} data-provider={provider} key={provider}>
            <div className={styles.providerMain}>
              <SourceMark provider={provider} />
              <div className={styles.grow}><div className={styles.providerName}>{IMPORT_LABELS[provider]}<span className={styles.badge} data-ready={Boolean(source || detected)}>{source ? source.uploaded ? 'File import' : status?.autoSync && source.enabled ? 'Sync on' : 'Imported' : detected ? 'Detected' : 'Choose source'}</span></div><p>{sourceDescription[provider]}</p></div>
              <button type="button" className={styles.primary} disabled={pending || !status} onClick={() => {
                if (detected || source?.roots.length) void scan(provider);
                else { setRootsInput(''); setSourceDialog(provider); }
              }}>{source ? 'Choose items' : 'Import'}<ArrowRight size={14} /></button>
            </div>
            <div className={styles.providerActions}>
              <button type="button" className={styles.textButton} disabled={pending} onClick={() => { setRootsInput(source?.roots.join('\n') || status?.available[provider]?.roots.join('\n') || ''); setSourceDialog(provider); }}><FolderOpen size={12} /> Source options</button>
              <button type="button" className={styles.textButton} disabled={pending} onClick={() => upload(provider)}><Upload size={12} /> Upload export</button>
              {source && !source.uploaded && <><span className={styles.flexSpacer} /><button type="button" className={styles.textButton} disabled={pending} onClick={() => { void sync(provider); }}><RefreshCw size={12} /> Sync now</button><Toggle checked={source.enabled} label={`Include ${IMPORT_LABELS[provider]} in automatic sync`} disabled={busy} onChange={enabled => { void configure({ provider, enabled }); }} /></>}
            </div>
            {source && <p className={styles.sourceMeta}>{source.lastError ? <span className={styles.warningText}>{source.lastError}</span> : <>Last import {formatTime(source.lastSyncAt)}{source.folder ? ` · Folder: ${source.folder}` : ' · Recents'}{source.uploaded ? ' · Upload again to update' : ''}</>}</p>}
          </div>;
        })}
      </div>
      <p className={styles.hint}>Imports are processed on this device. Cloud-only chats need an export. Your configured EterX provider receives context when you continue a chat. Accounts, model credentials, and source-app permissions are not migrated.</p>
    </section>

    {activeJob?.status === 'running' && <div className={styles.progress} role="status" aria-live="polite"><Loader2 size={17} className={styles.spin} /><div><strong>{activeJob.phase}</strong><p>{activeJob.processed ? `${activeJob.processed.toLocaleString()} items processed · ` : ''}You can keep using EterX.</p></div></div>}
    {status?.pendingPreview && !preview && !pending && <div className={styles.progress}><ArrowDownToLine size={17} /><div className={styles.grow}><strong>{IMPORT_LABELS[status.pendingPreview.provider]} content is ready</strong><p>Continue selecting items from your latest scan.</p></div><button type="button" className={styles.secondary} onClick={() => openPreview(status.pendingPreview!)}>Review items</button><button type="button" className={styles.textButton} onClick={() => { void run(async () => { await importRequest({ action: 'discard', previewId: status.pendingPreview!.id }); await load(); }); }}>Dismiss</button></div>}
    {lastReport && <section className={styles.result} aria-live="polite"><div className={styles.resultHeading}><CheckCircle2 size={17} /><strong>{IMPORT_LABELS[lastReport.provider]} import saved</strong><span>{formatTime(lastReport.completedAt)}</span></div><div className={styles.resultStats}><span><b>{lastReport.created}</b> new chats</span><span><b>{lastReport.updated}</b> updated</span><span><b>{lastReport.setup}</b> setup items</span>{lastReport.skipped > 0 && <span><b>{lastReport.skipped}</b> skipped</span>}</div><p>Open imported conversations from Recents or their sidebar folder and continue chatting.</p><Notices warnings={lastReport.warnings} /></section>}

    {!!status?.setup.length && <section className={styles.section}>
      <div className={styles.sectionHeading}><h4>Imported setup</h4><span className={styles.muted}>{status.setup.length} items</span></div>
      <label className={styles.search}><Search size={15} /><input value={setupSearch} onChange={event => setSetupSearch(event.target.value)} placeholder="Find a skill, instruction, agent, or server" aria-label="Search imported setup" /></label>
      <div className={`${styles.card} ${styles.setupList}`}>{setupItems.map(item => {
        const Icon = CategoryIcon[item.category];
        const setEnabled = (enabled: boolean) => { void run(async () => {
          await importRequest({ action: 'setup', id: item.id, enabled }); await load(); notifyImportChange();
        }); };
        return <div className={styles.setupRow} key={item.id}>
          <Icon size={16} />
          <div className={styles.grow}>
            <strong>{item.name}</strong>
            <p>{IMPORT_LABELS[item.provider]} · {CATEGORY_LABELS[item.category]}{item.workspace ? ` · ${shortPath(item.workspace)}` : ''}</p>
            {item.compatibilityNote && !item.enabled && <p className={styles.warningText}>{item.compatibilityNote}</p>}
            {item.category !== 'mcp' && <button type="button" className={styles.pathButton} title={item.destination} onClick={async () => {
              if (await safeCopyTextToClipboard(item.destination)) { setCopiedPath(item.id); window.setTimeout(() => setCopiedPath(null), 1800); }
            }}>{copiedPath === item.id ? 'Path copied' : item.destination}</button>}
          </div>
          {item.category === 'mcp' && !item.enabled
            ? <button type="button" className={styles.secondary} disabled={pending} onClick={() => setEnabled(true)}>Connect</button>
            : <Toggle checked={item.enabled} label={`Use ${item.name} in EterX`} disabled={pending} onChange={setEnabled} />}
        </div>;
      })}{!setupItems.length && <p className={styles.empty}>No matching setup items.</p>}</div>
      <p className={styles.hint}>Enabled skills are available to the agent through its skill catalog. Project skills and instructions apply only in their original workspace.</p>
    </section>}

    <Dialog.Root open={Boolean(sourceDialog)} onOpenChange={open => { if (!open && !busy) setSourceDialog(null); }}>
      <Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={`${styles.root} ${styles.modal} ${styles.sourceModal}`} data-import-dialog onEscapeKeyDown={event => event.stopPropagation()}>
        <Dialog.Title className={styles.modalTitle}>Choose a {sourceDialog ? IMPORT_LABELS[sourceDialog] : ''} source</Dialog.Title>
        <Dialog.Description className={styles.modalDescription}>Use a local data folder, or bring an exported conversation from another device.</Dialog.Description>
        <Dialog.Close className={styles.close} aria-label="Close source options" disabled={busy}><X size={18} /></Dialog.Close>
        <label className={styles.field}>Local data folder<textarea rows={3} value={rootsInput} onChange={event => setRootsInput(event.target.value)} placeholder={sourceDialog === 'codex' ? '~/.codex' : sourceDialog === 'claude' ? '~/.claude' : '~/.cursor'} /><span>One absolute folder path per line. Leave blank to use detected locations.</span></label>
        <div className={styles.actions}><button type="button" className={styles.secondary} disabled={busy} onClick={() => { void run(async () => {
          const api = (window as any).electronAPI;
          if (typeof api?.selectFolder === 'function') { const folder = await api.selectFolder(); if (typeof folder === 'string' && folder) setRootsInput(folder); }
          else setError('Enter the absolute source folder path above. The native folder picker is available in the desktop app.');
        }); }}><FolderOpen size={14} /> Browse</button><button type="button" className={styles.primary} disabled={busy} onClick={() => { if (sourceDialog) void scan(sourceDialog, rootsInput.split(/\r?\n/).map(value => value.trim()).filter(Boolean)); }}>Find content<ArrowRight size={14} /></button></div>
        <div className={styles.divider}>or</div><button type="button" className={styles.uploadButton} disabled={busy} onClick={() => { if (sourceDialog) upload(sourceDialog); }}><Upload size={18} /><span><strong>Choose export files</strong><small>JSON, JSONL, Markdown, TOML, text, or ZIP · up to 64 MB</small></span></button>
        {error && <p className={styles.modalError} role="alert">{error}</p>}
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>

    <Dialog.Root open={Boolean(preview)} onOpenChange={open => { if (!open) closePreview(); }}>
      <Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={`${styles.root} ${styles.modal}`} data-import-dialog onEscapeKeyDown={event => event.stopPropagation()}>
        <div className={styles.modalHeader}><div className={styles.modalKicker}>{preview && <SourceMark provider={preview.provider} small />}<span>{preview ? IMPORT_LABELS[preview.provider] : ''} <ArrowRight size={12} /> EterX import</span></div><Dialog.Title className={styles.modalTitle}>Select items to import</Dialog.Title><Dialog.Description className={styles.modalDescription}>Choose conversations and setup to bring into EterX. Review your selection before importing.</Dialog.Description><Dialog.Close className={styles.close} disabled={busy} aria-label="Close import selection"><X size={18} /></Dialog.Close></div>
        <div className={styles.modalScroll}>
          <div className={styles.destination}>
            <span className={styles.settingIcon}><Folder size={18} /></span>
            <div className={styles.grow}><label id="import-destination-label">Store chats in</label><p>Sidebar organization. Original project paths stay attached.</p></div>
            <Select.Root value={destinationValue} disabled={busy} onValueChange={value => {
              if (value === 'recents') setDestination('');
              else if (value === 'new-folder') setDestination('__new__');
              else if (value.startsWith('folder:')) setDestination(decodeURIComponent(value.slice('folder:'.length)));
            }}>
              <Select.Trigger className={styles.destinationTrigger} aria-labelledby="import-destination-label">
                <Folder size={15} aria-hidden="true" />
                <Select.Value className={styles.destinationValue} />
                <Select.Icon className={styles.destinationChevron}><ChevronDown size={15} /></Select.Icon>
              </Select.Trigger>
              <Select.Portal>
                <Select.Content className={styles.destinationMenu} position="popper" sideOffset={7} align="end" collisionPadding={12}>
                  <Select.ScrollUpButton className={styles.destinationScroll}><ChevronUp size={15} /></Select.ScrollUpButton>
                  <Select.Viewport className={styles.destinationViewport}>
                    <Select.Item className={styles.destinationItem} value="recents"><FolderOpen size={15} /><Select.ItemText>Recents</Select.ItemText><Select.ItemIndicator><Check size={15} /></Select.ItemIndicator></Select.Item>
                    {destinationFolders.map(folder => <Select.Item className={styles.destinationItem} key={folder} value={`folder:${encodeURIComponent(folder)}`}><Folder size={15} /><Select.ItemText>{folder}</Select.ItemText><Select.ItemIndicator><Check size={15} /></Select.ItemIndicator></Select.Item>)}
                    <Select.Separator className={styles.destinationSeparator} />
                    <Select.Item className={`${styles.destinationItem} ${styles.newFolderItem}`} value="new-folder"><FolderPlus size={15} /><Select.ItemText>New folder</Select.ItemText><Select.ItemIndicator><Check size={15} /></Select.ItemIndicator></Select.Item>
                  </Select.Viewport>
                  <Select.ScrollDownButton className={styles.destinationScroll}><ChevronDown size={15} /></Select.ScrollDownButton>
                </Select.Content>
              </Select.Portal>
            </Select.Root>
            {destination === '__new__' && <input className={styles.folderInput} value={newFolder} disabled={busy} maxLength={80} onChange={event => setNewFolder(event.target.value)} placeholder="Name your folder" aria-label="New sidebar folder name" autoFocus />}
          </div>
          <div className={styles.selectionCard}>
            <div className={styles.categoryHeader}><MessageSquare size={18} /><div className={styles.grow}><strong>Chats & projects</strong><p>{selectedChatItems.length} of {chats.length} conversations selected</p></div><Checkbox checked={selection.chats} label="Import chats and projects" onChange={checked => setSelection(current => ({ ...current, chats: checked }))} disabled={busy || !chats.length} /></div>
            {selection.chats && chats.length > 0 && <div className={styles.conversationPicker}>
              <label className={styles.search}><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search chats or projects" aria-label="Search chats or projects" /></label>
              <div className={styles.selectionTools}><button type="button" className={styles.textButton} disabled={busy} onClick={() => setSelection(current => ({ ...current, chatIds: null, projectPaths: [] }))}>Select all</button><span>·</span><button type="button" className={styles.textButton} disabled={busy} onClick={() => setSelection(current => ({ ...current, chatIds: [], projectPaths: [] }))}>Clear</button><span className={styles.flexSpacer} /><span>{groups.filter(([workspace]) => workspace).length} projects</span></div>
              <div className={styles.projectList}>{visibleGroups.map(([workspace, visible]) => {
                const all = groups.find(([key]) => key === workspace)![1];
                const count = all.filter(isChatSelected).length;
                return <details key={workspace} className={styles.projectGroup} open={groups.length < 4 || Boolean(search) ? true : undefined}>
                  <summary><ChevronDown size={14} /><Folder size={15} /><span className={styles.grow} title={workspace}>{workspace ? shortPath(workspace) : 'Conversations'}<small>{count}/{all.length}</small></span><span onClick={event => event.stopPropagation()}><Checkbox checked={count === all.length} mixed={count > 0 && count < all.length} label={`Select ${workspace || 'unassigned conversations'}`} onChange={checked => setProject(workspace, all, checked)} disabled={busy} /></span></summary>
                  {workspace && <p className={styles.projectPath} title={workspace}>{workspace}</p>}
                  {visible.slice(0, 200).map(item => <label className={styles.chatRow} data-selected={isChatSelected(item)} key={item.id}><MessageSquare size={14} /><span className={styles.grow}><strong title={item.name}>{item.name}</strong><small>{item.detail}{item.updatedAt ? ` · ${formatTime(item.updatedAt)}` : ''}</small></span><Checkbox checked={isChatSelected(item)} label={`Import ${item.name}`} onChange={checked => setChat(item, checked)} disabled={busy} /></label>)}
                  {visible.length > 200 && <p className={styles.hint}>Showing 200 conversations. Search to find others, or select the entire project.</p>}
                </details>;
              })}{!visibleGroups.length && <p className={styles.empty}>No matching conversations.</p>}</div>
              <p className={styles.hint}>{selection.chatIds === null ? 'All conversations includes new chats discovered by sync.' : selection.projectPaths?.length ? 'Sync will also include new chats in your selected projects.' : 'Only the selected conversations will be synced.'}</p>
            </div>}
            {!chats.length && <p className={styles.empty}>No readable conversations found in this source.</p>}
          </div>
          <div className={styles.setupHeading}><Settings2 size={16} /><strong>Tools & setup</strong></div>
          {IMPORT_CATEGORIES.filter(category => category !== 'chats').map(category => {
            const items = preview?.items.filter(item => item.category === category && relevantSetup(item)) || [];
            const Icon = CategoryIcon[category];
            return <details className={styles.selectionCard} key={category}>
              <summary className={styles.categoryHeader}>
                <Icon size={18} /><div className={styles.grow}><strong>{CATEGORY_LABELS[category]} <span className={styles.count}>{items.length}</span></strong><p>{CATEGORY_DESCRIPTIONS[category]}</p></div><ChevronDown size={14} />
                <span onClick={event => event.stopPropagation()}><Checkbox checked={selection[category] && items.length > 0} label={`Import ${CATEGORY_LABELS[category]}`} onChange={checked => setSelection(current => ({ ...current, [category]: checked }))} disabled={busy || !items.length} /></span>
              </summary>
              {items.length ? items.map(item => <label className={styles.setupSelection} key={item.id}>
                <div className={styles.grow}><strong>{item.name}</strong><p>{item.detail}{item.workspace ? ` · ${shortPath(item.workspace)}` : ''}</p>{item.compatibilityNote && <p className={styles.warningText}>{item.compatibilityNote}</p>}</div>
                <Checkbox checked={isSetupSelected(item)} label={`Import ${item.name}`} disabled={busy || !selection[category]} onChange={checked => setSelection(current => ({ ...current, excludedIds: checked ? (current.excludedIds || []).filter(id => id !== item.id) : [...(current.excludedIds || []), item.id] }))} />
              </label>) : <p className={styles.empty}>No compatible items found.</p>}
            </details>;
          })}
          <Notices warnings={preview?.warnings || []} />
          <div className={styles.securityNote}><ShieldCheck size={15} /><p>Imported skills use EterX’s tools and permissions. MCP servers stay disconnected until you connect them. Source-app plugins, authentication sessions, and hooks are not activated.</p></div>
        </div>
        <div className={styles.modalFooter}><div className={styles.selectionSummary}><span className={styles.selectionSummaryIcon}><Check size={14} /></span><div><strong>{selectedCount} item{selectedCount === 1 ? '' : 's'} selected</strong><span>{folderName ? `To ${folderName}` : 'To Recents'}</span></div></div><Dialog.Close className={styles.secondary} disabled={busy}>Cancel</Dialog.Close><button type="button" className={styles.primary} disabled={busy || !selectedCount || (destination === '__new__' && !newFolder.trim())} onClick={() => { void run(async () => {
          const data = await importRequest<{ job: ImportJob }>({ action: 'import', previewId: preview?.id, selection, folder: folderName || null });
          await track(data.job);
        }); }}>{busy ? <Loader2 size={15} className={styles.spin} /> : <ArrowDownToLine size={15} />}{busy ? 'Importing…' : 'Import to EterX'}</button></div>
        {error && <p className={styles.modalError} role="alert">{error}</p>}
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </div>;
}
