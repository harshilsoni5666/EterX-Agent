import { open, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { resolveReadableWorkspacePathForContext } from '../../workspace/path_resolver';

export const workspaceInspectionSchema = z.object({
  action: z.enum(['list', 'read', 'find']),
  path: z.string().min(1).describe('Directory for list, text file for read or find. Relative paths use the selected workspace.'),
  query: z.string().min(1).optional().describe('Literal, case-insensitive text for find.'),
  start: z.number().int().positive().optional().describe('First line or directory entry to consider, starting at 1.'),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum entries, lines, or matches to return.'),
});

export type WorkspaceInspection = z.infer<typeof workspaceInspectionSchema>;

export async function inspectWorkspace(input: WorkspaceInspection, context: any) {
  const target = resolveReadableWorkspacePathForContext(input.path, context);
  const start = input.start ?? 1;
  const limit = input.limit ?? 80;
  const rows: string[] = [];
  let nextStart: number | undefined;
  if (input.action === 'list') {
    const entries = await readdir(target, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries.slice(start - 1, start - 1 + limit)) {
      rows.push(entry.name + (entry.isDirectory() ? '/' : ''));
    }
    if (start - 1 + limit < entries.length) nextStart = start + limit;
  } else {
    const query = input.query?.toLowerCase();
    if (input.action === 'find' && !query) throw new Error('Supply the literal text to find in query.');
    const info = await stat(target);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Select a regular text file up to 16 MiB.');
    const file = await open(target, 'r');
    try {
      const sample = Buffer.alloc(4096);
      const { bytesRead } = await file.read(sample, 0, sample.length, 0);
      if (sample.subarray(0, bytesRead).includes(0)) throw new Error('Select a text file for inspection.');
      const stream = file.createReadStream({ start: 0, encoding: 'utf8', autoClose: false });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let lineNo = 0;
      let length = 0;
      try {
        for await (const line of lines) {
          if (context?.abortSignal?.aborted || context?.isCancelled?.()) throw new Error('CANCELLED_BY_USER');
          lineNo++;
          if (lineNo < start || (input.action === 'find' && !line.toLowerCase().includes(query!))) continue;
          const row = `${lineNo}  ${line.length > 4000 ? line.slice(0, 4000) + '…' : line}`;
          if (rows.length >= limit || length + row.length > 24_000) { nextStart = lineNo; break; }
          rows.push(row);
          length += row.length + 1;
        }
      } finally {
        lines.close();
        stream.destroy();
      }
    } finally {
      await file.close();
    }
  }
  return { success: true, mode: 'inspect', path: target, stdout: rows.join('\n'), stderr: '', exitCode: 0, ...(nextStart ? { nextStart } : {}) };
}
