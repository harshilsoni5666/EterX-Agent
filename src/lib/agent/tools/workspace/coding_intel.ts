import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import fse from 'fs-extra';
import path from 'path';
import {
  resolveReadableWorkspacePathForContext,
  resolveWorkspaceDirectoryForContext,
} from '../../workspace/path_resolver';
import { isRgAvailable } from '../shared/rg';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRgMatches(stdout: string, maxResults: number) {
  const results: Array<{ file: string; line: number; content: string; kind: string }> = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    if (results.length >= maxResults) break;
    const idx = line.indexOf(':');
    const idx2 = line.indexOf(':', idx + 1);
    if (idx <= 0 || idx2 <= idx) continue;
    results.push({
      file: line.slice(0, idx),
      line: parseInt(line.slice(idx + 1, idx2), 10) || 0,
      content: line.slice(idx2 + 1).trim().slice(0, 220),
      kind: 'match',
    });
  }
  return results;
}

export const workspaceSymbolLookupTool: ToolDefinition = {
  name: 'workspace_symbol_lookup',
  description: 'Find where a symbol is defined and referenced. Faster than manual grep for functions, classes, types, constants, and components.',
  category: 'workspace',
  inputSchema: z.object({
    symbol: z.string().describe('Symbol name, e.g. buildCodingAgentRootPrompt, UserService, handleSubmit'),
    directory: z.string().optional().describe('Directory scope. Default: workspace root'),
    includeReferences: z.boolean().optional().describe('Include usages/references (default: true)'),
    maxResults: z.number().optional().describe('Max results per section (default: 40)'),
  }),
  outputSchema: z.object({
    symbol: z.string(),
    definitions: z.array(z.any()),
    references: z.array(z.any()),
  }),
  execute: async (input: { symbol: string; directory?: string; includeReferences?: boolean; maxResults?: number }, context?: any) => {
    const searchDir = resolveWorkspaceDirectoryForContext(input.directory, context);
    const symbol = String(input.symbol || '').trim();
    const maxResults = Math.min(input.maxResults || 40, 80);
    const includeReferences = input.includeReferences !== false;

    if (!symbol) return { symbol, definitions: [], references: [], error: 'symbol is required' };
    if (!await fse.pathExists(searchDir)) return { symbol, definitions: [], references: [], error: `Directory not found: ${searchDir}` };

    if (!isRgAvailable()) {
      return {
        symbol,
        definitions: [],
        references: [],
        error: 'ripgrep (rg) is required for workspace_symbol_lookup. Install rg or use workspace_search_text.',
      };
    }

    const sym = escapeRegex(symbol);
    const definitionPatterns = [
      `(export\\s+)?(async\\s+)?function\\s+${sym}\\b`,
      `(export\\s+)?class\\s+${sym}\\b`,
      `(export\\s+)?interface\\s+${sym}\\b`,
      `(export\\s+)?type\\s+${sym}\\b`,
      `(export\\s+)?const\\s+${sym}\\b`,
      `def\\s+${sym}\\b`,
      `fn\\s+${sym}\\b`,
      `func\\s+${sym}\\b`,
    ];

    const definitions: Array<{ file: string; line: number; content: string; kind: string }> = [];
    for (const pattern of definitionPatterns) {
      const result = spawnSync('rg', ['-n', '--no-heading', '-S', pattern, '.'], {
        cwd: searchDir,
        encoding: 'utf-8',
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
      });
      if (result.stdout) definitions.push(...parseRgMatches(result.stdout, maxResults));
      if (definitions.length >= maxResults) break;
    }

    let references: Array<{ file: string; line: number; content: string; kind: string }> = [];
    if (includeReferences) {
      const refResult = spawnSync('rg', ['-n', '--no-heading', '-w', symbol, '.'], {
        cwd: searchDir,
        encoding: 'utf-8',
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
      });
      references = parseRgMatches(refResult.stdout || '', maxResults)
        .filter(hit => !definitions.some(def => def.file === hit.file && def.line === hit.line));
    }

    return {
      symbol,
      definitions: definitions.slice(0, maxResults),
      references: references.slice(0, maxResults),
      directory: searchDir,
      hint: definitions.length > 0
        ? 'Read the top definition with workspace_read_file using startLine/endLine, then edit with workspace_str_replace.'
        : 'No definition found. Try workspace_semantic_search or workspace_search_text.',
    };
  },
};

export const workspaceFileOutlineTool: ToolDefinition = {
  name: 'workspace_file_outline',
  description: 'Fast structural outline of one file: exports, functions, classes, imports. Use before editing unfamiliar files.',
  category: 'workspace',
  inputSchema: z.object({
    filename: z.string().describe('File path — absolute or relative'),
  }),
  outputSchema: z.object({
    path: z.string(),
    outline: z.array(z.any()),
    lineCount: z.number(),
  }),
  execute: async (input: { filename: string }, context?: any) => {
    const filePath = resolveReadableWorkspacePathForContext(input.filename, context);
    if (!await fse.pathExists(filePath)) {
      return { path: filePath, outline: [], lineCount: 0, error: `File not found: ${filePath}` };
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const outline: Array<{ line: number; kind: string; name: string; text: string }> = [];

    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) return;
      const patterns: Array<[RegExp, string]> = [
        [/^import\s+/, 'import'],
        [/^export\s+default\s+/, 'export'],
        [/^export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/, 'function'],
        [/^export\s+class\s+([A-Za-z_$][\w$]*)/, 'class'],
        [/^export\s+interface\s+([A-Za-z_$][\w$]*)/, 'interface'],
        [/^export\s+type\s+([A-Za-z_$][\w$]*)/, 'type'],
        [/^export\s+const\s+([A-Za-z_$][\w$]*)/, 'const'],
        [/^class\s+([A-Za-z_$][\w$]*)/, 'class'],
        [/^function\s+([A-Za-z_$][\w$]*)/, 'function'],
        [/^def\s+([A-Za-z_][\w]*)/, 'function'],
        [/^fn\s+([A-Za-z_][\w]*)/, 'function'],
      ];
      for (const [pattern, kind] of patterns) {
        const match = trimmed.match(pattern);
        if (match) {
          outline.push({
            line: index + 1,
            kind,
            name: match[2] || match[1] || kind,
            text: trimmed.slice(0, 160),
          });
          break;
        }
      }
    });

    return {
      path: filePath,
      outline: outline.slice(0, 120),
      lineCount: lines.length,
      hint: 'Use line numbers with workspace_read_file startLine/endLine for targeted reads.',
    };
  },
};
