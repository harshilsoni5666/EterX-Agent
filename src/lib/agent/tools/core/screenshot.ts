import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';

const execAsync = promisify(exec);

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
  execute: async (input: { target?: string, filename?: string }) => {
    const targetDir = path.resolve(process.cwd(), '.workspaces', 'temp', 'screenshots');
    await fs.ensureDir(targetDir);

    const filename = input.filename || `screenshot_${ Date.now() }.png`;
    const filePath = path.join(targetDir, filename);

    console.log(`[Tool: screenshot_capture] Capturing ${ input.target || 'fullscreen' } → ${ filePath }`);

    try {
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
          $bmp.Save('${ filePath.replace(/\\/g, '\\\\') }');
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
          $bmp.Save('${ filePath.replace(/\\/g, '\\\\') }');
          $graphics.Dispose();
          $bmp.Dispose();
        `.trim();
      }

      await execAsync(psScript, { shell: 'powershell.exe' });

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
