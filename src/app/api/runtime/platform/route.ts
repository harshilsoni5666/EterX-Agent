import { NextRequest, NextResponse } from 'next/server';
import { getAvailableTerminalShells } from '@/lib/agent/tools/core/shell_resolver';
import { buildRuntimePlatformPrompt, getRuntimePlatformContext } from '@/lib/agent/runtime/platform-context';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const selectedShells = getAvailableTerminalShells();
  const shell = req.nextUrl.searchParams.get('shell') || 'auto';
  const context = getRuntimePlatformContext(shell);
  const defaultContext = shell === 'auto' ? context : getRuntimePlatformContext();
  const platform = process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'mac'
      : 'linux';

  return NextResponse.json({
    platform,
    shells: selectedShells,
    defaultShell: defaultContext.resolvedShell || null,
    shellError: defaultContext.shellError,
    context,
    runtimePrompt: buildRuntimePlatformPrompt(shell),
  });
}
