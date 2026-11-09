import { loadMarkdownSkills } from './md_loader';
import { AgentSkill } from './types';
import { importRuntimeRevision, matchesImportWorkspace } from '../../imports/context';

export * from './types';

let loadedSkills = loadMarkdownSkills();
let lastRefresh = 0;
let lastImportRevision = '';

export const SKILL_REGISTRY: Record<string, AgentSkill> = Object.fromEntries(
  loadedSkills.map(skill => [skill.id, skill]),
);

export let SKILL_CATALOG = Object.freeze(
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

const buildPathwaysPrompt = (workspace?: string) => [
  'SKILL PATHWAYS',
  'Skills are optional, specialized operating playbooks—not a startup checklist.',
  'Do not load any skill at the beginning of a task merely because it might be useful. First understand the current request and use the normal workflow for answers, coding, inspection, debugging, and other ordinary work.',
  'Load one primary skill only when the current request clearly matches its catalog description, and load it immediately before the first action that needs its specialized procedure. Never load adjacent or speculative skills.',
  'A second skill is exceptional: use it only when the user explicitly requests a separate deliverable or workflow that independently matches that second skill. Never front-load multiple skills in one tool batch.',
  'Do not reload a skill during the same task. A later user request is a new routing decision and may legitimately load it again.',
  '',
  'Available skill pathways:',
  ...SKILL_CATALOG.filter(skill => matchesImportWorkspace(String(SKILL_REGISTRY[skill.id]?.metadata?.workspace || '') || undefined, workspace))
    .map(skill => `- ${skill.id}: ${compactSkillRoutingDescription(skill.description, skill.name)}`),
].join('\n');

export let SKILL_PATHWAYS_PROMPT = buildPathwaysPrompt();

/** Refresh at run/tool boundaries, including in separately bundled route workers. */
export function refreshSkillRegistry(force = false): void {
  const revision = importRuntimeRevision();
  if (!force && Date.now() - lastRefresh < 2000 && revision === lastImportRevision) return;
  lastImportRevision = revision;
  lastRefresh = Date.now();
  loadedSkills = loadMarkdownSkills();
  for (const key of Object.keys(SKILL_REGISTRY)) delete SKILL_REGISTRY[key];
  for (const skill of loadedSkills) SKILL_REGISTRY[skill.id] = skill;
  SKILL_CATALOG = Object.freeze(loadedSkills.map(skill => ({ id: skill.id, name: skill.name, description: String(skill.description || '').replace(/\s+/g, ' ').trim() })).sort((a, b) => a.id.localeCompare(b.id)));
  SKILL_PATHWAYS_PROMPT = buildPathwaysPrompt();
}

export function getSkillPathwaysPrompt(workspace?: string): string {
  refreshSkillRegistry();
  return buildPathwaysPrompt(workspace);
}

console.log(`[Skills] Loaded ${loadedSkills.length} isolated local skills`);
