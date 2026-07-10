import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';

const openWithOs = (targetPath: string) => {
  if (process.platform === 'win32') {
    const child = spawn('explorer.exe', [targetPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }

  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [targetPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const rawPath = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!rawPath || rawPath.includes('\0')) {
      return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
    }

    const targetPath = path.resolve(rawPath);
    const exists = fs.existsSync(targetPath);
    const fallbackDir = path.dirname(targetPath);

    if (exists) {
      openWithOs(targetPath);
      return NextResponse.json({ ok: true, opened: targetPath, mode: 'open' });
    }

    if (fallbackDir && fs.existsSync(fallbackDir)) {
      openWithOs(fallbackDir);
      return NextResponse.json({ ok: true, opened: fallbackDir, mode: 'parent', missing: targetPath });
    }

    return NextResponse.json({ error: 'File path not found' }, { status: 404 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to open file path' }, { status: 500 });
  }
}
