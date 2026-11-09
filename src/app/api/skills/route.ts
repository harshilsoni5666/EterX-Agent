import { NextRequest, NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getEterxAppRoot, getEterxAssetPath, getEterxWorkspaceDir } from '../../../lib/agent/storage-paths';
import { rejectCrossOrigin } from '../agent/_shared';

const roots = () => {
  const sourceRoot = path.join(getEterxAppRoot(), 'src', 'lib', 'agent', 'skills-new');
  const bundledRoot = existsSync(sourceRoot) ? sourceRoot : getEterxAssetPath('skills');
  return [getEterxWorkspaceDir('skills'), bundledRoot]
    .filter((root, index, all) => all.indexOf(root) === index);
};

type SkillSummary = { id: string; name: string; description: string; path: string; editable: boolean };

async function walk(dir: string, root: string, result: SkillSummary[]) {
  let entries: Array<import('node:fs').Dirent<string>>;
  try { entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, root, result);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') {
      try {
        const content = await fs.readFile(full, 'utf8');
        const name = content.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() || '';
        const description = content.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() || '';
        if (!name || !description) continue;
        result.push({
          id: `${roots().indexOf(root)}:${path.relative(root, full).replace(/\\/g, '/')}`,
          name,
          description,
          path: full,
          editable: path.resolve(root) === path.resolve(getEterxWorkspaceDir('skills')),
        });
      } catch { /* ignore unreadable files */ }
    }
  }
}

export async function GET() {
  const result: SkillSummary[] = [];
  for (const root of roots()) await walk(root, root, result);
  return NextResponse.json({ skills: result.map(({ path: _path, ...skill }) => skill) });
}

export async function POST(request: NextRequest) {
  const originError = rejectCrossOrigin(request);
  if (originError) return originError;
  const body = await request.json().catch(() => null);
  if (typeof body?.createName === 'string') {
    const safe = body.createName.trim();
    if (!safe || !/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*$/.test(safe)) return NextResponse.json({ error: 'Invalid skill name' }, { status: 400 });
    const fileName = `${safe.replace(/\s+/g, '-').toLowerCase()}.md`;
    const root = roots()[0];
    await fs.mkdir(root, { recursive: true });
    const title = safe.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (letter: string) => letter.toUpperCase());
    const initialContent = [
      '---',
      'name: ' + safe,
      'description: Custom local skill. Add a precise trigger and purpose.',
      'category: core',
      'icon: BookOpen',
      '---',
      '',
      '# ' + title,
      '',
      'Describe the skill workflow, evidence to inspect, and verification checks.',
      '',
    ].join('\n');
    try { await fs.writeFile(path.join(root, fileName), initialContent, { encoding: 'utf8', flag: 'wx' }); }
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
    const hasFrontmatter = /^---\r?\n[\s\S]*^name:\s*.+$[\s\S]*^description:\s*.+$[\s\S]*^---\r?\n/m.test(content);
    if (!name.toLowerCase().endsWith('.md') || !/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*\.md$/.test(name) || !content.trim() || !hasFrontmatter) {
      rejected.push({ name: name || 'unnamed file', reason: 'Structure unmatched: choose a non-empty .md skill file.' });
      continue;
    }
    const destination = path.join(root, name);
    try { await fs.writeFile(destination, content, { encoding: 'utf8', flag: 'wx' }); imported.push(name); }
    catch { rejected.push({ name, reason: 'A skill with this filename already exists.' }); }
  }
  return NextResponse.json({ ok: rejected.length === 0, imported, rejected }, { status: imported.length ? 200 : 422 });
}
