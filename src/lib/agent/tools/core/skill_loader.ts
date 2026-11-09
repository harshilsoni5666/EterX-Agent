import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { SKILL_CATALOG, SKILL_REGISTRY, refreshSkillRegistry } from '../../skills-new';
import { matchesImportWorkspace } from '../../../imports/context';

export const skillLoaderTool: ToolDefinition = {
  name: 'get_skill_guidelines',
  description: 'Optionally load one exact specialized playbook only when the current user request clearly matches its catalog description. Do not call at task startup, for ordinary coding or questions, speculatively, or in a batch with other skills. Load immediately before the specialized action and at most once per skill per task. Use an exact ID from the current SKILL PATHWAYS catalog, including enabled imported skills.',
  category: 'core',
  inputSchema: z.object({
    skill_name: z.string().describe('The exact skill ID from the current workspace’s SKILL PATHWAYS catalog.')
  }),
  outputSchema: z.object({
    guidelines: z.string()
  }),
  execute: async (input: { skill_name: string }, context: any) => {
    refreshSkillRegistry();
    const skillId = String(input.skill_name || '').trim().toLowerCase().replace(/-/g, '_');
    console.log(`[Tool: get_skill_guidelines] Reading cached guidelines for: ${ skillId }`);
    const skill = SKILL_REGISTRY[skillId];
    if (skill && !matchesImportWorkspace(String(skill.metadata?.workspace || '') || undefined, context?.workspacePath || context?.workspaceRoot)) {
      return { guidelines: 'This imported skill belongs to another workspace. Select its project before loading it.' };
    }
    if (skill) {
      return { guidelines: skill.systemPromptAddendum };
    }
    return { guidelines: 'Skill is unavailable or disabled. Use an exact catalog ID: ' + SKILL_CATALOG.filter(item => matchesImportWorkspace(String(SKILL_REGISTRY[item.id]?.metadata?.workspace || '') || undefined, context?.workspacePath || context?.workspaceRoot)).map(item => item.id).join(', ') };
  }
};
