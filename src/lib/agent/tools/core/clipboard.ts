import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { execFile, spawn } from 'child_process';
import { enforceToolCapability } from '../security/tool_policy';

function runClipboardCommand(command: string, args: string[] = [], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (input === undefined) {
      execFile(command, args, { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
      return;
    }
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited with code ${code}`)));
    child.stdin.end(input);
  });
}

async function readClipboard(): Promise<string> {
  if (process.platform === 'win32') return runClipboardCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw']);
  if (process.platform === 'darwin') return runClipboardCommand('pbpaste');
  const candidates: Array<[string, string[]]> = [
    ['wl-paste', ['--no-newline']],
    ['xclip', ['-selection', 'clipboard', '-o']],
    ['xsel', ['--clipboard', '--output']]
  ];
  for (const [command, args] of candidates) {
    try { return await runClipboardCommand(command, args); } catch {}
  }
  throw new Error('No supported clipboard utility was found. Install wl-clipboard, xclip, or xsel.');
}

async function writeClipboard(content: string): Promise<void> {
  if (process.platform === 'win32') {
    await runClipboardCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard'], content);
    return;
  }
  if (process.platform === 'darwin') {
    await runClipboardCommand('pbcopy', [], content);
    return;
  }
  const candidates: Array<[string, string[]]> = [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']]
  ];
  for (const [command, args] of candidates) {
    try { await runClipboardCommand(command, args, content); return; } catch {}
  }
  throw new Error('No supported clipboard utility was found. Install wl-clipboard, xclip, or xsel.');
}

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
  execute: async (input: { action: string, content?: string }, context?: any) => {
    console.log(`[Tool: clipboard_manager] Action: ${input.action}`);

    try {
      const decision = enforceToolCapability('clipboard_manager', input, context);
      if (!decision.allowed) {
        return { content: '', success: false, error: decision.reason || 'Clipboard access is not allowed' };
      }

      if (input.action === 'read') {
        return { content: await readClipboard(), success: true };
      } else if (input.action === 'write') {
        if (!input.content) {
          return { content: '', success: false, error: 'Content is required for write action' };
        }
        await writeClipboard(input.content);
        return { content: input.content, success: true, message: 'Content copied to clipboard successfully.' };
      }
      return { content: '', success: false, error: 'Invalid action' };
    } catch (error: any) {
      return { content: '', success: false, error: error.message };
    }
  }
};
