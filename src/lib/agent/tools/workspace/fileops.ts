import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import fs from 'fs/promises';
import fse from 'fs-extra';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  checkEterXReadProtection,
  checkEterXProtection,
  getPathResolverInfo,
  resolveWorkspacePathForContext,
  resolveReadableWorkspacePathForContext,
  resolveWorkspaceDirectoryForContext,
} from '../../workspace/path_resolver';

const execFileAsync = promisify(execFile);
const DESKTOP_SCRIPT_EXTENSIONS = new Set(['.py', '.ps1', '.js', '.mjs', '.cjs', '.bat', '.cmd', '.vbs', '.ahk']);
const DEFAULT_READ_MAX_CHARS = 25000;
const DEFAULT_READ_MANY_MAX_CHARS = 12000;
const MAX_READ_MAX_CHARS = 100000;
const DEFAULT_SEARCH_LIMIT = 150;
const DEFAULT_FILE_LIMIT = 500;
const DEFAULT_EXCLUDE_GLOBS = [
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cache',
];

type ReadFileOptions = {
  startLine?: number;
  endLine?: number;
  maxChars?: number;
  includeLineNumbers?: boolean;
};

type WorkspaceEdit = {
  search?: string;
  replace: string;
  startLine?: number;
  endLine?: number;
  insertAfterLine?: number;
  insertBeforeLine?: number;
  replaceAll?: boolean;
  useRegex?: boolean;
  createIfMissing?: boolean;
};

type BatchEditTarget = {
  filename: string;
  edits: WorkspaceEdit[];
};

function clampPositiveInt(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function normalizeLineNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

function toPowerShellEncodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function runPowerShell(script: string, timeoutMs = 15000, maxBuffer = 2 * 1024 * 1024): Promise<string> {
  const encoded = toPowerShellEncodedCommand(script);
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: timeoutMs, maxBuffer }
  );
  return String(stdout || '');
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function truncateText(text: string, maxChars: number, suffix: string): { content: string; truncated: boolean } {
  if (text.length <= maxChars) return { content: text, truncated: false };
  return { content: `${text.slice(0, maxChars)}\n\n${suffix}`, truncated: true };
}

function formatLinesWithNumbers(text: string, firstLine: number): string {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line, idx) => `${String(firstLine + idx).padStart(6, ' ')}: ${line}`).join('\n');
}

async function readFileViaPowerShell(filePath: string, options: ReadFileOptions): Promise<{ content: string; mode: string }> {
  const startLine = normalizeLineNumber(options.startLine);
  const endLine = normalizeLineNumber(options.endLine);
  const includeLineNumbers = options.includeLineNumbers ?? Boolean(startLine || endLine);
  const hasRange = startLine !== undefined || endLine !== undefined;

  if (!hasRange) {
    const content = await runPowerShell([
      '$ErrorActionPreference = "Stop"',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
      `$path = ${psString(filePath)}`,
      'Get-Content -LiteralPath $path -Raw -Encoding UTF8',
    ].join('\n'), 15000, Math.max(2 * 1024 * 1024, (options.maxChars || DEFAULT_READ_MAX_CHARS) * 4));
    return { content, mode: 'powershell_raw' };
  }

  const start = startLine ?? 1;
  const end = endLine ?? Math.max(start, start + 199);
  if (end < start) throw new Error(`Invalid line range: endLine (${end}) is before startLine (${start}).`);

  const content = await runPowerShell([
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
    `$path = ${psString(filePath)}`,
    `$start = ${start}`,
    `$end = ${end}`,
    '$skip = [Math]::Max(0, $start - 1)',
    'Get-Content -LiteralPath $path -Encoding UTF8 -TotalCount $end | Select-Object -Skip $skip',
  ].join('\n'), 15000);

  return {
    content: includeLineNumbers ? formatLinesWithNumbers(content, start) : content,
    mode: includeLineNumbers ? 'powershell_range_numbered' : 'powershell_range',
  };
}

async function readWorkspaceTextFile(filePath: string, stats: any, options: ReadFileOptions = {}) {
  const maxChars = clampPositiveInt(options.maxChars, DEFAULT_READ_MAX_CHARS, MAX_READ_MAX_CHARS);
  const hasRange = options.startLine !== undefined || options.endLine !== undefined;

  if (!hasRange && stats.size > 10 * 1024 * 1024) {
    throw new Error(`File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB). Use workspace_read_file with startLine/endLine or workspace_search_text.`);
  }

  let content = '';
  let readMode = 'node_fs';

  try {
    const psRead = await readFileViaPowerShell(filePath, options);
    content = psRead.content;
    readMode = psRead.mode;
  } catch (error: any) {
    if (hasRange) {
      const full = await fs.readFile(filePath, 'utf-8');
      const lines = full.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      const start = normalizeLineNumber(options.startLine) ?? 1;
      const end = normalizeLineNumber(options.endLine) ?? Math.min(lines.length, start + 199);
      const slice = lines.slice(start - 1, end).join('\n');
      content = options.includeLineNumbers ?? true ? formatLinesWithNumbers(slice, start) : slice;
      readMode = `node_fs_range_fallback:${error.message || 'powershell unavailable'}`;
    } else {
      content = await fs.readFile(filePath, 'utf-8');
      readMode = `node_fs_fallback:${error.message || 'powershell unavailable'}`;
    }
  }

  const truncated = truncateText(
    content,
    maxChars,
    `...[FILE TRUNCATED at ${maxChars} chars. Use startLine/endLine or workspace_search_text for a narrower read]...`
  );

  return {
    content: truncated.content,
    truncated: truncated.truncated,
    readMode,
    maxChars,
  };
}

function parseRgJsonLines(output: string, searchDir: string, maxResults: number): any[] {
  const results: any[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    try {
      const evt = JSON.parse(rawLine);
      if (evt.type !== 'match') continue;
      const data = evt.data || {};
      const absolute = String(data.path?.text || '');
      const linesText = String(data.lines?.text || '').replace(/\r?\n$/, '');
      const submatch = Array.isArray(data.submatches) ? data.submatches[0] : undefined;
      results.push({
        file: path.relative(searchDir, absolute) || absolute,
        path: absolute,
        line: data.line_number,
        column: submatch?.start !== undefined ? submatch.start + 1 : undefined,
        content: linesText.trim().slice(0, 300),
      });
      if (results.length >= maxResults) break;
    } catch {
      continue;
    }
  }
  return results;
}

async function searchWithRipgrep(input: {
  pattern: string;
  directory: string;
  useRegex?: boolean;
  caseSensitive?: boolean;
  maxResults: number;
  globs?: string[];
  includeHidden?: boolean;
}): Promise<{ results: any[]; engine: string } | null> {
  const args = [
    '--json',
    '--line-number',
    '--column',
    '--color',
    'never',
    '--max-filesize',
    '2M',
  ];

  if (!input.useRegex) args.push('--fixed-strings');
  if (input.caseSensitive === false) args.push('--ignore-case');
  if (input.includeHidden) args.push('--hidden');

  const excluded = new Set(DEFAULT_EXCLUDE_GLOBS);
  for (const glob of excluded) args.push('--glob', `!${glob}/**`);
  for (const glob of input.globs || []) args.push('--glob', glob);

  args.push('--', input.pattern, input.directory);

  try {
    const { stdout } = await execFileAsync('rg', args, {
      cwd: input.directory,
      timeout: 20000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return { results: parseRgJsonLines(String(stdout || ''), input.directory, input.maxResults), engine: 'ripgrep' };
  } catch (error: any) {
    if (error.code === 1 && error.stdout !== undefined) {
      return { results: [], engine: 'ripgrep' };
    }
    if (error.stdout) {
      return { results: parseRgJsonLines(String(error.stdout), input.directory, input.maxResults), engine: 'ripgrep' };
    }
    return null;
  }
}

async function searchWithPowerShell(input: {
  pattern: string;
  directory: string;
  useRegex?: boolean;
  caseSensitive?: boolean;
  maxResults: number;
}): Promise<any[]> {
  const simple = !input.useRegex;
  const caseSensitive = input.caseSensitive ?? true;
  const script = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
    `$dir = ${psString(input.directory)}`,
    `$pattern = ${psString(input.pattern)}`,
    `$max = ${input.maxResults}`,
    '$skip = @("node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo", ".cache")',
    '$count = 0',
    'Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue | Where-Object {',
    '  $full = $_.FullName',
    '  -not ($skip | Where-Object { $full -like ("*" + [IO.Path]::DirectorySeparatorChar + $_ + [IO.Path]::DirectorySeparatorChar + "*") })',
    '} | Select-String -Pattern $pattern' +
      (simple ? ' -SimpleMatch' : '') +
      (caseSensitive ? ' -CaseSensitive' : '') +
      ' | Select-Object -First $max | ForEach-Object {',
    '  [PSCustomObject]@{ path = $_.Path; line = $_.LineNumber; content = ($_.Line.Trim()) } | ConvertTo-Json -Compress',
    '}',
  ].join('\n');

  const output = await runPowerShell(script, 25000, 5 * 1024 * 1024);
  const results: any[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    try {
      const row = JSON.parse(rawLine);
      results.push({
        file: path.relative(input.directory, row.path) || row.path,
        path: row.path,
        line: row.line,
        content: String(row.content || '').slice(0, 300),
      });
    } catch {
      continue;
    }
  }
  return results;
}

async function findFilesWithRipgrep(directory: string, input: { glob?: string; maxResults: number; includeHidden?: boolean }) {
  const args = ['--files'];
  if (input.includeHidden) args.push('--hidden');
  for (const glob of DEFAULT_EXCLUDE_GLOBS) args.push('--glob', `!${glob}/**`);
  if (input.glob?.trim()) args.push('--glob', input.glob.trim());

  try {
    const { stdout } = await execFileAsync('rg', args, {
      cwd: directory,
      timeout: 15000,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    });
    return String(stdout || '').split(/\r?\n/).filter(Boolean).slice(0, input.maxResults);
  } catch (error: any) {
    if (error.stdout) return String(error.stdout).split(/\r?\n/).filter(Boolean).slice(0, input.maxResults);
    return null;
  }
}

async function findFilesWithPowerShell(directory: string, input: { glob?: string; maxResults: number }) {
  const filter = input.glob?.trim() || '*';
  const script = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
    `$dir = ${psString(directory)}`,
    `$filter = ${psString(filter)}`,
    `$max = ${input.maxResults}`,
    '$skip = @("node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo", ".cache")',
    'Get-ChildItem -LiteralPath $dir -Recurse -File -Filter $filter -ErrorAction SilentlyContinue | Where-Object {',
    '  $full = $_.FullName',
    '  -not ($skip | Where-Object { $full -like ("*" + [IO.Path]::DirectorySeparatorChar + $_ + [IO.Path]::DirectorySeparatorChar + "*") })',
    '} | Select-Object -First $max | ForEach-Object { [IO.Path]::GetRelativePath($dir, $_.FullName) }',
  ].join('\n');
  const output = await runPowerShell(script, 20000, 2 * 1024 * 1024);
  return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, input.maxResults);
}


function isDesktopHelperScript(filePath: string): boolean {
  const desktopPath = path.resolve(getPathResolverInfo().desktopPath);
  const resolved = path.resolve(filePath);
  const relative = path.relative(desktopPath, resolved);

  // Not under Desktop at all → allow
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;

  // Must be a script extension
  if (!DESKTOP_SCRIPT_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return false;

  // ALLOW: Scripts inside project subdirectories (2+ levels deep from Desktop)
  // e.g., Desktop/my-project/.workspaces/sandbox/script.py → allowed
  // e.g., Desktop/my-project/scripts/helper.py → allowed
  const depth = relative.split(path.sep).filter(Boolean).length;
  if (depth >= 2) return false;

  // Only block scripts DIRECTLY on Desktop root (depth === 1)
  // e.g., Desktop/click_helper.py → blocked (likely UI automation)
  return true;
}

export const workspaceReadTool: ToolDefinition = {
  name: 'workspace_read_file',
  description: `Read a file from the selected workspace using a PowerShell-backed reader with Node fallback. Supports targeted line ranges, line numbers, and output caps so code agents do not dump whole files when only one section is needed. Prefer workspace_search_text or workspace_find_files first, then read the smallest useful range. EterX app source is blocked unless internal development mode is enabled.`,
  category: 'workspace',
  inputSchema: z.object({
    filename: z.string().describe('File path — absolute (C:\\path\\to\\file) or relative to workspace')
  }).extend({
    startLine: z.number().int().positive().optional().describe('Optional 1-indexed first line to read. Use this for targeted inspection.'),
    endLine: z.number().int().positive().optional().describe('Optional 1-indexed last line to read. Defaults to startLine + 199 when startLine is provided.'),
    maxChars: z.number().int().positive().max(MAX_READ_MAX_CHARS).optional().describe('Maximum characters to return. Default: 25000.'),
    includeLineNumbers: z.boolean().optional().describe('Include "line: content" prefixes. Default true for ranged reads, false for full reads.')
  }),
  outputSchema: z.object({ content: z.string() }),
  execute: async (input: { filename: string } & ReadFileOptions, context?: any) => {
    const filePath = resolveReadableWorkspacePathForContext(input.filename, context);
    const readProtection = checkEterXReadProtection(filePath, context);
    if (readProtection.blocked) {
      return { content: '', error: readProtection.reason, path: filePath };
    }
    console.log(`[Tool: workspace_read_file] Reading: ${ filePath }`);

    if (!await fse.pathExists(filePath)) {
      throw new Error(`File not found: ${ filePath }. Check the path and try again.`);
    }

    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    const readResult = await readWorkspaceTextFile(filePath, stats, input);

    return {
      content: readResult.content,
      size: stats.size,
      path: filePath,
      readMode: readResult.readMode,
      truncated: readResult.truncated,
      startLine: input.startLine,
      endLine: input.endLine,
    };
  }
};

export const workspaceReadManyTool: ToolDefinition = {
  name: 'workspace_read_many_files',
  description: 'Read multiple files or line ranges in one tool call. Use this after search results point to several files; keep maxCharsPerFile small unless whole-file context is truly needed.',
  category: 'workspace',
  inputSchema: z.object({
    files: z.array(z.union([
      z.string(),
      z.object({
        filename: z.string().describe('File path to read.'),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        includeLineNumbers: z.boolean().optional(),
      })
    ])).min(1).max(50).describe('File paths or ranged read objects. Each path may be absolute or relative to the workspace.'),
    maxCharsPerFile: z.number().int().positive().max(MAX_READ_MAX_CHARS).optional().describe('Maximum characters to return per file. Default: 12000.')
  }),
  outputSchema: z.object({ files: z.array(z.any()) }),
  execute: async (input: { files: Array<string | ({ filename: string } & ReadFileOptions)>; maxCharsPerFile?: number }, context?: any) => {
    const maxChars = clampPositiveInt(input.maxCharsPerFile, DEFAULT_READ_MANY_MAX_CHARS, MAX_READ_MAX_CHARS);
    const results = [];

    for (const entry of input.files) {
      const filename = typeof entry === 'string' ? entry : entry.filename;
      const readOptions: ReadFileOptions = typeof entry === 'string'
        ? { maxChars }
        : { ...entry, maxChars };
      const filePath = resolveReadableWorkspacePathForContext(filename, context);
      const readProtection = checkEterXReadProtection(filePath, context);
      if (readProtection.blocked) {
        results.push({ filename, path: filePath, content: '', error: readProtection.reason });
        continue;
      }

      try {
        if (!await fse.pathExists(filePath)) {
          results.push({ filename, path: filePath, content: '', error: 'File not found' });
          continue;
        }

        const stats = await fs.stat(filePath);
        if (!stats.isFile()) {
          results.push({ filename, path: filePath, content: '', error: 'Path is not a file' });
          continue;
        }
        const readResult = await readWorkspaceTextFile(filePath, stats, readOptions);

        results.push({
          filename,
          path: filePath,
          content: readResult.content,
          size: stats.size,
          truncated: readResult.truncated,
          readMode: readResult.readMode,
          startLine: readOptions.startLine,
          endLine: readOptions.endLine,
        });
      } catch (error: any) {
        results.push({ filename, path: filePath, content: '', error: error.message });
      }
    }

    return { files: results, count: results.length };
  }
};

export const workspaceWriteTool: ToolDefinition = {
  name: 'workspace_write_file',
  description: 'Write content to a file in the selected user workspace or an explicit user path. Creates parent directories automatically. Protected EterX app source paths are rejected.',
  category: 'workspace',
  inputSchema: z.object({
    filename: z.string().describe('File path — absolute or relative to workspace'),
    content: z.string().describe('Content to write'),
    append: z.boolean().optional().describe('Set to true to append to the file instead of overwriting. EXTREMELY helpful for the auto-chunk workflow.')
  }),
  outputSchema: z.object({ success: z.boolean(), path: z.string() }),
  execute: async (input: { filename: string, content: string, append?: boolean }, context?: any) => {
    // Guard against undefined/empty filename — this was causing "path must be string" crashes
    if (!input.filename || typeof input.filename !== 'string' || !input.filename.trim()) {
      return { success: false, error: 'INVALID FILENAME: You must provide a valid filename string. Do not pass undefined or empty string.', path: '' };
    }
    const filePath = resolveWorkspacePathForContext(input.filename, context);
    if (isDesktopHelperScript(filePath)) {
      return {
        success: false,
        error: '⚠️ HINT: Creating scripts directly on the Desktop root is discouraged. Use .workspaces/sandbox/ for temporary scripts, or place project scripts in the project directory. If this is intentional, use workspace_run_command to write it manually.',
        path: filePath,
      };
    }

    // EterX Source Protection Cloak — NEVER modify our own source
    const protection = checkEterXProtection(filePath);
    if (protection.blocked) {
      console.warn(`[Tool: workspace_write_file] 🛡️ BLOCKED: ${ filePath }`);
      return { success: false, error: protection.reason, path: filePath };
    }

    await fse.ensureDir(path.dirname(filePath));

    console.log(`[Tool: workspace_write_file] ${ input.append ? 'Appending' : 'Writing' } to: ${ filePath }`);

    if (input.append) {
      await fs.appendFile(filePath, input.content, 'utf-8');
    } else {
      await fs.writeFile(filePath, input.content, 'utf-8');
    }

    return { success: true, path: filePath, size: input.content.length };
  }
};

export const workspaceListDirectoryTool: ToolDefinition = {
  name: 'workspace_list_directory',
  description: 'List files and directories in the selected user workspace or an explicit user path. Protected EterX app source paths are not used as the default workspace.',
  category: 'workspace',
  inputSchema: z.object({
    directory: z.string().optional().describe('Directory path — absolute (C:\\Users\\...\\Desktop) or relative. Default: workspace root')
  }),
  outputSchema: z.object({ files: z.array(z.string()), tree: z.string() }),
  execute: async (input: { directory?: string }, context?: any) => {
    const walkDir = resolveWorkspaceDirectoryForContext(input.directory, context);

    if (!await fse.pathExists(walkDir)) {
      throw new Error(`Directory not found: ${ walkDir }`);
    }

    const entries = await fs.readdir(walkDir, { withFileTypes: true });

    // Sort directories first, then alphabetically
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    let items = entries.slice(0, 500).map(e => {
      const type = e.isDirectory() ? '📁' : '📄';
      return `${ type } ${ e.name }`;
    });

    if (entries.length > 500) {
      items.push(`... [Truncated ${ entries.length - 500 } additional items. Use workspace_run_command with grep to filter]`);
    }

    return { files: entries.map(e => e.name).slice(0, 500), tree: items.join('\n'), path: walkDir, count: entries.length };
  }
};

export const workspaceSearchTextTool: ToolDefinition = {
  name: 'workspace_search_text',
  description: 'Fast code/text search across the selected workspace. Uses ripgrep when available and PowerShell Select-String as a fallback. Use this before reading files; then read only the matching ranges.',
  category: 'workspace',
  inputSchema: z.object({
    pattern: z.string().describe('String or regex pattern to search'),
    directory: z.string().optional().describe('Directory to search in (absolute or relative). Default: workspace'),
    useRegex: z.boolean().optional().describe('Treat pattern as a JavaScript regex. Default: false.'),
    caseSensitive: z.boolean().optional().describe('Use case-sensitive matching. Default: true.'),
    maxResults: z.number().int().positive().max(1000).optional().describe('Maximum matches to return. Default: 150.'),
    globs: z.array(z.string()).max(20).optional().describe('Optional ripgrep glob filters such as ["*.ts", "!*.test.ts"].'),
    includeHidden: z.boolean().optional().describe('Include hidden files. Default false.')
  }),
  outputSchema: z.object({ results: z.array(z.any()) }),
  execute: async (input: { pattern: string, directory?: string, useRegex?: boolean, caseSensitive?: boolean, maxResults?: number, globs?: string[], includeHidden?: boolean }, context?: any) => {
    const searchDir = resolveWorkspaceDirectoryForContext(input.directory, context);
    const maxResults = clampPositiveInt(input.maxResults, DEFAULT_SEARCH_LIMIT, 1000);

    if (!await fse.pathExists(searchDir)) return { results: [] };

    if (input.useRegex) {
      try {
        new RegExp(input.pattern, input.caseSensitive === false ? 'i' : '');
      } catch (error: any) {
        return { results: [], error: `Invalid regex pattern: ${error.message}`, engine: 'validation' };
      }
    }

    const rg = await searchWithRipgrep({
      pattern: input.pattern,
      directory: searchDir,
      useRegex: input.useRegex,
      caseSensitive: input.caseSensitive,
      maxResults,
      globs: input.globs,
      includeHidden: input.includeHidden,
    });

    if (rg) {
      return {
        results: rg.results,
        totalMatches: rg.results.length,
        engine: rg.engine,
        truncated: rg.results.length >= maxResults,
        nextStep: 'Use workspace_read_file with startLine/endLine around relevant matches before editing.',
      };
    }

    const results = await searchWithPowerShell({
      pattern: input.pattern,
      directory: searchDir,
      useRegex: input.useRegex,
      caseSensitive: input.caseSensitive,
      maxResults,
    });

    return {
      results,
      totalMatches: results.length,
      engine: 'powershell_select_string',
      truncated: results.length >= maxResults,
      nextStep: 'Use workspace_read_file with startLine/endLine around relevant matches before editing.',
    };
  }
};

export const workspaceFindFilesTool: ToolDefinition = {
  name: 'workspace_find_files',
  description: 'Find files quickly without reading file contents. Uses ripgrep --files with PowerShell fallback. Use this to map a repo before targeted reads.',
  category: 'workspace',
  inputSchema: z.object({
    directory: z.string().optional().describe('Directory to search in (absolute or relative). Default: workspace'),
    glob: z.string().optional().describe('Optional glob/filter, for example "*.ts", "src/**/*.tsx", or "*route.ts".'),
    maxResults: z.number().int().positive().max(5000).optional().describe('Maximum files to return. Default: 500.'),
    includeHidden: z.boolean().optional().describe('Include hidden files. Default false.')
  }),
  outputSchema: z.object({ files: z.array(z.string()) }),
  execute: async (input: { directory?: string, glob?: string, maxResults?: number, includeHidden?: boolean }, context?: any) => {
    const searchDir = resolveWorkspaceDirectoryForContext(input.directory, context);
    const maxResults = clampPositiveInt(input.maxResults, DEFAULT_FILE_LIMIT, 5000);

    if (!await fse.pathExists(searchDir)) return { files: [], directory: searchDir, error: 'Directory not found' };

    const rgFiles = await findFilesWithRipgrep(searchDir, {
      glob: input.glob,
      maxResults,
      includeHidden: input.includeHidden,
    });
    const files = rgFiles ?? await findFilesWithPowerShell(searchDir, {
      glob: input.glob,
      maxResults,
    });

    return {
      files,
      directory: searchDir,
      count: files.length,
      engine: rgFiles ? 'ripgrep' : 'powershell_get_child_item',
      truncated: files.length >= maxResults,
    };
  }
};

/**
 * ═══════════════════════════════════════════════════════════════
 * workspace_edit_file — Enterprise-Level Multi-Strategy Editing
 * NEVER fails silently. Uses 5 fallback strategies in order.
 * 
 * Strategy order:
 *   1. Exact match (fastest, most precise)
 *   2. Normalized whitespace match (handles CRLF/LF differences)
 *   3. Trimmed-line fuzzy match (handles leading/trailing space drift)
 *   4. Line-range replacement (always works if line numbers are given)
 *   5. Regex match (for complex patterns)
 * ═══════════════════════════════════════════════════════════════
 */

/** Normalize line endings to LF and collapse insignificant whitespace for fuzzy matching */
function normalizeForMatch(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Find a search string using multiple strategies, return [start, length] in the content or null */
function findInContent(content: string, search: string, useRegex: boolean): { start: number; length: number } | null {
  // Strategy 1: Exact byte match
  const exact = content.indexOf(search);
  if (exact !== -1) return { start: exact, length: search.length };

  // Strategy 2: Normalized line endings
  const normContent = normalizeForMatch(content);
  const normSearch = normalizeForMatch(search);
  const normIdx = normContent.indexOf(normSearch);
  if (normIdx !== -1) {
    // Map normalized index back to original content index
    // Find the Nth character in original that corresponds to normIdx in normalized
    let origPos = 0, normPos = 0;
    while (normPos < normIdx && origPos < content.length) {
      if (content[origPos] === '\r' && content[origPos + 1] === '\n') {
        origPos += 2; normPos += 1;
      } else {
        origPos += 1; normPos += 1;
      }
    }
    // Find length: walk normSearch.length chars in normalized original
    let endOrig = origPos, endNorm = normPos;
    while (endNorm < normPos + normSearch.length && endOrig < content.length) {
      if (content[endOrig] === '\r' && content[endOrig + 1] === '\n') {
        endOrig += 2; endNorm += 1;
      } else {
        endOrig += 1; endNorm += 1;
      }
    }
    return { start: origPos, length: endOrig - origPos };
  }

  // Strategy 3: Trimmed-line fuzzy match
  // Build a version where each line is trimmed and compare
  const contentLines = normalizeForMatch(content).split('\n');
  const searchLines = normalizeForMatch(search).split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (searchLines.length > 0) {
    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      const window = contentLines.slice(i, i + searchLines.length).map(l => l.trim());
      if (searchLines.every((sl, j) => window[j] === sl)) {
        // Found fuzzy match at line i — compute char positions
        const beforeLines = contentLines.slice(0, i).join('\n') + (i > 0 ? '\n' : '');
        const matchLines = contentLines.slice(i, i + searchLines.length).join('\n');
        const afterOffset = beforeLines.length;
        // Map back to original CRLF content if needed
        const normBefore = normalizeForMatch(content).slice(0, afterOffset);
        // Translate norm offset to original offset
        let oStart = 0, nStart = 0;
        while (nStart < afterOffset && oStart < content.length) {
          if (content[oStart] === '\r' && content[oStart + 1] === '\n') { oStart += 2; nStart += 1; }
          else { oStart += 1; nStart += 1; }
        }
        const matchLen = matchLines.length;
        let oEnd = oStart, nEnd = nStart;
        while (nEnd < nStart + matchLen && oEnd < content.length) {
          if (content[oEnd] === '\r' && content[oEnd + 1] === '\n') { oEnd += 2; nEnd += 1; }
          else { oEnd += 1; nEnd += 1; }
        }
        return { start: oStart, length: oEnd - oStart };
      }
    }
  }

  // Strategy 4: Regex match
  if (useRegex) {
    try {
      const re = new RegExp(search, 'ms');
      const m = re.exec(content);
      if (m) return { start: m.index, length: m[0].length };
    } catch { /* invalid regex — skip */ }
  }

  return null;
}

/** Show context around a failed match to help debugging */
function buildSearchErrorContext(content: string, search: string): string {
  const lines = content.split('\n');
  const searchLines = search.split('\n').map(l => l.trim()).filter(Boolean);
  if (searchLines.length === 0) return '';

  // Find the line most similar to the first search line
  const firstSearchLine = searchLines[0];
  let bestScore = 0, bestLine = -1;
  for (let i = 0; i < Math.min(lines.length, 500); i++) {
    const trimmed = lines[i].trim();
    // Simple overlap score
    let score = 0;
    for (const word of firstSearchLine.split(/\s+/)) {
      if (trimmed.includes(word)) score++;
    }
    if (score > bestScore) { bestScore = score; bestLine = i; }
  }

  if (bestLine === -1 || bestScore === 0) return '';

  const ctx = lines.slice(Math.max(0, bestLine - 2), Math.min(lines.length, bestLine + 4));
  return `\n\nNearest match found at ~line ${bestLine + 1}:\n${ctx.map((l, i) => `  ${bestLine - 1 + i + 1}: ${l}`).join('\n')}`;
}

export const workspaceEditFileTool: ToolDefinition = {
  name: 'workspace_edit_file',
  description: `Edit files in the selected user workspace or explicit user paths using search/replace or line-based replacement. Protected EterX app source paths are rejected.

EDIT MODES:
- search + replace: Find exact text and replace it. Uses 4 fallback strategies (exact → normalized → fuzzy → regex).
- startLine + endLine + replace: Replace a specific range of lines by line number (1-indexed). Always reliable.
- insertAfterLine + replace: Insert text after a specific line without removing anything.
- insertBeforeLine + replace: Insert text before a specific line without removing anything.

OPTIONS:
- replaceAll: true → replace ALL occurrences (default: false, replaces only first)
- useRegex: true → treat "search" as a JavaScript regex pattern
- createIfMissing: true → create the file if it doesn't exist (uses "replace" as the initial content)

TIPS FOR NEVER FAILING:
- Always read the file first to get exact text if unsure
- Use startLine/endLine mode when search text has complex whitespace
- Use replaceAll:true to fix all occurrences at once`,
  category: 'workspace',
  inputSchema: z.object({
    filename: z.string().describe('File path — absolute or relative'),
    edits: z.array(z.object({
      search: z.string().optional().describe('Text to find (exact, or regex if useRegex:true)'),
      replace: z.string().describe('Replacement text (or content to insert)'),
      startLine: z.number().optional().describe('Start line for line-range mode (1-indexed)'),
      endLine: z.number().optional().describe('End line for line-range mode (1-indexed, inclusive)'),
      insertAfterLine: z.number().optional().describe('Insert text AFTER this line number without removing anything'),
      insertBeforeLine: z.number().optional().describe('Insert text BEFORE this line number without removing anything'),
      replaceAll: z.boolean().optional().describe('Replace ALL occurrences (default: false = first only)'),
      useRegex: z.boolean().optional().describe('Treat search as a JavaScript regex'),
      createIfMissing: z.boolean().optional().describe('Create the file with replace content if it does not exist'),
    })).describe('One or more edit operations to apply in order')
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string() }),
  execute: async (input: { filename: string; edits: any[] }, context?: any) => {
    const filePath = resolveWorkspacePathForContext(input.filename, context);

    const protection = checkEterXProtection(filePath);
    if (protection.blocked) {
      console.warn(`[Tool: workspace_edit_file] 🛡️ BLOCKED: ${filePath}`);
      return { success: false, error: protection.reason, message: protection.reason };
    }

    const fileExists = await fse.pathExists(filePath);

    // Handle createIfMissing — if file doesn't exist, create it with the first edit's replace content
    if (!fileExists) {
      const createEdit = input.edits.find((e: any) => e.createIfMissing);
      if (createEdit) {
        await fse.ensureDir(path.dirname(filePath));
        await fs.writeFile(filePath, createEdit.replace, 'utf-8');
        console.log(`[Tool: workspace_edit_file] ✨ Created new file: ${filePath}`);
        if (input.edits.length === 1) {
          return { success: true, message: `Created ${filePath} with provided content` };
        }
        // Continue with remaining edits
        input.edits = input.edits.filter((e: any) => e !== createEdit);
      } else {
        throw new Error(`File not found: ${filePath}. If you want to create it, set createIfMissing: true on the edit.`);
      }
    }

    let content = await fs.readFile(filePath, 'utf-8');
    const appliedEdits: string[] = [];
    let totalReplacements = 0;

    for (let editIdx = 0; editIdx < input.edits.length; editIdx++) {
      const edit = input.edits[editIdx];
      if (typeof edit.replace !== 'string') {
        throw new Error(`Edit ${editIdx + 1} is invalid: "replace" must be a string.`);
      }

      // ── Mode A: Line-range replacement ─────────────────────────────
      if (edit.startLine !== undefined && edit.endLine !== undefined) {
        const lines = content.split('\n');
        const startIdx = Math.max(0, edit.startLine - 1);
        const endIdx = Math.min(lines.length - 1, edit.endLine - 1);
        if (!Number.isInteger(edit.startLine) || !Number.isInteger(edit.endLine) || edit.startLine < 1 || edit.endLine < edit.startLine) {
          throw new Error(`Edit ${editIdx + 1} has an invalid line range: startLine=${edit.startLine}, endLine=${edit.endLine}.`);
        }
        if (startIdx > lines.length - 1) {
          throw new Error(`startLine ${edit.startLine} is beyond end of file (${lines.length} lines)`);
        }
        const replacementLines = edit.replace.split('\n');
        lines.splice(startIdx, endIdx - startIdx + 1, ...replacementLines);
        content = lines.join('\n');
        appliedEdits.push(`line-range[${edit.startLine}-${edit.endLine}]`);
        totalReplacements++;
        continue;
      }

      // ── Mode B: Insert after line ───────────────────────────────────
      if (edit.insertAfterLine !== undefined) {
        if (!Number.isInteger(edit.insertAfterLine) || edit.insertAfterLine < 0) {
          throw new Error(`Edit ${editIdx + 1} has an invalid insertAfterLine value: ${edit.insertAfterLine}.`);
        }
        const lines = content.split('\n');
        const idx = Math.min(edit.insertAfterLine, lines.length);
        lines.splice(idx, 0, ...edit.replace.split('\n'));
        content = lines.join('\n');
        appliedEdits.push(`insert-after[${edit.insertAfterLine}]`);
        totalReplacements++;
        continue;
      }

      // ── Mode C: Insert before line ──────────────────────────────────
      if (edit.insertBeforeLine !== undefined) {
        if (!Number.isInteger(edit.insertBeforeLine) || edit.insertBeforeLine < 1) {
          throw new Error(`Edit ${editIdx + 1} has an invalid insertBeforeLine value: ${edit.insertBeforeLine}.`);
        }
        const lines = content.split('\n');
        const idx = Math.max(0, edit.insertBeforeLine - 1);
        lines.splice(idx, 0, ...edit.replace.split('\n'));
        content = lines.join('\n');
        appliedEdits.push(`insert-before[${edit.insertBeforeLine}]`);
        totalReplacements++;
        continue;
      }

      // ── Mode D: Search & Replace ────────────────────────────────────
      if (edit.search !== undefined) {
        if (typeof edit.search !== 'string' || edit.search.length === 0) {
          throw new Error(`Edit ${editIdx + 1} is invalid: "search" must be a non-empty string.`);
        }
        const useRegex = !!edit.useRegex;
        const replaceAll = !!edit.replaceAll;

        if (replaceAll) {
          // Replace ALL occurrences
          if (useRegex) {
            try {
              const re = new RegExp(edit.search, 'gms');
              const newContent = content.replace(re, edit.replace);
              const count = (content.match(re) || []).length;
              if (count === 0) {
                throw new Error(`Regex /${edit.search}/gms not found in ${input.filename}.`);
              }
              content = newContent;
              appliedEdits.push(`regex-replace-all[${count} occurrences]`);
              totalReplacements += count;
            } catch (reErr: any) {
              throw new Error(`Regex error in edit ${editIdx + 1}: ${reErr.message}`);
            }
          } else {
            const occurrences = content.split(edit.search).length - 1;
            if (occurrences === 0) {
              // Try fuzzy for replaceAll
              const match = findInContent(content, edit.search, false);
              if (!match) {
                const ctx = buildSearchErrorContext(content, edit.search);
                throw new Error(`Search text not found in ${input.filename} (replaceAll mode). The exact text must exist.${ctx}`);
              }
              // Only one fuzzy match found — replace it
              content = content.slice(0, match.start) + edit.replace + content.slice(match.start + match.length);
              appliedEdits.push(`fuzzy-replace[1 occurrence]`);
              totalReplacements++;
            } else {
              // Exact replaceAll
              let result = content;
              let safeCount = 0;
              while (result.includes(edit.search) && safeCount < 10000) {
                result = result.replace(edit.search, edit.replace);
                safeCount++;
              }
              content = result;
              appliedEdits.push(`exact-replace-all[${occurrences} occurrences]`);
              totalReplacements += occurrences;
            }
          }
        } else {
          // Replace FIRST occurrence — multi-strategy
          if (useRegex) {
            try {
              const re = new RegExp(edit.search, 'ms');
              const m = re.exec(content);
              if (!m) throw new Error(`Regex /${edit.search}/ms not found in ${input.filename}.`);
              content = content.slice(0, m.index) + edit.replace + content.slice(m.index + m[0].length);
              appliedEdits.push(`regex-replace[1]`);
            } catch (reErr: any) {
              throw new Error(`Regex error in edit ${editIdx + 1}: ${reErr.message}`);
            }
          } else {
            const match = findInContent(content, edit.search, false);
            if (!match) {
              const ctx = buildSearchErrorContext(content, edit.search);
              throw new Error(
                `Search text not found in ${input.filename} after trying exact, normalized, and fuzzy matching.\n` +
                `Search was:\n${edit.search.substring(0, 200)}${edit.search.length > 200 ? '...' : ''}${ctx}\n\n` +
                `TIP: Read the file first with workspace_read_file to get the exact current text, then retry.`
              );
            }
            const strategyUsed = content.includes(edit.search) ? 'exact' : 'fuzzy/normalized';
            content = content.slice(0, match.start) + edit.replace + content.slice(match.start + match.length);
            appliedEdits.push(`${strategyUsed}-replace[1]`);
            totalReplacements++;
          }
        }
        continue;
      }

      throw new Error(
        `Edit ${editIdx + 1} is invalid — must have one of: "search", "startLine"+"endLine", "insertAfterLine", or "insertBeforeLine". Got: ${JSON.stringify(Object.keys(edit))}`
      );
    }

    await fs.writeFile(filePath, content, 'utf-8');
    const finalLineCount = content.split('\n').length;
    return {
      success: true,
      message: `Applied ${input.edits.length} edit(s) to ${filePath} (${totalReplacements} replacements, ${finalLineCount} lines total). Strategies used: ${appliedEdits.join(', ')}`
    };
  }
};

export const workspaceEditManyFilesTool: ToolDefinition = {
  name: 'workspace_edit_many_files',
  description: `Apply coordinated edits across multiple files in one tool call. Use this for multi-file fixes, renames, repeated replacements, and feature work after targeted search/read. Each file uses the same edit operations as workspace_edit_file. Defaults to atomic rollback: if one file fails, earlier file changes are restored.`,
  category: 'workspace',
  inputSchema: z.object({
    files: z.array(z.object({
      filename: z.string().describe('File path - absolute or relative to workspace.'),
      edits: z.array(z.object({
        search: z.string().optional().describe('Text to find, or regex if useRegex:true.'),
        replace: z.string().describe('Replacement text or inserted content.'),
        startLine: z.number().optional().describe('Start line for line-range mode, 1-indexed.'),
        endLine: z.number().optional().describe('End line for line-range mode, inclusive.'),
        insertAfterLine: z.number().optional().describe('Insert text after this 1-indexed line without removing anything.'),
        insertBeforeLine: z.number().optional().describe('Insert text before this 1-indexed line without removing anything.'),
        replaceAll: z.boolean().optional().describe('Replace all occurrences. Default false.'),
        useRegex: z.boolean().optional().describe('Treat search as a JavaScript regex.'),
        createIfMissing: z.boolean().optional().describe('Create the file with replace content if it does not exist.'),
      })).min(1).describe('Edits to apply to this file in order.')
    })).min(1).max(25).describe('Files to edit. Keep one logical change set per call.'),
    atomic: z.boolean().optional().describe('Rollback all prior file edits if any later file fails. Default true.')
  }),
  outputSchema: z.object({ success: z.boolean(), results: z.array(z.any()) }),
  execute: async (input: { files: BatchEditTarget[]; atomic?: boolean }, context?: any) => {
    const atomic = input.atomic ?? true;
    const backups: Array<{ filePath: string; existed: boolean; content: string }> = [];
    const backedUp = new Set<string>();
    const results: any[] = [];

    if (!Array.isArray(input.files) || input.files.length === 0) {
      return { success: false, results: [], message: 'No files were provided.' };
    }

    try {
      for (const target of input.files) {
        if (!target?.filename || !Array.isArray(target.edits) || target.edits.length === 0) {
          throw new Error(`Invalid batch edit target: ${JSON.stringify(target)}`);
        }

        const filePath = resolveWorkspacePathForContext(target.filename, context);
        const protection = checkEterXProtection(filePath);
        if (protection.blocked) {
          throw new Error(protection.reason);
        }

        if (atomic && !backedUp.has(filePath)) {
          const existed = await fse.pathExists(filePath);
          backups.push({
            filePath,
            existed,
            content: existed ? await fs.readFile(filePath, 'utf-8') : '',
          });
          backedUp.add(filePath);
        }

        const result = await workspaceEditFileTool.execute({
          filename: target.filename,
          edits: target.edits,
        }, context);

        results.push({ filename: target.filename, path: filePath, ...result });

        if (result?.success === false || result?.error) {
          throw new Error(result.error || result.message || `Edit failed for ${target.filename}`);
        }
      }

      return {
        success: true,
        results,
        filesChanged: results.length,
        message: `Applied batch edits to ${results.length} file(s).`,
      };
    } catch (error: any) {
      if (atomic) {
        for (const backup of backups.reverse()) {
          if (backup.existed) {
            await fse.ensureDir(path.dirname(backup.filePath));
            await fs.writeFile(backup.filePath, backup.content, 'utf-8');
          } else if (await fse.pathExists(backup.filePath)) {
            await fse.remove(backup.filePath);
          }
        }
      }

      return {
        success: false,
        results,
        error: error.message,
        rolledBack: atomic,
        message: atomic
          ? `Batch edit failed and ${backups.length} file backup(s) were restored: ${error.message}`
          : `Batch edit failed after partial changes: ${error.message}`,
      };
    }
  }
};
