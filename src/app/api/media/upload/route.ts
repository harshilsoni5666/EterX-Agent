import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../../agent/_shared';
import { normalizeAttachmentMime } from '../../../../lib/agent/attachment-pipeline';
import { getEterxWorkspaceDir } from '../../../../lib/agent/storage-paths';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Save media files locally before send.
 *
 * Gemini file URIs are scoped to the API key that created them. This route runs
 * before the agent leases its key, so pre-uploading here can make the later
 * agent request fail with 403 permission errors. The agent will upload with its
 * own leased key when Files API upload is required.
 */
export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const fs = require('fs');
    const fsp = fs.promises;
    const path = require('path');
    const { randomUUID } = require('crypto');

    const workspaceTemp = getEterxWorkspaceDir('temp');
    await fsp.mkdir(workspaceTemp, { recursive: true });

    const contentType = req.headers.get('content-type') || '';
    let filePath: string | undefined;
    let fileData: string | undefined;
    let fileBuffer: Buffer | undefined;
    let fileName = `upload_${Date.now()}`;
    let mimeType = 'application/octet-stream';

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const file = formData.get('file');
      if (!file || typeof (file as any).arrayBuffer !== 'function') {
        return NextResponse.json({ error: 'No file provided' }, { status: 400 });
      }

      fileName = String(formData.get('fileName') || (file as any).name || fileName);
      mimeType = String(formData.get('mimeType') || (file as any).type || mimeType);
      fileBuffer = Buffer.from(await (file as any).arrayBuffer());
      if (fileBuffer.length > MAX_UPLOAD_BYTES) {
        return NextResponse.json({ error: `File exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB upload limit` }, { status: 413 });
      }
    } else {
      const body = await req.json();
      filePath = body.filePath;
      fileData = body.fileData;
      fileName = body.fileName || fileName;
      mimeType = body.mimeType || mimeType;
    }

    const safeBaseName = (fileName || `upload_${Date.now()}`)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .trim() || `upload_${Date.now()}`;
    const ext = path.extname(safeBaseName);
    const stem = path.basename(safeBaseName, ext).slice(0, 140) || 'upload';
    const safeName = `${Date.now()}_${randomUUID().slice(0, 8)}_${stem}${ext}`;
    const destPath = path.join(workspaceTemp, safeName);
    mimeType = normalizeAttachmentMime(safeBaseName, mimeType);

    if (fileBuffer) {
      await fsp.writeFile(destPath, fileBuffer);
    } else if (filePath) {
      const sourceStats = await fsp.stat(filePath);
      if (sourceStats.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json({ error: `File exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB upload limit` }, { status: 413 });
      }
      if (!fs.existsSync(destPath) || filePath !== destPath) {
        await fsp.copyFile(filePath, destPath);
      }
    } else if (fileData) {
      await fsp.writeFile(destPath, Buffer.from(fileData, 'base64'));
    } else {
      return NextResponse.json({ error: 'No file data provided' }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      fileUri: null,
      localPath: destPath,
      mimeType,
      fileName: safeName,
      isNative: false,
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (error: any) {
    console.error('[MediaUpload] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
