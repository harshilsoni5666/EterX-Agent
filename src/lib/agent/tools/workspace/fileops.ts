import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import fs from 'fs/promises';
import fse from 'fs-extra';
import path from 'path';
import { createReadStream } from 'fs';
import * as readline from 'readline';
import { execFileSync, spawnSync } from 'child_process';

import {
  checkEterXProtection,
  getPathResolverInfo,
  resolveWorkspacePathForContext,
  resolveReadableWorkspacePathForContext,
} from '../../workspace/path_resolver';
import { isRgAvailable } from '../shared/rg';
import { buildTerminalShellInvocation } from '../core/shell_resolver';

const DESKTOP_SCRIPT_EXTENSIONS = new Set(['.py', '.ps1', '.js', '.mjs', '.cjs', '.bat', '.cmd', '.vbs', '.ahk']);

async function writeUtf8Atomic(filePath: string, content: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await fs.writeFile(tempPath, content, 'utf8');
  try {
    await fse.move(tempPath, filePath, { overwrite: true });
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
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

async function extractDocumentText(filePath: string, extension: string): Promise<string> {
  if (extension === 'docx') {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(filePath);
    const xmlContent = zip.readAsText('word/document.xml', 'utf8');
    if (!xmlContent) return '[Error: Empty or invalid DOCX document.xml]';
    const paragraphs: string[] = [];
    const paragraphRegex = /<w:p\b[^>]*>(.*?)<\/w:p>/g;
    const textRegex = /<w:t\b[^>]*>(.*?)<\/w:t>/g;
    let match: RegExpExecArray | null;
    while ((match = paragraphRegex.exec(xmlContent)) !== null) {
      const textMatches = match[1].match(textRegex);
      if (!textMatches) continue;
      paragraphs.push(textMatches
        .map(value => value.replace(/<[^>]+>/g, ''))
        .join('')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'"));
    }
    return paragraphs.join('\n');
  }

  const pdfParse = require('pdf-parse');
  const data = await pdfParse(await fs.readFile(filePath));
  return data.text || '';
}

async function readFileRange(
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
  const hardEnd = endLine ?? Number.MAX_SAFE_INTEGER;
  const cap = Math.min(maxLines, hardEnd - start + 1);

  let totalLines = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      if (lineNo < start) continue;
      if (lineNo > hardEnd) break;
      selected.push(line);
      if (selected.length >= cap) break;
    }

    totalLines = lineNo;
    if (selected.length >= cap) {
      for await (const _line of rl) totalLines++;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { lines: selected, totalLines: Math.max(totalLines, lineNo), start, end: start + selected.length - 1 };
}

// ════════════════════════════════════════════════════════════════════
// workspace_read_file — UPGRADED with startLine/endLine + line numbers
// ════════════════════════════════════════════════════════════════════
export const workspaceReadTool: ToolDefinition = {
  name: 'workspace_read_file',
  description: 'Read file contents using an absolute OS path or a relative workspace path. Use startLine/endLine for targeted ranges. Returns numbered lines for precise editing.',
  category: 'workspace',
  inputSchema: z.object({
    filename: z.string().describe('Absolute path for the current OS, or a path relative to the workspace'),
    startLine: z.number().int().min(1).optional().describe('Start line number (1-indexed). Omit to start from beginning.'),
    endLine: z.number().int().min(1).optional().describe('End line number (1-indexed, inclusive). Omit to read to end.'),
    maxLines: z.number().int().min(1).max(5000).optional().describe('Maximum number of lines to return (default: 500). Use smaller values for targeted reads.')
  }),
  outputSchema: z.object({ content: z.string() }),
  execute: async (input: { filename: string; startLine?: number; endLine?: number; maxLines?: number }, context?: any) => {
    const filePath = resolveReadableWorkspacePathForContext(input.filename, context);
    console.log(`[Tool: workspace_read_file] Reading: ${ filePath }${ input.startLine ? ` (lines ${input.startLine}-${input.endLine || 'end'})` : '' }`);

    if (context?.runLocation === 'sandbox') {
      // Use SandboxGuard if available (enterprise enforcement)
      const guard = context?.sandboxGuard;
      if (guard) {
        const readDecision = guard.assertCanRead(filePath);
        if (!readDecision.allowed) {
          await guard.audit({ type: 'file.read.blocked', path: filePath, reason: readDecision.reason });
          throw new Error(readDecision.reason);
        }
        await guard.audit({ type: 'file.read', path: filePath });
      } else {
        // Fallback: use sandbox module directly
        const { createSandboxSession, readSandboxFile } = require('../../../sandbox');
        const session = createSandboxSession({
          tenantId: 'local',
          userId: context?.userId || 'user',
          projectId: context?.projectId || context?.chatId || 'default',
          sessionId: context?.chatId || context?.agentId || 'default',
          workspaceRoot: context?.workspaceRoot || process.cwd(),
          allowPaths: context?.allowedPaths || [],
        });
        await readSandboxFile(session, filePath);
      }

      if (!await fse.pathExists(filePath)) {
        throw new Error(`File not found: ${filePath}. Check the path and try again.`);
      }

      const stats = await fs.stat(filePath);
      const ext = filePath.split('.').pop()?.toLowerCase();
      let rawContent = '';
      if (ext === 'docx') {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(filePath);
        const xmlContent = zip.readAsText('word/document.xml', 'utf8');
        if (xmlContent) {
          const paragraphRegex = /<w:p\b[^>]*>(.*?)<\/w:p>/g;
          const textRegex = /<w:t\b[^>]*>(.*?)<\/w:t>/g;
          const paragraphs: string[] = [];
          let match;
          while ((match = paragraphRegex.exec(xmlContent)) !== null) {
            const pContent = match[1];
            const textMatches = pContent.match(textRegex);
            if (textMatches) {
              const pText = textMatches
                .map(tMatch => tMatch.replace(/<[^>]+>/g, ''))
                .join('')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'");
              paragraphs.push(pText);
            }
          }
          rawContent = paragraphs.join('\n');
        } else {
          rawContent = '[Error: Empty or invalid DOCX document.xml]';
        }
      } else if (ext === 'pdf') {
        const pdfParse = require('pdf-parse');
        const dataBuffer = await fs.readFile(filePath);
        const pdfData = await pdfParse(dataBuffer);
        rawContent = pdfData.text || '';
      } else {
        rawContent = await fs.readFile(filePath, 'utf-8');
      }
      const lines = rawContent.split('\n');
      const start = Math.max(1, input.startLine || 1);
      const end = input.endLine ?? lines.length;
      const maxLines = input.maxLines || 500;
      const rangedLines = lines.slice(start - 1, end);
      const outputLines = rangedLines.slice(0, maxLines);
      
      const MAX_CHAR_LIMIT = 150000;
      let content = '';
      let lastLineShown = start - 1;
      let charTruncated = false;

      for (let i = 0; i < outputLines.length; i++) {
        const lineText = `${start + i}| ${outputLines[i]}\n`;
        if (content.length + lineText.length > MAX_CHAR_LIMIT) {
          charTruncated = true;
          break;
        }
        content += lineText;
        lastLineShown = start + i;
      }

      const truncated = (rangedLines.length > maxLines) || charTruncated;
      if (charTruncated) {
        content += `\n\n⚠️ ...[TRUNCATED: Content exceeded maximum safety threshold of ${MAX_CHAR_LIMIT} characters to prevent API payload errors. To read the next section of this file, call workspace_read_file with startLine: ${lastLineShown + 1} and endLine: ${end}]...`;
      } else if (rangedLines.length > maxLines) {
        content += `\n\n...[TRUNCATED at ${maxLines} lines. File has ${lines.length} total lines. Showing lines ${start}-${start + maxLines - 1}. To read the next section of this file, call workspace_read_file with startLine: ${start + maxLines} and endLine: ${end}]...`;
      }

      const fileInfo = `[File: ${path.basename(filePath)} | ${lines.length} lines | ${(stats.size / 1024).toFixed(1)}KB | Showing lines ${start}-${lastLineShown}]`;
      
      return {
        content: `${fileInfo}\n${content}`,
        size: stats.size,
        path: filePath,
        totalLines: lines.length,
        linesShown: lastLineShown - start + 1,
        startLine: start,
        endLine: lastLineShown,
      };
    }

    if (!await fse.pathExists(filePath)) {
      throw new Error(`File not found: ${ filePath }. Check the path and try again.`);
    }

    const stats = await fs.stat(filePath);
    if (stats.size > 10 * 1024 * 1024) {
      throw new Error(`File too large (${ (stats.size / 1024 / 1024).toFixed(1) }MB). Use shell_command with "Get-Content -First N" or "Select-Object" to read portions.`);
    }

    const extension = path.extname(filePath).toLowerCase().slice(1);
    if (extension === 'docx' || extension === 'pdf') {
      const rawContent = await extractDocumentText(filePath, extension);
      const allLines = rawContent.split('\n');
      const start = Math.max(1, Math.floor(input.startLine || 1));
      const end = Math.max(start, Math.floor(input.endLine ?? allLines.length));
      const maxLines = Math.max(1, Math.min(Math.floor(input.maxLines || 500), 5000));
      const outputLines = allLines.slice(start - 1, end).slice(0, maxLines);
      const lastLineShown = outputLines.length ? start + outputLines.length - 1 : start - 1;
      const content = outputLines.map((line, index) => `${start + index}| ${line}`).join('\n');
      return {
        content: `[File: ${path.basename(filePath)} | ${allLines.length} lines | ${(stats.size / 1024).toFixed(1)}KB | Showing lines ${start}-${lastLineShown}]\n${content}`,
        size: stats.size,
        path: filePath,
        totalLines: allLines.length,
        linesShown: outputLines.length,
        startLine: start,
        endLine: lastLineShown,
      };
    }

    const maxLines = Math.max(1, Math.min(Math.floor(input.maxLines || 500), 5000));
    const start = Math.max(1, Math.floor(input.startLine || 1));
    const ranged = await readFileRange(filePath, start, input.endLine, maxLines);
    const outputLines = ranged.lines;
    const totalLines = ranged.totalLines;
    const endLineTarget = input.endLine ?? totalLines;

    const MAX_CHAR_LIMIT = 150000;
    let content = '';
    let lastLineShown = start - 1;
    let charTruncated = false;

    for (let i = 0; i < outputLines.length; i++) {
      const lineText = `${start + i}| ${outputLines[i]}\n`;
      if (content.length + lineText.length > MAX_CHAR_LIMIT) {
        charTruncated = true;
        break;
      }
      content += lineText;
      lastLineShown = start + i;
    }

    const truncated = (outputLines.length >= maxLines && (!input.endLine || ranged.end < input.endLine)) || charTruncated;
    if (charTruncated) {
      content += `\n\n⚠️ ...[TRUNCATED: Content exceeded maximum safety threshold of ${MAX_CHAR_LIMIT} characters to prevent API payload errors. To read the next section of this file, call workspace_read_file with startLine: ${lastLineShown + 1} and endLine: ${endLineTarget}]...`;
    } else if (truncated) {
      content += `\n\n...[TRUNCATED at ${maxLines} lines. File has ${totalLines} total lines. Showing lines ${start}-${start + maxLines - 1}. To read the next section of this file, call workspace_read_file with startLine: ${start + maxLines} and endLine: ${endLineTarget}]...`;
    }

    // Overall file info
    const fileInfo = `[File: ${path.basename(filePath)} | ${totalLines} lines | ${(stats.size / 1024).toFixed(1)}KB | Showing lines ${start}-${lastLineShown}]`;

    return {
      content: `${fileInfo}\n${content}`,
      size: stats.size,
      path: filePath,
      totalLines,
      linesShown: lastLineShown - start + 1,
      startLine: start,
      endLine: lastLineShown,
    };
  }
};

export const workspaceWriteTool: ToolDefinition = {
  name: 'workspace_write_file',
  description: 'Create a NEW file or append to an existing file and show the created-file preview in the UI. For modifying an existing file, use workspace_edit_file instead of rewriting it.',
  category: 'workspace',
  inputSchema: z.object({
    filename: z.string().describe('File path — absolute or relative to workspace'),
    content: z.string().describe('Content to write'),
    append: z.boolean().optional().describe('Set to true to append to the file instead of overwriting. EXTREMELY helpful for the auto-chunk workflow.'),
    overwrite: z.boolean().optional().describe('Explicitly allow replacing an existing file. Defaults to false because this tool is intended for new files.')
  }),
  outputSchema: z.object({ success: z.boolean(), path: z.string() }),
  execute: async (input: { filename: string, content: string, append?: boolean, overwrite?: boolean }, context?: any) => {
    // Guard against undefined/empty filename — this was causing "path must be string" crashes
    if (!input.filename || typeof input.filename !== 'string' || !input.filename.trim()) {
      return { success: false, error: 'INVALID FILENAME: You must provide a valid filename string. Do not pass undefined or empty string.', path: '' };
    }
    const filePath = resolveWorkspacePathForContext(input.filename, context);

    if (context?.runLocation === 'sandbox') {
      // Use SandboxGuard if available (enterprise enforcement)
      const guard = context?.sandboxGuard;
      if (guard) {
        const writeDecision = guard.assertCanWrite(filePath);
        if (!writeDecision.allowed) {
          await guard.audit({ type: 'file.write.blocked', path: filePath, reason: writeDecision.reason });
          return { success: false, error: writeDecision.reason, path: filePath };
        }
        
        await fse.ensureDir(path.dirname(filePath));
        let finalContent = input.content;
        if (input.append) {
          try {
            const existing = await fs.readFile(filePath, 'utf-8');
            finalContent = existing + input.content;
          } catch {}
        }
        await writeUtf8Atomic(filePath, finalContent);
        await guard.audit({ type: 'file.write', path: filePath, bytes: Buffer.byteLength(finalContent) });
        return { success: true, path: filePath, size: Buffer.byteLength(finalContent, 'utf8') };
      } else {
        // Fallback: use sandbox module directly
        const { createSandboxSession, writeSandboxFile, readSandboxFile } = require('../../../sandbox');
        const session = createSandboxSession({
          tenantId: 'local',
          userId: context?.userId || 'user',
          projectId: context?.projectId || context?.chatId || 'default',
          sessionId: context?.chatId || context?.agentId || 'default',
          workspaceRoot: context?.workspaceRoot || process.cwd(),
          allowPaths: context?.allowedPaths || [],
        });
        
        let finalContent = input.content;
        if (input.append) {
          try {
            const existing = await readSandboxFile(session, filePath);
            finalContent = existing + input.content;
          } catch {}
        }
        
        const writtenPath = await writeSandboxFile(session, filePath, finalContent);
        return { success: true, path: writtenPath, size: finalContent.length };
      }
    }

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

    // ─── OVERWRITE GUARD ───
    // Warn the agent when it tries to overwrite an existing large file.
    // This is almost always wrong — the agent should use str_replace instead.
    if (!input.append) {
      try {
        const existingStat = await fs.stat(filePath);
        if (existingStat.isFile()) {
          if (!input.overwrite) {
            return {
              success: false,
              error: `Refusing to overwrite existing file: ${filePath}. Use workspace_edit_file for targeted edits, append=true to append, or overwrite=true only when replacing the whole file is intentional.`,
              path: filePath,
            };
          }
          const existingContent = await fs.readFile(filePath, 'utf-8');
          const existingLines = existingContent.split('\n').length;
          
          // Allow small files (likely configs, new stubs) but warn on large ones
          if (existingLines > 50 && input.content.length > 500) {
            console.warn(`[workspace_write_file] ⚠️ OVERWRITE WARNING: ${filePath} has ${existingLines} lines. Agent should use workspace_edit_file instead.`);
            // Don't block — but inject a warning into the result
            await writeUtf8Atomic(filePath, input.content);
            return {
              success: true,
              path: filePath,
              size: Buffer.byteLength(input.content, 'utf8'),
              warning: `⚠️ You overwrote an existing ${existingLines}-line file. For future edits, use workspace_edit_file instead of workspace_write_file. Only use workspace_write_file for NEW files.`,
              overwrittenLines: existingLines,
            };
          }
        }
      } catch {
        // File doesn't exist yet — that's fine, this is a new file
      }
    }

    console.log(`[Tool: workspace_write_file] ${ input.append ? 'Appending' : 'Writing' } to: ${ filePath }`);

    if (input.append) {
      await fs.appendFile(filePath, input.content, 'utf-8');
    } else {
      await writeUtf8Atomic(filePath, input.content);
    }

    return { success: true, path: filePath, size: Buffer.byteLength(input.content, 'utf8') };
  }
};

export const workspaceListDirectoryTool: ToolDefinition = {
  name: 'workspace_list_directory',
  description: 'List files and directories at ANY path on the local system. Use absolute paths for Desktop, Documents, etc. Use relative for workspace.',
  category: 'workspace',
  inputSchema: z.object({
    directory: z.string().optional().describe('Absolute OS path or relative workspace directory. Default: workspace root'),
    depth: z.number().int().min(1).max(5).optional().describe('Maximum depth for recursive listing (default: 1 = current dir only, 2 = one level deep)')
  }),
  outputSchema: z.object({
    files: z.array(z.string()),
    tree: z.string(),
    entries: z.array(z.object({
      name: z.string(),
      isDir: z.boolean(),
      size: z.number().optional()
    })).optional(),
    path: z.string().optional(),
    count: z.number().optional()
  }),
  execute: async (input: { directory?: string; depth?: number }, context?: any) => {
    const walkDir = resolveReadableWorkspacePathForContext(input.directory || '.', context);

    if (!await fse.pathExists(walkDir)) {
      throw new Error(`Directory not found: ${ walkDir }`);
    }

    const entries = await fs.readdir(walkDir, { withFileTypes: true });
    const maxDepth = Math.max(1, Math.min(Math.floor(input.depth ?? 1), 5));
    const recursiveItems: Array<{ relative: string; name: string; isDir: boolean; isDirectory: () => boolean; size?: number }> = [];

    const collect = async (directory: string, relativeDirectory: string, currentDepth: number): Promise<void> => {
      if (currentDepth >= maxDepth || recursiveItems.length >= 500) return;
      let children: import('fs').Dirent[] = [];
      try {
        children = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      children.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });
      for (const child of children) {
        if (recursiveItems.length >= 500) break;
        const relative = relativeDirectory ? path.join(relativeDirectory, child.name) : child.name;
        let size: number | undefined;
        if (!child.isDirectory()) {
          try { size = (await fs.stat(path.join(directory, child.name))).size; } catch { /* best effort */ }
        }
        recursiveItems.push({ relative, name: relative, isDir: child.isDirectory(), isDirectory: () => child.isDirectory(), size });
        if (child.isDirectory()) await collect(path.join(directory, child.name), relative, currentDepth + 1);
      }
    };
    await collect(walkDir, '', 0);

    // Sort directories first, then alphabetically
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    let items = recursiveItems.slice(0, 500).map(e => {
      const type = e.isDirectory() ? '📁' : '📄';
      return `${ type } ${ e.name }`;
    });

    if (entries.length > 500) {
      items.push(`... [Truncated ${ entries.length - 500 } additional items. Use shell_command with "Get-ChildItem" for full listing]`);
    }

    const entriesInfo = await Promise.all(entries.slice(0, 500).map(async e => {
      const isDir = e.isDirectory();
      let size: number | undefined = undefined;
      if (!isDir) {
        try {
          const stats = await fs.stat(path.join(walkDir, e.name));
          size = stats.size;
        } catch {
          // ignore stats errors safely
        }
      }
      return { name: e.name, isDir, size };
    }));

    return {
      files: recursiveItems.map(e => e.relative).slice(0, 500),
      tree: items.join('\n'),
      entries: entriesInfo,
      path: walkDir,
      count: recursiveItems.length
    };
  }
};

// ════════════════════════════════════════════════════════════════════
// workspace_search_text — UPGRADED: Uses ripgrep (rg) when available,
// falls back to PowerShell Select-String, then naive Node.js search
// ════════════════════════════════════════════════════════════════════
export const workspaceSearchTextTool: ToolDefinition = {
  name: 'workspace_search_text',
  description: 'Search for a text pattern across files using ripgrep (rg). Fast, respects .gitignore, supports regex. Equivalent to rg -n. For complex searches, use shell_command directly with rg.',
  category: 'workspace',
  inputSchema: z.object({
    pattern: z.string().describe('String or regex pattern to search for'),
    directory: z.string().optional().describe('Directory to search in (absolute or relative). Default: workspace'),
    fileType: z.string().optional().describe('File type filter (e.g. "ts", "py", "js"). Maps to rg --type'),
    glob: z.string().optional().describe('Glob filter for files (e.g. "*.tsx", "!**/node_modules/**")'),
    caseSensitive: z.boolean().optional().describe('Case-sensitive search (default: smart case)'),
    maxResults: z.number().int().min(1).max(300).optional().describe('Maximum results to return (default: 200)')
  }),
  outputSchema: z.object({ results: z.array(z.any()) }),
  execute: async (input: { pattern: string; directory?: string; fileType?: string; glob?: string; caseSensitive?: boolean; maxResults?: number }, context?: any) => {
    const searchDir = resolveReadableWorkspacePathForContext(input.directory || '.', context);
    const maxResults = Math.max(1, Math.min(Math.floor(input.maxResults || 200), 300));

    if (!await fse.pathExists(searchDir)) return { results: [] };

    // ─── Try ripgrep first ───
    if (isRgAvailable()) {
      try {
        const args: string[] = ['--json', '-n', '--no-heading'];
        if (!input.caseSensitive) args.push('--smart-case');
        if (input.fileType) args.push('--type', input.fileType);
        if (input.glob) args.push('--glob', input.glob);
        args.push('--max-count', String(Math.min(maxResults * 2, 600)));
        args.push('--', input.pattern, '.');

        const rgResult = spawnSync('rg', args, {
          cwd: searchDir,
          encoding: 'utf-8',
          timeout: 30000,
          maxBuffer: 5 * 1024 * 1024,
        });

        if (rgResult.status === 1 && !rgResult.stdout) {
          return { results: [], totalMatches: 0, searchEngine: 'ripgrep', directory: searchDir };
        }

        const stdout = rgResult.stdout || '';

        const results: any[] = [];
        const lines = stdout.split('\n').filter(Boolean);
        for (const line of lines) {
          if (results.length >= maxResults) break;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'match' && parsed.data) {
              const d = parsed.data;
              const relPath = d.path?.text || '';
              const lineNum = d.line_number || 0;
              const lineText = d.lines?.text?.trim()?.substring(0, 200) || '';
              results.push({ file: relPath, line: lineNum, content: lineText });
            }
          } catch { /* skip malformed JSON lines */ }
        }

        return {
          results,
          totalMatches: results.length,
          searchEngine: 'ripgrep',
          directory: searchDir,
        };
      } catch (rgErr: any) {
        console.warn(`[workspace_search_text] rg failed, falling back: ${rgErr.message?.substring(0, 100)}`);
      }
    }

    // ─── Fallback: PowerShell Select-String ───
    if (process.platform === 'win32') try {
      const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
      const psCmd = `Get-ChildItem -LiteralPath ${psQuote(searchDir)} -File -Recurse -ErrorAction SilentlyContinue | ` +
        `Select-String -Pattern ${psQuote(input.pattern)} -ErrorAction SilentlyContinue | ` +
        `Select-Object -First ${maxResults} | ` +
        `ForEach-Object { [pscustomobject]@{ file=$_.Path; line=[int]$_.LineNumber; content=$_.Line.Trim().Substring(0, [Math]::Min(200, $_.Line.Trim().Length)) } | ConvertTo-Json -Compress }`;

      const invocation = buildTerminalShellInvocation(psCmd, 'powershell');
      const stdout = execFileSync(invocation.file, invocation.args, {
        cwd: searchDir,
        encoding: 'utf-8',
        timeout: 20000,
        maxBuffer: 3 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const results: any[] = [];
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        if (results.length >= maxResults) break;
        try {
          const parsed = JSON.parse(line);
          const relativeFile = parsed.file
            ? path.relative(searchDir, String(parsed.file)).replace(/\\/g, '/')
            : '';
          results.push({ file: relativeFile || parsed.file, line: Number(parsed.line) || 0, content: String(parsed.content || '').substring(0, 200) });
        } catch { /* skip malformed PowerShell output */ }
      }

      return { results, totalMatches: results.length, searchEngine: 'powershell', directory: searchDir };
    } catch {
      // Final fallback — naive Node.js search (slow but always works)
    }

    // ─── Final fallback: Node.js readdir + includes ───
    const results: any[] = [];

    const walkAndSearch = async (directory: string, relativeDirectory = ''): Promise<void> => {
      if (results.length >= maxResults) return;
      let entries: import('fs').Dirent[] = [];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const filePath = path.join(directory, entry.name);
        const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
        if (entry.isDirectory()) {
          await walkAndSearch(filePath, relativePath);
          continue;
        }
        try {
          const stat = await fs.stat(filePath);
          if (!stat.isFile() || stat.size > 1024 * 1024) continue;
          const content = await fs.readFile(filePath, 'utf-8');
          for (const [index, line] of content.split('\n').entries()) {
            if (line.includes(input.pattern) && results.length < maxResults) {
              results.push({ file: relativePath.replace(/\\/g, '/'), line: index + 1, content: line.trim().substring(0, 200) });
            }
            if (results.length >= maxResults) break;
          }
        } catch { /* ignore unreadable or binary files */ }
      }
    };

    await walkAndSearch(searchDir);

    if (results.length >= maxResults) {
      results.push({ warning: `Maximum ${maxResults} results reached. Use shell_command with rg for exhaustive search.` });
    }

    return { results, totalMatches: results.length, searchEngine: 'nodejs', directory: searchDir };
  }
};

// ════════════════════════════════════════════════════════════════════
// workspace_edit_file — FIXED critical bugs:
//   1. content.replace() only replaced first occurrence — now uses replaceAll
//   2. Added validation: confirms edit was applied correctly
//   3. Added line-range validation bounds checking
//   4. Better error messages with file context
// ════════════════════════════════════════════════════════════════════
export const workspaceEditFileTool: ToolDefinition = {
  name: 'workspace_edit_file',
  description: 'Edit an existing file using exact search/replace or line-based replacement and show an expandable real diff in the UI. Supports absolute and workspace-relative paths.',
  category: 'workspace',
  inputSchema: z.object({
    filename: z.string().describe('File path — absolute or relative'),
    edits: z.array(z.object({
      search: z.string().optional().describe('Exact text to find (for search-replace mode). Must match EXACTLY including whitespace.'),
      replace: z.string().describe('Replacement text'),
      replaceAll: z.boolean().optional().describe('Replace every matching occurrence. Defaults to false; ambiguous matches are rejected unless true.'),
      replace_all: z.boolean().optional().describe('Alias for replaceAll. Defaults to false.'),
      startLine: z.number().int().min(1).optional().describe('Start line number (for line-replace mode, 1-indexed)'),
      endLine: z.number().int().min(1).optional().describe('End line number (for line-replace mode, 1-indexed)')
    })).min(1).max(50)
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string().optional(),
    path: z.string().optional(),
    filename: z.string().optional(),
    editsApplied: z.number().optional(),
    totalLines: z.number().optional(),
    size: z.number().optional(),
  }).passthrough(),
  execute: async (input: { filename: string, edits: any[] }, context?: any) => {
    const filePath = resolveWorkspacePathForContext(input.filename, context);

    const protection = checkEterXProtection(filePath);
    if (protection.blocked) {
      console.warn(`[Tool: workspace_edit_file] 🛡️ BLOCKED: ${ filePath }`);
      return { success: false, error: protection.reason };
    }

    if (!await fse.pathExists(filePath)) throw new Error(`File not found: ${ filePath }`);

    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content; // Keep original for rollback
    let lines = content.split('\n');

    for (let editIdx = 0; editIdx < input.edits.length; editIdx++) {
      const edit = input.edits[editIdx];

      if (edit.startLine !== undefined && edit.endLine !== undefined) {
        // Line-based replacement mode
        const startIdx = Math.max(0, edit.startLine - 1);
        const endIdx = Math.min(lines.length - 1, edit.endLine - 1);

        if (startIdx > endIdx || startIdx >= lines.length) {
          throw new Error(`Invalid line range: ${edit.startLine}-${edit.endLine} (file has ${lines.length} lines)`);
        }

        const replacementLines = edit.replace.split('\n');
        lines.splice(startIdx, endIdx - startIdx + 1, ...replacementLines);
        // Re-join and re-split in case of multiple line-based edits to maintain sync
        content = lines.join('\n');
        lines = content.split('\n');
      } else if (edit.search !== undefined) {
        // String-based search and replace mode
        content = lines.join('\n');

        if (!content.includes(edit.search)) {
          // Provide helpful context about what we're looking for
          const searchPreview = edit.search.length > 100
            ? edit.search.substring(0, 100) + '...'
            : edit.search;
          throw new Error(
            `Could not find search block in ${ input.filename } (edit #${editIdx + 1}).\n` +
            `Searched for: "${searchPreview}"\n` +
            `Make sure it matches EXACTLY including whitespace, indentation, and line endings.\n` +
            `TIP: Read the file first with workspace_read_file to see the exact content, then copy the exact text.`
          );
        }

        // Count occurrences to warn about ambiguity
        const occurrences = content.split(edit.search).length - 1;
        const replaceAll = edit.replaceAll === true || edit.replace_all === true;
        if (occurrences > 1 && !replaceAll) {
          return {
            success: false,
            error: `Search text matched ${occurrences} times in ${input.filename} (edit #${editIdx + 1}). Add more context, use startLine/endLine, or set replaceAll=true intentionally.`,
            path: filePath,
            filename: input.filename,
            occurrences,
            editsApplied: 0,
          };
        }
        if (occurrences > 1) {
          console.warn(`[workspace_edit_file] replaceAll=true: replacing ${occurrences} occurrences in ${input.filename}.`);
        }

        // FIX: Use split/join to replace ALL occurrences (not just first)
        content = (edit.replaceAll === true || edit.replace_all === true)
          ? content.split(edit.search).join(edit.replace)
          : content.replace(edit.search, edit.replace);
        lines = content.split('\n');
      } else {
        throw new Error('Edit chunk must have either a "search" string or "startLine" and "endLine" numbers.');
      }
    }

    // Validate that something actually changed
    if (content === originalContent) {
      return {
        success: true,
        message: `No changes detected — the edits resulted in identical content. File unchanged: ${ filePath }`,
        warning: 'The search and replace values may be the same.',
        path: filePath,
        filename: input.filename,
        editsApplied: 0,
        totalLines: content.split('\n').length,
        size: Buffer.byteLength(content, 'utf8'),
      };
    }

    const finalContent = lines.join('\n');
    await writeUtf8Atomic(filePath, finalContent);
    return {
      success: true,
      message: `Applied ${ input.edits.length } edits to ${ filePath }`,
      path: filePath,
      filename: input.filename,
      editsApplied: input.edits.length,
      totalLines: finalContent.split('\n').length,
      size: Buffer.byteLength(finalContent, 'utf8'),
    };
  }
};
