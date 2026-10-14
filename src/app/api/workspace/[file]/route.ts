import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getEterxWorkspaceDir } from '../../../../lib/agent/storage-paths';

function resolveTempFile(filename: string): string {
  const root = path.resolve(getEterxWorkspaceDir('temp'));
  const resolved = path.resolve(root, filename);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid temporary file path');
  }
  return resolved;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  try {
    const routeParams = await params;
    const filename = String(routeParams.file || '');
    const filePath = resolveTempFile(filename);

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const fileBuffer = fs.readFileSync(filePath);
    return new NextResponse(fileBuffer, {
      headers: {
        'Content-Disposition': `attachment; filename="${path.basename(filename).replace(/["\\\r\n]/g, '_')}"`,
        'Content-Type': 'application/octet-stream',
      },
    });
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
