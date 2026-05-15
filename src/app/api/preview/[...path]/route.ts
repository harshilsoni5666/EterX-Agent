import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

function getMimeType(filename: string) {
  const ext = path.extname(filename).toLowerCase();
  const mimes: Record<string, string> = {
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.txt': 'text/plain',
  };
  return mimes[ext] || 'application/octet-stream';
}

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  try {
    const requestedPath = path.join(...params.path);
    const decodedPath = decodeURIComponent(requestedPath);
    
    let absolutePath = decodedPath;
    
    if (!fs.existsSync(absolutePath)) {
       if (absolutePath.startsWith('/') && absolutePath[2] === ':') {
         absolutePath = absolutePath.substring(1);
       }
       
       if (!fs.existsSync(absolutePath)) {
          return new NextResponse('Not found', { status: 404 });
       }
    }
    
    const mimeType = getMimeType(absolutePath);
    let fileBuffer = fs.readFileSync(absolutePath);
    
    if (mimeType === 'text/html') {
      let html = fileBuffer.toString('utf-8');
      
      const basePath = `/api/preview/${params.path.slice(0, -1).map(p => encodeURIComponent(p)).join('/')}/`;
      
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
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, must-revalidate',
        }
      });
    }
    
    return new NextResponse(fileBuffer, {
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'no-store, must-revalidate',
      }
    });
    
  } catch (error) {
    console.error('[API Preview Error]', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
