import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import fs from 'fs-extra';
import path from 'path';

interface WatchedEntry {
  id: string;
  path: string;
  type: 'file' | 'directory';
  changeCount: number;
  changes: Array<{ timestamp: number, type: string, detail: string }>;
}

const watchedEntries: Map<string, WatchedEntry> = new Map();
const watchers: Map<string, fs.FSWatcher> = new Map();

export const fileWatcherTool: ToolDefinition = {
  name: 'file_watcher',
  description: 'Watch files/directories for changes in real-time. Track modifications, new files, deletions. Use for monitoring config, build output, or log files.',
  category: 'automation',
  inputSchema: z.object({
    action: z.enum(['watch', 'unwatch', 'status', 'changes']).describe('Action to perform'),
    path: z.string().optional().describe('File/directory path (relative to workspace)'),
    watchId: z.string().optional().describe('ID of the watch')
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string(), data: z.any().optional() }),
  execute: async (input: any) => {
    const root = path.resolve(process.cwd(), '.workspaces', 'temp');
    try {
      switch (input.action) {
        case 'watch': {
          if (!input.path) return { success: false, message: 'path required' };
          const full = path.resolve(root, input.path);
          if (!await fs.pathExists(full)) return { success: false, message: 'Path not found' };
          const stats = await fs.stat(full);
          const id = input.watchId || `watch_${Date.now()}`;
          const entry: WatchedEntry = { id, path: input.path, type: stats.isDirectory() ? 'directory' : 'file', changeCount: 0, changes: [] };
          try {
            const w = fs.watch(full, { recursive: stats.isDirectory() }, (evt, fn) => {
              entry.changeCount++;
              entry.changes.push({ timestamp: Date.now(), type: evt, detail: `${evt}: ${fn || input.path}` });
              if (entry.changes.length > 50) entry.changes.shift();
            });
            watchers.set(id, w);
          } catch { }
          watchedEntries.set(id, entry);
          return { success: true, message: `Watching: ${input.path} (ID: ${id})` };
        }
        case 'unwatch': {
          const id = input.watchId || input.path;
          const w = watchers.get(id || '');
          if (w) { w.close(); watchers.delete(id!); }
          watchedEntries.delete(id || '');
          return { success: true, message: `Stopped watching: ${id}` };
        }
        case 'status': {
          const list = Array.from(watchedEntries.values()).map(e => ({ id: e.id, path: e.path, changes: e.changeCount }));
          return { success: true, message: `${list.length} watches active`, data: list };
        }
        case 'changes': {
          const e = watchedEntries.get(input.watchId || '');
          if (!e) return { success: false, message: 'Watch not found' };
          return { success: true, message: `${e.changeCount} changes`, data: e.changes.slice(-20) };
        }
        default: return { success: false, message: 'Unknown action' };
      }
    } catch (err: any) { return { success: false, message: err.message }; }
  }
};
