import { AgentSkill } from './types';
import { general } from './general';
import { devops } from './devops';
import { data_analyst } from './data_analyst';
import { security_auditor } from './security_auditor';
import { loadMarkdownSkills } from './md_loader';

export * from './types';
export * from './base';

// ─────────────────────────────────────────────────────────────────────────────
// EterX Skill Registry
// ─────────────────────────────────────────────────────────────────────────────
//
// The registry merges two skill sources:
//
//   1. STATIC_SKILLS  — Legacy .ts-defined skills (general, devops,
//                       data_analyst, security_auditor). Kept as fallbacks.
//
//   2. MD_SKILLS      — All .md skill files loaded dynamically by md_loader.ts.
//                       These are the primary skill definitions.
//
// Merge order: .md skills OVERRIDE .ts skills with the same id.
// This means if both general.ts AND general.md exist, the .md version wins.
//
// FULL SKILL LIST (26 skills):
//
//   Core:       general, data-analyst, devops, security-auditor
//   Documents:  pdf, docx, pptx, xlsx, file-reading
//   UI/Design:  hover-effects, motion-animations, glassmorphism-neumorphism,
//               dark-mode-theming, micro-interactions, typography-system,
//               color-systems, 3d-effects, component-architecture,
//               responsive-layout
//   Utility:    algorithmic-art, skill-creator, doc-coauthoring,
//               mcp-builder, web-artifacts-builder, theme-factory
//
// TO ADD A NEW SKILL:
//   → Create a .md file in src/lib/agent/skills/ with YAML frontmatter
//   → Add its icon to SKILL_ICONS in md_loader.ts
//   → It will be auto-discovered — no changes needed here
// ─────────────────────────────────────────────────────────────────────────────

// Static TypeScript-defined skills (fallbacks — .md versions override these)
const STATIC_SKILLS: Record<string, AgentSkill> = {
  general,
  devops,
  data_analyst,
  security_auditor
};

// Dynamically load all .md skills from the skills directory
const mdSkills = loadMarkdownSkills();
const MD_SKILLS: Record<string, AgentSkill> = {};
for (const skill of mdSkills) {
  MD_SKILLS[skill.id] = skill;
}

// Merge: .md skills override any static skill with the same id
export const SKILL_REGISTRY: Record<string, AgentSkill> = {
  ...STATIC_SKILLS,
  ...MD_SKILLS,
};

// ── Registry Summary ─────────────────────────────────────────────────────────
const staticCount = Object.keys(STATIC_SKILLS).length;
const mdCount = mdSkills.length;
const totalCount = Object.keys(SKILL_REGISTRY).length;
const overrides = Object.keys(STATIC_SKILLS).filter(id => MD_SKILLS[id]);

console.log(`[Skills] ✅ ${ totalCount } skills (${ staticCount } static + ${ mdCount } markdown)`);
