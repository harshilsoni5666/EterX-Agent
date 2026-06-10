import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import fs from 'fs/promises';
import fse from 'fs-extra';
import {
  checkEterXProtection,
  resolveWorkspacePathForContext,
} from '../../workspace/path_resolver';
import { editTracker, buildCompactDiff, buildEditReadback } from '@/lib/code/edit-tracker';

export const workspaceStrReplaceTool: ToolDefinition = {
  name: 'workspace_str_replace',
  description: 'Primary code edit tool. Replace exact old_string with new_string in one file. Returns inline diff + readback so you see the verified result immediately. Read the file first and copy exact text including whitespace.',
  category: 'workspace',
  inputSchema: z.object({
    filename: z.string().describe('File path — absolute or relative'),
    old_string: z.string().describe('Exact text to find. Must match precisely including whitespace and indentation.'),
    new_string: z.string().describe('Replacement text'),
    replace_all: z.boolean().optional().describe('Replace all occurrences (default: false; fails if ambiguous)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    replacements: z.number(),
    path: z.string(),
  }),
  execute: async (input: { filename: string; old_string: string; new_string: string; replace_all?: boolean }, context?: any) => {
    const filePath = resolveWorkspacePathForContext(input.filename, context);
    const protection = checkEterXProtection(filePath);
    if (protection.blocked) {
      return { success: false, error: protection.reason, path: filePath };
    }

    if (!await fse.pathExists(filePath)) {
      return { success: false, error: `File not found: ${filePath}`, path: filePath };
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const occurrences = content.split(input.old_string).length - 1;

    if (occurrences === 0) {
      const preview = input.old_string.length > 120
        ? `${input.old_string.slice(0, 120)}...`
        : input.old_string;
      return {
        success: false,
        error: `old_string not found in ${input.filename}. Searched for: "${preview}". Read the file and copy exact text.`,
        path: filePath,
      };
    }

    if (!input.replace_all && occurrences > 1) {
      return {
        success: false,
        error: `old_string matched ${occurrences} times. Add more context to old_string or set replace_all=true.`,
        path: filePath,
        occurrences,
      };
    }

    const updated = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, input.new_string);

    if (updated === content) {
      return { success: true, replacements: 0, path: filePath, message: 'No changes — old_string and new_string may be identical.' };
    }

    await fs.writeFile(filePath, updated, 'utf-8');

    // ─── Auto-readback: record edit + return diff + context ───
    const replacements = input.replace_all ? occurrences : 1;
    const editStartLine = content.slice(0, content.indexOf(input.old_string)).split('\n').length - 1;

    try {
      editTracker.recordEdit({
        filePath,
        beforeContent: content,
        afterContent: updated,
        toolName: 'workspace_str_replace',
        editType: 'replace',
      });
    } catch { /* tracker is best-effort */ }

    const diff = buildCompactDiff(input.old_string, input.new_string, 600);
    const readback = buildEditReadback(updated, editStartLine, 5);

    return {
      success: true,
      replacements,
      path: filePath,
      message: `Updated ${input.filename}`,
      diff,
      readback,
      editLine: editStartLine + 1,
      totalLines: updated.split('\n').length,
    };
  },
};
