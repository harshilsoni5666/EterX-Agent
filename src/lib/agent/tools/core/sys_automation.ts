import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { isUnsafeHostControlEnabled } from '../../computer/computer-session';
import { resolveReadableWorkspacePathForContext } from '../../workspace/path_resolver';
import { enforceToolCapability } from '../security/tool_policy';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const SAFE_READONLY_ACTIONS = new Set(['battery']);

function psQuote(value: unknown): string {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function requireTarget(input: any, field = 'target'): string {
  const value = String(input?.[field] ?? '').trim();
  if (!value) throw new Error(`${field} is required`);
  return value;
}

function requireEnvName(value: unknown): string {
  const name = String(value ?? '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('Environment variable names must use letters, numbers, and underscores, and may not start with a number.');
  }
  return name;
}

function requireProcessName(value: unknown): string {
  const name = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error('Process names may only contain letters, numbers, underscore, dot, and dash.');
  }
  return name;
}

function requireHttpUrl(value: unknown): string {
  const url = new URL(String(value ?? '').trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('open_url only allows http:// and https:// URLs.');
  }
  return url.toString();
}

function clampVolume(value: unknown): number {
  const level = Number.parseInt(String(value ?? '50'), 10);
  if (!Number.isFinite(level)) return 50;
  return Math.max(0, Math.min(100, level));
}

/**
 * System Automation — Open apps, manage windows, control OS
 * 
 * Deep OS integration for true desktop automation.
 */
export const sysAutomationTool: ToolDefinition = {
  name: 'system_automation',
  description: `Control common operating-system actions on Windows, macOS, and Linux. Platform-specific actions return a clear unsupported response when unavailable.`,
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
  execute: async (input: any, context?: any) => {
    const decision = enforceToolCapability('system_automation', input, context);
    if (!decision.allowed && !SAFE_READONLY_ACTIONS.has(input.action)) {
      return { success: false, result: decision.reason || 'System automation is not allowed' };
    }

    if (!isUnsafeHostControlEnabled() && !SAFE_READONLY_ACTIONS.has(input.action)) {
      return {
        success: false,
        result: 'Host OS automation and host process/app scanning are disabled for safety. Use computer or screen_agent inside isolated EterX Computer, or set ETERX_ALLOW_UNSAFE_HOST_COMPUTER=1 only when real host control is intentional.',
      };
    }

    try {
      if (process.platform !== 'win32') {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        switch (input.action) {
          case 'open_app': {
            const target = requireTarget(input);
            if (process.platform === 'darwin') await execFileAsync('open', ['-a', target]);
            else await execFileAsync(target, []);
            return { success: true, result: `Opened: ${target}` };
          }
          case 'open_url': {
            const target = requireHttpUrl(input.target);
            await execFileAsync(opener, [target]);
            return { success: true, result: `Opened URL: ${target}` };
          }
          case 'open_file':
          case 'open_folder': {
            const target = resolveReadableWorkspacePathForContext(input.target || '.', context);
            await execFileAsync(opener, [target]);
            return { success: true, result: `Opened: ${target}` };
          }
          case 'list_running': {
            const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,comm=,%cpu=,rss=']);
            return { success: true, result: stdout.trim().split(/\r?\n/).slice(0, 40).join('\n') };
          }
          case 'kill_app': {
            const target = requireProcessName(input.target);
            await execFileAsync('pkill', ['-f', target]);
            return { success: true, result: `Killed: ${target}` };
          }
          case 'get_env': {
            const target = input.target ? requireEnvName(input.target) : '';
            return { success: true, result: target ? (process.env[target] || '') : Object.entries(process.env).slice(0, 30) };
          }
          case 'battery': {
            if (process.platform === 'darwin') {
              const { stdout } = await execFileAsync('pmset', ['-g', 'batt']);
              return { success: true, result: stdout.trim() };
            }
            const { stdout } = await execAsync('for f in /sys/class/power_supply/BAT*/capacity; do printf "%s: " "$f"; cat "$f"; done', { shell: '/bin/sh' });
            return { success: true, result: stdout.trim() || 'No battery detected.' };
          }
          case 'lock_screen': {
            if (process.platform === 'darwin') {
              await execFileAsync('/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession', ['-suspend']);
            } else {
              await execFileAsync('loginctl', ['lock-session']);
            }
            return { success: true, result: 'Screen locked' };
          }
          case 'empty_trash': {
            return { success: false, result: 'Emptying trash is intentionally unsupported on this platform because desktop trash locations vary.' };
          }
          default:
            return { success: false, result: `${input.action} is not supported by system automation on ${process.platform}.` };
        }
      }

      switch (input.action) {
        case 'open_app': {
          const target = requireTarget(input);
          await execAsync(`Start-Process ${psQuote(target)}`, { shell: 'powershell.exe', windowsHide: true });
          return { success: true, result: `Opened: ${target}` };
        }
        case 'open_url': {
          const target = requireHttpUrl(input.target);
          await execAsync(`Start-Process ${psQuote(target)}`, { shell: 'powershell.exe', windowsHide: true });
          return { success: true, result: `Opened URL: ${target}` };
        }
        case 'open_file': {
          const target = resolveReadableWorkspacePathForContext(requireTarget(input), context);
          await execAsync(`Invoke-Item ${psQuote(target)}`, { shell: 'powershell.exe', windowsHide: true });
          return { success: true, result: `Opened file: ${target}` };
        }
        case 'open_folder': {
          const target = resolveReadableWorkspacePathForContext(input.target || '.', context);
          await execAsync(`Start-Process -FilePath explorer.exe -ArgumentList ${psQuote(target)}`, { shell: 'powershell.exe', windowsHide: true });
          return { success: true, result: `Opened folder: ${target}` };
        }
        case 'list_running': {
          const { stdout } = await execAsync(
            `Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object -First 30 Name, Id, CPU, WorkingSet64 | Format-Table -AutoSize | Out-String -Width 300`,
            { shell: 'powershell.exe', windowsHide: true }
          );
          return { success: true, result: stdout.trim() };
        }
        case 'kill_app': {
          const target = requireProcessName(input.target);
          await execAsync(`Stop-Process -Name ${psQuote(target)} -Force -ErrorAction SilentlyContinue`, { shell: 'powershell.exe', windowsHide: true });
          return { success: true, result: `Killed: ${target}` };
        }
        case 'set_env': {
          const target = requireEnvName(input.target);
          if (input.value === undefined || input.value === null) return { success: false, result: 'target (name) and value required' };
          await execAsync(`[System.Environment]::SetEnvironmentVariable(${psQuote(target)}, ${psQuote(input.value)}, "User")`, { shell: 'powershell.exe', windowsHide: true });
          return { success: true, result: `Set env: ${target}=<redacted>` };
        }
        case 'get_env': {
          const target = input.target ? requireEnvName(input.target) : '';
          const { stdout } = await execAsync(
            target
              ? `[System.Environment]::GetEnvironmentVariable(${psQuote(target)}, "User")`
              : `Get-ChildItem Env: | Select-Object -First 30 Name, Value | Format-Table -AutoSize | Out-String -Width 300`,
            { shell: 'powershell.exe', windowsHide: true }
          );
          return { success: true, result: stdout.trim() };
        }
        case 'volume': {
          const level = clampVolume(input.value);
          await execAsync(
            `$obj = New-Object -ComObject WScript.Shell; ` +
            `1..50 | ForEach-Object { $obj.SendKeys([char]174) }; ` +
            `1..${Math.floor(level/2)} | ForEach-Object { $obj.SendKeys([char]175) }`,
            { shell: 'powershell.exe', windowsHide: true }
          );
          return { success: true, result: `Volume set to ~${level}%` };
        }
        case 'lock_screen':
          await execAsync(`rundll32.exe user32.dll,LockWorkStation`, { shell: 'powershell.exe', windowsHide: true });
          return { success: true, result: 'Screen locked' };
        case 'empty_trash':
          await execAsync(`Clear-RecycleBin -Force -ErrorAction SilentlyContinue`, { shell: 'powershell.exe', windowsHide: true });
          return { success: true, result: 'Recycle bin emptied' };
        case 'battery': {
          const { stdout } = await execAsync(
            `Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus, EstimatedRunTime | Format-List | Out-String`,
            { shell: 'powershell.exe', windowsHide: true }
          );
          return { success: true, result: stdout.trim() || 'No battery detected (desktop PC)' };
        }
        case 'installed_apps': {
          const { stdout } = await execAsync(
            `Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Select-Object -First 25 DisplayName, DisplayVersion, Publisher | Sort-Object DisplayName | Format-Table -AutoSize | Out-String -Width 400`,
            { shell: 'powershell.exe', windowsHide: true }
          );
          return { success: true, result: stdout.trim() };
        }
        case 'startup_items': {
          const { stdout } = await execAsync(
            `Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location | Format-Table -AutoSize | Out-String -Width 400`,
            { shell: 'powershell.exe', windowsHide: true }
          );
          return { success: true, result: stdout.trim() };
        }
        case 'services': {
          const filter = input.target
            ? `| Where-Object {$needle = ${psQuote(input.target)}; $_.Name -like "*$needle*" -or $_.DisplayName -like "*$needle*"}`
            : '| Select-Object -First 20';
          const { stdout } = await execAsync(
            `Get-Service ${filter} | Select-Object Name, DisplayName, Status, StartType | Format-Table -AutoSize | Out-String -Width 400`,
            { shell: 'powershell.exe', windowsHide: true }
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
