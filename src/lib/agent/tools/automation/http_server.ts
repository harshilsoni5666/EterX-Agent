import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import http from 'http';
import path from 'path';
import fs from 'fs-extra';

/**
 * Quick HTTP Server
 * 
 * Spin up local HTTP servers for serving files, testing APIs, or webhooks.
 */

let activeServer: http.Server | null = null;
let activePort = 0;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain', '.pdf': 'application/pdf', '.xml': 'application/xml',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4'
};

export const httpServerTool: ToolDefinition = {
  name: 'http_server',
  description: `Start/stop a local HTTP file server to serve static files or preview HTML pages. Use this to preview generated websites, serve build output, or test static content. Only one server runs at a time.`,
  category: 'automation',
  inputSchema: z.object({
    action: z.enum(['start', 'stop', 'status']).describe('Start, stop, or check server status'),
    directory: z.string().optional().describe('Directory to serve (relative to workspace). Default: workspace root'),
    port: z.number().optional().default(8080).describe('Port to serve on (default: 8080)')
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string() }),
  execute: async (input: any) => {
    try {
      switch (input.action) {
        case 'start': {
          if (activeServer) {
            return { success: false, message: `Server already running on port ${activePort}. Stop it first.` };
          }
          const root = path.resolve(process.cwd(), '.workspaces', 'temp', input.directory || '');
          await fs.ensureDir(root);
          const port = input.port || 8080;

          activeServer = http.createServer(async (req, res) => {
            const urlPath = req.url === '/' ? '/index.html' : req.url || '/';
            const filePath = path.join(root, decodeURIComponent(urlPath));
            
            // Security: prevent directory traversal
            if (!filePath.startsWith(root)) {
              res.writeHead(403); res.end('Forbidden'); return;
            }
            try {
              if (await fs.pathExists(filePath)) {
                const stat = await fs.stat(filePath);
                if (stat.isDirectory()) {
                  // Serve directory listing as HTML
                  const files = await fs.readdir(filePath);
                  const list = files.map(f => `<li><a href="${urlPath}/${f}">${f}</a></li>`).join('');
                  res.writeHead(200, { 'Content-Type': 'text/html' });
                  res.end(`<html><body><h2>Index of ${urlPath}</h2><ul>${list}</ul></body></html>`);
                } else {
                  const ext = path.extname(filePath).toLowerCase();
                  const mime = MIME_TYPES[ext] || 'application/octet-stream';
                  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size });
                  fs.createReadStream(filePath).pipe(res);
                }
              } else {
                res.writeHead(404);
                res.end(`Not found: ${urlPath}`);
              }
            } catch { res.writeHead(500); res.end('Internal error'); }
          });

          await new Promise<void>((resolve, reject) => {
            activeServer!.listen(port, () => { activePort = port; resolve(); });
            activeServer!.on('error', reject);
          });

          return { success: true, message: `🌐 Server started at http://localhost:${port} serving: ${root}`, port, url: `http://localhost:${port}` };
        }
        case 'stop': {
          if (!activeServer) return { success: true, message: 'No server running' };
          activeServer.close();
          activeServer = null;
          const p = activePort;
          activePort = 0;
          return { success: true, message: `🛑 Server on port ${p} stopped` };
        }
        case 'status': {
          return {
            success: true,
            message: activeServer ? `Server running on port ${activePort}` : 'No server running',
            running: !!activeServer, port: activePort
          };
        }
        default: return { success: false, message: 'Unknown action' };
      }
    } catch (err: any) {
      return { success: false, message: `Server error: ${err.message}` };
    }
  }
};
