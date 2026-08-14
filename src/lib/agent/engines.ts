import path from 'path';
import fs from 'fs-extra';
import { getEterxWorkspaceDir } from './storage-paths';

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
  private profiles = new Map<string, WorkspaceProfile>();

  /** Analyze the current workspace and build a profile */
  async analyze(targetCwd = process.cwd()): Promise<WorkspaceProfile> {
    const cwd = path.resolve(targetCwd);
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

      this.profiles.set(cwd, profile);
      if (cwd === path.resolve(process.cwd())) this.profile = profile;

      console.log(`[WorkspaceIntel] ✅ Profile: ${profile.framework} | ${profile.language} | ${profile.packageManager}`);
      console.log(`[WorkspaceIntel]    Dirs: ${profile.mainDirs.join(', ')}`);
      console.log(`[WorkspaceIntel]    Features: TS=${profile.hasTypeScript} Docker=${profile.hasDocker} CI=${profile.hasCI} Tests=${profile.hasTests}`);

      // Persist for quick access
      if (cwd === path.resolve(process.cwd())) {
        const workspaceDir = getEterxWorkspaceDir();
        await writeJsonAtomic(resolveUnder(workspaceDir, 'workspace_profile.json'), profile);
      }

      return profile;
    } catch (error: any) {
      console.warn(`[WorkspaceIntel] Analysis failed: ${error.message}`);
      return profile;
    }
  }

  /** Get cached profile or analyze */
  async getProfile(targetCwd = process.cwd()): Promise<WorkspaceProfile> {
    const cwd = path.resolve(targetCwd);
    if (cwd === path.resolve(process.cwd()) && this.profile) return this.profile;
    const cachedProfile = this.profiles.get(cwd);
    if (cachedProfile) return cachedProfile;
    if (cwd !== path.resolve(process.cwd())) return this.analyze(cwd);

    // Try loading from cache
    const cachePath = getEterxWorkspaceDir('workspace_profile.json');
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

    return this.analyze(cwd);
  }

  /** Generate a concise workspace context string for system prompt injection */
  async getWorkspaceContext(targetCwd?: string): Promise<string> {
    const p = await this.getProfile(targetCwd || process.cwd());
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
export class AgentReflectionEngine {
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
      improvementActions.push({ tool: 'workspace_edit_file', reason: 'Replace placeholders with real implementation' });
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
      const fileTools = toolsUsed.filter(t => t === 'workspace_edit_file');
      if (fileTools.length === 0 && !outputLower.includes('file') && !outputLower.includes('created')) {
        suggestions.push('Coding task but no files created');
        improvementActions.push({ tool: 'workspace_edit_file', reason: 'Need to create actual code files' });
      }
    }

    // 8. Research task but no search tools used
    const isResearchTask = /\\b(research|find|search|look up|compare|analyze|report|summary)\\b/i.test(goalLower);
    if (isResearchTask) {
      const searchTools = toolsUsed.filter(t => t.startsWith('web_search'));
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
    const wroteUICode = toolsUsed.some(t => t === 'workspace_edit_file') && 
                        (outputLower.includes('.html') || outputLower.includes('.css') || outputLower.includes('.tsx') || outputLower.includes('.jsx'));
    const didVisualVerify = toolsUsed.some(t => t === 'browser_control' || t === 'screenshot_capture');
    if (isUITask && wroteUICode && !didVisualVerify) {
      suggestions.push('UI code written but never visually verified — consider browser preview');
      improvementActions.push({ tool: 'browser_control', reason: 'Visual verification of UI output' });
    }

    // 12. Terminal commands with reported errors
    const shellCalls = toolsUsed.filter(t => t === 'workspace_run_command').length;
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
export const workspaceIntelligence = new WorkspaceIntelligence();
export const agentReflection = new AgentReflectionEngine();

