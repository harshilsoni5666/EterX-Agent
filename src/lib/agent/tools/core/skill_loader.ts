import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { SKILL_CATALOG, SKILL_REGISTRY } from '../../skills';

// Build the list of available skill IDs dynamically from the registry
const availableSkillIds = SKILL_CATALOG.map(skill => skill.id);

export const skillLoaderTool: ToolDefinition = {
  name: 'get_skill_guidelines',
  description: `Load one exact skill from the startup-cached skill registry immediately before specialized work. The system prompt already contains the full catalog, so do not search the skill folder first and do not call this tool again for a skill already loaded in the current task. Available skills: ${ availableSkillIds.join(', ') }.`,
  category: 'core',
  inputSchema: z.object({
    skill_name: z.string().describe(`The ID of the skill to load. Available: ${ availableSkillIds.join(', ') }`)
  }),
  outputSchema: z.object({
    guidelines: z.string()
  }),
  execute: async (input: { skill_name: string }) => {
    const skillId = String(input.skill_name || '').trim().toLowerCase().replace(/-/g, '_');
    console.log(`[Tool: get_skill_guidelines] Reading cached guidelines for: ${ skillId }`);
    const skill = SKILL_REGISTRY[skillId];
    if (skill) {
      return { guidelines: skill.systemPromptAddendum };
    }
    return { guidelines: 'Skill not found in the cached registry. Use an exact catalog ID: ' + availableSkillIds.join(', ') };
  }
};
