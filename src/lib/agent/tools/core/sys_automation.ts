import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * System Automation — Open apps, manage windows, control OS
 * 
 * Deep OS integration for true desktop automation.
 */
export const sysAutomationTool: ToolDefinition = {
  name: 'system_automation',
  description: `Control the OS: open applications, manage windows, set environment variables, control volume, lock screen, open URLs in browser, manage services, check battery, and empty recycle bin. Deep Windows integration.`,
  category: 'core',
  inputSchema: z.object({
    action: z.enum([
      'open_app', 'open_url', 'open_file', 'open_folder',
      'list_running', 'kill_app',
      'set_env', 'get_env',
      'volume', 'lock_screen', 'empty_trash',
      'battery', 'installed_apps',
      'startup_items', 'services'
    ]).describe('System automation action'),
    target: z.string().optional().describe('App name, URL, file path, env var name, or service name'),
    value: z.string().optional().describe('Value for set operations (e.g., env var value, volume level 0-100)')
  }),
  outputSchema: z.object({ success: z.boolean(), result: z.any() }),
  execute: async (input: any) => {
    try {
      switch (input.action) {
        case 'open_app':
          await execAsync(`Start-Process "${input.target}"`, { shell: 'powershell.exe' });
          return { success: true, result: `Opened: ${input.target}` };
        case 'open_url':
          await execAsync(`Start-Process "${input.target}"`, { shell: 'powershell.exe' });
          return { success: true, result: `Opened URL: ${input.target}` };
        case 'open_file':
          await execAsync(`Invoke-Item "${input.target}"`, { shell: 'powershell.exe' });
          return { success: true, result: `Opened file: ${input.target}` };
        case 'open_folder':
          await execAsync(`explorer "${input.target || '.'}"`, { shell: 'powershell.exe' });
          return { success: true, result: `Opened folder: ${input.target}` };
        case 'list_running': {
          const { stdout } = await execAsync(
            `Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object -First 30 Name, Id, CPU, WorkingSet64 | Format-Table -AutoSize | Out-String -Width 300`,
            { shell: 'powershell.exe' }
          );
          return { success: true, result: stdout.trim() };
        }
        case 'kill_app':
          await execAsync(`Stop-Process -Name "${input.target}" -Force -ErrorAction SilentlyContinue`, { shell: 'powershell.exe' });
          return { success: true, result: `Killed: ${input.target}` };
        case 'set_env':
          if (!input.target || !input.value) return { success: false, result: 'target (name) and value required' };
          await execAsync(`[System.Environment]::SetEnvironmentVariable("${input.target}", "${input.value}", "User")`, { shell: 'powershell.exe' });
          return { success: true, result: `Set env: ${input.target}=${input.value}` };
        case 'get_env': {
          const { stdout } = await execAsync(
            input.target 
              ? `[System.Environment]::GetEnvironmentVariable("${input.target}", "User")`
              : `Get-ChildItem Env: | Select-Object -First 30 Name, Value | Format-Table -AutoSize | Out-String -Width 300`,
            { shell: 'powershell.exe' }
          );
          return { success: true, result: stdout.trim() };
        }
        case 'volume': {
          const level = parseInt(input.value || '50');
          await execAsync(
            `$obj = New-Object -ComObject WScript.Shell; ` +
            `1..50 | ForEach-Object { $obj.SendKeys([char]174) }; ` +
            `1..${Math.floor(level/2)} | ForEach-Object { $obj.SendKeys([char]175) }`,
            { shell: 'powershell.exe' }
          );
          return { success: true, result: `Volume set to ~${level}%` };
        }
        case 'lock_screen':
          await execAsync(`rundll32.exe user32.dll,LockWorkStation`, { shell: 'powershell.exe' });
          return { success: true, result: 'Screen locked' };
        case 'empty_trash':
          await execAsync(`Clear-RecycleBin -Force -ErrorAction SilentlyContinue`, { shell: 'powershell.exe' });
          return { success: true, result: 'Recycle bin emptied' };
        case 'battery': {
          const { stdout } = await execAsync(
            `Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus, EstimatedRunTime | Format-List | Out-String`,
            { shell: 'powershell.exe' }
          );
          return { success: true, result: stdout.trim() || 'No battery detected (desktop PC)' };
        }
        case 'installed_apps': {
          const { stdout } = await execAsync(
            `Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Select-Object -First 25 DisplayName, DisplayVersion, Publisher | Sort-Object DisplayName | Format-Table -AutoSize | Out-String -Width 400`,
            { shell: 'powershell.exe' }
          );
          return { success: true, result: stdout.trim() };
        }
        case 'startup_items': {
          const { stdout } = await execAsync(
            `Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location | Format-Table -AutoSize | Out-String -Width 400`,
            { shell: 'powershell.exe' }
          );
          return { success: true, result: stdout.trim() };
        }
        case 'services': {
          const filter = input.target ? `| Where-Object {$_.Name -like '*${input.target}*' -or $_.DisplayName -like '*${input.target}*'}` : '| Select-Object -First 20';
          const { stdout } = await execAsync(
            `Get-Service ${filter} | Select-Object Name, DisplayName, Status, StartType | Format-Table -AutoSize | Out-String -Width 400`,
            { shell: 'powershell.exe' }
          );
          return { success: true, result: stdout.trim() };
        }
        default:
          return { success: false, result: 'Unknown action' };
      }
    } catch (err: any) {
      return { success: false, result: `Automation error: ${err.message}` };
    }
  }
};
