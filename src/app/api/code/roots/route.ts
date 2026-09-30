import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../../agent/_shared';
import { getChatWorkspacePaths } from '@/lib/agent/storage-paths';
import fs from 'fs/promises';
const { resolveWorkspaceRoots } = require('../../../../../electron/workspace-roots') as { resolveWorkspaceRoots: (options: unknown) => Promise<string[]> };

export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  try {
    const options = await request.json();
    const roots = await resolveWorkspaceRoots(options);
    if (!options.workspacePath && typeof options.chatId === 'string' && options.chatId.trim()) {
      const owned = getChatWorkspacePaths(options.chatId).workspace;
      await fs.mkdir(owned, { recursive: true });
      if (!roots.includes(owned)) roots.unshift(owned);
    }
    return NextResponse.json({ roots });
  }
  catch (error) { return NextResponse.json({ error: (error as Error).message || 'Could not read workspace folders.' }, { status: 400 }); }
}
