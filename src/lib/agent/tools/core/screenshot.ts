import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';
import { resolveFinalArtifactPathForContext } from '../../workspace/path_resolver';
import { enforceToolCapability } from '../security/tool_policy';
import { buildTerminalShellInvocation } from './shell_resolver';

const execFileAsync = promisify(execFile);

async function runPowerShell(script: string): Promise<{ stdout: string; stderr: string }> {
  const invocation = buildTerminalShellInvocation(script, 'powershell');
  return execFileAsync(invocation.file, invocation.args, { timeout: 15_000, windowsHide: true });
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export const screenshotTool: ToolDefinition = {
  name: 'screenshot_capture',
  description: 'Capture a screenshot of the current screen or a specific window. Saves the image to workspace. Use this for visual debugging, documentation, monitoring dashboards, or when you need to "see" what is on screen.',
  category: 'core',
  inputSchema: z.object({
    target: z.enum(['fullscreen', 'active_window']).default('fullscreen')
      .describe('What to capture: full screen or just the active window'),
    filename: z.string().optional().describe('Custom filename for the screenshot (default: screenshot_<timestamp>.png)')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    filePath: z.string(),
    message: z.string()
  }),
  execute: async (input: { target?: string, filename?: string }, context?: any) => {
    const decision = enforceToolCapability('screenshot_capture', input, context);
    if (!decision.allowed) {
      return { success: false, filePath: '', message: decision.reason || 'Screenshot capture is not allowed' };
    }

    const filename = input.filename || `screenshot_${ Date.now() }.png`;
    const filePath = resolveFinalArtifactPathForContext(filename, '.png', 'Screenshot', context);
    await fs.ensureDir(path.dirname(filePath));

    console.log(`[Tool: screenshot_capture] Capturing ${ input.target || 'fullscreen' } → ${ filePath }`);

    try {
      if (process.platform === 'darwin') {
        await execFileAsync('screencapture', input.target === 'active_window'
          ? ['-x', '-w', filePath]
          : ['-x', filePath], { timeout: 15_000, windowsHide: true });
      } else if (process.platform !== 'win32') {
        const candidates: Array<[string, string[]]> = [
          ['grim', [filePath]],
          ['gnome-screenshot', input.target === 'active_window' ? ['-w', '-f', filePath] : ['-f', filePath]],
          ['spectacle', input.target === 'active_window' ? ['-a', '-b', '-n', '-o', filePath] : ['-b', '-n', '-o', filePath]],
          ['scrot', input.target === 'active_window' ? ['-u', filePath] : [filePath]],
          ['maim', [filePath]],
          ['import', ['-window', 'root', filePath]]
        ];
        let captured = false;
        let lastError: any;
        for (const [command, args] of candidates) {
          try {
            await execFileAsync(command, args, { timeout: 15_000, windowsHide: true });
            captured = true;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!captured) throw new Error(`No supported screenshot utility was found: ${lastError?.message || 'install gnome-screenshot, scrot, or ImageMagick'}`);
      } else {
      let psScript: string;

      if (input.target === 'active_window') {
        psScript = `
          Add-Type -AssemblyName System.Windows.Forms;
          Add-Type -AssemblyName System.Drawing;
          
          Add-Type @'
          using System;
          using System.Runtime.InteropServices;
          public class Win32 {
            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")]
            public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
            [StructLayout(LayoutKind.Sequential)]
            public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
          }
'@;
          $hwnd = [Win32]::GetForegroundWindow();
          $rect = New-Object Win32+RECT;
          [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null;
          $w = $rect.Right - $rect.Left;
          $h = $rect.Bottom - $rect.Top;
          $bmp = New-Object System.Drawing.Bitmap($w, $h);
          $graphics = [System.Drawing.Graphics]::FromImage($bmp);
          $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)));
          $bmp.Save(${psQuote(filePath)});
          $graphics.Dispose();
          $bmp.Dispose();
        `.trim();
      } else {
        psScript = `
          Add-Type -AssemblyName System.Windows.Forms;
          Add-Type -AssemblyName System.Drawing;
          $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
          $bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height);
          $graphics = [System.Drawing.Graphics]::FromImage($bmp);
          $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size);
          $bmp.Save(${psQuote(filePath)});
          $graphics.Dispose();
          $bmp.Dispose();
        `.trim();
      }

      await runPowerShell(psScript);
      }

      if (await fs.pathExists(filePath)) {
        const stats = await fs.stat(filePath);
        return {
          success: true,
          filePath,
          message: `Screenshot captured successfully (${ (stats.size / 1024).toFixed(1) } KB). File saved at: ${ filePath }`
        };
      }
      return { success: false, filePath, message: 'Screenshot command ran but file was not created.' };
    } catch (error: any) {
      return { success: false, filePath, message: `Screenshot failed: ${ error.message }` };
    }
  }
};
