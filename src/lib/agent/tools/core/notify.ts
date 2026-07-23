import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { enforceToolCapability } from '../security/tool_policy';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function psQuote(value: unknown): string {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const desktopNotifyTool: ToolDefinition = {
  name: 'desktop_notification',
  description: 'Send a native desktop notification on Windows, macOS, or Linux.',
  category: 'core',
  inputSchema: z.object({
    title: z.string().describe('The notification title (short, 1-5 words)'),
    message: z.string().describe('The notification body message'),
    urgency: z.enum(['low', 'normal', 'critical']).default('normal').describe('Notification urgency level')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string()
  }),
  execute: async (input: { title: string, message: string, urgency?: string }, context?: any) => {
    console.log(`[Tool: desktop_notification] Sending: "${input.title}" - ${input.message}`);

    try {
      const decision = enforceToolCapability('desktop_notification', input, context);
      if (!decision.allowed) {
        return { success: false, message: decision.reason || 'Desktop notifications are not allowed' };
      }

      if (process.platform === 'darwin') {
        const script = 'on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run';
        await execFileAsync('osascript', ['-e', script, input.title.slice(0, 120), input.message.slice(0, 500)]);
        return { success: true, message: `Notification sent: "${input.title}"` };
      }
      if (process.platform !== 'win32') {
        const urgency = input.urgency === 'critical' ? 'critical' : input.urgency === 'low' ? 'low' : 'normal';
        await execFileAsync('notify-send', ['--urgency', urgency, input.title.slice(0, 120), input.message.slice(0, 500)]);
        return { success: true, message: `Notification sent: "${input.title}"` };
      }

      // Use PowerShell to create a Windows Toast notification
      const escapedTitle = escapeXml(input.title).slice(0, 120);
      const escapedMsg = escapeXml(input.message).slice(0, 500);
      
      const psScript = `
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;
        
        $template = @"
        <toast>
          <visual>
            <binding template='ToastGeneric'>
              <text>🤖 ${escapedTitle}</text>
              <text>${escapedMsg}</text>
            </binding>
          </visual>
        </toast>
"@;
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument;
        $xml.LoadXml($template);
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml);
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('EterX Agent').Show($toast);
      `.trim();

      await execAsync(psScript, { shell: 'powershell.exe' });
      return { success: true, message: `Notification sent: "${input.title}"` };
    } catch (error: any) {
      // Fallback to simpler BurntToast or basic notification
      try {
        const fallbackScript = `
          Add-Type -AssemblyName System.Windows.Forms;
          $notify = New-Object System.Windows.Forms.NotifyIcon;
          $notify.Icon = [System.Drawing.SystemIcons]::Information;
          $notify.Visible = $true;
          $notify.ShowBalloonTip(5000, ${psQuote(String(input.title).slice(0, 120))}, ${psQuote(String(input.message).slice(0, 500))}, 'Info');
          Start-Sleep -Seconds 6;
          $notify.Dispose();
        `.trim();
        await execAsync(fallbackScript, { shell: 'powershell.exe' });
        return { success: true, message: `Notification sent (fallback): "${input.title}"` };
      } catch (fallbackError: any) {
        return { success: false, message: `Failed to send notification: ${fallbackError.message}` };
      }
    }
  }
};
