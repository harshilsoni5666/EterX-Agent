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
    const { filePath, fileData, fileName, mimeType } = await req.json();
    const fs = require('fs');
    const path = require('path');

    const workspaceTemp = path.resolve(process.cwd(), '.workspaces', 'temp');
    if (!fs.existsSync(workspaceTemp)) fs.mkdirSync(workspaceTemp, { recursive: true });

    const safeName = (fileName || `upload_${Date.now()}`).replace(/[<>:"/\\|?*]/g, '_');
    const destPath = path.join(workspaceTemp, safeName);

    if (filePath) {
      if (!fs.existsSync(destPath) || filePath !== destPath) {
        fs.copyFileSync(filePath, destPath);
      }
    } else if (fileData) {
      fs.writeFileSync(destPath, Buffer.from(fileData, 'base64'));
    } else {
      return NextResponse.json({ error: 'No file data provided' }, { status: 400 });
    }

    let inlineData = null;
    if (String(mimeType || '').startsWith('image/')) {
      try {
        const imgBuffer = fs.readFileSync(destPath);
        if (imgBuffer.length < 4 * 1024 * 1024) {
          inlineData = { mimeType, data: imgBuffer.toString('base64') };
        }
      } catch {
        // The file is still saved locally; the agent can read/upload it later.
      }
    }

    return NextResponse.json({
      success: true,
      fileUri: null,
      localPath: destPath,
      mimeType,
      fileName: safeName,
      inlineData,
      isNative: false,
    });
  } catch (error: any) {
    console.error('[MediaUpload] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
