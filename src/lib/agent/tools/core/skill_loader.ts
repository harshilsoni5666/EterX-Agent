import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { SKILL_REGISTRY } from '../../skills';

// Build the list of available skill IDs dynamically from the registry
const availableSkillIds = Object.keys(SKILL_REGISTRY);

export const skillLoaderTool: ToolDefinition = {
  name: 'get_skill_guidelines',
  description: `Load explicit skill guidelines before specialized work. Each markdown skill includes shared Codex-level operating contracts plus its domain workflow, so use this as a professional execution contract, not optional advice. Available skills: ${ availableSkillIds.join(', ') }. Use this for PDFs, DOCX, XLSX, PPTX, browser/computer use, image/visual assets, API/docs work, skill/plugin authoring, UI/web design, DevOps, data analysis, security audits, file reading, and all styling tasks (hover effects, animations, glassmorphism, dark mode, typography, color systems, 3D effects, responsive layout, micro-interactions, component architecture).`,
  category: 'core',
  inputSchema: z.object({
    skill_name: z.string().describe(`The ID of the skill to load. Available: ${ availableSkillIds.join(', ') }`)
  }),
  outputSchema: z.object({
    guidelines: z.string()
  }),
  execute: async (input: { skill_name: string }) => {
    console.log(`[Tool: get_skill_guidelines] Fetching constraints for: ${ input.skill_name }`);
    const skill = SKILL_REGISTRY[input.skill_name];
    if (skill) {
      return { guidelines: skill.systemPromptAddendum };
    }
    return { guidelines: 'Skill not found in registry. Available skills: ' + Object.keys(SKILL_REGISTRY).join(', ') };
  }
};
