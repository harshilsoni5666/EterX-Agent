import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { rejectCrossOrigin } from '../../agent/_shared';

function getMimeType(filename: string) {
  const ext = path.extname(filename).toLowerCase();
  const mimes: Record<string, string> = {
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.json': 'application/json',
    '.map': 'application/json',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.mp4': 'video/mp4',
    '.m4v': 'video/x-m4v',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.docm': 'application/vnd.ms-word.document.macroEnabled.12',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.pptm': 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
    '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
    '.zip': 'application/zip',
  };
  return mimes[ext] || 'application/octet-stream';
}

function inlineFileNameHeader(filename: string) {
  const name = path.basename(filename);
  const safeName = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
  // HTTP header values must be byte strings. Preserve Unicode through RFC 5987.
  return `inline; filename="${safeName}"; filename*=UTF-8''${encoded}`;
}

function streamFile(filename: string, req: NextRequest, start?: number, end?: number) {
  const stream = fs.createReadStream(filename, { start, end });
  const abort = () => stream.destroy(new Error('Preview request cancelled.'));
  req.signal.addEventListener('abort', abort, { once: true });
  stream.once('close', () => req.signal.removeEventListener('abort', abort));
  const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
  if (req.signal.aborted) abort();
  return body;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    // New callers send the complete native path in a query parameter. This
    // keeps roots and special characters intact on Windows, macOS, and Linux.
    // Keep the catch-all route as a backwards-compatible fallback for older
    // renderer bundles and previously stored links.
    const queryPath = req.nextUrl.searchParams.get('path');
    // Next.js has already decoded route parameters. Decoding again changes
    // literal filenames such as report%20final.html into different paths.
    const parts = (await params).path;
    let absolutePath = queryPath || '';
    if (absolutePath.includes('\0')) return new NextResponse('Invalid path', { status: 400 });

    if (!absolutePath) {
      const driveIndex = parts.findIndex(p => p.endsWith(':'));
      if (driveIndex !== -1) {
        absolutePath = parts[driveIndex] + path.sep + path.join(...parts.slice(driveIndex + 1));
      } else {
        absolutePath = path.join(...parts);
      }
    }

    absolutePath = path.normalize(absolutePath);

    if (!fs.existsSync(absolutePath) && !path.isAbsolute(absolutePath)) {
      // Older POSIX links dropped the leading slash while building route
      // segments. Preserve those links without affecting native paths.
      const altPath = path.resolve(path.sep, absolutePath);
      if (fs.existsSync(altPath)) absolutePath = altPath;
    }
    
    if (!fs.existsSync(absolutePath)) {
       return new NextResponse('Not found', { status: 404 });
    }
    
    const stats = fs.statSync(absolutePath);
    if (!stats.isFile()) {
      return new NextResponse('Not found', { status: 404 });
    }

    const mimeType = getMimeType(absolutePath);
    const sharedHeaders = {
      'Content-Type': mimeType,
      'Cache-Control': 'no-store, must-revalidate',
      'Content-Disposition': inlineFileNameHeader(absolutePath),
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
    };

    const range = req.headers.get('range');
    if (range && mimeType !== 'text/html') {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (match && (match[1] || match[2]) && Number.isSafeInteger(Number(match[1] || match[2]))) {
        const suffix = !match[1];
        const requestedStart = suffix ? Math.max(0, stats.size - Number(match[2])) : Number(match[1]);
        const requestedEnd = suffix || !match[2] ? stats.size - 1 : Number(match[2]);
        const start = requestedStart;
        const end = Math.min(stats.size - 1, requestedEnd);

        if (start >= 0 && start <= end && Number.isSafeInteger(start) && Number.isSafeInteger(requestedEnd)) {
          const chunkSize = end - start + 1;
          return new NextResponse(streamFile(absolutePath, req, start, end), {
            status: 206,
            headers: {
              ...sharedHeaders,
              'Content-Length': String(chunkSize),
              'Content-Range': `bytes ${start}-${end}/${stats.size}`,
            },
          });
        }
      }

      return new NextResponse(null, {
        status: 416,
        headers: {
          ...sharedHeaders,
          'Content-Range': `bytes */${stats.size}`,
        },
      });
    }

    if (mimeType === 'text/html') {
      let html = await fs.promises.readFile(absolutePath, 'utf8');
      
      const baseParts = queryPath
        ? [path.parse(absolutePath).root, ...path.dirname(absolutePath).slice(path.parse(absolutePath).root.length).split(path.sep)].filter(Boolean)
        : (await params).path.slice(0, -1);
      const basePath = `/api/preview/${baseParts.map(p => encodeURIComponent(p)).join('/')}/`;
      
      if (!html.includes('<base ')) {
        const baseTag = `<base href="${basePath}" />`;
        if (html.includes('<head>')) {
          html = html.replace('<head>', `<head>\n    ${baseTag}`);
        } else if (html.includes('<html>')) {
          html = html.replace('<html>', `<html>\n  <head>\n    ${baseTag}\n  </head>`);
        } else {
          html = `${baseTag}\n${html}`;
        }
      }
      
      const script = `
        <script>
          (function() {
            const originalLog = console.log;
            const originalError = console.error;
            const originalWarn = console.warn;
            
            console.log = function(...args) {
              window.parent.postMessage({ type: 'preview-console', level: 'info', args: args.map(a => String(a)) }, '*');
              originalLog.apply(console, args);
            };
            console.error = function(...args) {
              window.parent.postMessage({ type: 'preview-console', level: 'error', args: args.map(a => String(a)) }, '*');
              originalError.apply(console, args);
            };
            console.warn = function(...args) {
              window.parent.postMessage({ type: 'preview-console', level: 'warn', args: args.map(a => String(a)) }, '*');
              originalWarn.apply(console, args);
            };
            window.onerror = function(msg, url, line, col, error) {
              window.parent.postMessage({ type: 'preview-console', level: 'error', args: [\`\${msg} at \${line}:\${col}\`] }, '*');
              return false;
            };
            window.addEventListener('message', (e) => {
               if (e.data?.type === 'preview-reload') {
                  window.location.reload();
               }
            });
          })();
        </script>
      `;
      
      if (html.includes('<head>')) {
        html = html.replace('<head>', `<head>\n${script}`);
      } else {
         html = script + html;
      }
      
      return new NextResponse(html, {
        headers: {
          ...sharedHeaders,
          'Content-Type': 'text/html; charset=utf-8',
        }
      });
    }
    
    return new NextResponse(streamFile(absolutePath, req), {
      headers: {
        ...sharedHeaders,
        'Content-Length': String(stats.size),
      }
    });
    
  } catch (error) {
    console.error('[API Preview Error]', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
