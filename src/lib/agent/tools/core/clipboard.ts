import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const clipboardTool: ToolDefinition = {
  name: 'clipboard_manager',
  description: 'Read from or write to the system clipboard. Use this to get text the user has copied, or to put results directly into their clipboard for easy pasting.',
  category: 'core',
  inputSchema: z.object({
    action: z.enum(['read', 'write']).describe('Whether to read from or write to clipboard'),
    content: z.string().optional().describe('The text content to write to clipboard (required for write action)')
  }),
  outputSchema: z.object({
    content: z.string(),
    success: z.boolean()
  }),
  execute: async (input: { action: string, content?: string }) => {
    console.log(`[Tool: clipboard_manager] Action: ${input.action}`);

    try {
      if (input.action === 'read') {
        const { stdout } = await execAsync('Get-Clipboard', { shell: 'powershell.exe' });
        return { content: stdout.trim(), success: true };
      } else if (input.action === 'write') {
        if (!input.content) {
          return { content: '', success: false, error: 'Content is required for write action' };
        }
        // Escape for PowerShell
        const escaped = input.content.replace(/'/g, "''");
        await execAsync(`Set-Clipboard -Value '${escaped}'`, { shell: 'powershell.exe' });
        return { content: input.content, success: true, message: 'Content copied to clipboard successfully.' };
      }
      return { content: '', success: false, error: 'Invalid action' };
    } catch (error: any) {
      return { content: '', success: false, error: error.message };
    }
  }
};
