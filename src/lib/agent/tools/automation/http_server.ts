import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import http from 'http';
import path from 'path';
import fs from 'fs-extra';
import { resolveWorkspaceDirectoryForContext } from '../../workspace/path_resolver';

/**
 * Quick HTTP Server
 * 
 * Spin up local HTTP servers for serving files, testing APIs, or webhooks.
 */

interface ActiveHttpServer {
  server: http.Server;
  port: number;
  root: string;
}

const activeServers: Map<string, ActiveHttpServer> = new Map();

function ownerChatId(context: any): string {
  return String(context?.chatId || context?.projectId || 'global').trim() || 'global';
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain', '.pdf': 'application/pdf', '.xml': 'application/xml',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4'
};

export const httpServerTool: ToolDefinition = {
  name: 'http_server',
  description: `Start/stop a local HTTP file server owned by this chat to serve static files or preview HTML pages. Each chat has independent server control.`,
  category: 'automation',
  inputSchema: z.object({
    action: z.enum(['start', 'stop', 'status']).describe('Start, stop, or check server status'),
    directory: z.string().optional().describe('Directory to serve (relative to workspace). Default: workspace root'),
    port: z.number().optional().default(8080).describe('Port to serve on (default: 8080)')
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string() }),
  execute: async (input: any, context?: any) => {
    try {
      switch (input.action) {
        case 'start': {
          const owner = ownerChatId(context);
          const existing = activeServers.get(owner);
          if (existing) {
            return { success: false, message: `Server already running on port ${existing.port}. Stop it first.` };
          }
          const root = resolveWorkspaceDirectoryForContext(input.directory, context);
          await fs.ensureDir(root);
          const port = input.port || 8080;

          const server = http.createServer(async (req, res) => {
            const urlPath = req.url === '/' ? '/index.html' : req.url || '/';
            const filePath = path.resolve(root, `.${decodeURIComponent(urlPath)}`);
            
            // Security: prevent directory traversal
            const relative = path.relative(root, filePath);
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
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
            server.listen(port, () => resolve());
            server.on('error', reject);
          });
          activeServers.set(owner, { server, port, root });
          server.on('close', () => {
            if (activeServers.get(owner)?.server === server) activeServers.delete(owner);
          });

          return { success: true, message: `🌐 Server started at http://localhost:${port} serving: ${root}`, port, url: `http://localhost:${port}` };
        }
        case 'stop': {
          const active = activeServers.get(ownerChatId(context));
          if (!active) return { success: true, message: 'No server running' };
          active.server.close();
          activeServers.delete(ownerChatId(context));
          const p = active.port;
          return { success: true, message: `🛑 Server on port ${p} stopped` };
        }
        case 'status': {
          const active = activeServers.get(ownerChatId(context));
          return {
            success: true,
            message: active ? `Server running on port ${active.port}` : 'No server running',
            running: !!active, port: active?.port || 0
          };
        }
        default: return { success: false, message: 'Unknown action' };
      }
    } catch (err: any) {
      return { success: false, message: `Server error: ${err.message}` };
    }
  }
};
