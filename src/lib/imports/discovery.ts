import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openReadonlyDatabase, type ReadonlyDatabase } from './sqlite-reader';
import { readCompressedTranscript, TranscriptSizeLimit } from './compressed-transcript';
import { IMPORT_PROVIDERS, type ImportProvider, type ImportSourceFile } from './types';
import { digest, object, string, parseJsonExport, parseJsonLines, parseTextTranscript, parseCodexConfig, setupItem, type ImportItem } from './parsers';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 20000;
type Progress = (phase: string, processed: number) => void;
export interface Discovery {
  provider: ImportProvider;
  roots: string[];
  items: ImportItem[];
  warnings: string[];
  uploaded: boolean;
}
const localPath = (value: string) => path.isAbsolute(value) && !/^\\\\|^\/\//.test(value) && !value.includes('\0');
const directoryExists = async (value: string) => localPath(value) && await fs.stat(value).then(stat => stat.isDirectory(), () => false);

export async function detectImportSources() {
  const home = os.homedir();
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const appData = process.platform === 'win32' ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : configHome;
  const candidates: Record<ImportProvider, string[]> = {
    codex: [process.env.CODEX_HOME || path.join(home, '.codex')],
    claude: [process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')],
    cursor: [path.join(home, '.cursor'), path.join(appData, 'Cursor', 'User')],
  };
  const result = {} as Record<ImportProvider, { roots: string[]; detected: boolean }>;
  for (const provider of IMPORT_PROVIDERS) {
    const roots: string[] = [];
    for (const candidate of candidates[provider]) if (await directoryExists(candidate)) roots.push(path.resolve(candidate));
    result[provider] = { roots: [...new Set(roots)], detected: roots.length > 0 };
  }
  return result;
}

export async function validateImportRoots(values: string[]): Promise<string[]> {
  if (values.length > 8) throw new Error('Choose at most eight source folders.');
  const roots: string[] = [];
  for (const value of values) {
    const expanded = value.startsWith('~/') || value.startsWith('~\\') ? path.join(os.homedir(), value.slice(2)) : value;
    if (!localPath(expanded)) throw new Error('Use an absolute local folder path. Network locations are not supported.');
    const stat = await fs.lstat(expanded).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`Source folder is unavailable: ${expanded}`);
    roots.push(await fs.realpath(expanded));
  }
  return [...new Set(roots)];
}

/** Only known transcript and setup paths are visited; credentials and source code are not crawled. */
export async function discoverLocal(provider: ImportProvider, requestedRoots: string[], progress: Progress, options: { chatSourceIds?: Set<string> } = {}): Promise<Discovery> {
  const detected = await detectImportSources();
  const roots = await validateImportRoots(requestedRoots.length ? requestedRoots : detected[provider].roots);
  if (!roots.length) throw new Error(`No local ${provider} data found. Choose its data folder or import an export file.`);
  const result: Discovery = { provider, roots, items: [], warnings: [], uploaded: false };
  let bytes = 0;
  let files = 0;
  let limitReported = false;
  const visited = new Set<string>();
  const projects = new Set<string>();
  const memories = new Map<string, string>();
  const titles = new Map<string, string>();
  const warning = (text: string) => { if (result.warnings.length < 100 && !result.warnings.includes(text)) result.warnings.push(text); };
  const read = async (file: string, binary = false): Promise<{ text: string; modified: number } | null> => {
    if (visited.has(file)) return null;
    visited.add(file);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (stat.size > MAX_FILE_BYTES) { warning(`${path.basename(file)} exceeds the 64 MB file limit and was skipped. Export smaller conversations to include it.`); return null; }
    if (++files > MAX_FILES || bytes + stat.size > MAX_SCAN_BYTES) {
      if (!limitReported) warning('This scan reached the 20,000-file / 512 MB limit. Select a more specific source folder to import the remaining content.');
      limitReported = true;
      return null;
    }
    bytes += stat.size;
    progress(`Reading ${provider} data`, files);
    const compressed = provider === 'codex' && /\.jsonl\.zst$/i.test(file);
    const expandedLimit = Math.min(MAX_FILE_BYTES, MAX_SCAN_BYTES - bytes + stat.size);
    try {
      if (compressed) {
        const content = await readCompressedTranscript(file, expandedLimit);
        bytes += Math.max(0, content.byteLength - stat.size);
        return { text: content.toString('utf8'), modified: stat.mtimeMs };
      }
      return { text: await fs.readFile(file, binary ? 'base64' : 'utf8'), modified: stat.mtimeMs };
    } catch (error) {
      if (error instanceof TranscriptSizeLimit) {
        bytes += Math.max(0, expandedLimit - stat.size);
        limitReported ||= bytes >= MAX_SCAN_BYTES;
      }
      warning(compressed ? `Could not read ${path.basename(file)}: ${error instanceof Error ? error.message : 'Invalid compressed transcript.'}`
        : `Could not read ${path.basename(file)}. Check its file permissions and scan again.`);
      return null;
    }
  };
  const walk = async (folder: string, accept: (file: string) => Promise<void>, extensions: RegExp, depth = 0): Promise<void> => {
    if (depth > 9 || limitReported) return;
    const entries = (await fs.readdir(folder, { withFileTypes: true }).catch(() => [])).sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ['node_modules', '.git', 'cache', '.cache'].includes(entry.name)) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file, accept, extensions, depth + 1);
      else if (entry.isFile() && extensions.test(entry.name)) await accept(file);
      if (limitReported) break;
    }
  };
  const transcript = async (file: string) => {
    // Repairs revisit selected conversations before spending the scan budget
    // on unrelated archives. Codex names rollouts with their stable session ID.
    const sessionId = provider === 'codex' ? path.basename(file).match(/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl(?:\.zst)?$/i)?.[1] : undefined;
    if (sessionId && options.chatSourceIds && !options.chatSourceIds.has(sessionId.toLowerCase())) return;
    const data = await read(file);
    if (!data) return;
    let items: ImportItem[] = [];
    if (/\.jsonl(?:\.zst)?$/i.test(file)) items = parseJsonLines(provider, data.text, file, data.modified, result.warnings);
    else if (/\.json$/i.test(file)) {
      try { items = parseJsonExport(provider, JSON.parse(data.text), file, data.modified); }
      catch { warning(`${path.basename(file)} contains invalid JSON and was skipped.`); }
    } else items = parseTextTranscript(provider, data.text, file, data.modified);
    for (const item of items) if (item.workspace && localPath(item.workspace)) {
      projects.add(item.workspace);
      if (provider === 'claude') {
        let folder = path.dirname(file);
        while (folder !== path.dirname(folder) && path.basename(path.dirname(folder)) !== 'projects') folder = path.dirname(folder);
        if (path.basename(path.dirname(folder)) === 'projects') memories.set(path.join(folder, 'memory'), item.workspace);
      }
    }
    result.items.push(...items);
  };
  const setup = async (file: string, category: 'instructions' | 'skills' | 'agents', workspace?: string) => {
    const data = await read(file);
    if (!data?.text.trim()) return;
    const item = setupItem(provider, category, file, data.text, data.modified, workspace);
    if (category === 'skills' && path.basename(file).toLowerCase() === 'skill.md') {
      // Retain support resources with the skill. Nothing here is executed.
      const resourceRoot = path.dirname(file);
      item.files = [];
      await walk(resourceRoot, async resource => {
        if (resource === file) return;
        const binary = /\.(png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|otf|docx|xlsx|pptx|mp3|wav|mp4)$/i.test(resource);
        const asset = await read(resource, binary);
        if (asset) item.files!.push({ name: path.relative(resourceRoot, resource).replace(/\\/g, '/'), content: asset.text, ...(binary ? { encoding: 'base64' as const } : {}) });
      }, /\.(md|txt|json|ya?ml|toml|py|js|mjs|cjs|tsx?|jsx|sh|ps1|csv|html|css|svg|png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|otf|docx|xlsx|pptx|mp3|wav|mp4)$/i);
      item.files.sort((a, b) => a.name.localeCompare(b.name));
      item.fingerprint = digest(JSON.stringify([item.fingerprint, item.files]));
    }
    result.items.push(item);
  };
  const configuration = async (file: string, workspace?: string) => {
    const data = await read(file);
    if (!data) return;
    let config: Record<string, any>;
    try {
      if (/\.toml$/i.test(file)) {
        const parsed = parseCodexConfig(data.text);
        config = parsed.config;
        if (parsed.unsupported) warning(`${path.basename(file)}: ${parsed.unsupported} unsupported TOML value(s) were left out.`);
      } else config = object(JSON.parse(data.text));
    } catch { warning(`${path.basename(file)} could not be parsed; other items are still available.`); return; }
    const addMcp = (servers: unknown, scope?: string) => {
      for (const [name, raw] of Object.entries(object(servers))) {
        const server = object(raw);
        if (server.type === 'sse') { warning(`${name}: legacy SSE transport is not supported by EterX; add a Streamable HTTP endpoint in MCP settings.`); continue; }
        if (!string(server.command) && !string(server.url)) continue;
        result.items.push(setupItem(provider, 'mcp', `${file}#${scope || ''}:${name}`, '', data.modified, scope, name, server));
      }
    };
    addMcp(config.mcpServers || config.mcp_servers, workspace);
    if (file.endsWith('.claude.json')) for (const [folder, raw] of Object.entries(object(config.projects))) {
      if (localPath(folder)) projects.add(folder);
      addMcp(object(raw).mcpServers, folder);
    }
    for (const field of ['developer_instructions', 'user_instructions', 'instructions']) {
      if (string(config[field]).trim()) result.items.push(setupItem(provider, 'instructions', `${file}#${field}`, string(config[field]), data.modified, workspace, `${provider} instructions`));
    }
    if (provider === 'codex') for (const [name, raw] of Object.entries(object(config.agents))) {
      const agent = object(raw);
      if (!string(agent.config_file)) continue;
      const agentPath = path.resolve(path.dirname(file), string(agent.config_file));
      if (!localPath(agentPath)) continue;
      const data = await read(agentPath);
      if (!data) continue;
      const parsed = parseCodexConfig(data.text);
      const prompt = string(parsed.config.developer_instructions);
      if (prompt) result.items.push(setupItem(provider, 'agents', agentPath, `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(string(agent.description))}\n---\n\n${prompt}`, data.modified, workspace));
      if (parsed.unsupported) warning(`${name}: unsupported agent settings were left out. EterX supplies model and tool permissions.`);
    }
    if (config.enabledPlugins || config.plugins) warning('Plugin-specific hooks, extension binaries, account sessions, and permission policies are not portable. Compatible local skills and MCP definitions are listed separately.');
  };
  for (const root of roots) {
    progress('Discovering chats and setup', files);
    if (provider === 'codex') {
      const index = await read(path.join(root, 'session_index.jsonl'));
      if (index) for (const line of index.text.split(/\r?\n/)) {
        try { const entry = object(JSON.parse(line)); if (entry.id && entry.thread_name) titles.set(string(entry.id), string(entry.thread_name)); } catch { /* Append-only indexes can end with an incomplete line. */ }
      }
      await walk(path.join(root, 'sessions'), transcript, /\.jsonl(?:\.zst)?$/i);
      await walk(path.join(root, 'archived_sessions'), transcript, /\.jsonl(?:\.zst)?$/i);
      // Also accept a selected sessions/date folder.
      if (/sessions|^\d{2,4}$/.test(path.basename(root))) await walk(root, transcript, /\.jsonl(?:\.zst)?$/i);
      await configuration(path.join(root, 'config.toml'));
      for (const file of ['AGENTS.md', 'AGENTS.override.md']) await setup(path.join(root, file), 'instructions');
      await walk(path.join(root, 'skills'), file => setup(file, 'skills'), /^SKILL\.md$/i);
      if (path.basename(root) === '.codex') await walk(path.join(path.dirname(root), '.agents', 'skills'), file => setup(file, 'skills'), /^SKILL\.md$/i);
      await walk(path.join(root, 'agents'), file => setup(file, 'agents'), /\.md$/i);
      await walk(path.join(root, 'plugins', 'cache'), async file => {
        if (path.basename(file).toLowerCase() === 'skill.md') await setup(file, 'skills');
      }, /^SKILL\.md$/i);
    } else if (provider === 'claude') {
      await walk(path.join(root, 'projects'), transcript, /\.jsonl$/i);
      if (path.basename(root) === 'projects' || path.basename(path.dirname(root)) === 'projects') await walk(root, transcript, /\.jsonl$/i);
      await setup(path.join(root, 'CLAUDE.md'), 'instructions');
      await walk(path.join(root, 'rules'), file => setup(file, 'instructions'), /\.md$/i);
      await configuration(path.join(root, 'settings.json'));
      await configuration(path.join(path.dirname(root), '.claude.json'));
      await walk(path.join(root, 'agents'), file => setup(file, 'agents'), /\.md$/i);
      await walk(path.join(root, 'skills'), file => setup(file, 'skills'), /^SKILL\.md$/i);
      await walk(path.join(root, 'commands'), file => setup(file, 'skills'), /\.md$/i);
      await walk(path.join(root, 'plugins', 'cache'), async file => {
        if (path.basename(file).toLowerCase() === 'skill.md') await setup(file, 'skills');
        else if (/[\\/]agents[\\/]/.test(file)) await setup(file, 'agents');
      }, /\.md$/i);
    } else {
      await walk(path.join(root, 'projects'), async file => {
        if (/[\\/]agent-transcripts[\\/]/.test(file)) await transcript(file);
      }, /\.(jsonl|txt|md)$/i);
      if (path.basename(root) === 'agent-transcripts') await walk(root, transcript, /\.(jsonl|txt|md)$/i);
      await configuration(path.join(root, 'mcp.json'));
      await walk(path.join(root, 'rules'), file => setup(file, 'instructions'), /\.(md|mdc)$/i);
      await walk(path.join(root, 'skills'), file => setup(file, 'skills'), /^SKILL\.md$/i);
      await walk(path.join(root, 'agents'), file => setup(file, 'agents'), /\.md$/i);
      const cursor = await discoverCursorDatabase(root, progress);
      result.items.push(...cursor.items);
      cursor.warnings.forEach(warning);
      cursor.projects.forEach(folder => projects.add(folder));
    }
  }
  for (const [folder, workspace] of memories) await walk(folder, file => setup(file, 'instructions', workspace), /\.md$/i);
  // Project configuration is read only at verified local workspace paths.
  for (const project of [...projects].slice(0, 500)) {
    if (!await directoryExists(project)) continue;
    if (provider === 'codex') {
      await setup(path.join(project, 'AGENTS.md'), 'instructions', project);
      await setup(path.join(project, 'AGENTS.override.md'), 'instructions', project);
      await configuration(path.join(project, '.codex', 'config.toml'), project);
      await walk(path.join(project, '.agents', 'skills'), file => setup(file, 'skills', project), /^SKILL\.md$/i);
      await walk(path.join(project, '.codex', 'skills'), file => setup(file, 'skills', project), /^SKILL\.md$/i);
    } else if (provider === 'claude') {
      for (const file of ['CLAUDE.md', '.claude/CLAUDE.md']) await setup(path.join(project, file), 'instructions', project);
      await configuration(path.join(project, '.mcp.json'), project);
      await walk(path.join(project, '.claude', 'rules'), file => setup(file, 'instructions', project), /\.md$/i);
      await walk(path.join(project, '.claude', 'skills'), file => setup(file, 'skills', project), /^SKILL\.md$/i);
      await walk(path.join(project, '.claude', 'agents'), file => setup(file, 'agents', project), /\.md$/i);
    } else {
      await setup(path.join(project, '.cursorrules'), 'instructions', project);
      await setup(path.join(project, 'AGENTS.md'), 'instructions', project);
      await walk(path.join(project, '.cursor', 'rules'), file => setup(file, 'instructions', project), /\.(md|mdc)$/i);
      await walk(path.join(project, '.cursor', 'skills'), file => setup(file, 'skills', project), /^SKILL\.md$/i);
      await walk(path.join(project, '.cursor', 'agents'), file => setup(file, 'agents', project), /\.md$/i);
      await configuration(path.join(project, '.cursor', 'mcp.json'), project);
    }
  }
  if (projects.size > 500) warning('Project setup discovery is limited to 500 workspaces per scan. Chat history is still included.');
  const unique = new Map<string, ImportItem>();
  for (const item of result.items) {
    const title = item.category === 'chats' && titles.get(item.sourceId);
    if (title) { item.name = title.slice(0, 200); item.fingerprint = digest(JSON.stringify([title, item.fingerprint])); }
    const previous = unique.get(item.id);
    if (!previous || item.updatedAt >= previous.updatedAt || (item.messages?.length || 0) > (previous.messages?.length || 0)) unique.set(item.id, item);
  }
  result.items = [...unique.values()];
  if (result.items.some(item => item.messages?.some(message => message.attachments?.some(file => file.unavailable)))) warning('Some source attachments have no local file or embedded content. Their cards are retained; missing originals can be reattached.');
  return result;
}

async function discoverCursorDatabase(root: string, progress: Progress) {
  const result: { items: ImportItem[]; warnings: string[]; projects: string[] } = { items: [], warnings: [], projects: [] };
  const dbPath = path.join(root, 'globalStorage', 'state.vscdb');
  if (!await fs.stat(dbPath).then(stat => stat.isFile(), () => false)) return result;
  let db: ReadonlyDatabase | undefined;
  try {
    db = openReadonlyDatabase(dbPath);
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(row => row.name));
    const table = tables.has('cursorDiskKV') ? 'cursorDiskKV' : tables.has('ItemTable') ? 'ItemTable' : null;
    if (!table) throw new Error('Unsupported database schema');
    const workspaces = new Map<string, string>();
    const dirs = await fs.readdir(path.join(root, 'workspaceStorage'), { withFileTypes: true }).catch(() => []);
    for (const dir of dirs.slice(0, 1000)) {
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      const folder = path.join(root, 'workspaceStorage', dir.name);
      let workspace = '';
      try {
        const meta = JSON.parse(await fs.readFile(path.join(folder, 'workspace.json'), 'utf8'));
        if (String(meta.folder || '').startsWith('file:')) workspace = fileURLToPath(meta.folder);
      } catch { /* Workspace may be remote or have been removed. */ }
      if (!workspace || !localPath(workspace)) continue;
      result.projects.push(workspace);
      let workspaceDb: ReadonlyDatabase | undefined;
      try {
        workspaceDb = openReadonlyDatabase(path.join(folder, 'state.vscdb'));
        for (const key of ['composer.composerData', 'composer.composerHeaders']) {
          const row = workspaceDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
          const index = row ? JSON.parse(row.value instanceof Uint8Array ? Buffer.from(row.value).toString('utf8') : String(row.value)) : {};
          const headers = Array.isArray(index) ? index : index.allComposers || index.headers || [];
          for (const entry of headers) if (entry.composerId) workspaces.set(entry.composerId, workspace);
        }
      } catch { /* Global conversations remain importable without workspace metadata. */ }
      finally { workspaceDb?.close(); }
    }
    const parse = (value: unknown) => object(JSON.parse(value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : String(value)));
    const lookup = db.prepare(`SELECT value FROM ${table} WHERE key = ? AND length(value) <= ${MAX_FILE_BYTES}`);
    let bytes = 0;
    let count = 0;
    for (const row of db.prepare(`SELECT key, value FROM ${table} WHERE key LIKE 'composerData:%' AND length(value) <= ${MAX_FILE_BYTES} LIMIT ${MAX_FILES + 1}`).iterate()) {
      if (++count > MAX_FILES || (bytes += Buffer.byteLength(String(row.value))) > MAX_SCAN_BYTES) { result.warnings.push('Cursor database scan reached its size limit. Export remaining chats as Markdown or JSON.'); break; }
      progress('Reading Cursor conversations', count);
      try {
        const composer = parse(row.value);
        const id = string(composer.composerId) || String(row.key).slice('composerData:'.length);
        let conversation = Array.isArray(composer.conversation) ? composer.conversation : [];
        if (!conversation.length && Array.isArray(composer.fullConversationHeadersOnly)) {
          for (const header of composer.fullConversationHeadersOnly) {
            const bubble = lookup.get(`bubbleId:${id}:${header.bubbleId}`);
            if (!bubble) continue;
            bytes += bubble.value instanceof Uint8Array ? bubble.value.byteLength : Buffer.byteLength(String(bubble.value));
            if (bytes > MAX_SCAN_BYTES || conversation.length >= MAX_FILES) { result.warnings.push('A Cursor conversation reached the scan limit. Export that conversation separately to include the rest.'); break; }
            try { conversation.push({ ...parse(bubble.value), bubbleId: header.bubbleId }); } catch { /* Other messages remain importable. */ }
          }
        }
        const chats = parseJsonExport('cursor', { ...composer, composerId: id, conversation, workspacePath: workspaces.get(id) || composer.workspacePath }, dbPath, Number(composer.lastUpdatedAt || composer.createdAt || 0));
        result.items.push(...chats);
        if (!chats.length && (composer.conversationState || composer.fullConversationHeadersOnly?.length)) result.warnings.push(`${string(composer.name) || 'Cursor conversation'} uses a format without readable message text. Import its Markdown export to retain the conversation.`);
      } catch { result.warnings.push('A malformed Cursor conversation was skipped.'); }
      // Yield between database records so chat polling and progress requests stay responsive.
      if (count % 20 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  } catch (error) {
    result.warnings.push(`Cursor's local database could not be read (${error instanceof Error ? error.message : 'unavailable'}). Text transcripts and exported chats can still be imported.`);
  } finally { db?.close(); }
  return result;
}

export function discoverUploads(provider: ImportProvider, files: ImportSourceFile[]): Discovery {
  const result: Discovery = { provider, roots: [], items: [], warnings: [], uploaded: true };
  const normalized = files.map(file => ({ ...file, name: file.name.replace(/\\/g, '/') }));
  const skills = normalized.filter(file => /(?:^|\/)SKILL\.md$/i.test(file.name) && !file.encoding);
  const resources = new Set<string>();
  for (const file of skills) {
    const item = setupItem(provider, 'skills', file.name, file.content, 0);
    const prefix = file.name.slice(0, file.name.lastIndexOf('/') + 1);
    item.files = normalized.filter(resource => resource.name !== file.name && (prefix ? resource.name.startsWith(prefix) : /^(scripts|references|assets|templates|examples)\//.test(resource.name)) && !skills.some(other => other !== file && resource.name.startsWith(other.name.slice(0, other.name.lastIndexOf('/') + 1))))
      .map(resource => { resources.add(resource.name); return { ...resource, name: resource.name.slice(prefix.length) }; }).sort((a, b) => a.name.localeCompare(b.name));
    resources.add(file.name);
    item.fingerprint = digest(JSON.stringify([item.fingerprint, item.files]));
    result.items.push(item);
  }
  for (const file of normalized) {
    const name = file.name;
    if (resources.has(name) || file.encoding) continue;
    const modified = 0; // Stable fallback keeps re-uploading the same export idempotent.
    if (/\.jsonl$/i.test(name)) result.items.push(...parseJsonLines(provider, file.content, name, modified, result.warnings));
    else if (/\.(json|toml)$/i.test(name)) {
      try {
        const parsed = /\.toml$/i.test(name) ? parseCodexConfig(file.content) : { config: JSON.parse(file.content), unsupported: 0 };
        const config = object(parsed.config);
        result.items.push(...parseJsonExport(provider, parsed.config, name, modified));
        if (parsed.unsupported) result.warnings.push(`${name}: unsupported TOML settings were left out.`);
        for (const [serverName, raw] of Object.entries(object(config.mcpServers || config.mcp_servers))) {
          const server = object(raw);
          if (server.type === 'sse') { result.warnings.push(`${serverName}: legacy SSE transport is not supported.`); continue; }
          if (string(server.command) || string(server.url)) result.items.push(setupItem(provider, 'mcp', `${name}#${serverName}`, '', modified, undefined, serverName, server));
        }
        for (const field of ['developer_instructions', 'user_instructions', 'instructions']) {
          if (string(config[field]).trim()) result.items.push(setupItem(provider, 'instructions', `${name}#${field}`, string(config[field]), modified, undefined, `${provider} instructions`));
        }
      }
      catch { result.warnings.push(`${name}: invalid or unsupported configuration data.`); }
    } else if (/(?:^|\/)agents\/[^/]+\.md$/i.test(name)) result.items.push(setupItem(provider, 'agents', name, file.content, modified));
    else if (/(?:AGENTS(?:\.override)?|CLAUDE)\.md$|\.mdc$|\.cursorrules$|(?:^|\/)(?:rules|memory)\/.*\.md$/i.test(name)) result.items.push(setupItem(provider, 'instructions', name, file.content, modified));
    else if (/\.(md|txt)$/i.test(name)) result.items.push(...parseTextTranscript(provider, file.content, name, modified));
  }
  if (!result.items.length) result.warnings.push('No supported conversations or setup were found. Use JSON/JSONL conversation exports, a Cursor Markdown export, or instruction and SKILL.md files.');
  result.items = [...new Map(result.items.map(item => [item.id, item])).values()];
  if (result.items.some(item => item.messages?.some(message => message.attachments?.some(file => file.unavailable)))) result.warnings.push('Some source attachments have no local file or embedded content. Their cards are retained; missing originals can be reattached.');
  if (result.items.some(item => item.category !== 'chats')) result.warnings.push('Setup files uploaded without an original workspace path become personal setup. Use a local source scan to preserve project scope.');
  return result;
}
