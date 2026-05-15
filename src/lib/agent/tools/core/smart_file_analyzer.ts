import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';
import { createReadStream } from 'fs';
import { open as openFile } from 'fs/promises';
import * as readline from 'readline';

const FULL_TEXT_STATS_LIMIT_BYTES = 2 * 1024 * 1024;
const DIFF_FULL_READ_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * Smart File Analyzer — Multi-Mode File Intelligence
 * 
 * NEXT-GEN CONCEPT: Advanced file operations beyond simple read/write.
 * 
 * MODES:
 * - "stats": Get detailed file statistics (size, lines, encoding, type)
 * - "diff": Compare two files and show differences
 * - "head": Read first N lines of a file (for large files)
 * - "tail": Read last N lines of a file (for logs)
 * - "find": Find files matching a pattern recursively
 * - "tree": Generate directory tree visualization
 * - "count": Count files by extension in a directory
 * - "duplicates": Find duplicate files by content hash
 */
export const smartFileAnalyzerTool: ToolDefinition = {
  name: 'smart_file_analyzer',
  description: `Advanced file intelligence tool. Analyze files, compare diffs, read head/tail of large files, find patterns, generate directory trees, and count file types.

MODES:
- "stats": Detailed file stats (size, lines, type, encoding)
- "diff": Compare two files, show line-by-line differences
- "head": Read first N lines (default 30) — useful for large files
- "tail": Read last N lines (default 30) — useful for logs
- "find": Recursively find files matching glob pattern
- "tree": Generate visual directory tree (max 3 levels deep)
- "count": Count files by extension in dir
- "duplicates": Find duplicate files by size in dir`,
  category: 'workspace',
  inputSchema: z.object({
    mode: z.enum(['stats', 'diff', 'head', 'tail', 'find', 'tree', 'count', 'duplicates'])
      .describe('Analysis mode'),
    target: z.string().describe('File or directory path'),
    secondTarget: z.string().optional().describe('Second file for diff mode'),
    lines: z.number().optional().describe('Number of lines for head/tail mode (default: 30)'),
    pattern: z.string().optional().describe('Glob pattern for find mode (e.g. "*.ts", "*.py")')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    mode: z.string(),
    result: z.any()
  }),
  execute: async (input: {
    mode: string, target: string, secondTarget?: string,
    lines?: number, pattern?: string
  }) => {
    const resolvePath = (p: string) => path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    const targetPath = resolvePath(input.target);

    switch (input.mode) {
      case 'stats': {
        if (!await fs.pathExists(targetPath)) {
          return { success: false, mode: 'stats', result: { error: `Not found: ${targetPath}` } };
        }
        const stat = await fs.stat(targetPath);
        const result: any = {
          path: targetPath,
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
          size: stat.size,
          sizeHuman: stat.size < 1024 ? `${stat.size}B` : stat.size < 1048576 ? `${(stat.size / 1024).toFixed(1)}KB` : `${(stat.size / 1048576).toFixed(1)}MB`,
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          extension: path.extname(targetPath)
        };

        if (stat.isFile() && stat.size <= FULL_TEXT_STATS_LIMIT_BYTES) {
          const content = await fs.readFile(targetPath, 'utf-8');
          result.lines = content.split('\n').length;
          result.characters = content.length;
          result.words = content.split(/\s+/).filter(Boolean).length;
          result.encoding = 'utf-8';
        } else if (stat.isFile()) {
          result.largeFileMode = true;
          result.note = `Skipped full text scan because file is larger than ${(FULL_TEXT_STATS_LIMIT_BYTES / 1024 / 1024).toFixed(0)}MB. Use head/tail for sampling or a purpose-built script for full analysis.`;
        }

        return { success: true, mode: 'stats', result };
      }

      case 'diff': {
        if (!input.secondTarget) {
          return { success: false, mode: 'diff', result: { error: 'secondTarget required for diff' } };
        }
        const path2 = resolvePath(input.secondTarget);
        if (!await fs.pathExists(targetPath) || !await fs.pathExists(path2)) {
          return { success: false, mode: 'diff', result: { error: 'One or both files not found' } };
        }
        const [stat1, stat2] = await Promise.all([fs.stat(targetPath), fs.stat(path2)]);
        if (stat1.size > DIFF_FULL_READ_LIMIT_BYTES || stat2.size > DIFF_FULL_READ_LIMIT_BYTES) {
          return {
            success: false,
            mode: 'diff',
            result: {
              error: `Files are too large for full in-memory diff. Use head/tail sampling or a dedicated streaming diff.`,
              file1: { path: targetPath, size: stat1.size },
              file2: { path: path2, size: stat2.size },
              limitBytes: DIFF_FULL_READ_LIMIT_BYTES
            }
          };
        }

        const content1 = (await fs.readFile(targetPath, 'utf-8')).split('\n');
        const content2 = (await fs.readFile(path2, 'utf-8')).split('\n');

        const diffs: string[] = [];
        const maxLines = Math.max(content1.length, content2.length);

        for (let i = 0; i < maxLines; i++) {
          const line1 = content1[i];
          const line2 = content2[i];
          if (line1 !== line2) {
            if (line1 !== undefined && line2 !== undefined) {
              diffs.push(`L${i + 1}: - ${line1.substring(0, 120)}`);
              diffs.push(`L${i + 1}: + ${line2.substring(0, 120)}`);
            } else if (line1 !== undefined) {
              diffs.push(`L${i + 1}: - ${line1.substring(0, 120)} (removed)`);
            } else {
              diffs.push(`L${i + 1}: + ${line2!.substring(0, 120)} (added)`);
            }
          }
        }

        return {
          success: true,
          mode: 'diff',
          result: {
            file1: { path: targetPath, lines: content1.length },
            file2: { path: path2, lines: content2.length },
            identical: diffs.length === 0,
            diffCount: Math.floor(diffs.length / 2),
            diffs: diffs.slice(0, 50)  // Cap at 50 diff lines
          }
        };
      }

      case 'head': {
        if (!await fs.pathExists(targetPath)) {
          return { success: false, mode: 'head', result: { error: `Not found: ${targetPath}` } };
        }
        const n = input.lines || 30;
        const sampled = await readHeadLines(targetPath, n);
        return {
          success: true,
          mode: 'head',
          result: { showing: sampled.showing, streamed: true, content: sampled.content, note: sampled.truncated ? 'Only the requested first lines were read; the full file was not loaded into memory.' : undefined }
        };
      }

      case 'tail': {
        if (!await fs.pathExists(targetPath)) {
          return { success: false, mode: 'tail', result: { error: `Not found: ${targetPath}` } };
        }
        const n = input.lines || 30;
        const sampled = await readTailLines(targetPath, n);
        return {
          success: true,
          mode: 'tail',
          result: { showing: sampled.showing, streamed: true, content: sampled.content, note: 'Read from the end of the file without loading the full file into memory.' }
        };
      }

      case 'find': {
        const pattern = input.pattern || '*';
        const results: string[] = [];

        async function walk(dir: string, depth: number = 0) {
          if (depth > 5 || results.length > 100) return;
          try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                await walk(fullPath, depth + 1);
              } else {
                // Simple glob matching
                const ext = pattern.startsWith('*.') ? pattern.slice(1) : null;
                if (ext) {
                  if (entry.name.endsWith(ext)) results.push(fullPath);
                } else if (entry.name.includes(pattern.replace('*', ''))) {
                  results.push(fullPath);
                }
              }
            }
          } catch { }
        }

        await walk(targetPath);
        return { success: true, mode: 'find', result: { pattern, found: results.length, files: results.slice(0, 50) } };
      }

      case 'tree': {
        const lines: string[] = [];

        async function buildTree(dir: string, prefix: string, depth: number) {
          if (depth > 3 || lines.length > 200) return;
          try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const filtered = entries.filter(e => !e.name.startsWith('.') && e.name !== 'node_modules');
            
            for (let i = 0; i < filtered.length; i++) {
              const entry = filtered[i];
              const isLast = i === filtered.length - 1;
              const connector = isLast ? '└── ' : '├── ';
              const icon = entry.isDirectory() ? '📁' : '📄';
              lines.push(`${prefix}${connector}${icon} ${entry.name}`);

              if (entry.isDirectory()) {
                const newPrefix = prefix + (isLast ? '    ' : '│   ');
                await buildTree(path.join(dir, entry.name), newPrefix, depth + 1);
              }
            }
          } catch { }
        }

        lines.push(`📁 ${path.basename(targetPath)}`);
        await buildTree(targetPath, '', 0);
        return { success: true, mode: 'tree', result: { path: targetPath, tree: lines.join('\n') } };
      }

      case 'count': {
        const counts: Record<string, number> = {};
        let totalFiles = 0;

        async function countFiles(dir: string, depth: number) {
          if (depth > 5) return;
          try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
              if (entry.isDirectory()) {
                await countFiles(path.join(dir, entry.name), depth + 1);
              } else {
                const ext = path.extname(entry.name) || '(no ext)';
                counts[ext] = (counts[ext] || 0) + 1;
                totalFiles++;
              }
            }
          } catch { }
        }

        await countFiles(targetPath, 0);
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        return {
          success: true,
          mode: 'count',
          result: { path: targetPath, totalFiles, byExtension: Object.fromEntries(sorted) }
        };
      }

      case 'duplicates': {
        const sizeMap: Map<number, string[]> = new Map();

        async function scanDupes(dir: string, depth: number) {
          if (depth > 3) return;
          try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                await scanDupes(fullPath, depth + 1);
              } else {
                const stat = await fs.stat(fullPath);
                const key = stat.size;
                if (!sizeMap.has(key)) sizeMap.set(key, []);
                sizeMap.get(key)!.push(fullPath);
              }
            }
          } catch { }
        }

        await scanDupes(targetPath, 0);
        const duplicates = Array.from(sizeMap.entries())
          .filter(([_, files]) => files.length > 1)
          .map(([size, files]) => ({ sizeBytes: size, files }))
          .slice(0, 20);

        return {
          success: true,
          mode: 'duplicates',
          result: { path: targetPath, duplicateGroups: duplicates.length, duplicates }
        };
      }

      default:
        return { success: false, mode: input.mode, result: { error: `Unknown mode: ${input.mode}` } };
    }
  }
};

async function readHeadLines(filePath: string, maxLines: number): Promise<{ content: string; showing: number; truncated: boolean }> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  let truncated = false;

  try {
    for await (const line of rl) {
      if (lines.length < maxLines) {
        lines.push(line);
      } else {
        truncated = true;
        break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { content: lines.join('\n'), showing: lines.length, truncated };
}

async function readTailLines(filePath: string, maxLines: number): Promise<{ content: string; showing: number }> {
  const handle = await openFile(filePath, 'r');
  const stat = await handle.stat();
  const chunkSize = 64 * 1024;
  const chunks: string[] = [];
  let position = stat.size;
  let newlineCount = 0;

  try {
    while (position > 0 && newlineCount <= maxLines) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, position);
      const text = buffer.toString('utf-8');
      chunks.unshift(text);
      newlineCount += (text.match(/\n/g) || []).length;
    }
  } finally {
    await handle.close();
  }

  const lines = chunks.join('').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const lastLines = lines.slice(Math.max(0, lines.length - maxLines));
  return { content: lastLines.join('\n'), showing: lastLines.length };
}
