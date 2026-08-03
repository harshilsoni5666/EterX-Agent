import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getEterxWorkspaceDir } from '../storage-paths';

const execFileAsync = promisify(execFile);
const SCREEN_DIR = getEterxWorkspaceDir('temp', 'screenshots');

type CaptureOptions = {
  target?: 'fullscreen' | 'active_window';
};

function safeLabel(value: string) {
  return String(value || 'screen').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50) || 'screen';
}

/** Capture a host screen on macOS/Linux using standard OS utilities. */
export async function capturePlatformScreen(label = 'screen', options: CaptureOptions = {}): Promise<{ path: string; base64: string } | null> {
  if (process.platform === 'win32') return null;

  await fs.ensureDir(SCREEN_DIR);
  const filePath = path.join(SCREEN_DIR, `desktop_${safeLabel(label)}_${Date.now()}.png`);

  try {
    if (process.platform === 'darwin') {
      const args = options.target === 'active_window'
        ? ['-x', '-w', filePath]
        : ['-x', filePath];
      await execFileAsync('screencapture', args, { timeout: 15_000 });
    } else if (process.platform === 'linux') {
      const candidates: Array<[string, string[]]> = options.target === 'active_window'
        ? [
            ['gnome-screenshot', ['-w', '-f', filePath]],
            ['spectacle', ['-a', '-b', '-n', '-o', filePath]],
            ['scrot', ['-u', filePath]],
          ]
        : [
            ['grim', [filePath]],
            ['gnome-screenshot', ['-f', filePath]],
            ['spectacle', ['-b', '-n', '-o', filePath]],
            ['scrot', [filePath]],
            ['maim', [filePath]],
            ['import', ['-window', 'root', filePath]],
          ];
      let captured = false;
      for (const [command, args] of candidates) {
        try {
          await execFileAsync(command, args, { timeout: 15_000 });
          captured = true;
          break;
        } catch {}
      }
      if (!captured) return null;
    } else {
      return null;
    }

    if (!await fs.pathExists(filePath)) return null;
    return { path: filePath, base64: (await fs.readFile(filePath)).toString('base64') };
  } catch {
    return null;
  } finally {
    // The returned artifact is consumed immediately by the monitor/model.
    // Keep the path only for the current result, then remove it on the next tick.
    if (await fs.pathExists(filePath)) {
      setTimeout(() => { void fs.remove(filePath); }, 30_000).unref?.();
    }
  }
}

export function platformScreenProvider(): string {
  if (process.platform === 'darwin') return 'macOS screencapture';
  if (process.platform === 'linux') return 'Linux screenshot utility';
  if (process.platform === 'win32') return 'Windows managed capture';
  return os.platform();
}
