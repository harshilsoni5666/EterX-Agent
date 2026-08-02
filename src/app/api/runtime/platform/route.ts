import { NextResponse } from 'next/server';
import { getAvailableTerminalShells, normalizeTerminalShell, resolveTerminalShell } from '@/lib/agent/tools/core/shell_resolver';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const selectedShells = getAvailableTerminalShells();
  const platform = process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'mac'
      : 'linux';

  return NextResponse.json({
    platform,
    shells: selectedShells,
    defaultShell: resolveTerminalShell(normalizeTerminalShell('auto')),
  });
}
