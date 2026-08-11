import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { rejectCrossOrigin } from '../../agent/_shared';

export const runtime = 'nodejs';

const openWithOs = (targetPath: string): Promise<string> => {
  const commands = process.platform === 'win32'
    ? [['explorer.exe', [targetPath]] as const]
    : process.platform === 'darwin'
      ? [['open', [targetPath]] as const]
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
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', (error) => {
        void tryCommand(index + 1, error as Error).then(resolve, reject);
      });
      child.once('spawn', () => {
        child.unref();
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
    const rawPath = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!rawPath || rawPath.includes('\0')) {
      return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
    }

    const targetPath = path.resolve(rawPath);
    const exists = fs.existsSync(targetPath);
    const fallbackDir = path.dirname(targetPath);

    if (exists) {
      const opener = await openWithOs(targetPath);
      return NextResponse.json({ ok: true, opened: targetPath, mode: 'open', opener });
    }

    if (fallbackDir && fs.existsSync(fallbackDir)) {
      const opener = await openWithOs(fallbackDir);
      return NextResponse.json({ ok: true, opened: fallbackDir, mode: 'parent', missing: targetPath, opener });
    }

    return NextResponse.json({ error: 'File path not found' }, { status: 404 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to open file path' }, { status: 500 });
  }
}
