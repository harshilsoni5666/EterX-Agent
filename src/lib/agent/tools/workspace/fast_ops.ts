import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import fs from 'fs/promises';
import fse from 'fs-extra';
import path from 'path';
import { createReadStream } from 'fs';
import * as readline from 'readline';
import {
  checkEterXProtection,
  resolveReadableWorkspacePathForContext,
  resolveWorkspaceDirectoryForContext,
  resolveWorkspacePathForContext,
} from '../../workspace/path_resolver';
import { isRgAvailable, runRgFiles } from '../shared/rg';
import { editTracker, buildCompactDiff } from '@/lib/code/edit-tracker';

async function countFileLines(filePath: string): Promise<number> {
  let count = 0;
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const _line of rl) count++;
  return Math.max(count, 1);
}

async function readTargetedLines(
  filePath: string,
  startLine: number,
  endLine?: number,
  maxLines = 500,
): Promise<{ lines: string[]; totalLines: number; start: number; end: number }> {
  const start = Math.max(1, startLine);
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const selected: string[] = [];
  let lineNo = 0;
  let totalLines = 0;
  const hardEnd = endLine ?? Number.MAX_SAFE_INTEGER;
  const cap = Math.min(maxLines, hardEnd - start + 1);

  for await (const line of rl) {
    lineNo++;
    totalLines = lineNo;
    if (lineNo < start) continue;
    if (lineNo > hardEnd) break;
    selected.push(line);
    if (selected.length >= cap) break;
  }

  if (selected.length < cap) {
    for await (const _line of rl) totalLines++;
  } else {
    totalLines = await countFileLines(filePath);
  }

  const actualEnd = start + selected.length - 1;
  return { lines: selected, totalLines, start, end: actualEnd };
}

function formatNumberedContent(lines: string[], startLine: number): string {
  return lines.map((line, idx) => `${startLine + idx}| ${line}`).join('\n');
}

export const workspaceFindFilesTool: ToolDefinition = {
  name: 'workspace_find_files',
  description: 'Fast file discovery without reading contents. Equivalent to rg --files. Use before targeted reads.',
  category: 'workspace',
  inputSchema: z.object({
    glob: z.string().optional().describe('Glob filter, e.g. "*.tsx", "**/*.ts", "!**/node_modules/**"'),
    directory: z.string().optional().describe('Directory to search. Default: workspace root'),
    maxResults: z.number().optional().describe('Maximum files to return (default: 400)'),
  }),
  outputSchema: z.object({
    files: z.array(z.string()),
    count: z.number(),
    searchEngine: z.string(),
  }),
  execute: async (input: { glob?: string; directory?: string; maxResults?: number }, context?: any) => {
    const searchDir = resolveWorkspaceDirectoryForContext(input.directory, context);
    const maxResults = Math.min(input.maxResults || 400, 1000);

    if (!await fse.pathExists(searchDir)) {
      return { files: [], count: 0, searchEngine: 'none', directory: searchDir, error: `Directory not found: ${searchDir}` };
    }

    if (isRgAvailable()) {
      try {
        const files = runRgFiles(searchDir, { glob: input.glob, maxResults });
        return { files, count: files.length, searchEngine: 'ripgrep', directory: searchDir };
      } catch (err: any) {
        console.warn(`[workspace_find_files] rg failed: ${err.message?.substring(0, 120)}`);
      }
    }

    const matches: string[] = [];
    const globPattern = input.glob?.replace(/^\*\*\//, '') || '*';

    async function walk(dir: string, rel = ''): Promise<void> {
      if (matches.length >= maxResults) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= maxResults) break;
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const relPath = rel ? path.join(rel, entry.name) : entry.name;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath, relPath);
          continue;
        }
        if (!globPattern || relPath.includes(globPattern.replace(/\*/g, '')) || relPath.endsWith(globPattern.replace(/^\*/, ''))) {
          matches.push(relPath.replace(/\\/g, '/'));
        }
      }
    }

    await walk(searchDir);
    return { files: matches.slice(0, maxResults), count: matches.length, searchEngine: 'nodejs', directory: searchDir };
  },
};

export const workspaceReadManyFilesTool: ToolDefinition = {
  name: 'workspace_read_many_files',
  description: 'Batch-read several files or targeted line ranges in parallel. Prefer this over repeated workspace_read_file calls.',
  category: 'workspace',
  inputSchema: z.object({
    files: z.array(z.object({
      filename: z.string().describe('File path — absolute or relative'),
      startLine: z.number().optional().describe('Start line (1-indexed)'),
      endLine: z.number().optional().describe('End line (1-indexed, inclusive)'),
    })).min(1).max(20),
    maxLinesPerFile: z.number().optional().describe('Max lines per file (default: 300)'),
  }),
  outputSchema: z.object({
    files: z.array(z.any()),
    readCount: z.number(),
  }),
  execute: async (input: { files: Array<{ filename: string; startLine?: number; endLine?: number }>; maxLinesPerFile?: number }, context?: any) => {
    const maxLinesPerFile = Math.min(input.maxLinesPerFile || 300, 500);

    const results = await Promise.all(input.files.map(async (spec) => {
      try {
        const filePath = resolveReadableWorkspacePathForContext(spec.filename, context);
        if (!await fse.pathExists(filePath)) {
          return { filename: spec.filename, path: filePath, error: `File not found: ${filePath}`, success: false };
        }

        const stats = await fs.stat(filePath);
        if (stats.size > 10 * 1024 * 1024) {
          return {
            filename: spec.filename,
            path: filePath,
            error: `File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB). Read a targeted range instead.`,
            success: false,
          };
        }

        const startLine = spec.startLine || 1;
        const { lines, totalLines, start, end } = await readTargetedLines(
          filePath,
          startLine,
          spec.endLine,
          maxLinesPerFile,
        );

        const numbered = formatNumberedContent(lines, start);
        const truncated = end < (spec.endLine || totalLines) && lines.length >= maxLinesPerFile;

        return {
          filename: spec.filename,
          path: filePath,
          success: true,
          totalLines,
          startLine: start,
          endLine: end,
          content: `[File: ${path.basename(filePath)} | ${totalLines} lines | Showing ${start}-${end}]\n${numbered}${truncated ? `\n...[TRUNCATED at ${maxLinesPerFile} lines]...` : ''}`,
        };
      } catch (err: any) {
        return { filename: spec.filename, success: false, error: err.message || 'Read failed' };
      }
    }));

    return { files: results, readCount: results.filter(r => r.success).length };
  },
};

export const workspaceEditManyFilesTool: ToolDefinition = {
  name: 'workspace_edit_many_files',
  description: 'Apply coordinated simple edits across multiple files. Atomic rollback on failure by default.',
  category: 'workspace',
  inputSchema: z.object({
    edits: z.array(z.object({
      filename: z.string(),
      search: z.string().optional().describe('Exact text to find for search/replace mode'),
      replace: z.string().describe('Replacement text'),
      startLine: z.number().optional(),
      endLine: z.number().optional(),
    })).min(1).max(30),
    atomic: z.boolean().optional().describe('Rollback all files if any edit fails (default: true)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    applied: z.number(),
    results: z.array(z.any()),
  }),
  execute: async (input: { edits: Array<{ filename: string; search?: string; replace: string; startLine?: number; endLine?: number }>; atomic?: boolean }, context?: any) => {
    const atomic = input.atomic !== false;
    const originals = new Map<string, string>();
    const latest = new Map<string, string>();
    const results: Array<Record<string, unknown>> = [];

    const applyOne = async (edit: { filename: string; search?: string; replace: string; startLine?: number; endLine?: number }) => {
      const filePath = resolveWorkspacePathForContext(edit.filename, context);
      const protection = checkEterXProtection(filePath);
      if (protection.blocked) throw new Error(protection.reason);

      if (!await fse.pathExists(filePath)) throw new Error(`File not found: ${filePath}`);
      if (!originals.has(filePath)) {
        const original = await fs.readFile(filePath, 'utf-8');
        originals.set(filePath, original);
        latest.set(filePath, original);
      }

      let content = latest.get(filePath)!;
      let lines = content.split('\n');

      if (edit.startLine !== undefined && edit.endLine !== undefined) {
        const startIdx = Math.max(0, edit.startLine - 1);
        const endIdx = Math.min(lines.length - 1, edit.endLine - 1);
        if (startIdx > endIdx || startIdx >= lines.length) {
          throw new Error(`Invalid line range ${edit.startLine}-${edit.endLine} in ${edit.filename}`);
        }
        const replacementLines = edit.replace.split('\n');
        lines.splice(startIdx, endIdx - startIdx + 1, ...replacementLines);
        content = lines.join('\n');
      } else if (edit.search !== undefined) {
        if (!content.includes(edit.search)) {
          throw new Error(`Search text not found in ${edit.filename}`);
        }
        content = content.split(edit.search).join(edit.replace);
      } else {
        throw new Error(`Edit for ${edit.filename} needs search or startLine/endLine`);
      }

      await fs.writeFile(filePath, content, 'utf-8');
      const beforeForDiff = originals.get(filePath) || '';
      latest.set(filePath, content);

      // Record in universal edit tracker
      try {
        editTracker.recordEdit({
          filePath,
          beforeContent: beforeForDiff,
          afterContent: content,
          toolName: 'workspace_edit_many_files',
          editType: 'multi',
        });
      } catch { /* tracker is best-effort */ }

      const diff = buildCompactDiff(
        edit.search || '',
        edit.replace,
        400,
      );

      return { filename: edit.filename, path: filePath, success: true, diff };
    };

    try {
      for (const edit of input.edits) {
        results.push(await applyOne(edit));
      }
      return { success: true, applied: results.length, results };
    } catch (err: any) {
      if (atomic) {
        for (const [filePath, original] of originals.entries()) {
          try { await fs.writeFile(filePath, original, 'utf-8'); } catch { /* best effort */ }
        }
      }
      return {
        success: false,
        applied: results.length,
        error: err.message || 'Batch edit failed',
        rolledBack: atomic,
        results,
      };
    }
  },
};
