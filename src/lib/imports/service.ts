import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { getEterxDataDir, getEterxWorkspaceDir } from '../agent/storage-paths';
import { loadChatSnapshot, updateImportedChats } from '../chat-store';
import { visibleUserRequest } from '../chat-user-payload';
import { IMPORT_PRESENTATION_VERSION, mergeImportedAttachments, normalizeImportedTraces } from './presentation';
import { retainImportedMedia } from './media';
import { expandImportedActions } from './source-actions';
import { restoreImportedDiffContext, restoreProjectDiffContext } from './diff-context';
import { getMcpServerRecord, saveMcpServerRecord, type McpServerRecord } from '../connectors/store';
import { detectImportSources, discoverLocal, discoverUploads, type Discovery } from './discovery';
import { digest, frontmatter, string, type ImportItem } from './parsers';
import { IMPORT_CATEGORIES, IMPORT_LABELS, type ImportedSetupEntry, type ImportJob, type ImportPreview, type ImportProvider, type ImportReport, type ImportSelection, type ImportSourceFile, type ImportSourceState, type ImportStatus } from './types';

interface Receipt { fingerprint: string; destination: string; destinationHash?: string; messageHashes?: Record<string, string> }
interface ImportState {
  version: 1;
  autoSync: boolean;
  sources: Partial<Record<ImportProvider, ImportSourceState>>;
  receipts: Record<string, Receipt>;
  instructions: Record<string, { provider: ImportProvider; path: string; workspace?: string; name: string }>;
  setup: Record<string, ImportedSetupEntry>;
  folders: string[];
}
const statePath = () => path.join(getEterxDataDir(), 'imports', 'state.json');
const blankState = (): ImportState => ({ version: 1, autoSync: false, sources: {}, receipts: {}, instructions: {}, setup: {}, folders: [] });
interface ImportRuntime {
  jobs: Map<string, ImportJob>;
  previews: Map<string, { discovery: Discovery; createdAt: number }>;
  queue: Promise<unknown>;
  activeJob?: string;
  lastAutoAttempt: number;
  repairAttempted?: Set<string>;
}
const shared = globalThis as typeof globalThis & { __eterxImports?: ImportRuntime };
const runtime: ImportRuntime = shared.__eterxImports ||= { jobs: new Map(), previews: new Map(), queue: Promise.resolve(), lastAutoAttempt: 0 };

function localWorkspaceResolver(warnings: string[]) {
  const folders = new Map<string, Promise<string | null>>();
  return (candidate: unknown): Promise<string | null> => {
    const raw = typeof candidate === 'string' ? candidate.trim() : '';
    if (!raw || !path.isAbsolute(raw) || /[\r\n\0]/.test(raw)) return Promise.resolve(null);
    const root = path.normalize(raw);
    if (!folders.has(root)) folders.set(root, fs.stat(root).then(stat => {
      if (stat.isDirectory()) return root;
      warnings.push(`The source workspace is not a folder: ${root}. Choose a workspace folder in the chat.`);
      return null;
    }, () => {
      warnings.push(`Workspace folder unavailable: ${root}. Choose its local location in the chat to reconnect.`);
      return null;
    }));
    return folders.get(root)!;
  };
}

const connectedImportWorkspace = (chat: any, sourceRoot: string | null) => chat?.workspaceSelectionUpdatedAt
  ? chat.workspacePath || null : chat?.workspacePath || sourceRoot;

export async function readImportState(): Promise<ImportState> {
  for (const file of [statePath(), `${statePath()}.backup`]) {
    try {
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      if (state.version !== 1 || !state.sources || !state.receipts || !state.instructions) throw new Error('Invalid import state');
      return { ...blankState(), ...state };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && file.endsWith('.backup')) throw new Error('Import preferences could not be read. The existing imports have been preserved.');
      if (file.endsWith('.backup') && await fs.stat(statePath()).then(() => true, () => false)) throw new Error('Import preferences need recovery. Existing imports have been preserved.');
    }
  }
  return blankState();
}

async function atomicWrite(file: string, text: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}
async function writeState(state: ImportState) {
  await fs.mkdir(path.dirname(statePath()), { recursive: true });
  const previous = await fs.readFile(statePath(), 'utf8').catch(() => null);
  if (previous) {
    let valid = false;
    try { const parsed = JSON.parse(previous); valid = parsed.version === 1 && Boolean(parsed.sources && parsed.receipts && parsed.instructions); } catch { }
    if (valid) await atomicWrite(`${statePath()}.backup`, previous);
  }
  await atomicWrite(statePath(), JSON.stringify(state));
}
function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const next = runtime.queue.catch(() => undefined).then(operation);
  runtime.queue = next;
  return next;
}
const prune = () => {
  const now = Date.now();
  for (const [id, item] of runtime.previews) if (now - item.createdAt > 30 * 60_000) runtime.previews.delete(id);
  for (const [id, job] of runtime.jobs) if (job.status !== 'running' && now - (job.finishedAt || job.startedAt) > 30 * 60_000) runtime.jobs.delete(id);
};
function previewOf(id: string, discovery: Discovery): ImportPreview {
  return {
    id, provider: discovery.provider, roots: discovery.roots, warnings: discovery.warnings.slice(0, 100), uploaded: discovery.uploaded, createdAt: Date.now(),
    items: discovery.items.map(({ id, category, name, detail, workspace, updatedAt, count, compatibilityNote }) => ({ id, category, name, detail, workspace, updatedAt, count, compatibilityNote })),
  };
}
function startJob(provider: ImportProvider, kind: ImportJob['kind'], work: (job: ImportJob) => Promise<void>): ImportJob {
  prune();
  const active = runtime.activeJob ? runtime.jobs.get(runtime.activeJob) : undefined;
  if (active?.status === 'running') throw new Error('Another import is in progress. Wait for it to finish.');
  const job: ImportJob = { id: randomUUID(), provider, kind, status: 'running', phase: 'Preparing import', processed: 0, startedAt: Date.now() };
  runtime.jobs.set(job.id, job);
  runtime.activeJob = job.id;
  void exclusive(async () => {
    try { await work(job); job.status = 'complete'; job.phase = kind === 'scan' ? 'Ready to review' : 'Import complete'; }
    catch (error) {
      job.status = 'failed'; job.error = error instanceof Error ? error.message : 'Import failed';
      if (kind !== 'scan') {
        try {
          const state = await readImportState();
          if (state.sources[provider]) { state.sources[provider]!.lastError = job.error; await writeState(state); }
        } catch { /* The job keeps its error even if durable storage is unavailable. */ }
      }
    }
    finally { job.finishedAt = Date.now(); if (runtime.activeJob === job.id) runtime.activeJob = undefined; }
  });
  return { ...job };
}
export const getImportJob = (id: string) => { prune(); return runtime.jobs.get(id) || null; };

export async function getImportStatus(): Promise<ImportStatus> {
  prune();
  const state = await readImportState();
  await repairPreviousImport(state);
  const pending = [...runtime.previews.entries()].at(-1);
  return { autoSync: state.autoSync, sources: state.sources, folders: state.folders, setup: Object.values(state.setup), available: await detectImportSources(), activeJob: runtime.activeJob ? runtime.jobs.get(runtime.activeJob) : undefined, pendingPreview: pending ? { ...previewOf(pending[0], pending[1].discovery), createdAt: pending[1].createdAt } : undefined };
}

/** Upgrade already imported history after adapter changes. Only conversations
 * already present are repaired; saved selections and sync preferences stay put. */
async function repairPreviousImport(state: ImportState) {
  if (runtime.activeJob || !Object.keys(state.sources).length) return;
  runtime.repairAttempted ||= new Set();
  const snapshot = await loadChatSnapshot();
  const oldChats = (snapshot.chats as any[]).filter(chat => chat.importOrigin && chat.importPresentationVersion !== IMPORT_PRESENTATION_VERSION);
  const provider = oldChats.find(chat => !runtime.repairAttempted!.has(`${chat.importOrigin.provider}:${IMPORT_PRESENTATION_VERSION}`))?.importOrigin.provider as ImportProvider | undefined;
  if (!provider || runtime.activeJob) return;
  runtime.repairAttempted.add(`${provider}:${IMPORT_PRESENTATION_VERSION}`);
  startJob(provider, 'import', async job => {
    const report: ImportReport = { provider, created: 0, updated: 0, unchanged: 0, skipped: 0, setup: 0, warnings: [], chatIds: [], savedAt: 0, completedAt: 0 };
    job.phase = 'Repairing imported attachments and activity';
    const selectedChats = oldChats.filter(chat => chat.importOrigin.provider === provider);
    const source = state.sources[provider];
    const sourceItems = new Map<string, ImportItem>();
    if (source && !source.uploaded) {
      try {
        const discovery = await discoverLocal(provider, source.roots, (phase, processed) => { job.phase = phase; job.processed = processed; },
          { chatSourceIds: new Set(selectedChats.map(chat => String(chat.importOrigin.sourceId).toLowerCase())) });
        report.warnings.push(...discovery.warnings.slice(0, 100));
        for (const item of discovery.items) if (item.category === 'chats') sourceItems.set(`import-${item.id}`, item);
      } catch { report.warnings.push('The original source was unavailable. Existing history and locally available attachments were repaired.'); }
    }
    const prepared = new Map<string, any[]>();
    const workspaceRoots = new Map<string, string | null>();
    const resolveWorkspace = localWorkspaceResolver(report.warnings);
    for (const chat of selectedChats) {
      const item = sourceItems.get(chat.id);
      workspaceRoots.set(chat.id, await resolveWorkspace(item?.workspace || chat.importOrigin?.sourceWorkspace));
      const sourceLogs = item ? traceLogs(item, provider) : restoreImportedDiffContext(normalizeImportedTraces(expandImportedActions(chat.traceLogs || [])).filter(log => log.importedFrom));
      for (const log of sourceLogs) log.importRevision = Date.now();
      prepared.set(chat.id, await retainImportedMedia(chat.id, sourceLogs, report.warnings));
      job.processed++;
    }
    job.phase = 'Restoring file positions and project context';
    restoreProjectDiffContext(prepared, snapshot.chats as any[]);
    const latestState = await readImportState();
    const saved = await updateImportedChats(current => {
      let changed = false;
      const chats = current.map(chat => {
        const replacement = prepared.get(chat.id);
        if (!replacement || chat.importPresentationVersion === IMPORT_PRESENTATION_VERSION) return chat;
        const currentLogs = normalizeImportedTraces(chat.traceLogs || []);
        const incoming = new Map(replacement.map(log => [log.id, log]));
        const sourceId = chat.id.replace(/^import-/, '');
        const receipt = latestState.receipts[sourceId];
        const sourceLogs = currentLogs.filter(log => log.importedFrom).map(log => {
          const next = incoming.get(log.id); incoming.delete(log.id);
          if (!next) return log;
          const visible = (value: unknown) => string(value).replace(/#eterx-local-file:[^\s)]+/g, '#saved-file');
          const edited = ['user_action', 'answer', 'work_note'].includes(log.type) && receipt?.messageHashes?.[log.id] && receipt.messageHashes[log.id] !== digest(string(log.text)).slice(0, 16) && visible(log.text) !== visible(next.text);
          return edited ? { ...next, text: log.text, attachments: mergeImportedAttachments(next.attachments || [], log.attachments || []) } : next;
        });
        for (const next of incoming.values()) if (!receipt?.messageHashes?.[next.id]) sourceLogs.push(next);
        if (receipt) {
          const original = sourceItems.get(chat.id);
          if (original) receipt.fingerprint = original.fingerprint;
          receipt.messageHashes = { ...receipt.messageHashes, ...Object.fromEntries(sourceLogs.map(log => [log.id, digest(string(log.text)).slice(0, 16)])) };
        }
        report.updated++; report.chatIds.push(chat.id); changed = true;
        return { ...chat, workspacePath: connectedImportWorkspace(chat, workspaceRoots.get(chat.id) || null), traceLogs: [...sourceLogs, ...currentLogs.filter(log => !log.importedFrom)], importPresentationVersion: IMPORT_PRESENTATION_VERSION,
          importOrigin: { ...chat.importOrigin, syncedAt: Date.now() } };
      });
      return changed ? chats : current;
    });
    report.savedAt = saved.savedAt; report.completedAt = Date.now();
    if (latestState.sources[provider]) latestState.sources[provider]!.lastReport = report;
    await writeState(latestState);
    job.report = report;
  });
}
export function scanImport(provider: ImportProvider, roots: string[] = [], files?: ImportSourceFile[]) {
  return startJob(provider, 'scan', async job => {
    const discovery = files ? discoverUploads(provider, files) : await discoverLocal(provider, roots, (phase, processed) => { job.phase = phase; job.processed = processed; });
    // Keep full payloads on the server. The renderer receives only a manifest.
    runtime.previews.clear();
    runtime.previews.set(job.id, { discovery, createdAt: Date.now() });
    job.preview = previewOf(job.id, discovery);
  });
}

function traceLogs(item: ImportItem, provider: ImportProvider): any[] {
  const chatId = `import-${item.id}`;
  const importRevision = Date.now();
  const fallbackTime = item.updatedAt >= 1e11 ? item.updatedAt : Date.now() - (item.messages?.length || 0);
  let turnId = `${chatId}-start`;
  const logs: any[] = [];
  const calls = new Map<string, any>();
  (item.messages || []).forEach((message, index) => {
    const id = `import-${digest(`${item.id}:${message.id}:${message.role}`).slice(0, 40)}`;
    if (message.role === 'user') turnId = id;
    const tool = message.role === 'tool';
    const at = message.timestamp >= 1e11 ? message.timestamp : fallbackTime + index;
    if (tool && message.toolEvent === 'result' && message.callId && calls.has(message.callId)) {
      const call = calls.get(message.callId);
      call.output = message.text; call.toolResult = message.toolResult ?? message.text; call.endTime = at;
      call.sourceFailed = message.toolFailed;
      call.attachments = mergeImportedAttachments(call.attachments || [], (message.attachments || []).map(item => ({ ...item, origin: 'output' as const })));
      return;
    }
    const log: any = {
      id, ...(message.role === 'assistant' && message.phase !== 'commentary' ? { answerId: id } : {}),
      type: message.role === 'user' ? 'user_action' : tool ? 'tool_call' : message.phase === 'commentary' ? 'work_note' : 'answer',
      text: message.role === 'user' ? visibleUserRequest(message.text) : message.text, timestamp: at, startTime: at, endTime: at,
      chatId, ownerChatId: chatId, turnId, runId: turnId, importedFrom: provider,
      importRevision, workspacePath: item.workspace,
      sourceFailed: message.toolFailed,
      isStreaming: false, streamState: 'closed', status: 'completed',
      phase: message.phase, attachments: (message.attachments || []).map(item => ({ ...item, origin: message.role === 'user' ? 'attachment' : 'output' })),
      ...(tool ? { toolName: message.tool || 'Tool output', tool: message.tool || 'Tool output', toolArgs: message.toolInput || {}, toolCallId: message.callId,
        output: message.toolEvent === 'call' ? undefined : message.text, toolResult: message.toolResult, isComplete: true } : {}),
    };
    if (tool && message.callId) calls.set(message.callId, log);
    logs.push(log);
  });
  return restoreImportedDiffContext(normalizeImportedTraces(expandImportedActions(logs)));
}

async function importSetup(item: ImportItem, provider: ImportProvider, state: ImportState, report: ImportReport) {
  const receipt = state.receipts[item.id];
  if (state.setup[item.id]?.enabled === false && item.category !== 'mcp') { report.skipped++; return; }
  if (receipt?.fingerprint === item.fingerprint) { report.unchanged++; return; }
  let destination = '';
  let destinationHash = '';
  if (item.category === 'mcp') {
    const raw = item.config || {};
    const id = `import-${item.id}`;
    const previous = getMcpServerRecord(id);
    if (previous && (previous.enabled || !receipt || digest(JSON.stringify(previous)) !== receipt.destinationHash)) {
      report.skipped++; report.warnings.push(`${item.name}: kept the MCP configuration edited or connected in EterX.`); return;
    }
    if (!previous && receipt) { report.skipped++; report.warnings.push(`${item.name}: previously removed in EterX; left removed.`); return; }
    const interpolate = (value: string): string => value.replace(/\$\{([^}]+)\}/g, (_, expression: string) => {
      if (expression === 'userHome') return os.homedir();
      if (expression === 'workspaceFolder' && item.workspace) return item.workspace;
      const match = expression.replace(/^env:/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/);
      const resolved = match ? process.env[match[1]] ?? match[2] : undefined;
      if (resolved === undefined) throw new Error(`Set the required environment variable or source setting ${expression} before importing this MCP server.`);
      return resolved;
    });
    const strings = (value: unknown): Record<string, string> => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, value]) => [key, interpolate(value)]));
    const endpoint = interpolate(string(raw.url));
    if (endpoint && !/^https?:\/\//i.test(endpoint)) { report.skipped++; report.warnings.push(`${item.name}: unsupported MCP URL.`); return; }
    const headers = strings(raw.headers || raw.http_headers);
    for (const [header, variable] of Object.entries(strings(raw.env_http_headers))) {
      if (!process.env[variable]) throw new Error(`Set ${variable} in EterX's environment before importing this MCP server.`);
      headers[header] = process.env[variable]!;
    }
    if (string(raw.bearer_token_env_var)) {
      const variable = string(raw.bearer_token_env_var);
      if (!process.env[variable]) throw new Error(`Set ${variable} in EterX's environment before importing this MCP server.`);
      headers.Authorization = `Bearer ${process.env[variable]}`;
    }
    const sourceFolder = item.workspace || (path.isAbsolute(item.sourcePath) ? path.dirname(item.sourcePath.split('#')[0]) : undefined);
    const configuredCwd = interpolate(string(raw.cwd));
    const cwd = configuredCwd ? path.resolve(sourceFolder || os.homedir(), configuredCwd) : sourceFolder;
    let command = interpolate(string(raw.command));
    if (cwd && /^\.\.?[\\/]/.test(command)) command = path.resolve(cwd, command);
    const record: McpServerRecord = {
      id, name: `${item.name} · ${IMPORT_LABELS[provider]}`, transport: endpoint ? 'streamable-http' : 'stdio',
      ...(endpoint ? { endpoint, headers } : { command, cwd, args: Array.isArray(raw.args) ? raw.args.filter((value: unknown): value is string => typeof value === 'string').map(interpolate) : [], env: strings(raw.env) }),
      enabled: false,
    };
    saveMcpServerRecord(record);
    destination = id;
    destinationHash = digest(JSON.stringify(record));
    report.warnings.push(`${item.name}: use Connect in Imported setup to verify tools and authentication.${item.workspace ? ' Connecting makes this server available to EterX; its source workspace is shown for reference.' : ''}`);
  } else {
    const fileName = `${item.id}.md`;
    destination = item.category === 'skills' ? getEterxWorkspaceDir('skills', 'imports', provider, item.id, 'SKILL.md')
      : item.category === 'agents' ? getEterxWorkspaceDir('agent-builder', 'agents', `import-${item.id}`, 'profile.json')
      : path.join(getEterxDataDir(), 'imports', 'instructions', fileName);
    const existing = await fs.readFile(destination, 'utf8').catch(() => null);
    if (receipt && existing === null) { report.skipped++; report.warnings.push(`${item.name}: previously removed in EterX; left removed.`); return; }
    if (existing !== null && (!receipt || digest(existing) !== receipt.destinationHash)) {
      report.skipped++; report.warnings.push(`${item.name}: kept the version edited in EterX.`); return;
    }
    let content = item.content || '';
    if (item.category === 'agents') {
      const { applyAgentBuilderDefaults } = await import('../agent/builder-agent');
      const parsed = frontmatter(content);
      const now = new Date().toISOString();
      content = JSON.stringify(applyAgentBuilderDefaults({
        agentId: `import-${item.id}`, version: 1, createdAt: now, updatedAt: now, status: 'ready',
        name: parsed.name || item.name.replace(/\.md$/i, ''), mission: parsed.description || `Imported ${IMPORT_LABELS[provider]} agent`,
        professionalPrompt: parsed.body, behaviorRules: [], safetyRules: [], skills: [],
        directMainTools: [{ toolName: 'get_skill_guidelines', purpose: 'Load a compatible skill from EterX’s catalog.', whenToUse: 'When the current request calls for that skill.', attachedAt: now }], customTools: [],
        notes: [`Imported from ${IMPORT_LABELS[provider]}: ${item.sourcePath}. Source tool names and permissions use EterX's runtime equivalents.`],
        presentation: { description: parsed.description || `Imported from ${IMPORT_LABELS[provider]}`, category: 'Imported', starterPrompts: [] },
      }));
    } else if (item.category === 'skills') {
      const parsed = frontmatter(content);
      const name = `import_${provider}_${(parsed.name || item.name).replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 50)}_${item.id.slice(-8)}`;
      content = `---\nname: ${name}\ndisplay_name: ${JSON.stringify(parsed.name || item.name)}\ndescription: ${JSON.stringify(parsed.description || `Use the imported ${item.name} workflow when explicitly requested.`)}\nimported_from: ${provider}\n${item.workspace ? `workspace: ${JSON.stringify(item.workspace)}\n` : ''}---\n\n${parsed.body}\n`;
      for (const resource of item.files || []) {
        const parts = resource.name.replace(/\\/g, '/').split('/');
        if (parts.some(part => !part || part === '.' || part === '..' || /[:\0]/.test(part)) || resource.name.toLowerCase() === 'skill.md') continue;
        const target = path.resolve(path.dirname(destination), ...parts);
        if (!target.startsWith(path.dirname(destination) + path.sep)) continue;
        // Resources have individual receipts so locally edited scripts survive sync.
        const key = `${item.id}:asset:${resource.name}`;
        const current = await fs.readFile(target, resource.encoding === 'base64' ? 'base64' : 'utf8').catch(() => null);
        if (current === null && state.receipts[key]) { report.warnings.push(`${item.name}: preserved a removed support file (${resource.name}).`); continue; }
        if (current !== null && digest(current) !== state.receipts[key]?.destinationHash) { report.warnings.push(`${item.name}: preserved an edited support file (${resource.name}).`); continue; }
        await atomicWrite(target, resource.encoding === 'base64' ? Buffer.from(resource.content, 'base64') : resource.content);
        state.receipts[key] = { fingerprint: digest(resource.content), destination: target, destinationHash: digest(resource.content) };
      }
    }
    await atomicWrite(destination, content);
    destinationHash = digest(content);
    if (item.category === 'instructions') state.instructions[item.id] = { provider, path: destination, workspace: item.workspace, name: item.name };
  }
  state.receipts[item.id] = { fingerprint: item.fingerprint, destination, destinationHash };
  if (item.category !== 'chats') state.setup[item.id] = { id: item.id, provider, category: item.category, name: item.name, destination, enabled: item.category !== 'mcp' && !item.compatibilityNote, workspace: item.workspace, compatibilityNote: item.compatibilityNote };
  if (item.compatibilityNote) report.warnings.push(`${item.name}: ${item.compatibilityNote}`);
  report.setup++;
}

async function commitDiscovery(discovery: Discovery, selection: ImportSelection, job: ImportJob, folder?: string | null): Promise<ImportReport> {
  const state = await readImportState();
  const provider = discovery.provider;
  const report: ImportReport = { provider, created: 0, updated: 0, unchanged: 0, skipped: 0, setup: 0, warnings: [...discovery.warnings], chatIds: [], savedAt: 0, completedAt: 0 };
  const selectedIds = selection.chatIds ? new Set(selection.chatIds) : null;
  const excludedIds = new Set(selection.excludedIds || []);
  const selectedWorkspaces = new Set(discovery.items.filter(item => item.category === 'chats' && (!selectedIds || selectedIds.has(item.id) || Boolean(item.workspace && selection.projectPaths?.includes(item.workspace)))).map(item => item.workspace));
  const selected = discovery.items.filter(item => selection[item.category] && !excludedIds.has(item.id)
    && (item.category !== 'chats' || !selectedIds || selectedIds.has(item.id) || Boolean(item.workspace && selection.projectPaths?.includes(item.workspace)))
    && (item.category === 'chats' || !item.workspace || !selection.chats || !selectedIds || selectedWorkspaces.has(item.workspace)));
  const chatItems = selected.filter(item => item.category === 'chats');
  const preparedChats = new Map<string, any[]>();
  const workspaceRoots = new Map<string, string | null>();
  const resolveWorkspace = localWorkspaceResolver(report.warnings);
  for (const item of chatItems) {
    workspaceRoots.set(item.id, await resolveWorkspace(item.workspace));
    if (state.receipts[item.id]?.fingerprint === item.fingerprint) continue;
    job.phase = `Retaining attachments for ${item.name}`;
    preparedChats.set(item.id, await retainImportedMedia(`import-${item.id}`, traceLogs(item, provider), report.warnings));
  }
  const projectHistories = new Map([...preparedChats].map(([id, logs]) => [`import-${id}`, logs]));
  restoreProjectDiffContext(projectHistories, (await loadChatSnapshot()).chats as any[]);
  for (const [id, logs] of projectHistories) preparedChats.set(id.replace(/^import-/, ''), logs);
  job.phase = 'Saving conversations';
  const snapshot = await updateImportedChats(current => {
    const byId = new Map(current.map(chat => [chat.id, chat]));
    let changed = false;
    for (const item of chatItems) {
      const id = `import-${item.id}`;
      const existing = byId.get(id);
      const receipt = state.receipts[item.id];
      const workspacePath = connectedImportWorkspace(existing, workspaceRoots.get(item.id) || null);
      if (!existing && receipt) { report.skipped++; report.warnings.push(`${item.name}: previously deleted in EterX; left deleted.`); continue; }
      if (existing && receipt?.fingerprint === item.fingerprint) {
        // An explicit re-import may reorganize existing chats without changing their transcript.
        const folderChanged = job.kind === 'import' && (existing.importFolder || null) !== (folder || null);
        if (folderChanged || (existing.workspacePath || null) !== workspacePath) {
          byId.set(id, { ...existing, workspacePath, ...(folderChanged ? { importFolder: folder || undefined } : {}) }); changed = true;
          report.updated++; report.chatIds.push(id);
        } else report.unchanged++;
        continue;
      }
      if (existing && existing.importOrigin?.sourceId !== item.sourceId) { report.skipped++; report.warnings.push(`${item.name}: a conflicting local chat was preserved.`); continue; }
      const imported = preparedChats.get(item.id) || traceLogs(item, provider);
      const incoming = new Map(imported.map(log => [log.id, log]));
      const messageHashes = { ...receipt?.messageHashes };
      // Keep old source records if the source was truncated or compacted. Add new
      // source messages before the EterX continuation, preserving local order.
      const oldSource = (existing?.traceLogs || []).filter((log: any) => log.importedFrom === provider);
      let preservedEdit = false;
      const mergedSource = oldSource.map((log: any) => {
        const next = incoming.get(log.id); incoming.delete(log.id);
        if (!next) return log;
        if (['user_action', 'answer', 'work_note'].includes(log.type) && messageHashes[log.id] && messageHashes[log.id] !== digest(string(log.text)).slice(0, 16)) { preservedEdit = true; return { ...log, importRevision: next.importRevision }; }
        messageHashes[log.id] = digest(string(next.text)).slice(0, 16);
        return next;
      });
      for (const next of incoming.values()) {
        // A previously imported message missing from the durable chat was
        // removed locally. Do not restore it during a later source update.
        if (receipt?.messageHashes?.[next.id]) continue;
        mergedSource.push(next); messageHashes[next.id] = digest(string(next.text)).slice(0, 16);
      }
      if (preservedEdit) report.warnings.push(`${item.name}: preserved conversation text edited in EterX.`);
      const local = (existing?.traceLogs || []).filter((log: any) => log.importedFrom !== provider);
      const now = Date.now();
      byId.set(id, {
        ...existing, id,
        title: existing && existing.title !== existing.importOrigin?.sourceTitle ? existing.title : item.name,
        titleState: existing?.titleState === 'manual' ? 'manual' : 'generated',
        titleUpdatedAt: existing && existing.title !== existing.importOrigin?.sourceTitle ? existing.titleUpdatedAt : now,
        updatedAt: Math.max(existing?.updatedAt || 0, item.updatedAt >= 1e11 ? item.updatedAt : now),
        workspacePath,
        runLocation: existing?.runLocation || 'local', traceLogs: [...mergedSource, ...local],
        importPresentationVersion: IMPORT_PRESENTATION_VERSION,
        importFolder: existing && job.kind !== 'import' ? existing.importFolder : folder || undefined,
        importOrigin: { provider, sourceId: item.sourceId, importedAt: existing?.importOrigin?.importedAt || now, syncedAt: now, sourceUpdatedAt: item.updatedAt, sourceTitle: item.name, sourceWorkspace: item.workspace },
      });
      state.receipts[item.id] = { fingerprint: item.fingerprint, destination: id, messageHashes };
      report[existing ? 'updated' : 'created']++;
      report.chatIds.push(id);
      changed = true;
    }
    return changed ? [...byId.values()] : current;
  });
  report.savedAt = snapshot.savedAt;
  // Journal chat receipts immediately: a setup failure can be retried safely.
  await writeState(state);
  for (const item of selected.filter(item => item.category !== 'chats')) {
    job.phase = `Importing ${item.name}`;
    job.processed++;
    try { await importSetup(item, provider, state, report); }
    catch (error) { report.skipped++; report.warnings.push(`${item.name}: ${error instanceof Error ? error.message : 'could not be imported'}`); }
    await writeState(state);
  }
  report.completedAt = Date.now();
  report.warnings = [...new Set(report.warnings)].slice(0, 100);
  const previousSource = state.sources[provider];
  state.sources[provider] = discovery.uploaded && previousSource && !previousSource.uploaded ? { ...previousSource, lastReport: report } : {
    provider, roots: discovery.roots, selection, uploaded: discovery.uploaded,
    enabled: !discovery.uploaded && (state.sources[provider]?.enabled ?? true), folder: folder || null, lastSyncAt: report.completedAt, lastReport: report,
  };
  if (folder && !state.folders.includes(folder)) state.folders.push(folder);
  await writeState(state);
  return report;
}

export function applyImport(previewId: string, selection: ImportSelection, folder?: string | null) {
  prune();
  const staged = runtime.previews.get(previewId);
  if (!staged) throw new Error('This preview expired or the server restarted. Scan again to refresh it.');
  if (!IMPORT_CATEGORIES.some(category => selection[category])) throw new Error('Select at least one category.');
  return startJob(staged.discovery.provider, 'import', async job => {
    job.report = await commitDiscovery(staged.discovery, selection, job, folder);
    runtime.previews.delete(previewId);
  });
}

export async function configureImports(update: { autoSync?: boolean; provider?: ImportProvider; enabled?: boolean; selection?: ImportSelection }) {
  return exclusive(async () => {
    const state = await readImportState();
    if (typeof update.autoSync === 'boolean') state.autoSync = update.autoSync;
    if (update.provider) {
      const source = state.sources[update.provider];
      if (!source) throw new Error('Import this source before configuring sync.');
      if (typeof update.enabled === 'boolean') source.enabled = !source.uploaded && update.enabled;
      if (update.selection) source.selection = update.selection;
    }
    await writeState(state);
    return { autoSync: state.autoSync, sources: state.sources };
  });
}

export async function syncImports(provider?: ImportProvider, automatic = false): Promise<ImportJob | null> {
  const active = runtime.activeJob ? runtime.jobs.get(runtime.activeJob) : undefined;
  if (active?.status === 'running') return active;
  const state = await readImportState();
  prune();
  if (automatic && runtime.previews.size > 0) return null;
  if (automatic && (!state.autoSync || Date.now() - runtime.lastAutoAttempt < 10_000)) return null;
  const source = Object.values(state.sources).filter((value): value is ImportSourceState => Boolean(value))
    .filter(value => !value.uploaded && (!provider || value.provider === provider) && (!automatic || value.enabled))
    .sort((a, b) => (a.lastSyncAt || 0) - (b.lastSyncAt || 0))
    .find(value => !automatic || Date.now() - (value.lastSyncAt || 0) >= 30_000);
  if (!source) return null;
  runtime.lastAutoAttempt = Date.now();
  return startJob(source.provider, 'sync', async job => {
    try {
      // A settings update may have been queued while eligibility was read.
      const latestState = await readImportState();
      const latest = latestState.sources[source.provider];
      if (!latest || latest.uploaded || (automatic && (!latestState.autoSync || !latest.enabled))) return;
      const discovery = await discoverLocal(source.provider, latest.roots, (phase, processed) => { job.phase = phase; job.processed = processed; });
      job.report = await commitDiscovery(discovery, latest.selection, job, latest.folder);
    } catch (error) {
      const failedState = await readImportState();
      if (failedState.sources[source.provider]) {
        failedState.sources[source.provider]!.lastError = error instanceof Error ? error.message : 'Sync failed';
        failedState.sources[source.provider]!.lastSyncAt = Date.now();
        await writeState(failedState);
      }
      throw error;
    }
  });
}

export function discardImportPreview(id: string) { runtime.previews.delete(id); }

export async function toggleImportedSetup(id: string, enabled: boolean) {
  return exclusive(async () => {
    const state = await readImportState();
    const entry = state.setup[id];
    if (!entry) throw new Error('Imported setup item not found.');
    if (entry.category === 'mcp') {
      const server = getMcpServerRecord(entry.destination);
      if (!server) throw new Error('This MCP server was removed. Import it again to reconnect.');
      if (enabled) {
        const { listConnectedMcpTools } = await import('../connectors/runtime');
        await listConnectedMcpTools(server.id, { allowDisabled: true });
      }
      const saved = saveMcpServerRecord({ ...server, enabled, lastCheckedAt: Date.now(), lastError: undefined, ...(enabled ? { connectedAt: Date.now() } : {}) });
      state.receipts[id].destinationHash = digest(JSON.stringify(saved));
    } else if (entry.category === 'agents') {
      const profile = JSON.parse(await fs.readFile(entry.destination, 'utf8'));
      profile.status = enabled ? 'ready' : 'draft';
      const text = JSON.stringify(profile);
      await atomicWrite(entry.destination, text);
      state.receipts[id].destinationHash = digest(text);
    }
    entry.enabled = enabled;
    await writeState(state);
    return entry;
  });
}
