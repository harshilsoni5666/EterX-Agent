import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const roots = () => [
  path.join(process.cwd(), 'src', 'lib', 'agent', 'skills'),
  path.join(process.cwd(), '.agents', 'skills'),
  path.join(os.homedir(), '.codex', 'skills'),
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.agents', 'skills'),
];

async function walk(dir: string, root: string, result: Array<{ id: string; name: string; description: string; path: string }>) {
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, root, result);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      try {
        const content = await fs.readFile(full, 'utf8');
        const name = content.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() || path.basename(entry.name, '.md').replace(/[-_]/g, ' ');
        const description = content.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() || '';
        result.push({ id: `${roots().indexOf(root)}:${path.relative(root, full).replace(/\\/g, '/')}`, name, description, path: full });
      } catch { /* ignore unreadable files */ }
    }
  }
}

export async function GET() {
  const result: Array<{ id: string; name: string; description: string; path: string }> = [];
  for (const root of roots()) await walk(root, root, result);
  return NextResponse.json({ skills: result.map(({ path: _path, ...skill }) => skill) });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (typeof body?.createName === 'string') {
    const safe = body.createName.trim();
    if (!safe || !/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*$/.test(safe)) return NextResponse.json({ error: 'Invalid skill name' }, { status: 400 });
    const fileName = `${safe.replace(/\s+/g, '-').toLowerCase()}.md`;
    const root = roots()[0];
    await fs.mkdir(root, { recursive: true });
    try { await fs.writeFile(path.join(root, fileName), '', { encoding: 'utf8', flag: 'wx' }); }
    catch { return NextResponse.json({ error: 'A skill with this name already exists.' }, { status: 409 }); }
    return NextResponse.json({ ok: true, id: `0:${fileName}`, name: safe });
  }
  const files = Array.isArray(body?.files) ? body.files : [];
  if (!files.length) return NextResponse.json({ error: 'No skill files supplied' }, { status: 400 });
  const root = roots()[0];
  await fs.mkdir(root, { recursive: true });
  const imported: string[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  for (const item of files) {
    const name = typeof item?.name === 'string' ? path.basename(item.name) : '';
    const content = typeof item?.content === 'string' ? item.content : '';
    if (!name.toLowerCase().endsWith('.md') || !/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*\.md$/.test(name) || !content.trim()) {
      rejected.push({ name: name || 'unnamed file', reason: 'Structure unmatched: choose a non-empty .md skill file.' });
      continue;
    }
    const destination = path.join(root, name);
    try { await fs.writeFile(destination, content, { encoding: 'utf8', flag: 'wx' }); imported.push(name); }
    catch { rejected.push({ name, reason: 'A skill with this filename already exists.' }); }
  }
  return NextResponse.json({ ok: rejected.length === 0, imported, rejected }, { status: imported.length ? 200 : 422 });
}
