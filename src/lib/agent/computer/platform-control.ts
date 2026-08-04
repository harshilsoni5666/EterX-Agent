import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type PlatformActionResult = {
  success: boolean;
  result: unknown;
  provider: string;
};

const executableCache = new Map<string, boolean>();

async function hasExecutable(command: string): Promise<boolean> {
  if (executableCache.has(command)) return executableCache.get(command)!;
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [command], { timeout: 2500 });
    executableCache.set(command, true);
    return true;
  } catch {
    executableCache.set(command, false);
    return false;
  }
}

async function runWithInput(command: string, args: string[], input?: string): Promise<string> {
  if (input === undefined) {
    const { stdout } = await execFileAsync(command, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
    return String(stdout || '');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, 8000);
    timeout.unref?.();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

function appleScriptString(value: unknown): string {
  return JSON.stringify(String(value ?? ''));
}

function requireHttpUrl(value: unknown): string {
  const url = new URL(String(value ?? '').trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('open_url only allows http:// and https:// URLs.');
  }
  return url.toString();
}

const MAC_KEY_CODES: Record<string, number> = {
  enter: 36, return: 36, tab: 48, space: 49, backspace: 51, delete: 117,
  esc: 53, escape: 53, left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

function macModifiers(parts: string[]): string {
  const modifiers = parts.slice(0, -1).map(part => part.toLowerCase()).flatMap(part => {
    if (part === 'cmd' || part === 'command' || part === 'meta') return ['command down'];
    if (part === 'ctrl' || part === 'control') return ['control down'];
    if (part === 'alt' || part === 'option') return ['option down'];
    if (part === 'shift') return ['shift down'];
    return [];
  });
  return modifiers.length ? ` using {${modifiers.join(', ')}}` : '';
}

async function runMac(action: string, input: any): Promise<PlatformActionResult | null> {
  const provider = 'macOS Accessibility (osascript)';
  if (!(await hasExecutable('osascript'))) return { success: false, result: 'macOS osascript is unavailable.', provider };
  const x = Math.round(Number(input.x ?? 0));
  const y = Math.round(Number(input.y ?? 0));
  const cliclick = await hasExecutable('cliclick');

  const runAppleScript = async (script: string) => {
    await execFileAsync('osascript', ['-e', script], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  };

  try {
    if (action === 'click' || action === 'right_click' || action === 'double_click') {
      if (cliclick) {
        const clickCode = action === 'right_click' ? 'rc' : action === 'double_click' ? 'dc' : 'c';
        await execFileAsync('cliclick', [`${clickCode}:${x},${y}`], { timeout: 8000 });
      } else if (action === 'click') {
        await runAppleScript(`tell application "System Events" to click at {${x}, ${y}}`);
      } else {
        return { success: false, result: `${action} requires cliclick on macOS. Install it or use a left click.`, provider };
      }
      return { success: true, result: `${action} completed at (${x}, ${y}).`, provider };
    }
    if (action === 'hover' || action === 'drag') {
      if (!cliclick) return { success: false, result: 'Cursor movement requires cliclick on macOS. Install cliclick and grant Accessibility permission.', provider };
      if (action === 'hover') await execFileAsync('cliclick', [`m:${x},${y}`], { timeout: 8000 });
      else await execFileAsync('cliclick', [`dd:${x},${y}`, `du:${Math.round(Number(input.x2 ?? 0))},${Math.round(Number(input.y2 ?? 0))}`], { timeout: 8000 });
      return { success: true, result: `${action} completed.`, provider };
    }
    if (action === 'type') {
      const text = String(input.text || '');
      if (!text) return { success: false, result: 'No text provided.', provider };
      await runAppleScript(`tell application "System Events" to keystroke ${appleScriptString(text)}`);
      return { success: true, result: `Typed ${text.length} characters.`, provider };
    }
    if (action === 'key' || ['select_all', 'copy', 'paste', 'save', 'undo', 'close_window'].includes(action)) {
      const key = action === 'key' ? String(input.text || 'enter') : ({ select_all: 'cmd+a', copy: 'cmd+c', paste: 'cmd+v', save: 'cmd+s', undo: 'cmd+z', close_window: 'cmd+w' } as Record<string, string>)[action];
      const parts = key.toLowerCase().split('+');
      const base = parts[parts.length - 1];
      const keyCode = MAC_KEY_CODES[base];
      const suffix = macModifiers(parts);
      if (keyCode !== undefined) await runAppleScript(`tell application "System Events" to key code ${keyCode}${suffix}`);
      else if (base.length === 1) await runAppleScript(`tell application "System Events" to keystroke ${appleScriptString(base)}${suffix}`);
      else return { success: false, result: `Unsupported macOS key: ${key}.`, provider };
      return { success: true, result: `Pressed ${key}.`, provider };
    }
    if (action === 'maximize' || action === 'minimize') {
      const accessibilityAction = action === 'maximize' ? 'AXZoomWindow' : 'AXMinimize';
      await runAppleScript(`tell application "System Events" to tell (first application process whose frontmost is true) to perform action "${accessibilityAction}" of window 1`);
      return { success: true, result: `${action} completed.`, provider };
    }
    if (action === 'scroll') {
      const direction = input.direction === 'up' ? 'up' : 'down';
      const amount = Math.max(1, Math.min(10, Number(input.amount ?? 3)));
      if (cliclick) await execFileAsync('cliclick', [`${direction === 'up' ? 'wu' : 'wd'}:${amount}`], { timeout: 8000 });
      else await runAppleScript(`tell application "System Events" to repeat ${amount} times\nscroll ${direction}\nend repeat`);
      return { success: true, result: `Scrolled ${direction} ${amount} times.`, provider };
    }
    if (action === 'clipboard_get') return { success: true, result: (await runWithInput('pbpaste', [])).trimEnd() || '(clipboard empty)', provider };
    if (action === 'clipboard_set') {
      const text = String(input.text || '');
      await runWithInput('pbcopy', [], text);
      return { success: true, result: `Clipboard set (${text.length} chars).`, provider };
    }
    if (action === 'list_apps') {
      const { stdout } = await execFileAsync('osascript', ['-e', 'tell application "System Events" to get name of every process whose background only is false'], { timeout: 10000 });
      return { success: true, result: String(stdout || '').split(',').map(value => value.trim()).filter(Boolean), provider };
    }
    if (action === 'focus_app') {
      const app = String(input.text || '');
      await runAppleScript(`tell application "System Events" to set frontmost of process ${appleScriptString(app)} to true`);
      return { success: true, result: `Focused ${app}.`, provider };
    }
    if (action === 'launch_app') {
      const app = String(input.text || '');
      await execFileAsync('open', ['-a', app], { timeout: 10000 });
      return { success: true, result: `Launched ${app}.`, provider };
    }
    if (action === 'open_url') {
      const url = requireHttpUrl(input.url ?? input.text);
      await execFileAsync('open', [url], { timeout: 10000 });
      return { success: true, result: `Opened URL: ${url}`, provider };
    }
    if (action === 'get_cursor') {
      if (!cliclick) return { success: false, result: 'Cursor position requires cliclick on macOS.', provider };
      const { stdout } = await execFileAsync('cliclick', ['p'], { timeout: 8000 });
      return { success: true, result: String(stdout || '').trim(), provider };
    }
    return null;
  } catch (error: any) {
    return { success: false, result: `${String(error?.message || error).slice(0, 360)} Grant EterX Accessibility/Automation permission if macOS blocked the action.`, provider };
  }
}

const LINUX_KEY_MAP: Record<string, string> = {
  enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'space',
  backspace: 'BackSpace', delete: 'Delete', left: 'Left', right: 'Right', up: 'Up', down: 'Down',
  home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down',
};

async function runLinux(action: string, input: any): Promise<PlatformActionResult | null> {
  const provider = 'Linux desktop input (xdotool)';
  if (!(await hasExecutable('xdotool'))) {
    return { success: false, result: 'xdotool is required for Linux screen actions. On Wayland, use a desktop session with xdotool/XWayland or use browser CDP control.', provider };
  }
  const xdo = async (...args: string[]) => { await execFileAsync('xdotool', args, { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }); };
  const x = Math.round(Number(input.x ?? 0));
  const y = Math.round(Number(input.y ?? 0));
  try {
    if (action === 'click' || action === 'right_click' || action === 'double_click') {
      const button = action === 'right_click' ? '3' : '1';
      const repeat = action === 'double_click' ? ['--repeat', '2', '--delay', '80'] : [];
      await xdo('mousemove', '--sync', String(x), String(y), 'click', ...repeat, button);
      return { success: true, result: `${action} completed at (${x}, ${y}).`, provider };
    }
    if (action === 'hover') { await xdo('mousemove', '--sync', String(x), String(y)); return { success: true, result: `Cursor moved to (${x}, ${y}).`, provider }; }
    if (action === 'drag') {
      await xdo('mousemove', '--sync', String(x), String(y), 'mousedown', '1');
      await xdo('mousemove', '--sync', String(Math.round(Number(input.x2 ?? 0))), String(Math.round(Number(input.y2 ?? 0))), 'mouseup', '1');
      return { success: true, result: 'Drag completed.', provider };
    }
    if (action === 'type') {
      const text = String(input.text || '');
      await xdo('type', '--clearmodifiers', '--delay', '1', text);
      return { success: true, result: `Typed ${text.length} characters.`, provider };
    }
    if (action === 'key' || ['select_all', 'copy', 'paste', 'save', 'undo', 'close_window'].includes(action)) {
      const key = action === 'key' ? String(input.text || 'enter') : ({ select_all: 'ctrl+a', copy: 'ctrl+c', paste: 'ctrl+v', save: 'ctrl+s', undo: 'ctrl+z', close_window: 'alt+F4' } as Record<string, string>)[action];
      const mapped = key.split('+').map(part => LINUX_KEY_MAP[part.toLowerCase()] || part).join('+');
      await xdo('key', '--clearmodifiers', mapped);
      return { success: true, result: `Pressed ${key}.`, provider };
    }
    if (action === 'minimize' || action === 'maximize' || action === 'close_window') {
      const key = action === 'minimize' ? 'alt+F9' : action === 'maximize' ? 'alt+F10' : 'alt+F4';
      await xdo('key', '--clearmodifiers', key);
      return { success: true, result: `${action} completed.`, provider };
    }
    if (action === 'scroll') {
      const button = input.direction === 'up' ? '4' : input.direction === 'left' ? '6' : input.direction === 'right' ? '7' : '5';
      await xdo('mousemove', '--sync', String(x), String(y), 'click', '--repeat', String(Math.max(1, Math.min(10, Number(input.amount ?? 3)))), '--delay', '45', button);
      return { success: true, result: `Scrolled ${input.direction === 'up' ? 'up' : 'down'}.`, provider };
    }
    if (action === 'clipboard_get') {
      for (const [command, args] of [['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']] ] as Array<[string, string[]]>) {
        try { return { success: true, result: (await runWithInput(command, args)).trimEnd() || '(clipboard empty)', provider }; } catch {}
      }
      return { success: false, result: 'Install wl-clipboard, xclip, or xsel for Linux clipboard access.', provider };
    }
    if (action === 'clipboard_set') {
      const text = String(input.text || '');
      for (const [command, args] of [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']] ] as Array<[string, string[]]>) {
        try { await runWithInput(command, args, text); return { success: true, result: `Clipboard set (${text.length} chars).`, provider }; } catch {}
      }
      return { success: false, result: 'Install wl-clipboard, xclip, or xsel for Linux clipboard access.', provider };
    }
    if (action === 'list_apps') {
      const { stdout } = await execFileAsync('xdotool', ['search', '--onlyvisible', '--name', '.*'], { timeout: 10000 });
      const windows = await Promise.all(String(stdout || '').split(/\r?\n/).filter(Boolean).map(async id => {
        try { const { stdout: title } = await execFileAsync('xdotool', ['getwindowname', id], { timeout: 4000 }); return { id, title: String(title || '').trim() }; } catch { return null; }
      }));
      return { success: true, result: windows.filter(Boolean), provider };
    }
    if (action === 'focus_app') {
      const query = String(input.text || '');
      const { stdout } = await execFileAsync('xdotool', ['search', '--onlyvisible', '--name', query], { timeout: 8000 });
      const id = String(stdout || '').trim().split(/\r?\n/)[0];
      if (!id) return { success: false, result: `App not found: ${query}`, provider };
      await xdo('windowactivate', '--sync', id);
      return { success: true, result: `Focused ${query}.`, provider };
    }
    if (action === 'launch_app') {
      const app = String(input.text || '');
      await execFileAsync('xdg-open', [app], { timeout: 10000 });
      return { success: true, result: `Launched ${app}.`, provider };
    }
    if (action === 'open_url') {
      const url = requireHttpUrl(input.url ?? input.text);
      await execFileAsync('xdg-open', [url], { timeout: 10000 });
      return { success: true, result: `Opened URL: ${url}`, provider };
    }
    if (action === 'get_cursor') {
      const { stdout } = await execFileAsync('xdotool', ['getmouselocation', '--shell'], { timeout: 8000 });
      return { success: true, result: String(stdout || '').trim(), provider };
    }
    return null;
  } catch (error: any) {
    return { success: false, result: `${String(error?.message || error).slice(0, 360)} Check X11/XWayland permissions and the desktop utility availability.`, provider };
  }
}

async function runWindows(action: string, input: any): Promise<PlatformActionResult | null> {
  const provider = 'Windows system clipboard / shell fallback';
  if (!['clipboard_get', 'clipboard_set', 'open_url'].includes(action)) return null;
  const powershell = process.env.ETERX_POWERSHELL || 'powershell.exe';
  try {
    if (action === 'clipboard_get') {
      const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      return { success: true, result: String(stdout || '').trimEnd() || '(clipboard empty)', provider };
    }
    if (action === 'clipboard_set') {
      const text = String(input.text || '');
      const encoded = Buffer.from(text, 'utf8').toString('base64');
      const script = `$value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); Set-Clipboard -Value $value`;
      await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000, windowsHide: true });
      return { success: true, result: `Clipboard set (${text.length} chars).`, provider };
    }
    const url = requireHttpUrl(input.url ?? input.text);
    const encoded = Buffer.from(url, 'utf8').toString('base64');
    const script = `$url = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); Start-Process -FilePath $url`;
    await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, windowsHide: true });
    return { success: true, result: `Opened URL: ${url}`, provider };
  } catch (error: any) {
    return { success: false, result: `${String(error?.message || error).slice(0, 320)} Check Windows clipboard or shell permissions.`, provider };
  }
}

export async function executePlatformScreenAction(action: string, input: any): Promise<PlatformActionResult | null> {
  if (process.platform === 'darwin') return runMac(action, input);
  if (process.platform === 'linux') return runLinux(action, input);
  if (process.platform === 'win32') return runWindows(action, input);
  return null;
}

export function platformControlProvider(): string {
  if (process.platform === 'darwin') return 'macOS Accessibility (osascript)';
  if (process.platform === 'linux') return 'Linux desktop input (xdotool)';
  return 'Windows managed/native desktop input';
}
