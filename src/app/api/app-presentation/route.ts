import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';
import { getEterxDataDir } from '../../../lib/agent/storage-paths';
import { isAnnouncementId, isRecord } from '../../../lib/app-presentation/contract';
import { readAppPresentation } from '../../../lib/app-presentation/posthog';
import { rejectCrossOrigin } from '../agent/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private' };

export async function GET() {
  return Response.json(await readAppPresentation(), { headers });
}

export async function POST(request: NextRequest) {
  const originError = rejectCrossOrigin(request);
  if (originError) return originError;
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
    return Response.json({ claimed: false }, { status: 415, headers });
  }
  // The receipt request is just a UUID. Bound the body before parsing it.
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ claimed: false }, { status: 400, headers });
  const decoder = new TextDecoder();
  let length = 0;
  let json = '';
  let body: unknown;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 160) return Response.json({ claimed: false }, { status: 413, headers });
      json += decoder.decode(value, { stream: true });
    }
    body = JSON.parse(json + decoder.decode());
  } catch {
    return Response.json({ claimed: false }, { status: 400, headers });
  } finally {
    await reader.cancel().catch(() => {});
  }
  const id = isRecord(body) ? body.id : undefined;
  if (!isAnnouncementId(id)) return Response.json({ claimed: false }, { status: 400, headers });

  const { data } = await readAppPresentation();
  if (data.announcement?.id !== id) return Response.json({ claimed: false }, { headers });

  const folder = join(getEterxDataDir(), 'settings', 'seen-announcements');
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const receipt = await open(join(folder, id), 'wx', 0o600);
    await receipt.close();
    return Response.json({ claimed: true }, { headers });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return Response.json({ claimed: false }, { headers });
    return Response.json({ claimed: false }, { status: 503, headers });
  }
}
