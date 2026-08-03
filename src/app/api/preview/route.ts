import { NextRequest } from 'next/server';
import { GET as getPreviewFile } from './[...path]/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Handle query-encoded preview paths when no catch-all route segment exists. */
export async function GET(req: NextRequest) {
  return getPreviewFile(req, { params: { path: [] } });
}
