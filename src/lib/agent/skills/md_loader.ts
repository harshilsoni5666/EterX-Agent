import * as fs from 'fs';
import * as path from 'path';
import { AgentSkill } from './types';
import { getEterxAssetPath } from '../storage-paths';

interface ParsedFrontmatter {
  name: string;
  id?: string;
  icon?: string;
  category?: string;
  description: string;
  metadata: Record<string, unknown>;
  body: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// EterX Skill Loader — Unified Markdown Skill System
// ─────────────────────────────────────────────────────────────────────────────
//
// All agent skills are defined as .md files with YAML frontmatter in this
// directory. The loader reads each file, extracts the `name` and `description`
// from the frontmatter, and builds an AgentSkill object.
//
// ┌─────────────────────────────────────────────────────────────────────┐
// │                     COMPLETE SKILL CATALOG                         │
// ├───────────────────────────┬──────────────────┬──────────────────────┤
// │ File                      │ Skill ID         │ Role                 │
// ├───────────────────────────┼──────────────────┼──────────────────────┤
// │ general.md                │ general          │ Core Orchestrator    │
// │ data_analyst.md           │ data_analyst     │ Data & BI Analysis   │
// │ devops.md                 │ devops           │ Infrastructure/CI/CD │
// │ security_auditor.md       │ security_auditor │ Security Auditing    │
// │ pdf_skill.md              │ pdf              │ PDF Generation       │
// │ docx_skill.md             │ docx             │ Word Documents       │
// │ pptx_skill.md             │ pptx             │ Presentations        │
// │ xlsx_skill.md             │ xlsx             │ Spreadsheets         │
// │ file_reading.md           │ file_reading     │ File Reading Router  │
// │ hover_effects.md          │ hover_effects    │ CSS Hover Effects    │
// │ motion_animations.md      │ motion_animations│ Motion & Animation   │
// │ glassmorphism_neumorphism.md │ glassmorphism_neumorphism │ Glass/Soft UI │
// │ dark_mode_theming.md      │ dark_mode_theming│ Dark Mode & Themes   │
// │ micro_interactions.md     │ micro_interactions│ Micro-Interactions  │
// │ typography_system.md      │ typography_system│ Typography System    │
// │ color_systems.md          │ color_systems    │ Color Systems        │
// │ 3d_effects.md             │ 3d_effects       │ 3D CSS Effects       │
// │ component_architecture.md │ component_architecture │ Component Design│
// │ responsive_layout.md      │ responsive_layout│ Responsive Layout    │
// │ algorithmic_art.md        │ algorithmic_art  │ Generative Art       │
// │ skill_creator.md          │ skill_creator    │ Skill File Creator   │
// │ doc_coauthoring.md        │ doc_coauthoring  │ Doc Co-Authoring     │
// │ mcp_builder.md            │ mcp_builder      │ MCP Server Builder   │
// │ web_artifacts_builder.md  │ web_artifacts_builder │ Web Artifacts    │
// │ theme_factory.md          │ theme_factory    │ Theme Factory        │
// └───────────────────────────┴──────────────────┴──────────────────────┘
//
// HOW IT WORKS:
// 1. Reads all .md files from this directory
// 2. Parses YAML frontmatter for `name` and `description`
// 3. Converts `name` (e.g. "hover-effects") to snake_case id (e.g. "hover_effects")
// 4. Creates display name from name (e.g. "Hover Effects")
// 5. Maps icons from SKILL_ICONS lookup
// 6. Returns array of AgentSkill objects
//
// TO ADD A NEW SKILL:
// 1. Create a new .md file in this directory
// 2. Add YAML frontmatter with `name:` and `description:`
// 3. Add the skill name to SKILL_ICONS below
// 4. The loader will auto-discover it — no code changes needed in index.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses YAML frontmatter from a markdown skill file.
 * Expects the format:
 * ```
 * ---
 * name: skill-name
 * description: Short description of what the skill does
 * ---
 * # Markdown body content...
 * ```
 *
 * Supports both single-line and multi-line (YAML `>` block scalar) descriptions.
 *
 * @returns Parsed { name, description, body } or null if frontmatter is missing/invalid
 */
function parseYamlLikeFrontmatter(frontmatter: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const lines = frontmatter.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!match) continue;

    const key = match[1];
    let value = (match[2] || '').trim();

    const blockStyle = value.match(/^([>|])[-+]?$/)?.[1];
    if (blockStyle) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(?:\s+|\t)/.test(lines[i + 1])) {
        i++;
        block.push(lines[i].trim());
      }
      data[key] = block.filter(Boolean).join(blockStyle === '>' ? ' ' : '\n');
      continue;
    }

    if (!value && i + 1 < lines.length && /^(?:\s{2,}|\t)/.test(lines[i + 1])) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(?:\s{2,}|\t)/.test(lines[i + 1])) {
        i++;
        block.push(lines[i].trim());
      }
      data[key] = block;
      continue;
    }

    data[key] = value.replace(/^["']|["']$/g, '');
  }

  return data;
}

function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const normalizedContent = content.replace(/^\uFEFF/, '');
  const match = normalizedContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2];
  const metadata = parseYamlLikeFrontmatter(frontmatter);

  // Extract name (required)
  const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';

  // Extract description — supports both inline and multi-line YAML block scalar (>)
  let description = '';
  const descBlockMatch = frontmatter.match(/^description:\s*>\s*\r?\n([\s\S]*?)(?=\r?\n\w|\r?\n---)/m);
  if (descBlockMatch) {
    description = descBlockMatch[1]
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .join(' ');
  } else {
    const descLineMatch = frontmatter.match(/^description:\s*["']?(.*?)["']?\s*$/m);
    description = descLineMatch ? descLineMatch[1].trim() : '';
  }

  // Some imported skills accidentally contain a stub frontmatter block before
  // the real one. Prefer the real second block instead of falling back to a
  // filename-derived id/description.
  if (!name && body.trimStart().startsWith('---')) {
    return parseFrontmatter(body.trimStart());
  }

  if (!name) return null;
  return {
    name,
    id: typeof metadata.id === 'string' ? metadata.id.trim() : undefined,
    icon: typeof metadata.icon === 'string' ? metadata.icon.trim() : undefined,
    category: typeof metadata.category === 'string' ? metadata.category.trim() : undefined,
    description: typeof metadata.description === 'string' && metadata.description.trim()
      ? metadata.description.trim()
      : description,
    metadata,
    body
  };
}

function loadSharedSkillContract(skillsDir: string): string {
  const sharedDir = path.join(skillsDir, '_shared');
  try {
    if (!fs.existsSync(sharedDir)) return '';

    return fs.readdirSync(sharedDir)
      .filter(file => file.endsWith('.md'))
      .sort()
      .map(file => fs.readFileSync(path.join(sharedDir, file), 'utf-8').trim())
      .filter(Boolean)
      .map(contract => `${contract}\n\n---\n\n`)
      .join('');
  } catch {
    return '';
  }
}

/**
 * Icon registry — maps each skill `name` (from frontmatter) to a Lucide icon identifier.
 * Used by the UI to render the correct icon next to each skill in selection menus.
 *
 * When adding a new skill, add its icon mapping here.
 * Fallback icon: 'BookOpen'
 */
const SKILL_ICONS: Record<string, string> = {
  // ── Core Agent Skills ──────────────────────────────────────────────
  'general': 'Brain',         // Central orchestrator
  'data-analyst': 'BarChart3',      // Data analysis & BI
  'devops': 'Server',         // Infrastructure & CI/CD
  'security-auditor': 'Shield',         // Security auditing

  // ── Document Generation Skills ─────────────────────────────────────
  'pdf': 'FileText',       // PDF creation & processing
  'docx': 'FileText',       // Word document creation
  'pptx': 'MonitorPlay',    // PowerPoint presentations
  'xlsx': 'FileSpreadsheet',// Excel spreadsheets
  'file-reading': 'FolderOpen',     // File reading router

  // ── UI/Design Skills ───────────────────────────────────────────────
  'hover-effects': 'MousePointer',   // CSS hover & cursor effects
  'motion-animations': 'Sparkles',       // Motion & animation systems
  'glassmorphism-neumorphism': 'Layers',         // Glassmorphism & neumorphism
  'dark-mode-theming': 'Moon',           // Dark mode & theming
  'micro-interactions': 'Zap',            // Micro-interactions & feedback
  'typography-system': 'Type',           // Typography & font systems
  'color-systems': 'Paintbrush',     // Color palettes & systems
  '3d-effects': 'Box',            // 3D CSS transforms & effects
  'component-architecture': 'LayoutGrid',     // Component design patterns
  'responsive-layout': 'Smartphone',     // Responsive layout systems

  // ── Utility / Builder Skills ───────────────────────────────────────
  'algorithmic-art': 'Palette',        // Generative & algorithmic art
  'image-generation': 'Image',          // Raster image generation and editing
  'skill-creator': 'Wrench',         // Creates new skill files
  'doc-coauthoring': 'Users',          // Document co-authoring workflow
  'mcp-builder': 'Server',         // MCP server scaffolding
  'web-artifacts-builder': 'Globe',          // Web artifact generation
  'theme-factory': 'Paintbrush',     // Theme creation factory
  // ── Masterclass Intelligence Skills ───────────────────────────────────────
  'self-healing-code': 'ShieldAlert',    // Autonomous debugging
  'system-architecture': 'Network',        // Scalable architecture
  'performance-optimization': 'Zap',            // O(1) ops and memory
  'advanced-prompting': 'MessageSquare',  // Prompt eng and delegation
  'a11y-audit': 'Accessibility',
  'agent-designer': 'Bot',
  'agenthub': 'GitBranch',
  'api-design-reviewer': 'Route',
  'batch-operations': 'Layers',
  'browser-automation': 'MousePointerClick',
  'code-review': 'Eye',
  'code-tour': 'Map',
  'code-verify': 'CheckCircle',
  'codebase-onboarding': 'Compass',
  'database-designer': 'Database',
  'debug': 'Bug',
  'design-md': 'FileCode',
  'docker-development': 'Container',
  'enhance-prompt': 'Sparkles',
  'epic-design': 'Wand2',
  'extreme-power': 'Rocket',
  'focused-fix': 'Crosshair',
  'get-unstuck': 'LifeBuoy',
  'git-commit': 'GitCommit',
  'iterative-loop': 'Repeat',
  'karpathy-coder': 'Code2',
  'performance-profiler': 'Gauge',
  'rag-architect': 'Network',
  'react:components': 'Component',
  'remember': 'Brain',
  'remotion': 'Video',
  'runbook-generator': 'BookOpenCheck',
  'security-pen-testing': 'ShieldAlert',
  'self-eval': 'Scale',
  'senior-architect': 'Landmark',
  'senior-backend': 'ServerCog',
  'senior-frontend': 'MonitorSmartphone',
  'senior-qa': 'ClipboardCheck',
  'shadcn-ui': 'Component',
  'simplify-code': 'Scissors',
  'skillify': 'Wand2',
  'slack': 'MessageSquare',
  'spec-driven-workflow': 'ListChecks',
  'stitch-design': 'Paintbrush',
  'stitch-loop': 'RefreshCw',
  'taste-design': 'Palette',
  'tech-debt-tracker': 'Archive',
  'tech-stack-evaluator': 'Blocks',
};

function skillIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function displayNameFromName(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function localResourceWarnings(skillsDir: string, file: string, body: string): string[] {
  const warnings = new Set<string>();
  const fileDir = path.dirname(path.join(skillsDir, file));
  const refs = body.match(/\b(?:scripts|references|workflows|assets|resources)\/[A-Za-z0-9_.#/-]+/g) || [];

  for (const ref of refs) {
    const cleanRef = ref.split('#')[0].replace(/[).,;:]+$/g, '');
    if (!cleanRef || cleanRef.endsWith('/')) continue;
    if (!fs.existsSync(path.join(fileDir, cleanRef))) warnings.add(cleanRef);
  }

  return Array.from(warnings).sort();
}

function operatingNoticeForSkill(id: string): string {
  const notices: Record<string, string> = {
    advanced_prompting: [
      'Do not instruct another model, agent, script, or user to defeat security controls, anti-abuse systems, paywalls, CAPTCHAs, MFA, or access controls.',
      'Do not reference unavailable delegation tools unless the current runtime actually exposes them.',
      'Prompts generated by this skill must preserve the user request, system/developer policy, available-tool limits, and safe execution boundaries.'
    ].join(' '),
    browser_automation: [
      'Browser automation must respect site terms, robots guidance, rate limits, account boundaries, and user privacy.',
      'Do not implement stealth, identity masking, access-control avoidance, or other anti-abuse circumvention.',
      'For logged-in, sensitive, purchase, booking, upload, deletion, sharing, or account-change flows, stop for user confirmation at the final action boundary.'
    ].join(' '),
    security_pen_testing: [
      'Only perform testing on systems the user owns or has explicit authorization to assess.',
      'Default to code review, dependency analysis, configuration review, and safe local reproduction.',
      'Do not attack third-party services, scan public targets, attempt persistence, exfiltrate data, circumvent authentication, or provide weaponized exploitation steps.'
    ].join(' '),
    devops: [
      'Infrastructure actions must be scoped to the user-requested environment.',
      'Before destructive, production, credential, deployment, DNS, billing, or access-control changes, require explicit confirmation and provide rollback steps.'
    ].join(' '),
    docker_development: [
      'Do not run or recommend privileged containers, host mounts, host networking, or broad capability grants unless the user explicitly asks and the risk is explained.',
      'Prefer least-privilege images, pinned dependencies, non-root users, and reproducible builds.'
    ].join(' '),
    git_commit: [
      'Never commit, amend, tag, reset, rebase, push, or change branches unless the user explicitly asks for that exact git action.',
      'When git commands are unavailable or disallowed, provide the intended commit plan instead.'
    ].join(' '),
    security_auditor: [
      'Treat secret findings as sensitive. Do not print full secrets, tokens, private keys, cookies, or credentials in chat or logs.',
      'Redact values and recommend rotation when exposure is confirmed.'
    ].join(' ')
  };

  const notice = notices[id];
  return notice ? `\n\n## EterX Runtime Safety Boundary\n\n${notice}\n` : '';
}

/**
 * Loads ALL .md skill files from the skills directory and converts them
 * into AgentSkill objects for the registry.
 *
 * Each .md file must have valid YAML frontmatter with at minimum a `name` field.
 * Files without valid frontmatter are skipped with a warning.
 *
 * The skill `id` is derived from the frontmatter `name` by replacing hyphens
 * with underscores (e.g. "hover-effects" → "hover_effects").
 *
 * The `systemPromptAddendum` is set to the full markdown body after the
 * frontmatter delimiter, giving the agent access to the complete skill
 * instructions during inference.
 *
 * @returns Array of AgentSkill objects, one per valid .md file
 */
export function loadMarkdownSkills(): AgentSkill[] {
  const bundledSkillsDir = getEterxAssetPath('skills');
  const skillsDir = fs.existsSync(bundledSkillsDir)
    ? bundledSkillsDir
    : path.join(process.cwd(), 'src', 'lib', 'agent', 'skills');
  const skills: AgentSkill[] = [];
  const seenSkillIds = new Map<string, { index: number; file: string }>();
  const sharedSkillContract = loadSharedSkillContract(skillsDir);

  const isCanonicalSkillFile = (file: string, id: string): boolean => {
    const normalizedFile = file.replace(/\\/g, '/').toLowerCase();
    const base = path.basename(normalizedFile, '.md');
    const dashedId = id.replace(/_/g, '-');
    return (
      base === id ||
      base === dashedId ||
      base === `${id}_skill` ||
      base === `${dashedId}-skill` ||
      normalizedFile === `${dashedId}/skill.md` ||
      normalizedFile === `${id}/skill.md`
    );
  };

  try {
    const files = fs.readdirSync(skillsDir, { withFileTypes: true })
      .flatMap((entry) => {
        if (entry.isFile() && entry.name.endsWith('.md') && !/^SKILL\s*\(\d+\)\.md$/i.test(entry.name)) {
          return [entry.name];
        }
        if (entry.isDirectory()) {
          const skillFile = path.join(entry.name, 'SKILL.md');
          return fs.existsSync(path.join(skillsDir, skillFile)) ? [skillFile] : [];
        }
        return [];
      })
      .sort(); // Alphabetical for consistent load order


    for (const file of files) {
      try {
        const filePath = path.join(skillsDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        let parsed = parseFrontmatter(content);

        if (!parsed) {
          const basename = path.basename(file, '.md');
          const fallbackName = basename
            .replace(/^SKILL\s*\(\d+\)$/i, 'skill')
            .replace(/[_\s]+/g, '-')
            .replace(/[^a-zA-Z0-9:-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase();
          if (fallbackName && fallbackName !== 'skill') {
            const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
            parsed = {
              name: fallbackName,
              id: undefined,
              icon: undefined,
              category: undefined,
              description: heading || `Guidelines for ${fallbackName}`,
              metadata: {},
              body: content
            };
          }
        }

        if (!parsed) {
          console.warn(`[SkillLoader] ⚠️  Skipped ${ file } — no valid YAML frontmatter`);
          continue;
        }

        // Convert skill names to stable snake_case ids for registry lookup.
        const declaredId = parsed.id ? skillIdFromName(parsed.id) : '';
        const nameId = skillIdFromName(parsed.name);
        const id = declaredId && isCanonicalSkillFile(file, declaredId) ? declaredId : nameId;
        const existing = seenSkillIds.get(id);
        if (existing) {
          const incomingCanonical = isCanonicalSkillFile(file, id);
          const existingCanonical = isCanonicalSkillFile(existing.file, id);
          if (!incomingCanonical || existingCanonical) {
            console.warn(`[SkillLoader] Skipped duplicate skill id "${id}" from ${file}`);
            continue;
          }
          console.warn(`[SkillLoader] Replaced duplicate skill id "${id}" from ${existing.file} with canonical ${file}`);
          skills.splice(existing.index, 1);
          for (const value of seenSkillIds.values()) {
            if (value.index > existing.index) value.index--;
          }
        }
        seenSkillIds.set(id, { index: skills.length, file });

        // Build human-readable display name from kebab-case
        // e.g. "hover-effects" → "Hover Effects"
        const displayName = displayNameFromName(parsed.name);

        const icon = parsed.icon || SKILL_ICONS[parsed.name] || SKILL_ICONS[id.replace(/_/g, '-')] || 'BookOpen';
        const operatingNotice = operatingNoticeForSkill(id);
        const missingResources = localResourceWarnings(skillsDir, file, parsed.body);
        const resourceNotice = missingResources.length
          ? `\n\n## Local Resource Availability\n\nThis skill references local bundled resources that are not present in this repository: ${missingResources.map(ref => `\`${ref}\``).join(', ')}. Do not claim to have used these files or scripts unless they are added or otherwise available at runtime. Use built-in tools or inspect the workspace directly instead.\n`
          : '';

        skills.push({
          id,
          name: displayName,
          icon,
          description: parsed.description,
          systemPromptAddendum: `${sharedSkillContract}${parsed.body}${operatingNotice}${resourceNotice}`,
          category: parsed.category,
          sourceFile: file,
          metadata: parsed.metadata,
        });

      } catch (err) {
        console.warn(`[SkillLoader] ⚠️  Failed to load ${ file }:`, err);
      }
    }
  } catch (err) {
    console.error('[SkillLoader] ❌ Could not read skills directory:', err);
  }

  console.log(`[SkillLoader] ✅ ${ skills.length } skills loaded`);
  return skills;
}
