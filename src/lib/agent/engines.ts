import { z } from 'zod';
import { ToolDefinition } from './schemas';
import { globalToolRegistry, normalizeRegistryToolName } from './tools/registry';
import { normalizeRegistryToolArgs, validateRegistryToolArgs } from './tools/tool-args';
import { enforceToolCapability } from './tools/security/tool_policy';
import { createToolExecutionContext, isToolCancellationError } from './cancellation';
import path from 'path';
import fs from 'fs-extra';

/**
 * Dynamic Skill Generator — Runtime Tool Factory
 * 
 * NEXT-GEN CONCEPT: The agent can CREATE new tools at runtime.
 * When it encounters a repetitive pattern or needs a specialized capability,
 * it generates a new tool definition, registers it, and can use it immediately.
 * 
 * Generated tools are:
 * - Persisted to .workspaces/dynamic_tools/ so they survive restarts
 * - Auto-loaded on startup
 * - Full first-class tools — appear in the tool registry
 * - Can be composed from existing tools (macro-tools)
 * 
 * EXAMPLES:
 * - Agent notices it keeps formatting dates → creates a "date_formatter" tool
 * - Agent builds a project → creates a "deploy_project" macro-tool
 * - Agent does repetitive API calls → creates a "fetch_stock_price" tool
 */

const DYNAMIC_TOOLS_DIR = path.resolve(process.cwd(), '.workspaces', 'dynamic_tools');
const MAX_DYNAMIC_TOOL_CODE_LENGTH = 10_000;

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveUnder(parent: string, ...segments: string[]): string {
  const resolved = path.resolve(parent, ...segments);
  if (!isPathInside(parent, resolved)) {
    throw new Error(`Resolved path escapes expected directory: ${resolved}`);
  }
  return resolved;
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeJson(tmpPath, data, { spaces: 2 });
  await fs.move(tmpPath, filePath, { overwrite: true });
}

function safeToolName(name: unknown): string | null {
  const value = String(name || '').trim();
  return /^[a-z][a-z0-9_]{2,63}$/.test(value) ? value : null;
}

function safeFieldName(name: unknown): string | null {
  const value = String(name || '').trim();
  return /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(value) ? value : null;
}

function dynamicToolExecutionEnabled(): boolean {
  return process.env.ETERX_ENABLE_DYNAMIC_TOOL_EXECUTION === '1';
}

function validateDynamicExecutionCode(code: string): string | null {
  if (code.length > MAX_DYNAMIC_TOOL_CODE_LENGTH) {
    return `Execution code exceeds ${MAX_DYNAMIC_TOOL_CODE_LENGTH} characters.`;
  }

  const blockedPatterns = [
    /\b(?:require|process|child_process|fs|net|http|https|eval|Function|constructor|globalThis|window|document|Buffer)\b/i,
    /\bimport\s*\(/i,
    /\b(?:rm\s+-rf|format\s+c:|del\s+\/f)\b/i,
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(code)) {
      return 'Execution code contains blocked runtime APIs or shell patterns.';
    }
  }

  return null;
}

interface DynamicToolSpec {
  name: string;
  description: string;
  category: string;
  inputFields: Array<{ name: string, type: string, description: string, required: boolean }>;
  executionCode: string;  // JavaScript code string that gets eval'd
  composedFrom?: string[];  // If this is a macro — which tools it chains
  createdAt: number;
  createdBy: string;  // Which agent created it
}

class DynamicSkillEngine {
  private dynamicTools: Map<string, DynamicToolSpec> = new Map();
  private initialized = false;

  private normalizeSpec(raw: any, fallbackName?: string): DynamicToolSpec | null {
    if (!raw || typeof raw !== 'object') return null;

    const name = safeToolName(raw.name) || safeToolName(fallbackName);
    if (!name) return null;

    const inputFields = Array.isArray(raw.inputFields)
      ? raw.inputFields.slice(0, 50).flatMap((field: any) => {
          const fieldName = safeFieldName(field?.name);
          if (!fieldName) return [];
          const fieldType = ['string', 'number', 'boolean', 'array'].includes(field?.type) ? field.type : 'string';
          return [{
            name: fieldName,
            type: fieldType,
            description: String(field?.description || '').slice(0, 500),
            required: Boolean(field?.required),
          }];
        })
      : [];

    return {
      name,
      description: String(raw.description || 'Dynamic tool').slice(0, 1000),
      category: String(raw.category || 'dynamic').slice(0, 100),
      inputFields,
      executionCode: String(raw.executionCode || ''),
      composedFrom: Array.isArray(raw.composedFrom)
        ? raw.composedFrom.map((tool: any) => String(tool)).filter(Boolean).slice(0, 20)
        : undefined,
      createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
      createdBy: String(raw.createdBy || 'unknown').slice(0, 100),
    };
  }

  private buildToolDefinition(spec: DynamicToolSpec): ToolDefinition {
    const schemaFields: Record<string, any> = {};
    for (const field of spec.inputFields) {
      let zodType: any;
      switch (field.type) {
        case 'number': zodType = z.number(); break;
        case 'boolean': zodType = z.boolean(); break;
        case 'array': zodType = z.array(z.any()); break;
        default: zodType = z.string();
      }
      if (field.description) zodType = zodType.describe(field.description);
      schemaFields[field.name] = field.required ? zodType : zodType.optional();
    }

    return {
      name: spec.name,
      description: `[DYNAMIC] ${spec.description}`,
      category: 'core' as const,
      inputSchema: z.object(schemaFields),
      outputSchema: z.object({ result: z.any(), success: z.boolean() }),
      execute: async (input: any) => {
        console.log(`[DynamicTool: ${spec.name}] Executing...`);
        if (!dynamicToolExecutionEnabled()) {
          return {
            result: null,
            success: false,
            error: 'Dynamic tool execution is disabled. Set ETERX_ENABLE_DYNAMIC_TOOL_EXECUTION=1 only for trusted local tools.',
          };
        }

        const blockedReason = validateDynamicExecutionCode(spec.executionCode);
        if (blockedReason) {
          return { result: null, success: false, error: blockedReason };
        }

        try {
          const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
          const fn = new AsyncFunction('input', `"use strict";\n${spec.executionCode}`);
          const safeInput = input && typeof input === 'object' ? Object.freeze({ ...input }) : input;
          const result = await fn(safeInput);
          return { result, success: true };
        } catch (error: any) {
          return { result: null, success: false, error: error.message };
        }
      }
    };
  }

  /** Load all dynamic tools from disk and register them */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await fs.ensureDir(DYNAMIC_TOOLS_DIR);
      const files = await fs.readdir(DYNAMIC_TOOLS_DIR);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const filePath = resolveUnder(DYNAMIC_TOOLS_DIR, file);
          const raw = await fs.readJson(filePath);
          const spec = this.normalizeSpec(raw, path.basename(file, '.json'));
          if (!spec) {
            console.warn(`[DynamicSkills] Skipping invalid dynamic tool file ${file}`);
            continue;
          }
          this.registerDynamicTool(spec);
          if (dynamicToolExecutionEnabled() && !globalToolRegistry.getTool(spec.name)) {
            globalToolRegistry.registerTools([this.buildToolDefinition(spec)]);
          }
        } catch (e) {
          console.warn(`[DynamicSkills] Could not load ${file}`);
        }
      }

      if (this.dynamicTools.size > 0) {
        console.log(`[DynamicSkills] Loaded ${this.dynamicTools.size} dynamic tools from disk`);
      }
      this.initialized = true;
    } catch {
      this.initialized = true;
      // Silent — dynamic tools are optional
    }
  }

  /** Create and register a new dynamic tool */
  async createTool(spec: DynamicToolSpec): Promise<{ success: boolean, message: string }> {
    const normalized = this.normalizeSpec(spec);
    if (!normalized) {
      return { success: false, message: 'Invalid dynamic tool spec. Use a snake_case name and valid input field names.' };
    }
    spec = normalized;

    if (!dynamicToolExecutionEnabled()) {
      return {
        success: false,
        message: 'Dynamic tool creation is disabled for safety. Enable ETERX_ENABLE_DYNAMIC_TOOL_EXECUTION=1 only for trusted local tools.',
      };
    }

    // Validate name doesn't conflict with existing tools
    if (globalToolRegistry.getTool(spec.name)) {
      return { success: false, message: `Tool "${spec.name}" already exists in the registry. Choose a different name.` };
    }

    const blockedReason = validateDynamicExecutionCode(spec.executionCode);
    if (blockedReason) {
      return { success: false, message: blockedReason };
    }

    const toolDef = this.buildToolDefinition(spec);

    // Register in the global registry
    this.registerDynamicTool(spec);
    globalToolRegistry.registerTools([toolDef]);

    // Persist to disk
    await this.saveTool(spec);

    console.log(`[DynamicSkills] ✅ Created tool: ${spec.name}`);
    return { success: true, message: `Tool "${spec.name}" created and registered. It's now available for use.` };
  }

  /** Register a spec in memory */
  private registerDynamicTool(spec: DynamicToolSpec) {
    this.dynamicTools.set(spec.name, spec);
  }

  /** Save tool spec to disk */
  private async saveTool(spec: DynamicToolSpec) {
    const toolName = safeToolName(spec.name);
    if (!toolName) throw new Error(`Invalid dynamic tool name: ${spec.name}`);
    await writeJsonAtomic(resolveUnder(DYNAMIC_TOOLS_DIR, `${toolName}.json`), spec);
  }

  /** List all dynamic tools */
  listTools(): DynamicToolSpec[] {
    return Array.from(this.dynamicTools.values());
  }

  /** Delete a dynamic tool */
  async deleteTool(name: string): Promise<boolean> {
    const toolName = safeToolName(name);
    if (!toolName) return false;

    this.dynamicTools.delete(toolName);
    globalToolRegistry.replaceAllTools(
      globalToolRegistry.getAllTools().filter(tool => tool.name !== toolName)
    );

    const filePath = resolveUnder(DYNAMIC_TOOLS_DIR, `${toolName}.json`);
    if (await fs.pathExists(filePath)) {
      await fs.remove(filePath);
      return true;
    }
    return false;
  }
}

/**
 * Tool Composition Engine — Macro Tool Builder
 * 
 * NEXT-GEN CONCEPT: Chain multiple existing tools into a single
 * "macro-tool" that executes them in sequence, passing outputs as inputs.
 * 
 * EXAMPLE MACROS:
 * - "research_and_write": web_search → workspace_write_file
 * - "build_and_verify": workspace_write_file → workspace_verify_code
 * - "scrape_and_analyze": web_scraper → csv_analyzer
 */
interface MacroStep {
  tool: string;
  inputMapping: Record<string, string>;  // Maps macro input fields to tool input fields
  outputKey: string;  // Key to store this step's output under
}

interface MacroDefinition {
  name: string;
  description: string;
  steps: MacroStep[];
  inputFields: Array<{ name: string, type: string, description: string }>;
}

class ToolCompositionEngine {
  private macros: Map<string, MacroDefinition> = new Map();

  /** Execute a macro — run steps in sequence, piping outputs */
  async executeMacro(macro: MacroDefinition, input: any, runtimeContext: any = {}): Promise<any> {
    console.log(`[MacroEngine] Executing macro: ${macro.name} (${macro.steps.length} steps)`);

    const context: Record<string, any> = { ...input };

    for (let i = 0; i < macro.steps.length; i++) {
      const step = macro.steps[i];
      const stepToolName = normalizeRegistryToolName(step.tool);
      const tool = globalToolRegistry.getTool(stepToolName);

      if (!tool) {
        return { error: `Step ${i + 1}: Tool "${stepToolName}" not found`, step: i + 1 };
      }

      // Build input from mapping
      const stepInput: Record<string, any> = {};
      for (const [macroField, toolField] of Object.entries(step.inputMapping)) {
        stepInput[toolField] = context[macroField];
      }

      console.log(`[MacroEngine] Step ${i + 1}/${macro.steps.length}: ${stepToolName}`);

      try {
        const normalizedArgs = normalizeRegistryToolArgs(stepToolName, stepInput);
        const validation = validateRegistryToolArgs(tool, normalizedArgs);
        if (!validation.success) {
          return { error: `Step ${i + 1} (${stepToolName}) invalid args: ${validation.error}`, step: i + 1, context };
        }
        const capabilityDecision = enforceToolCapability(stepToolName, validation.args, runtimeContext);
        if (!capabilityDecision.allowed) {
          return { error: `Step ${i + 1} (${stepToolName}) blocked: ${capabilityDecision.reason || 'capability denied'}`, step: i + 1, context };
        }
        const toolExec = createToolExecutionContext(runtimeContext);
        let result: any;
        try {
          toolExec.throwIfCancelled();
          result = await tool.execute(validation.args, toolExec.context);
          toolExec.throwIfCancelled();
        } finally {
          toolExec.dispose();
        }
        context[step.outputKey] = result;
      } catch (error: any) {
        if (isToolCancellationError(error)) {
          return { error: 'CANCELLED_BY_USER', cancelled: true, step: i + 1, context };
        }
        return { error: `Step ${i + 1} (${stepToolName}) failed: ${error.message}`, step: i + 1, context };
      }
    }

    return { success: true, results: context };
  }

  /** Register a macro */
  registerMacro(macro: MacroDefinition) {
    this.macros.set(macro.name, macro);
  }

  /** Get a macro by name */
  getMacro(name: string): MacroDefinition | undefined {
    return this.macros.get(name);
  }

  /** List all macros */
  listMacros(): MacroDefinition[] {
    return Array.from(this.macros.values());
  }
}

/**
 * Workspace Intelligence Engine — Deep Project Understanding
 * 
 * NEXT-GEN CONCEPT: Automatically analyzes the project workspace to understand:
 * - Framework (Next.js, React, Express, Python, etc.)
 * - Language distribution
 * - Directory structure
 * - Dependencies
 * - Config files
 * - Build system
 * 
 * This context is injected into the agent's system prompt for smarter decisions.
 */
interface WorkspaceProfile {
  framework: string;
  language: string;
  packageManager: string;
  buildSystem: string;
  hasTypeScript: boolean;
  hasTests: boolean;
  hasDocker: boolean;
  hasCI: boolean;
  hasGit: boolean;
  mainDirs: string[];
  configFiles: string[];
  dependencies: string[];
  totalFiles: number;
  analyzedAt: number;
}

class WorkspaceIntelligence {
  private profile: WorkspaceProfile | null = null;

  /** Analyze the current workspace and build a profile */
  async analyze(): Promise<WorkspaceProfile> {
    const cwd = process.cwd();
    console.log(`[WorkspaceIntel] Analyzing workspace: ${cwd}`);

    const profile: WorkspaceProfile = {
      framework: 'unknown',
      language: 'unknown',
      packageManager: 'unknown',
      buildSystem: 'unknown',
      hasTypeScript: false,
      hasTests: false,
      hasDocker: false,
      hasCI: false,
      hasGit: false,
      mainDirs: [],
      configFiles: [],
      dependencies: [],
      totalFiles: 0,
      analyzedAt: Date.now()
    };

    try {
      // Check for key files
      const checks = {
        'package.json': 'npm/node',
        'tsconfig.json': 'typescript',
        'next.config.js': 'next.js',
        'next.config.mjs': 'next.js',
        'next.config.ts': 'next.js',
        'vite.config.ts': 'vite',
        'vite.config.js': 'vite',
        'angular.json': 'angular',
        'vue.config.js': 'vue',
        'requirements.txt': 'python',
        'Pipfile': 'python',
        'pyproject.toml': 'python',
        'Cargo.toml': 'rust',
        'go.mod': 'go',
        'pom.xml': 'java/maven',
        'build.gradle': 'java/gradle',
        'Dockerfile': 'docker',
        'docker-compose.yml': 'docker',
        '.github': 'github-ci',
        '.gitlab-ci.yml': 'gitlab-ci',
        '.git': 'git',
        'jest.config.js': 'jest-tests',
        'jest.config.ts': 'jest-tests',
        'vitest.config.ts': 'vitest-tests',
      };

      for (const [file, tech] of Object.entries(checks)) {
        const fullPath = path.join(cwd, file);
        if (await fs.pathExists(fullPath)) {
          profile.configFiles.push(file);

          if (tech === 'next.js') profile.framework = 'Next.js';
          else if (tech === 'vite') profile.framework = 'Vite';
          else if (tech === 'angular') profile.framework = 'Angular';
          else if (tech === 'vue') profile.framework = 'Vue';
          else if (tech === 'typescript') profile.hasTypeScript = true;
          else if (tech === 'docker') profile.hasDocker = true;
          else if (tech.includes('ci')) profile.hasCI = true;
          else if (tech === 'git') profile.hasGit = true;
          else if (tech.includes('tests')) profile.hasTests = true;

          if (tech === 'npm/node') {
            profile.language = 'JavaScript/TypeScript';
            profile.packageManager = 'npm';
          } else if (tech === 'python') {
            profile.language = 'Python';
          } else if (tech === 'rust') {
            profile.language = 'Rust';
          } else if (tech === 'go') {
            profile.language = 'Go';
          } else if (tech.startsWith('java')) {
            profile.language = 'Java';
          }
        }
      }

      // Read package.json for dependencies
      const pkgPath = path.join(cwd, 'package.json');
      if (await fs.pathExists(pkgPath)) {
        try {
          const pkg = await fs.readJson(pkgPath);
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          profile.dependencies = Object.keys(deps).slice(0, 30);  // Top 30

          // Detect framework from deps
          if (deps['next']) profile.framework = `Next.js ${deps['next']}`;
          if (deps['react']) profile.language = 'React/TypeScript';
          if (deps['electron']) profile.framework += ' + Electron';
          if (deps['express']) profile.framework += ' + Express';

          // Detect build system
          if (pkg.scripts?.build) {
            if (pkg.scripts.build.includes('next')) profile.buildSystem = 'Next.js';
            else if (pkg.scripts.build.includes('vite')) profile.buildSystem = 'Vite';
            else if (pkg.scripts.build.includes('webpack')) profile.buildSystem = 'Webpack';
            else if (pkg.scripts.build.includes('tsc')) profile.buildSystem = 'TypeScript Compiler';
            else profile.buildSystem = pkg.scripts.build.substring(0, 50);
          }

          // Detect package manager
          if (await fs.pathExists(path.join(cwd, 'yarn.lock'))) profile.packageManager = 'yarn';
          else if (await fs.pathExists(path.join(cwd, 'pnpm-lock.yaml'))) profile.packageManager = 'pnpm';
          else if (await fs.pathExists(path.join(cwd, 'bun.lockb'))) profile.packageManager = 'bun';
        } catch { }
      }

      // Scan top-level directories
      try {
        const entries = await fs.readdir(cwd, { withFileTypes: true });
        profile.mainDirs = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
          .map(e => e.name)
          .slice(0, 15);

        profile.totalFiles = entries.length;
      } catch { }

      this.profile = profile;

      console.log(`[WorkspaceIntel] ✅ Profile: ${profile.framework} | ${profile.language} | ${profile.packageManager}`);
      console.log(`[WorkspaceIntel]    Dirs: ${profile.mainDirs.join(', ')}`);
      console.log(`[WorkspaceIntel]    Features: TS=${profile.hasTypeScript} Docker=${profile.hasDocker} CI=${profile.hasCI} Tests=${profile.hasTests}`);

      // Persist for quick access
      const workspaceDir = path.join(cwd, '.workspaces');
      await writeJsonAtomic(resolveUnder(workspaceDir, 'workspace_profile.json'), profile);

      return profile;
    } catch (error: any) {
      console.warn(`[WorkspaceIntel] Analysis failed: ${error.message}`);
      return profile;
    }
  }

  /** Get cached profile or analyze */
  async getProfile(): Promise<WorkspaceProfile> {
    if (this.profile) return this.profile;

    // Try loading from cache
    const cachePath = path.join(process.cwd(), '.workspaces', 'workspace_profile.json');
    if (await fs.pathExists(cachePath)) {
      try {
        const cached = await fs.readJson(cachePath);
        // Cache valid for 1 hour
        if (Date.now() - cached.analyzedAt < 3600000) {
          this.profile = cached;
          return cached;
        }
      } catch { }
    }

    return this.analyze();
  }

  /** Generate a concise workspace context string for system prompt injection */
  async getWorkspaceContext(): Promise<string> {
    const p = await this.getProfile();
    const parts = [
      `Project: ${p.framework} (${p.language})`,
      `Build: ${p.buildSystem} | PM: ${p.packageManager}`,
      `Features: ${[
        p.hasTypeScript && 'TypeScript',
        p.hasDocker && 'Docker',
        p.hasCI && 'CI/CD',
        p.hasTests && 'Tests',
        p.hasGit && 'Git'
      ].filter(Boolean).join(', ')}`,
      `Structure: ${p.mainDirs.join(', ')}`,
      p.dependencies.length > 0 && `Key deps: ${p.dependencies.slice(0, 10).join(', ')}`
    ].filter(Boolean);

    return `━━━ WORKSPACE INTELLIGENCE ━━━\n${parts.join('\n')}`;
  }
}

/**
 * Agent Reflection Loop — Self-Evaluation Engine v2
 * 
 * Before delivering a final answer, the agent reflects on its output quality.
 * 15 heuristic checks covering: length, placeholders, give-ups, formatting,
 * code blocks, completeness, file creation, research effort, tool usage, 
 * repetition, visual verification, error handling, security, and structure.
 * 
 * v2 UPGRADES:
 * - Visual verification awareness (detects if UI code was written but never previewed)
 * - Improvement action suggestions (specific tool calls to improve output)
 * - Reflection history for pattern detection across sessions
 */
class AgentReflectionEngine {
  private reflectionCount = 0;
  private maxReflections = 3; // Increased from 2
  private reflectionHistory: Array<{ quality: string; issues: string[]; timestamp: number }> = [];

  async reflect(
    userGoal: string,
    agentOutput: string,
    toolsUsed: string[]
  ): Promise<{ 
    quality: 'high' | 'medium' | 'low'; 
    suggestions: string[]; 
    shouldImprove: boolean;
    improvementActions: Array<{ tool: string; reason: string }>;
  }> {
    this.reflectionCount++;
    if (this.reflectionCount > this.maxReflections) {
      return { quality: 'medium', suggestions: [], shouldImprove: false, improvementActions: [] };
    }

    const suggestions: string[] = [];
    const improvementActions: Array<{ tool: string; reason: string }> = [];
    const goalLower = userGoal.toLowerCase();
    const outputLower = agentOutput.toLowerCase();
    const taskWords = userGoal.split(/\\s+/).length;
    const outputWords = agentOutput.split(/\\s+/).length;

    // === CORE QUALITY CHECKS ===
    
    // 1. Output too short for complex task
    if (taskWords > 15 && outputWords < 50) {
      suggestions.push('Output too short for task complexity');
      improvementActions.push({ tool: 'continue_generation', reason: 'Need more content for this task' });
    }
    
    // 2. Contains placeholder/TODO markers
    if (agentOutput.includes('TODO') || agentOutput.includes('placeholder') || agentOutput.includes('FIXME')) {
      suggestions.push('Contains TODO/placeholder/FIXME — incomplete work');
      improvementActions.push({ tool: 'workspace_str_replace', reason: 'Replace placeholders with real implementation' });
    }
    
    // 3. Claims inability instead of trying
    if (/\\b(I cannot|I can't|unable to|not possible|beyond my|I'm sorry but)\\b/i.test(agentOutput)) {
      suggestions.push('Claims inability — should attempt with tools');
    }
    
    // 4. Bad markdown formatting
    if (agentOutput.includes('##') && !agentOutput.includes('\\n##')) {
      suggestions.push('Markdown headings not on own lines');
    }
    
    // 5. Unclosed code blocks
    const codeBlocks = (agentOutput.match(/```/g) || []).length;
    if (codeBlocks % 2 !== 0) {
      suggestions.push('Unclosed code block');
    }
    
    // 6. Output appears cut off
    const lastChar = agentOutput.trim().slice(-1);
    if (lastChar && !/[.!?)\\]"'\`]/.test(lastChar) && outputWords > 20) {
      suggestions.push('Output appears cut off mid-sentence');
    }

    // === TASK-SPECIFIC CHECKS ===
    
    // 7. Coding task but no files created
    const isCodingTask = /\\b(build|create|write|make|implement|code|develop|app|website|script|function|component)\\b/i.test(goalLower);
    if (isCodingTask) {
      const fileTools = toolsUsed.filter(t =>
        t.startsWith('workspace_write_file') ||
        t.startsWith('workspace_str_replace') ||
        t.startsWith('workspace_apply_patch') ||
        t.startsWith('workspace_edit_file') ||
        t.startsWith('workspace_edit_many_files')
      );
      if (fileTools.length === 0 && !outputLower.includes('file') && !outputLower.includes('created')) {
        suggestions.push('Coding task but no files created');
        improvementActions.push({ tool: 'workspace_write_file', reason: 'Need to create actual code files' });
      }
    }

    // 8. Research task but no search tools used
    const isResearchTask = /\\b(research|find|search|look up|compare|analyze|report|summary)\\b/i.test(goalLower);
    if (isResearchTask) {
      const searchTools = toolsUsed.filter(t => t.startsWith('web_search') || t.startsWith('web_scraper') || t.startsWith('deep_research'));
      if (searchTools.length === 0 && outputWords < 100) {
        suggestions.push('Research task but no search tools used');
        improvementActions.push({ tool: 'web_search', reason: 'Need external research for factual accuracy' });
      }
    }

    // 9. Complex task with zero tool usage
    if (taskWords > 20 && toolsUsed.length === 0) {
      suggestions.push('Complex task with zero tool usage');
    }

    // 10. Repetitive content
    const sentences = agentOutput.split(/[.!?]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 20);
    const uniqueSentences = new Set(sentences);
    if (sentences.length > 5 && uniqueSentences.size < sentences.length * 0.7) {
      suggestions.push('Repetitive content detected');
    }

    // === ADVANCED CHECKS (v2) ===
    
    // 11. UI code written but never visually verified
    const isUITask = /\\b(ui|frontend|html|css|design|layout|dashboard|landing|page|component|react|vue|svelte)\\b/i.test(goalLower);
    const wroteUICode = toolsUsed.some(t => t === 'workspace_write_file') && 
                        (outputLower.includes('.html') || outputLower.includes('.css') || outputLower.includes('.tsx') || outputLower.includes('.jsx'));
    const didVisualVerify = toolsUsed.some(t => t === 'browser_control' || t === 'screenshot_capture');
    if (isUITask && wroteUICode && !didVisualVerify) {
      suggestions.push('UI code written but never visually verified — consider browser preview');
      improvementActions.push({ tool: 'browser_control', reason: 'Visual verification of UI output' });
    }

    // 12. File created but never verified
    const wroteFiles = toolsUsed.filter(t => t === 'workspace_write_file').length;
    const verifiedFiles = toolsUsed.filter(t => t === 'realtime_verify' || t === 'workspace_verify_code').length;
    if (wroteFiles > 0 && verifiedFiles === 0) {
      suggestions.push('Files created but never verified — quality risk');
      improvementActions.push({ tool: 'realtime_verify', reason: 'Verify created files exist and are valid' });
    }

    // 13. Shell commands without error checking
    const shellCalls = toolsUsed.filter(t => t === 'system_shell').length;
    if (shellCalls > 2 && outputLower.includes('error')) {
      suggestions.push('Multiple shell commands with potential errors — verify outcomes');
    }

    // 14. Document task but no structured output
    const isDocTask = /\\b(document|report|paper|essay|article|write.*about)\\b/i.test(goalLower);
    if (isDocTask && outputWords > 200 && !agentOutput.includes('##') && !agentOutput.includes('**')) {
      suggestions.push('Document task with unstructured output — needs headings and formatting');
    }

    // 15. Multi-step task but only partially completed
    const hasNumbers = /\\b(steps?|parts?|phases?|sections?)\\s*(\\d+|one|two|three|four|five)/i.test(goalLower);
    if (hasNumbers && toolsUsed.length < 3) {
      suggestions.push('Multi-step task may be only partially completed');
    }

    const quality = suggestions.length === 0 ? 'high' : suggestions.length <= 2 ? 'medium' : 'low';
    const shouldImprove = quality === 'low' && this.reflectionCount < this.maxReflections;
    
    // Save reflection history for pattern analysis
    this.reflectionHistory.push({ quality, issues: [...suggestions], timestamp: Date.now() });
    
    if (suggestions.length > 0) {
      console.log(`[Reflection] Quality: ${quality} | Issues: ${suggestions.join('; ')}${improvementActions.length > 0 ? ` | Actions: ${improvementActions.map(a => a.tool).join(', ')}` : ''}`);
    }
    
    return { quality, suggestions, shouldImprove, improvementActions };
  }

  /** Get historical reflection patterns */
  getReflectionPatterns(): { avgQuality: string; commonIssues: string[]; totalReflections: number } {
    const qualities = this.reflectionHistory.map(r => r.quality);
    const highCount = qualities.filter(q => q === 'high').length;
    const total = qualities.length || 1;
    const avgQuality = highCount / total > 0.7 ? 'high' : highCount / total > 0.4 ? 'medium' : 'low';
    
    const issueCounts: Record<string, number> = {};
    this.reflectionHistory.forEach(r => {
      r.issues.forEach(issue => {
        issueCounts[issue] = (issueCounts[issue] || 0) + 1;
      });
    });
    
    const commonIssues = Object.entries(issueCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([issue]) => issue);

    return { avgQuality, commonIssues, totalReflections: this.reflectionHistory.length };
  }

  reset() { this.reflectionCount = 0; }
}

// ── Exports ──
export const dynamicSkillEngine = new DynamicSkillEngine();
export const toolCompositionEngine = new ToolCompositionEngine();
export const workspaceIntelligence = new WorkspaceIntelligence();
export const agentReflection = new AgentReflectionEngine();

