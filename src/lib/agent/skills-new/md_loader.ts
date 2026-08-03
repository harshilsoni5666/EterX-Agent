import * as fs from 'fs';
import * as path from 'path';
import { AgentSkill } from './types';
import { getEterxAppRoot, getEterxAssetPath, getEterxWorkspaceDir } from '../storage-paths';

interface ParsedSkill {
  name: string;
  description: string;
  category?: string;
  icon?: string;
  body: string;
  metadata: Record<string, unknown>;
}

function parseValue(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function parseFrontmatter(content: string): ParsedSkill | null {
  const normalized = content.replace(/^\uFEFF/, '');
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;

  const metadata: Record<string, unknown> = {};
  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    const item = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!item) continue;
    metadata[item[1]] = parseValue(item[2]);
  }

  const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
  const description = typeof metadata.description === 'string' ? metadata.description.trim() : '';
  if (!name || !description) return null;

  return {
    name,
    description,
    category: typeof metadata.category === 'string' ? metadata.category : undefined,
    icon: typeof metadata.icon === 'string' ? metadata.icon : undefined,
    body: match[2].trim(),
    metadata,
  };
}

function idFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function displayName(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function skillRoots(): string[] {
  const appRoot = getEterxAppRoot();
  return [
    path.resolve(appRoot, 'src', 'lib', 'agent', 'skills-new'),
    getEterxAssetPath('skills'),
    path.resolve(appRoot, 'desktop-runtime', 'assets', 'skills'),
    getEterxWorkspaceDir('skills'),
    __dirname,
  ].filter((root, index, roots) => roots.indexOf(root) === index);
}

function loadFromRoot(skillsDir: string): AgentSkill[] {
  if (!fs.existsSync(skillsDir)) return [];

  const skills: AgentSkill[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.toLowerCase() === 'readme.md') {
      continue;
    }

    const sourceFile = path.join(skillsDir, entry.name);
    const parsed = parseFrontmatter(fs.readFileSync(sourceFile, 'utf8'));
    if (!parsed) continue;

    skills.push({
      id: idFromName(parsed.name),
      name: displayName(parsed.name),
      icon: parsed.icon || 'BookOpen',
      description: parsed.description,
      category: parsed.category,
      sourceFile,
      metadata: parsed.metadata,
      systemPromptAddendum: parsed.body,
    });
  }

  return skills;
}

export function loadMarkdownSkills(): AgentSkill[] {
  const bundledRoot = skillRoots().find(root => loadFromRoot(root).length > 0);
  if (!bundledRoot) return [];

  const bundledSkills = loadFromRoot(bundledRoot);
  const customSkills = loadFromRoot(getEterxWorkspaceDir('skills'));
  const merged = new Map(bundledSkills.map(skill => [skill.id, skill]));
  for (const skill of customSkills) merged.set(skill.id, skill);
  return Array.from(merged.values());
}
