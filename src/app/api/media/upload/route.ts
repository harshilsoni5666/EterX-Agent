import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
    const fs = require('fs');
    const fsp = fs.promises;
    const path = require('path');

    const workspaceTemp = path.resolve(process.cwd(), '.workspaces', 'temp');
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
    } else {
      const body = await req.json();
      filePath = body.filePath;
      fileData = body.fileData;
      fileName = body.fileName || fileName;
      mimeType = body.mimeType || mimeType;
    }

    const safeBaseName = (fileName || `upload_${Date.now()}`).replace(/[<>:"/\\|?*]/g, '_');
    const safeName = `${Date.now()}_${safeBaseName}`;
    const destPath = path.join(workspaceTemp, safeName);

    if (fileBuffer) {
      await fsp.writeFile(destPath, fileBuffer);
    } else if (filePath) {
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
    });
  } catch (error: any) {
    console.error('[MediaUpload] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
