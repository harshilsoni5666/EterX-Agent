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

function compactSkillRoutingDescription(description: string, fallback: string): string {
  const normalized = String(description || fallback).replace(/\s+/g, ' ').trim();
  if (normalized.length <= 120) return normalized;
  const firstSentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || normalized;
  if (firstSentence.length <= 120) return firstSentence;
  return `${normalized.slice(0, 117).replace(/\s+\S*$/, '').trim()}...`;
}

export const SKILL_PATHWAYS_PROMPT = [
  'SKILL PATHWAYS',
  'The isolated local skill catalog is loaded. Load one applicable skill immediately before specialized work; otherwise use the normal workflow.',
  '',
  'Available skill pathways:',
  ...SKILL_CATALOG.map(skill => `- ${skill.id}: ${compactSkillRoutingDescription(skill.description, skill.name)}`),
].join('\n');

console.log(`[Skills] Loaded ${loadedSkills.length} isolated local skills`);
