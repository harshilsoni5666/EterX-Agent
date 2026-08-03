import type { AgentSkill } from './types';
import { loadMarkdownSkills } from './md_loader';

export * from './types';
export * from './base';

const markdownSkills = loadMarkdownSkills();
const fallbackSkills: AgentSkill[] = [
  {
    id: 'general',
    name: 'General',
    icon: 'Brain',
    description: 'General-purpose agent execution guidance.',
    systemPromptAddendum: 'Work carefully, verify important changes, and report concrete results.',
  },
];

export const SKILL_REGISTRY: Record<string, AgentSkill> = Object.fromEntries(
  (markdownSkills.length ? markdownSkills : fallbackSkills).map(skill => [skill.id, skill]),
);

export const SKILL_CATALOG = Object.freeze(
  Object.values(SKILL_REGISTRY)
    .map(skill => ({ id: skill.id, name: skill.name, description: String(skill.description || '').replace(/\s+/g, ' ').trim() }))
    .sort((left, right) => left.id.localeCompare(right.id)),
);

export const SKILL_PATHWAYS_PROMPT = [
  'SKILL PATHWAYS',
  'The skill catalog is loaded at startup. Do not search the skill folder to discover skills.',
  'When specialist instructions materially apply, call get_skill_guidelines with the exact catalog ID immediately before that work.',
  'Load an applicable skill once and keep using it for the current task.',
  '',
  'Available skill pathways:',
  ...SKILL_CATALOG.map(skill => `- ${skill.id}: ${skill.description || skill.name}`),
].join('\n');

console.log(`[Skills] Loaded ${Object.keys(SKILL_REGISTRY).length} skills.`);
