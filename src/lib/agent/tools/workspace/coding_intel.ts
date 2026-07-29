import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import fs from 'fs/promises';
import fse from 'fs-extra';
import { resolveReadableWorkspacePathForContext } from '../../workspace/path_resolver';

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
