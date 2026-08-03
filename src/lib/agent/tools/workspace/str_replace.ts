import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { ToolDefinition } from '../../schemas';
import { checkEterXProtection, resolveWorkspacePathForContext } from '../../workspace/path_resolver';

export const workspaceStrReplaceTool: ToolDefinition = {
  name: 'workspace_str_replace',
  description: 'Replace an exact string in an existing workspace file. Ambiguous matches are rejected unless replace_all is true.',
  category: 'workspace',
  inputSchema: z.object({
    filename: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
    replaceAll: z.boolean().optional(),
  }),
  outputSchema: z.object({ success: z.boolean() }).passthrough(),
  execute: async (input: { filename: string; old_string: string; new_string: string; replace_all?: boolean; replaceAll?: boolean }, context?: any) => {
    const filePath = resolveWorkspacePathForContext(input.filename, context);
    const protection = checkEterXProtection(filePath);
    if (protection.blocked) return { success: false, error: protection.reason, path: filePath };
    if (!input.old_string) return { success: false, error: 'old_string must not be empty', path: filePath };
    if (!await fs.stat(filePath).then(stat => stat.isFile()).catch(() => false)) {
      return { success: false, error: `File not found: ${filePath}`, path: filePath };
    }

    const original = await fs.readFile(filePath, 'utf8');
    const occurrences = original.split(input.old_string).length - 1;
    if (occurrences === 0) return { success: false, error: 'old_string was not found in the file', occurrences, path: filePath };
    if (occurrences > 1 && !(input.replace_all || input.replaceAll)) {
      return { success: false, error: 'old_string occurs more than once; set replace_all=true to replace every match', occurrences, path: filePath };
    }

    const next = input.replace_all || input.replaceAll
      ? original.split(input.old_string).join(input.new_string)
      : original.replace(input.old_string, input.new_string);
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(temporary, next, 'utf8');
    try {
      await fs.rename(temporary, filePath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
    return {
      success: true,
      path: filePath,
      replacements: input.replace_all || input.replaceAll ? occurrences : 1,
      occurrences,
      size: Buffer.byteLength(next, 'utf8'),
    };
  },
};
