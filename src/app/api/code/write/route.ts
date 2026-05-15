import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST: Write / save file content
export async function POST(req: NextRequest) {
  try {
    const { filePath, content, createDirs } = await req.json();

    if (!filePath || content === undefined) {
      return NextResponse.json({ error: 'filePath and content are required' }, { status: 400 });
    }

    // Safety: don't write outside project scope
    const normalizedPath = path.normalize(filePath);

    // Create parent directories if needed
    if (createDirs) {
      const dir = path.dirname(normalizedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    // Check if parent dir exists
    const parentDir = path.dirname(normalizedPath);
    if (!fs.existsSync(parentDir)) {
      return NextResponse.json({ error: 'Parent directory does not exist' }, { status: 400 });
    }

    const isNew = !fs.existsSync(normalizedPath);
    fs.writeFileSync(normalizedPath, content, 'utf-8');

    return NextResponse.json({
      success: true,
      filePath: normalizedPath,
      isNew,
      size: Buffer.byteLength(content, 'utf-8'),
      lines: content.split('\n').length,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
