import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const roots = () => [path.join(process.cwd(), 'src', 'lib', 'agent', 'skills'), path.join(process.cwd(), '.agents', 'skills'), path.join(os.homedir(), '.codex', 'skills'), path.join(os.homedir(), '.claude', 'skills'), path.join(os.homedir(), '.agents', 'skills')];
function resolveId(raw: string) {
  const decoded = decodeURIComponent(raw);
  const split = decoded.indexOf(':');
  const rootIndex = Number(decoded.slice(0, split));
  const relative = decoded.slice(split + 1);
  const root = roots()[rootIndex];
  if (!root || !relative || path.isAbsolute(relative)) return null;
  const file = path.resolve(root, relative);
  return file.startsWith(path.resolve(root) + path.sep) && file.toLowerCase().endsWith('.md') ? file : null;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const file = resolveId((await context.params).id);
  if (!file) return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
  try { return NextResponse.json({ content: await fs.readFile(file, 'utf8'), path: file }); } catch { return NextResponse.json({ error: 'Skill not found' }, { status: 404 }); }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const file = resolveId((await context.params).id);
  if (!file) return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body.content !== 'string') return NextResponse.json({ error: 'Invalid content' }, { status: 400 });
  try { await fs.writeFile(file, body.content, 'utf8'); return NextResponse.json({ ok: true }); } catch { return NextResponse.json({ error: 'Unable to save skill' }, { status: 500 }); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const file = resolveId((await context.params).id);
  if (!file) return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
  const body = await request.json().catch(() => null);
  const nextName = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!nextName || !/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*$/.test(nextName)) return NextResponse.json({ error: 'Invalid skill name' }, { status: 400 });
  const destination = path.join(path.dirname(file), `${nextName.replace(/\s+/g, '-').toLowerCase()}.md`);
  try { await fs.rename(file, destination); return NextResponse.json({ ok: true, path: destination }); } catch { return NextResponse.json({ error: 'Unable to rename skill' }, { status: 500 }); }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const file = resolveId((await context.params).id);
  if (!file) return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
  try { await fs.unlink(file); return NextResponse.json({ ok: true }); } catch { return NextResponse.json({ error: 'Unable to delete skill' }, { status: 500 }); }
}
