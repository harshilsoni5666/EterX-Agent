import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { createReadStream } from 'fs';
import * as readline from 'readline';
import { runRgFiles, isRgAvailable } from '../tools/shared/rg';

const INDEX_ROOT = path.resolve(process.cwd(), '.workspaces', '.code-index');
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'cs',
  'cpp', 'c', 'h', 'hpp', 'swift', 'rb', 'php', 'vue', 'svelte', 'css', 'scss',
  'html', 'md', 'json', 'yaml', 'yml', 'toml', 'sql', 'sh', 'ps1', 'bat',
]);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo',
  'out', 'target', '__pycache__', '.venv', 'venv', '.workspaces',
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_INDEX_FILES = 4000;
const CHUNK_LINES = 40;

export interface CodeIndexChunk {
  startLine: number;
  endLine: number;
  text: string;
}

export interface CodeIndexEntry {
  path: string;
  relPath: string;
  language: string;
  lineCount: number;
  symbols: string[];
  imports: string[];
  chunks: CodeIndexChunk[];
  mtimeMs: number;
}

export interface CodeIndex {
  workspacePath: string;
  builtAt: number;
  fileCount: number;
  entries: CodeIndexEntry[];
}

function normalizeWords(text: string): string[] {
  const camel = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  return camel
    .toLowerCase()
    .replace(/[^a-z0-9_.\-\/\\]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
}

function extractSymbols(line: string): string[] {
  const symbols: string[] = [];
  const patterns = [
    /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /\bfunction\s+([A-Za-z_$][\w$]*)/,
    /\bclass\s+([A-Za-z_$][\w$]*)/,
    /\binterface\s+([A-Za-z_$][\w$]*)/,
    /\btype\s+([A-Za-z_$][\w$]*)/,
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=/,
    /\bdef\s+([A-Za-z_][\w]*)/,
    /\bpub\s+fn\s+([A-Za-z_][\w]*)/,
    /\bfunc\s+([A-Za-z_][\w]*)/,
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match?.[1]) symbols.push(match[1]);
  }
  return symbols;
}

function extractImports(line: string): string[] {
  const trimmed = line.trim();
  if (/^import\s+/.test(trimmed)) return [trimmed.slice(0, 120)];
  if (/^from\s+/.test(trimmed)) return [trimmed.slice(0, 120)];
  if (/^#include\s+/.test(trimmed)) return [trimmed.slice(0, 120)];
  if (/^use\s+/.test(trimmed)) return [trimmed.slice(0, 120)];
  return [];
}

async function readFileLines(filePath: string, maxLines = 800): Promise<string[]> {
  const lines: string[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    lines.push(line);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function chunkLines(lines: string[]): CodeIndexChunk[] {
  const chunks: CodeIndexChunk[] = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const slice = lines.slice(i, i + CHUNK_LINES);
    chunks.push({
      startLine: i + 1,
      endLine: i + slice.length,
      text: slice.join('\n').slice(0, 2500),
    });
  }
  return chunks;
}

function indexCachePath(workspacePath: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(workspacePath)).digest('hex');
  return path.join(INDEX_ROOT, `${hash}.json`);
}

async function listCodeFiles(workspacePath: string): Promise<string[]> {
  if (isRgAvailable()) {
    try {
      const globs = [
        '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.py', '*.rs', '*.go',
        '*.java', '*.kt', '*.cs', '*.cpp', '*.c', '*.h', '*.swift', '*.rb', '*.php',
        '*.vue', '*.svelte', '*.css', '*.scss', '*.html', '*.md', '*.json', '*.yml',
        '*.yaml', '*.toml', '*.sql',
      ];
      const files: string[] = [];
      for (const glob of globs) {
        files.push(...runRgFiles(workspacePath, { glob, maxResults: MAX_INDEX_FILES }));
        if (files.length >= MAX_INDEX_FILES) break;
      }
      return [...new Set(files)].slice(0, MAX_INDEX_FILES);
    } catch { /* fallback */ }
  }

  const found: string[] = [];
  async function walk(dir: string, rel = ''): Promise<void> {
    if (found.length >= MAX_INDEX_FILES) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (found.length >= MAX_INDEX_FILES) break;
      if (SKIP_DIRS.has(entry.name)) continue;
      const relPath = rel ? path.join(rel, entry.name) : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, relPath);
        continue;
      }
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (CODE_EXTENSIONS.has(ext)) found.push(relPath.replace(/\\/g, '/'));
    }
  }
  await walk(workspacePath);
  return found;
}

async function buildEntry(workspacePath: string, relPath: string): Promise<CodeIndexEntry | null> {
  const fullPath = path.join(workspacePath, relPath);
  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const lines = await readFileLines(fullPath, 800);
    const symbols = new Set<string>();
    const imports: string[] = [];
    for (const line of lines) {
      for (const sym of extractSymbols(line)) symbols.add(sym);
      imports.push(...extractImports(line));
    }
    const ext = path.extname(relPath).slice(1).toLowerCase();
    return {
      path: fullPath,
      relPath: relPath.replace(/\\/g, '/'),
      language: ext || 'text',
      lineCount: lines.length,
      symbols: [...symbols].slice(0, 40),
      imports: imports.slice(0, 20),
      chunks: chunkLines(lines),
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

const indexCache = new Map<string, { index: CodeIndex; fingerprint: string }>();

async function workspaceFingerprint(workspacePath: string): Promise<string> {
  try {
    const stat = await fs.stat(workspacePath);
    const files = await listCodeFiles(workspacePath);
    return `${stat.mtimeMs}:${files.length}:${files.slice(0, 5).join('|')}`;
  } catch {
    return 'missing';
  }
}

export async function ensureCodeIndex(workspacePath: string): Promise<CodeIndex> {
  const root = path.resolve(workspacePath);
  const fingerprint = await workspaceFingerprint(root);
  const cached = indexCache.get(root);
  if (cached && cached.fingerprint === fingerprint) return cached.index;

  const cacheFile = indexCachePath(root);
  if (await fs.pathExists(cacheFile)) {
    try {
      const saved = await fs.readJson(cacheFile) as CodeIndex & { fingerprint?: string };
      if (saved.fingerprint === fingerprint && Array.isArray(saved.entries)) {
        indexCache.set(root, { index: saved, fingerprint });
        return saved;
      }
    } catch { /* rebuild */ }
  }

  const relFiles = await listCodeFiles(root);
  const entries: CodeIndexEntry[] = [];
  const batchSize = 40;
  for (let i = 0; i < relFiles.length; i += batchSize) {
    const batch = relFiles.slice(i, i + batchSize);
    const built = await Promise.all(batch.map(rel => buildEntry(root, rel)));
    for (const entry of built) if (entry) entries.push(entry);
  }

  const index: CodeIndex & { fingerprint?: string } = {
    workspacePath: root,
    builtAt: Date.now(),
    fileCount: entries.length,
    entries,
    fingerprint,
  };

  await fs.ensureDir(INDEX_ROOT);
  await fs.writeJson(cacheFile, index);
  indexCache.set(root, { index, fingerprint });
  return index;
}

export function searchCodeIndex(index: CodeIndex, query: string, options?: {
  maxResults?: number;
  targetDirectories?: string[];
}): Array<{
  file: string;
  path: string;
  score: number;
  startLine: number;
  endLine: number;
  snippet: string;
  symbols: string[];
  reason: string;
}> {
  const maxResults = Math.min(options?.maxResults || 12, 25);
  const queryWords = new Set(normalizeWords(query));
  const dirFilters = (options?.targetDirectories || [])
    .map(d => d.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(Boolean);

  const scored: Array<{
    file: string;
    path: string;
    score: number;
    startLine: number;
    endLine: number;
    snippet: string;
    symbols: string[];
    reason: string;
  }> = [];

  for (const entry of index.entries) {
    if (dirFilters.length > 0 && !dirFilters.some(dir => entry.relPath.startsWith(dir))) continue;

    let fileScore = 0;
    const pathWords = new Set(normalizeWords(`${entry.relPath} ${entry.symbols.join(' ')}`));
    for (const word of queryWords) {
      if (entry.relPath.toLowerCase().includes(word)) fileScore += 6;
      if (entry.symbols.some(s => s.toLowerCase().includes(word))) fileScore += 8;
      if (pathWords.has(word)) fileScore += 3;
    }

    for (const chunk of entry.chunks) {
      const chunkWords = new Set(normalizeWords(chunk.text));
      let chunkScore = fileScore * 0.35;
      for (const word of queryWords) {
        if (chunkWords.has(word)) chunkScore += 2;
        if (chunk.text.toLowerCase().includes(word)) chunkScore += 1.5;
      }
      if (chunkScore <= 0) continue;

      scored.push({
        file: entry.relPath,
        path: entry.path,
        score: chunkScore,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        snippet: chunk.text.split('\n').slice(0, 8).join('\n').slice(0, 600),
        symbols: entry.symbols.slice(0, 8),
        reason: entry.symbols.length > 0
          ? `Matched symbols: ${entry.symbols.slice(0, 4).join(', ')}`
          : `Matched content in ${entry.relPath}`,
      });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
