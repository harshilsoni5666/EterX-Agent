import { NextRequest, NextResponse } from 'next/server';
import { promises as fs, watch, type FSWatcher } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { getPathResolverInfo, resolveReadableWorkspacePath } from '@/lib/agent/workspace/path_resolver';
import { rejectCrossOrigin } from '../../agent/_shared';
import { formatUnknownError } from '@/lib/agent/error-format';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  extension?: string;
  children?: FileEntry[];
}

interface TreeBuildState {
  entries: number;
  truncated: boolean;
  signatureParts: string[];
  observeDirectory?: (directory: string) => void;
  onReadError?: () => void;
}

const MAX_TREE_DEPTH = 4;
const MAX_TREE_ENTRIES = 1400;
const MAX_CHILDREN_PER_DIR = 180;
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_READ_LINES = 20000;

const SKIP_NAMES = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.turbo',
  '.vercel',
  '.workspaces',
  'target',
  'vendor',
  '__pycache__',
  '.DS_Store',
  'Thumbs.db',
  '.env.local',
  '.env',
  'package-lock.json',
  'bun.lock',
  'tsconfig.tsbuildinfo',
]);

const isSkippedName = (name: string) => {
  if (SKIP_NAMES.has(name)) return true;
  return name.startsWith('.') && name !== '.vscode';
};

type TreeSnapshot = {
  root: string;
  tree: FileEntry[];
  name: string;
  truncated: boolean;
  totalEntries: number;
  signature: string;
};
type TreeCacheEntry = {
  snapshot?: TreeSnapshot;
  pending?: Promise<TreeSnapshot>;
  watchers: FSWatcher[];
  revision: number;
  builtRevision: number;
  builtAt: number;
  lastUsedAt: number;
  watchFailed: boolean;
  disposed: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
};
const treeCache = new Map<string, TreeCacheEntry>();
const TREE_CACHE_IDLE_MS = 60_000;
const TREE_RECONCILE_MS = 15_000;
const MAX_CACHED_TREES = 6;

function disposeTreeCacheEntry(key: string, entry: TreeCacheEntry) {
  entry.disposed = true;
  entry.watchers.forEach(watcher => watcher.close());
  entry.watchers = [];
  if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
  if (treeCache.get(key) === entry) treeCache.delete(key);
}

async function readTreeSnapshot(root: string, maxDepth: number): Promise<TreeSnapshot> {
  const key = `${root}:${maxDepth}`;
  let entry = treeCache.get(key);
  if (!entry) {
    if (treeCache.size >= MAX_CACHED_TREES) {
      const oldest = [...treeCache.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (oldest) disposeTreeCacheEntry(oldest[0], oldest[1]);
    }
    entry = {
      watchers: [], revision: 0, builtRevision: -1, builtAt: 0,
      lastUsedAt: Date.now(), watchFailed: false, disposed: false,
    };
    treeCache.set(key, entry);
    const ownedEntry = entry;
    const expire = () => {
      const remaining = TREE_CACHE_IDLE_MS - (Date.now() - ownedEntry.lastUsedAt);
      if (remaining <= 0) disposeTreeCacheEntry(key, ownedEntry);
      else {
        ownedEntry.expiryTimer = setTimeout(expire, remaining);
        ownedEntry.expiryTimer.unref?.();
      }
    };
    entry.expiryTimer = setTimeout(expire, TREE_CACHE_IDLE_MS);
    entry.expiryTimer.unref?.();
  }
  entry.lastUsedAt = Date.now();
  if (entry.pending) return entry.pending;
  if (entry.snapshot && !entry.watchFailed && entry.builtRevision === entry.revision && Date.now() - entry.builtAt < TREE_RECONCILE_MS) {
    return entry.snapshot;
  }

  const ownedEntry = entry;
  ownedEntry.watchers.forEach(watcher => watcher.close());
  ownedEntry.watchers = [];
  ownedEntry.watchFailed = false;
  const revision = ownedEntry.revision;
  const state: TreeBuildState = {
    entries: 0, truncated: false, signatureParts: [],
    onReadError() { ownedEntry.watchFailed = true; },
    observeDirectory(directory) {
      if (ownedEntry.disposed) return;
      try {
        // Observe only directories that actually appear in the bounded tree.
        // This avoids recursive watchers over dependencies and build output.
        const watcher = watch(directory, { persistent: false }, (_event, filename) => {
          if (filename && isSkippedName(String(filename))) return;
          ownedEntry.revision += 1;
        });
        watcher.on('error', () => {
          ownedEntry.watchFailed = true;
          ownedEntry.revision += 1;
          watcher.close();
        });
        ownedEntry.watchers.push(watcher);
      } catch {
        // Network volumes and watcher limits retain the original fresh scan
        // on every request. A failed watch must never freeze the explorer.
        ownedEntry.watchFailed = true;
      }
    },
  };
  ownedEntry.pending = (async () => {
    const tree = await getFileTree(root, 0, maxDepth, state);
    const hash = createHash('sha1').update(state.signatureParts.join('|')).digest('hex');
    const snapshot: TreeSnapshot = {
      root, tree, name: path.basename(root), truncated: state.truncated,
      totalEntries: state.entries,
      signature: `${state.entries}:${state.truncated ? 1 : 0}:${hash}`,
    };
    ownedEntry.snapshot = snapshot;
    // An edit during traversal leaves the snapshot dirty for the next caller.
    ownedEntry.builtRevision = revision;
    ownedEntry.builtAt = Date.now();
    return snapshot;
  })();
  try {
    return await ownedEntry.pending;
  } finally {
    ownedEntry.pending = undefined;
  }
}

const parsePositiveInt = (value: unknown, fallback?: number) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const splitLines = (content: string) => {
  if (content.length === 0) return [];
  return content.split(/\r?\n/);
};

async function getFileTree(dirPath: string, depth: number, maxDepth: number, state: TreeBuildState): Promise<FileEntry[]> {
  if (depth > maxDepth || state.entries >= MAX_TREE_ENTRIES) return [];

  try {
    state.observeDirectory?.(dirPath);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const sorted = entries
      .filter(entry => !isSkippedName(entry.name) && !entry.isSymbolicLink())
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    const result: FileEntry[] = [];
    for (const entry of sorted) {
      if (state.entries >= MAX_TREE_ENTRIES || result.length >= MAX_CHILDREN_PER_DIR) {
        state.truncated = true;
        break;
      }

      const fullPath = path.join(dirPath, entry.name);
      state.entries++;

      if (entry.isDirectory()) {
        state.signatureParts.push(`d:${fullPath}`);
        result.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children: await getFileTree(fullPath, depth + 1, maxDepth, state),
        });
      } else {
        try {
          const stats = await fs.stat(fullPath);
          state.signatureParts.push(`f:${fullPath}:${stats.size}:${Math.floor(stats.mtimeMs)}`);
          result.push({
            name: entry.name,
            path: fullPath,
            type: 'file',
            size: stats.size,
            extension: path.extname(entry.name).slice(1).toLowerCase(),
          });
        } catch {
          state.onReadError?.();
          state.signatureParts.push(`f:${fullPath}:0:0`);
          result.push({
            name: entry.name,
            path: fullPath,
            type: 'file',
            extension: path.extname(entry.name).slice(1).toLowerCase(),
          });
        }
      }
    }

    return result;
  } catch {
    state.onReadError?.();
    return [];
  }
}

export async function GET(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const { searchParams } = new URL(req.url);
    const dirPath = path.resolve(path.normalize(searchParams.get('path') || getPathResolverInfo().desktopPath));
    const requestedDepth = Number.parseInt(searchParams.get('depth') || '3', 10);
    const maxDepth = Number.isFinite(requestedDepth)
      ? Math.min(Math.max(requestedDepth, 0), MAX_TREE_DEPTH)
      : 3;

    let stats;
    try {
      stats = await fs.stat(dirPath);
    } catch {
      return NextResponse.json({ error: 'Path does not exist' }, { status: 404 });
    }

    if (!stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
    }

    return NextResponse.json(await readTreeSnapshot(dirPath, maxDepth));
  } catch (error: any) {
    return NextResponse.json({ error: formatUnknownError(error, 'Could not read workspace files') }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const { filePath, offset, limit } = await req.json();

    if (typeof filePath !== 'string' || !filePath.trim()) {
      return NextResponse.json({ error: 'filePath is required' }, { status: 400 });
    }

    const normalizedPath = resolveReadableWorkspacePath(filePath.trim());

    let stats;
    try {
      stats = await fs.stat(normalizedPath);
    } catch {
      return NextResponse.json({ error: 'File does not exist' }, { status: 404 });
    }

    if (stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is a directory, not a file' }, { status: 400 });
    }

    if (stats.size > MAX_FILE_SIZE) {
      return NextResponse.json({
        error: 'File too large',
        size: stats.size,
        maxSize: MAX_FILE_SIZE,
      }, { status: 413 });
    }

    const content = await fs.readFile(normalizedPath, 'utf-8');
    const lines = splitLines(content);
    const totalLines = lines.length;

    const requestedOffset = parsePositiveInt(offset, 1) || 1;
    const requestedLimit = parsePositiveInt(limit);
    const effectiveLimit = requestedLimit ? Math.min(requestedLimit, MAX_READ_LINES) : undefined;
    const startIndex = totalLines === 0 ? 0 : Math.min(Math.max(0, requestedOffset - 1), totalLines);
    const endIndex = effectiveLimit ? Math.min(startIndex + effectiveLimit, totalLines) : totalLines;
    const slicedContent = lines.slice(startIndex, endIndex).join('\n');
    const startLine = totalLines === 0 ? 0 : startIndex + 1;
    const endLine = endIndex;

    return NextResponse.json({
      filePath: normalizedPath,
      content: slicedContent,
      totalLines,
      loadedLines: Math.max(0, endIndex - startIndex),
      startLine,
      endLine,
      truncated: startIndex > 0 || endIndex < totalLines,
      requestedLimit: requestedLimit || null,
      effectiveLimit: effectiveLimit || null,
      language: getLanguageFromExt(path.extname(normalizedPath).slice(1).toLowerCase()),
      size: stats.size,
    });
  } catch (error: any) {
    return NextResponse.json({ error: formatUnknownError(error, 'Could not read file') }, { status: 500 });
  }
}

function getLanguageFromExt(ext: string): string {
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp', cs: 'csharp',
    json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', html: 'html',
    css: 'css', scss: 'scss', less: 'less', sql: 'sql', sh: 'bash',
    bash: 'bash', zsh: 'bash', md: 'markdown', mdx: 'markdown',
    toml: 'toml', ini: 'ini', cfg: 'ini', env: 'bash',
    dockerfile: 'dockerfile', makefile: 'makefile',
  };
  return map[ext] || 'text';
}
