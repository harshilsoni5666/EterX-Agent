import { loadMarkdownSkills } from './md_loader';
import { AgentSkill } from './types';

export * from './types';

const loadedSkills = loadMarkdownSkills();

export const SKILL_REGISTRY: Record<string, AgentSkill> = Object.fromEntries(
  loadedSkills.map(skill => [skill.id, skill]),
);

export const SKILL_CATALOG = Object.freeze(
  loadedSkills
    .map(skill => ({
      id: skill.id,
      name: skill.name,
      description: String(skill.description || '').replace(/\s+/g, ' ').trim(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id)),
);

export const SKILL_PATHWAYS_PROMPT = [
  'SKILL PATHWAYS',
  'The isolated local skill catalog is already loaded; do not search the skill folder to discover a skill.',
  'Decide from the actual deliverable whether a specialist materially applies.',
  'Load one applicable skill immediately before specialized work and reuse it for the current task.',
  'If no specialist materially applies, continue with the normal agent workflow.',
  '',
  'Available skill pathways:',
  ...SKILL_CATALOG.map(skill => `- ${skill.id}: ${skill.description || skill.name}`),
].join('\n');

console.log(`[Skills] Loaded ${loadedSkills.length} isolated local skills`);
