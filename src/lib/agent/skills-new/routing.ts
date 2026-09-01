import { SKILL_REGISTRY } from './index';

export type SkillLoadDecision = {
  allowed: boolean;
  skillId: string;
  reason?: string;
};

export function normalizeSkillId(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

/**
 * Keep routing intentionally conservative. Skills are large operating
 * playbooks, not general hints, so a request must contain a concrete signal
 * for the specialized deliverable or workflow before one is loaded.
 */
export function getRelevantSkillIds(request: string): Set<string> {
  const text = String(request || '').toLowerCase();
  const relevant = new Set<string>();

  if (/\b(skill|skills)\b/.test(text) && /\b(?:create|add|write|edit|update|fix|repair|review|improve|consolidat(?:e|ion)?|deduplicat(?:e|ion)?|rout(?:e|ing)?|trigger|metadata|instruction)/.test(text)) {
    relevant.add('skill_creator');
  }
  if (/\b(reusable\s+template|template\s+(?:from|based on)|turn\s+.+\s+into\s+(?:a\s+)?template|personal\s+template)\b/.test(text)) {
    relevant.add('template_creator');
  }
  if (/\b(?:\.docx|docx|word document|word file|microsoft word)\b/.test(text) || /\b(?:create|make|write|edit|review|read|convert)\b[\s\S]{0,50}\bword\b/.test(text)) relevant.add('docx');
  if (/\b(?:\.pdf|pdf)\b/.test(text)) relevant.add('pdf');
  if (/\b(?:\.pptx|pptx|powerpoint|slide deck|presentation slides?)\b/.test(text) || /\b(?:create|make|build|edit|review|read|update)\b[\s\S]{0,50}\bpresentation\b/.test(text)) relevant.add('pptx');
  if (/\b(?:\.xlsx|\.xlsm|\.xls|\.csv|\.tsv|xlsx|xlsm|excel workbook|excel file|spreadsheet|csv|tsv)\b/.test(text)) relevant.add('xlsx');
  if (/\b(?:generate|create|make|design|produce)\b[\s\S]{0,80}\b(?:image|illustration|photo|texture|sprite|bitmap|transparent[- ]background asset)\b/.test(text)) {
    relevant.add('image_generation');
  }
  if (
    /\bvisuali[sz](?:e|ation)\b/.test(text)
    || /\b(?:create|make|show|draw|plot|build|design|render|need|want)\b[\s\S]{0,60}\b(?:chart|graph|map|diagram|simulator|interactive explanation|ui mockup)\b/.test(text)
    || /\b(?:interactive explanation|ui mockup)\b/.test(text)
  ) {
    relevant.add('visualization');
  }
  if (/\b(?:mcp|connector|oauth|api token|api endpoint|connect(?:ing)?\s+(?:to\s+)?(?:an?\s+)?external service|register\s+(?:an?\s+)?mcp server|gmail|notion|hubspot|salesforce|slack|google drive|dropbox|airtable|todoist|asana|trello)\b/.test(text)) {
    relevant.add('connector_setup_and_mcp_operations');
  }

  // A reusable-template workflow owns its reference file. Loading the DOCX,
  // PPTX, XLSX, or image playbook too is redundant unless the request also
  // asks for a separate artifact of that type.
  if (relevant.has('template_creator')) {
    for (const id of ['docx', 'pdf', 'pptx', 'xlsx', 'image_generation']) relevant.delete(id);
  }

  // Charts and diagrams inside a requested deck or workbook are handled by
  // that artifact skill. The generic visualization playbook is for a primary
  // visual/interactive deliverable.
  if (relevant.has('pptx') || relevant.has('xlsx')) relevant.delete('visualization');

  return relevant;
}

export function evaluateSkillLoad(
  request: string,
  requestedSkill: unknown,
  loadedThisTask: ReadonlySet<string>,
): SkillLoadDecision {
  const skillId = normalizeSkillId(requestedSkill);
  if (!SKILL_REGISTRY[skillId]) {
    return { allowed: false, skillId, reason: `Skill "${skillId}" is not in the cached skill catalog.` };
  }
  if (loadedThisTask.has(skillId)) {
    return { allowed: false, skillId, reason: `Skill "${skillId}" is already loaded for this task. Use its existing guidelines.` };
  }

  const relevant = getRelevantSkillIds(request);
  if (!relevant.has(skillId)) {
    const suffix = relevant.size > 0
      ? ` The request only indicates: ${Array.from(relevant).join(', ')}.`
      : ' This request does not require a specialized skill; continue with the normal workflow.';
    return { allowed: false, skillId, reason: `Skill "${skillId}" is not relevant to the current user request.${suffix}` };
  }

  return { allowed: true, skillId };
}
