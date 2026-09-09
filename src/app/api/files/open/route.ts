import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { rejectCrossOrigin } from '../../agent/_shared';

export const runtime = 'nodejs';

const openWithOs = (targetPath: string): Promise<string> => {
  const commands = process.platform === 'win32'
    ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:ETERX_OPEN_TARGET -ErrorAction Stop"]] as const]
    : process.platform === 'darwin'
      ? [['/usr/bin/open', [targetPath]] as const]
      : [
          ['xdg-open', [targetPath]] as const,
          ['gio', ['open', targetPath]] as const,
        ];

  const tryCommand = (index: number, previousError?: Error): Promise<string> => {
    const candidate = commands[index];
    if (!candidate) return Promise.reject(previousError || new Error('No operating-system file opener is available.'));

    return new Promise((resolve, reject) => {
      const [command, args] = candidate;
      const child = spawn(command, args, {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ETERX_OPEN_TARGET: targetPath },
      });
      let settled = false;
      const failed = (error: Error) => {
        if (settled) return;
        settled = true;
        void tryCommand(index + 1, error).then(resolve, reject);
      };
      child.once('error', (error) => {
        failed(error);
      });
      child.once('exit', (code) => {
        if (settled) return;
        if (code !== 0) { failed(new Error(`${command} could not open the requested path`)); return; }
        settled = true;
        resolve(command);
      });
    });
  };

  return tryCommand(0);
};

export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const body = await req.json().catch(() => ({}));
    let rawPath = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!rawPath || rawPath.includes('\0')) {
      return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
    }

    rawPath = rawPath.replace(/^<([\s\S]*)>$/, '$1').replace(/^(["'])([\s\S]*)\1$/, '$2');
    const localLink = rawPath.match(/^#?eterx-local-file:([\s\S]*)$/i);
    if (localLink) rawPath = decodeURIComponent(localLink[1]);
    if (/^file:/i.test(rawPath)) {
      const driveUrl = rawPath.match(/^file:\/{2,3}([A-Za-z]:[\\/][\s\S]*)$/i);
      rawPath = driveUrl && process.platform === 'win32'
        ? decodeURIComponent(driveUrl[1]).replace(/\//g, '\\') : fileURLToPath(rawPath);
    }
    if (rawPath === '~') rawPath = os.homedir();
    else if (/^~[\\/]/.test(rawPath)) rawPath = path.join(os.homedir(), rawPath.slice(2));
    // Never resolve a relative artifact against the application installation.
    // The chat resolves it against its own workspace before making this call.
    if (rawPath.includes('\0') || !path.isAbsolute(rawPath)
      || (process.platform !== 'win32' && /^(?:[A-Za-z]:|\\\\)/.test(rawPath))
      || (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(rawPath))) {
      return NextResponse.json({ error: 'An absolute path for this operating system is required' }, { status: 400 });
    }
    const targetPath = path.normalize(rawPath);
    const exists = fs.existsSync(targetPath);

    if (exists) {
      const opener = await openWithOs(targetPath);
      return NextResponse.json({ ok: true, opened: targetPath, mode: 'open', opener });
    }

    return NextResponse.json({ error: 'File path not found' }, { status: 404 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to open file path' }, { status: 500 });
  }
}
