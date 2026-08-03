import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import fs from 'fs-extra';
import { resolveReadableWorkspacePathForContext } from '../../workspace/path_resolver';

interface WatchedEntry {
  id: string;
  ownerChatId?: string;
  path: string;
  type: 'file' | 'directory';
  changeCount: number;
  changes: Array<{ timestamp: number, type: string, detail: string }>;
}

const watchedEntries: Map<string, WatchedEntry> = new Map();
const watchers: Map<string, fs.FSWatcher> = new Map();

function ownerChatId(context: any): string | undefined {
  const value = String(context?.chatId || context?.projectId || '').trim();
  return value || undefined;
}

function ownedEntry(id: string, context?: any): WatchedEntry | undefined {
  const entry = watchedEntries.get(id);
  const owner = ownerChatId(context);
  return entry && (!owner || entry.ownerChatId === owner) ? entry : undefined;
}

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
  execute: async (input: any, context?: any) => {
    try {
      switch (input.action) {
        case 'watch': {
          if (!input.path) return { success: false, message: 'path required' };
          const full = resolveReadableWorkspacePathForContext(input.path, context);
          if (!await fs.pathExists(full)) return { success: false, message: 'Path not found' };
          const stats = await fs.stat(full);
          const requestedId = input.watchId || `watch_${Date.now()}`;
          const owner = ownerChatId(context);
          const existing = watchedEntries.get(requestedId);
          const id = existing
            ? `${requestedId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
            : requestedId;
          const entry: WatchedEntry = { id, ownerChatId: owner, path: input.path, type: stats.isDirectory() ? 'directory' : 'file', changeCount: 0, changes: [] };
          const recordChange = (evt: string, fn?: string | Buffer | null) => {
              entry.changeCount++;
              entry.changes.push({ timestamp: Date.now(), type: evt, detail: `${evt}: ${fn || input.path}` });
              if (entry.changes.length > 50) entry.changes.shift();
          };
          let watcher: fs.FSWatcher | null = null;
          try {
            watcher = fs.watch(
              full,
              { recursive: stats.isDirectory() } as fs.WatchOptions,
              (evt, filename) => recordChange(evt, filename),
            );
          } catch {
            // Linux does not support recursive fs.watch. Fall back to a
            // portable direct-directory watcher instead of reporting a dead
            // watch; Windows and macOS keep recursive coverage.
            try { watcher = fs.watch(full, (evt, filename) => recordChange(evt, filename)); } catch { watcher = null; }
          }
          if (!watcher) return { success: false, message: `Unable to watch path on this device: ${input.path}` };
          watchers.set(id, watcher);
          watchedEntries.set(id, entry);
          return { success: true, message: `Watching: ${input.path} (ID: ${id})` };
        }
        case 'unwatch': {
          const id = input.watchId || input.path;
          const entry = ownedEntry(id || '', context);
          if (!entry) return { success: false, message: `Watch not found: ${id}` };
          const w = watchers.get(entry.id);
          if (w) { w.close(); watchers.delete(entry.id); }
          watchedEntries.delete(entry.id);
          return { success: true, message: `Stopped watching: ${entry.id}` };
        }
        case 'status': {
          const owner = ownerChatId(context);
          const list = Array.from(watchedEntries.values())
            .filter(e => !owner || e.ownerChatId === owner)
            .map(e => ({ id: e.id, path: e.path, changes: e.changeCount }));
          return { success: true, message: `${list.length} watches active`, data: list };
        }
        case 'changes': {
          const e = ownedEntry(input.watchId || '', context);
          if (!e) return { success: false, message: 'Watch not found' };
          return { success: true, message: `${e.changeCount} changes`, data: e.changes.slice(-20) };
        }
        default: return { success: false, message: 'Unknown action' };
      }
    } catch (err: any) { return { success: false, message: err.message }; }
  }
};
