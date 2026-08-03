import fs from 'node:fs';
import path from 'node:path';
import type { AgentSkill } from './types';
import { getEterxAppRoot, getEterxAssetPath, getEterxWorkspaceDir } from '../storage-paths';

function skillRoots(): string[] {
  return [
    getEterxWorkspaceDir('skills'),
    getEterxAssetPath('skills'),
    path.resolve(getEterxAppRoot(), 'desktop-runtime', 'assets', 'skills'),
    path.resolve(getEterxAppRoot(), 'src', 'lib', 'agent', 'skills'),
  ].filter((root, index, roots) => roots.indexOf(root) === index);
}

function parseFrontmatter(content: string): { name: string; id?: string; icon?: string; description: string; metadata: Record<string, unknown>; body: string } | null {
  const normalized = content.replace(/^\uFEFF/, '');
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;

  const metadata: Record<string, unknown> = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!field) continue;
    const key = field[1];
    const value = field[2].trim();
    if (value === '>' || value === '|') {
      const block: string[] = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) block.push(lines[++index].trim());
      metadata[key] = block.join(value === '>' ? ' ' : '\n');
    } else {
      metadata[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }

  const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
  if (!name) return null;
  const description = typeof metadata.description === 'string' ? metadata.description.trim() : '';
  return {
    name,
    id: typeof metadata.id === 'string' ? metadata.id.trim() : undefined,
    icon: typeof metadata.icon === 'string' ? metadata.icon.trim() : undefined,
    description,
    metadata,
    body: match[2].trim(),
  };
}

function skillId(name: string, fallback: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '_').replace(/-/g, '_') || fallback;
}

function walkMarkdown(root: string, current = root, result: AgentSkill[] = []): AgentSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(root, fullPath, result);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    try {
      const parsed = parseFrontmatter(fs.readFileSync(fullPath, 'utf8'));
      if (!parsed) continue;
      const fallback = path.basename(entry.name, '.md');
      result.push({
        id: skillId(parsed.id || parsed.name, skillId(fallback, 'skill')),
        name: parsed.name,
        icon: parsed.icon || 'BookOpen',
        description: parsed.description,
        systemPromptAddendum: parsed.body,
        category: typeof parsed.metadata.category === 'string' ? parsed.metadata.category : undefined,
        sourceFile: fullPath,
        metadata: parsed.metadata,
      });
    } catch {
      // One malformed optional skill must not prevent the agent from starting.
    }
  }
  return result;
}

export function loadMarkdownSkills(): AgentSkill[] {
  for (const root of skillRoots()) {
    if (fs.existsSync(root)) return walkMarkdown(root);
  }
  return [];
}
