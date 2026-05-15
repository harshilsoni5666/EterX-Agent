import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const desktopNotifyTool: ToolDefinition = {
  name: 'desktop_notification',
  description: 'Send a Windows desktop toast notification to the user. Use this to alert them about completed tasks, important events, scheduled reminders, errors, or any important status updates.',
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
  execute: async (input: { title: string, message: string, urgency?: string }) => {
    console.log(`[Tool: desktop_notification] Sending: "${input.title}" - ${input.message}`);

    try {
      // Use PowerShell to create a Windows Toast notification
      const escapedTitle = input.title.replace(/'/g, "''").replace(/`/g, '``');
      const escapedMsg = input.message.replace(/'/g, "''").replace(/`/g, '``');
      
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
          $notify.ShowBalloonTip(5000, '${input.title.replace(/'/g, "''")}', '${input.message.replace(/'/g, "''")}', 'Info');
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
