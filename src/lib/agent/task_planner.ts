import { MODEL_REQUEST_TIMEOUT_MS } from './model-request-policy';
import { GoogleGenAI } from '@google/genai';
import { Anthropic, OpenAI } from './model-clients';
import { getMainAgentModelConfig, normalizeMainAgentMode, type MainAgentMode, type MainAgentProvider } from './model-routing';
import { getProviderBaseURL, isLocalModelProvider } from './provider-runtime';
import { getRuntimeApiKey, type RuntimeApiKeyProvider } from './runtime-api-keys';
import { globalToolRegistry, normalizeRegistryToolName } from './tools/registry';

/**
 * Task Planner - selected-model client for real execution-oriented task plans.
 *
 * Model output is treated as a draft. The normalizer validates tool names,
 * dependencies, and lifecycle coverage. If the configured model cannot produce
 * a valid plan, planning fails transparently; no canned plan is substituted.
 */

const MAX_ALLOWED_STEPS = 20;
const DEFAULT_MAX_STEPS = 8;

export type PlannerStepType =
  | 'inspect'
  | 'research'
  | 'configure'
  | 'edit'
  | 'create'
  | 'run'
  | 'verify'
  | 'communicate'
  | 'deliver';

export type PlannerRisk = 'low' | 'medium' | 'high';

export type PlannerStep = {
  step: number;
  name: string;
  description: string;
  tools: string[];
  done_when: string;
  depends_on: number[];
  priority: 'low' | 'medium' | 'high';
  step_type: PlannerStepType;
  expected_output: string;
  risk: PlannerRisk;
  artifacts: string[];
};

export type PlannerPlan = {
  steps: PlannerStep[];
  estimated_complexity: 'simple' | 'moderate' | 'complex';
  estimated_time_minutes: number;
  planner_version: string;
  quality_warnings: string[];
};

export type TaskPlanningOptions = {
  maxSubtasks?: number;
  provider?: MainAgentProvider;
  modelName?: string;
};

const BASE_PLANNER_TOOLS = new Set([
  'workspace_run_command',
  'workspace_edit_file',
  'browser_control',
  'computer',
  'screen_agent',
  'web_search',
  'get_skill_guidelines',
  'image_generator',
  'video_generator',
  'image_asset_search',
  'ask_user',
]);

const DISALLOWED_PLANNER_TOOLS = new Set([
  'task_decomposer',
  'task_checkpoint',
  'spawn_sub_agent',
]);

const EXTERNAL_COMMS_TOOLS = new Set([
  'gateway_bridge',
  'channel_agent',
  'connector_mcp',
]);

const STOPWORDS = new Set([
  'about', 'after', 'again', 'agent', 'also', 'and', 'any', 'are', 'because',
  'before', 'being', 'can', 'check', 'code', 'could', 'deep', 'does', 'done',
  'enterprise', 'every', 'fix', 'for', 'from', 'full', 'give', 'good', 'grade',
  'have', 'help', 'into', 'its', 'just', 'like', 'make', 'more', 'need', 'now',
  'only', 'perfect', 'please', 'product', 'real', 'really', 'should', 'that',
  'the', 'then', 'this', 'through', 'use', 'user', 'very', 'want', 'when',
  'where', 'with', 'work', 'would', 'you',
]);

const GENERIC_NAMES = new Set([
  'understand',
  'understand & plan',
  'understand and plan',
  'setup',
  'setup environment',
  'implement',
  'implement core',
  'implement details',
  'fix code',
  'make changes',
  'do task',
  'review',
  'review changes',
  'verify & polish',
  'verify and polish',
  'polish',
  'deliver',
  'finalize',
  'complete task',
]);

const PLANNER_SYSTEM_PROMPT = `You are EterX's enterprise task decomposition engine.

Your job is to convert a complex user request into an operational plan that an autonomous agent can execute reliably.

Rules:
1. Use only concrete task steps. Never output vague names like "Fix code", "Implement Core", "Review", "Setup Environment", or "Verify & Polish".
2. Every step must produce a real outcome: files inspected, code patched, data collected, artifact generated, check run, or result delivered.
3. Prefer the fewest meaningful steps. Do not pad simple work. Keep plans under the requested max_steps.
4. Include inspection only when the task modifies an existing implementation and the supplied context does not identify the relevant ownership or behavior. Never add generic workspace listings, parent-directory discovery, runtime/version checks, server startup, or environment setup as preliminary steps unless the requested outcome truly depends on them.
5. For a new artifact at a known or runtime-provided default location, begin with the artifact outcome itself. Do not invent a discovery/setup phase.
6. Put ordinary correctness evidence in each implementation step's done_when. Create a separate verification/release step only when it is a distinct cross-cutting gate or later work depends on its result.
7. For UI work, name the exact UI surface and state only when visible UI validation is actually required.
8. Do not plan sub-agents, background workers, dynamic tools, connector triggers, or hidden scheduler work unless the user explicitly asks for those systems.
9. Do not include task_decomposer, task_checkpoint, tracker-management, narration, or reporting-the-plan as steps.
10. Use exact filenames, folders, UI areas, tools, constraints, and deliverables from the request/context when present.
11. Dependencies must point only to earlier step numbers. Use [] for independent outcomes; do not invent a sequential chain. Explicit user restrictions (including no tests/checks) apply to every step and done_when.
12. Tools must use exact names from the AVAILABLE TOOLS catalog supplied with the task. Select only tools that materially help the specific step.

Return ONLY valid JSON:
{
  "steps": [
    {
      "step": 1,
      "name": "Prepare the destination account model",
      "description": "Add the destination schema and compatibility boundary needed by both the API and worker before either producer migrates.",
      "tools": ["workspace_edit_file"],
      "done_when": "Both systems can use the destination representation without breaking current consumers.",
      "depends_on": [],
      "priority": "high",
      "step_type": "edit",
      "expected_output": "A shared destination model with a temporary compatibility boundary.",
      "risk": "medium",
      "artifacts": ["src/account/schema.ts", "src/account/compatibility.ts"]
    }
  ],
  "estimated_complexity": "complex",
  "estimated_time_minutes": 90
}`;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function cleanText(value: unknown, fallback = ''): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || fallback;
}

function compactSentence(value: string, fallback: string, maxLength = 280): string {
  const text = cleanText(value, fallback);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}...`;
}

function titleCase(value: string): string {
  const text = cleanText(value);
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.map(v => cleanText(v)).filter(Boolean)));
}

function getRegisteredToolNames(): Set<string> {
  const names = new Set(BASE_PLANNER_TOOLS);
  try {
    for (const tool of globalToolRegistry.getAllTools()) {
      if (tool?.name) names.add(tool.name);
    }
  } catch {
    // Registry may not be bootstrapped during isolated tests.
  }
  return names;
}

function extractFileHints(task: string, context = ''): string[] {
  const text = `${task}\n${context}`;
  const paths = new Set<string>();
  const pathPattern = /(?:[A-Za-z]:[\\/][^\s"'`<>|]+|(?:\.{1,2}[\\/])?[A-Za-z0-9_.@ -]+(?:[\\/][A-Za-z0-9_.@ -]+)+\.[A-Za-z0-9]{1,12}|[A-Za-z0-9_.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|html|md|mdx|py|go|rs|java|cs|yml|yaml|toml|sql|csv|xlsx|docx|pptx|pdf))\b/g;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(text)) !== null) {
    const clean = match[0].replace(/[),.;:]+$/g, '').trim();
    if (clean.length > 2) paths.add(clean);
  }
  return Array.from(paths).slice(0, 10);
}

function wordsFromTask(task: string): string[] {
  return uniq(
    task
      .toLowerCase()
      .replace(/[`"'()[\]{}.,:;!?/\\_-]+/g, ' ')
      .split(/\s+/)
      .filter(word => word.length >= 4 && !STOPWORDS.has(word) && !/^\d+$/.test(word)),
  ).slice(0, 8);
}

function deriveSubject(task: string, context = ''): string {
  const lower = `${task}\n${context}`.toLowerCase();
  if (/\b(task\s*(?:decomposer|decomposition|generation|planner|planning)|decompose\s+tasks?)\b/.test(lower)) {
    if (/\b(ui|dock|tracker|progress|current\s+task)\b/.test(lower)) return 'task planning and tracker flow';
    return 'task planning flow';
  }
  if (/\b(task\s*tracker|progress\s*dock|current\s+task|checklist)\b/.test(lower)) return 'task tracker flow';
  if (/\b(ui|interface|component|frontend|screen|dock|panel|modal)\b/.test(lower)) return 'UI flow';
  if (/\b(api|route|endpoint|server|backend|request|response)\b/.test(lower)) return 'API flow';
  if (/\b(auth|login|session|permission|approval|security|safe|unsafe)\b/.test(lower)) return 'security-sensitive flow';
  if (/\b(report|document|docx|pdf|presentation|slides?|deck)\b/.test(lower)) return 'document artifact';
  if (/\b(csv|spreadsheet|xlsx|data|dataset|analysis)\b/.test(lower)) return 'data workflow';
  if (/\b(research|sources?|citations?|latest|web)\b/.test(lower)) return 'research brief';

  const files = extractFileHints(task, context);
  if (files.length > 0) {
    const file = files[0].split(/[\\/]/).pop() || files[0];
    return file.replace(/\.[^.]+$/, '') || 'requested work';
  }

  const afterIntent = cleanText(task).match(/\b(?:fix|improve|harden|build|create|implement|refactor|audit|review|generate|decompose)\s+(.{4,90})/i)?.[1];
  if (afterIntent) {
    const phrase = afterIntent
      .split(/[.!?;\n]/)[0]
      .replace(/\b(?:and|then|also|with|for|to|all|the|this|that)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (phrase.length >= 4) return phrase.split(/\s+/).slice(0, 6).join(' ');
  }

  const words = wordsFromTask(task);
  return words.length ? words.slice(0, 4).join(' ') : 'requested work';
}

function taskProfile(task: string, context = '') {
  const text = `${task}\n${context}`;
  const lower = text.toLowerCase();
  const files = extractFileHints(task, context);
  const isCode = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|css|html|json|yml|yaml)\b/i.test(text) ||
    /\b(code|repo|codebase|bug|fix|implement|refactor|compile|typescript|javascript|component|route|server|client|api|backend|frontend|workspace|src\/|src\\)\b/i.test(text);
  const isUi = /\b(ui|frontend|component|screen|dock|panel|modal|button|form|layout|responsive|browser|visual|page|view)\b/i.test(text);
  const isResearch = /\b(research|sources?|citations?|latest|web search|scrape|paper|article|market|news)\b/i.test(text);
  const isDocument = /\b(report|document|docx|pdf|presentation|slides?|deck|markdown|readme)\b/i.test(text);
  const isData = /\b(csv|spreadsheet|xlsx|dataset|data analysis|chart|visualization|table)\b/i.test(text);
  const isAutomation = /\b(automation|schedule|cron|watcher|background|workflow|connector|integration)\b/i.test(text);
  const needsEdit = /\b(fix|patch|edit|update|change|remove|harden|refactor|advance|improve|implement|integrate|connect)\b/i.test(text);
  const needsCreate = /\b(create|generate|build|make|draft|write|produce|export|scaffold)\b/i.test(text);
  const explicitBrowser = /\b(browser|playwright|visual|screenshot|click|navigate|render|viewport)\b/i.test(text);
  const gitIntent = /\b(git|commit|branch|pull request|pr\b|merge|checkout|diff)\b/i.test(text);
  const externalCommsIntent = /\b(slack|telegram|whatsapp|email|send message|notify|dm\b)\b/i.test(text);

  return {
    files,
    subject: deriveSubject(task, context),
    isCode,
    isUi,
    isResearch,
    isDocument,
    isData,
    isAutomation,
    needsEdit,
    needsCreate,
    explicitBrowser,
    gitIntent,
    externalCommsIntent,
    wordCount: lower.split(/\s+/).filter(Boolean).length,
  };
}

function isGenericName(value: unknown): boolean {
  const normalized = cleanText(value).toLowerCase().replace(/[^\w\s&-]/g, '');
  if (!normalized || GENERIC_NAMES.has(normalized)) return true;
  if (/^step\s*\d+$/i.test(normalized)) return true;
  if (/^(analy[sz]e|understand|setup|implement|fix|review|verify|polish|finali[sz]e|deliver)(?:\s+(?:code|task|changes?|work|core|details?|output|result))?$/i.test(normalized)) return true;
  return normalized.length < 5;
}

function isGenericDescription(value: unknown): boolean {
  const text = cleanText(value).toLowerCase();
  if (text.length < 28) return true;
  return /\b(?:determine the approach|create the main output|supporting files|ensure quality|step completed|fix issues|review output|complete the task)\b/i.test(text);
}

function inferStepType(raw: any, index: number, total: number, task: string, context = ''): PlannerStepType {
  const text = `${raw?.name || ''} ${raw?.description || ''} ${(Array.isArray(raw?.tools) ? raw.tools : []).join(' ')} ${raw?.step_type || ''}`.toLowerCase();
  const profile = taskProfile(task, context);

  if (/\b(research|search|scrape|source|citation|read article|collect evidence)\b/.test(text)) return 'research';
  if (/\b(read|inspect|audit|trace|map|find|locate|identify|analy[sz]e current|review existing|outline)\b/.test(text)) return 'inspect';
  if (/\b(configure|install|setup|dependency|environment|env|settings)\b/.test(text)) return 'configure';
  if (/\b(patch|edit|replace|update|refactor|fix|harden|remove|rename|change)\b/.test(text)) return 'edit';
  if (/\b(create|write|generate|build|scaffold|draft|export|produce)\b/.test(text)) return 'create';
  if (/\b(run|execute|start|command|script)\b/.test(text)) return 'run';
  if (/\b(test|verify|validate|lint|typecheck|build check|compile|screenshot|browser|qa)\b/.test(text)) return 'verify';
  if (/\b(ask|confirm|approve|message|send|notify|email|slack|telegram|whatsapp)\b/.test(text)) return 'communicate';
  if (/\b(deliver|summari[sz]e|final|handoff|report result)\b/.test(text)) return 'deliver';

  // Position alone never creates a mandatory discovery or verification phase.
  if (profile.needsCreate && !profile.needsEdit) return 'create';
  if (profile.needsEdit || profile.isCode || profile.isUi) return 'edit';
  if (profile.isResearch) return 'research';
  return 'create';
}

function makeStepName(type: PlannerStepType, task: string, context = '', index = 0, total = 1): string {
  const profile = taskProfile(task, context);
  const subject = profile.subject;
  const fileLabel = profile.files.length > 0
    ? profile.files.slice(0, 2).map(file => file.split(/[\\/]/).pop() || file).join(', ')
    : '';

  switch (type) {
    case 'inspect':
      return fileLabel ? `Inspect ${fileLabel}` : `Inspect ${subject}`;
    case 'research':
      return `Research ${subject}`;
    case 'configure':
      return `Configure ${subject} prerequisites`;
    case 'edit':
      return `Patch ${subject}`;
    case 'create':
      return profile.isDocument ? `Create ${subject}` : `Build ${subject}`;
    case 'run':
      return `Run ${subject} workflow`;
    case 'verify':
      if (profile.isUi) return `Verify ${subject} behavior`;
      if (profile.isCode) return `Run code checks for ${subject}`;
      return `Verify ${subject}`;
    case 'communicate':
      return `Confirm ${subject} action`;
    case 'deliver':
      return index >= total - 1 ? `Deliver ${subject} result` : `Summarize ${subject} status`;
    default:
      return `Handle ${subject}`;
  }
}

function describeFiles(files: string[]): string {
  if (files.length === 0) return '';
  return files.slice(0, 5).join(', ');
}

function makeDescription(type: PlannerStepType, task: string, context = ''): string {
  const profile = taskProfile(task, context);
  const subject = profile.subject;
  const files = describeFiles(profile.files);
  const filePhrase = files ? `, including ${files}` : '';

  switch (type) {
    case 'inspect':
      return `Read and search the relevant ${subject} code and context${filePhrase}. Identify entry points, current behavior, constraints, and the smallest safe files to change before editing.`;
    case 'research':
      return `Collect focused information for ${subject} from the required source material, keeping sources and facts tied to the final deliverable.`;
    case 'configure':
      return `Prepare the required configuration, dependencies, or environment for ${subject} without changing unrelated project settings.`;
    case 'edit':
      return `Apply focused changes to ${subject} based on the inspected files. Keep the patch scoped, preserve existing conventions, and avoid unrelated refactors.`;
    case 'create':
      return `Create the requested ${subject} artifact or implementation with complete usable content, using existing project patterns and the user's constraints.`;
    case 'run':
      return `Run the concrete command or workflow needed for ${subject}, capture the output, and use any errors to drive the next fix.`;
    case 'verify':
      return profile.isUi
        ? `Run relevant type/build checks and verify the ${subject} UI state, copy, and progress behavior without introducing layout or runtime regressions.`
        : `Run the relevant validation for ${subject}, such as type checks, tests, builds, or artifact inspection, and fix blocking failures.`;
    case 'communicate':
      return `Request the explicit user confirmation or missing information needed before performing the external ${subject} action.`;
    case 'deliver':
      return `Summarize the completed ${subject} work with changed files, verification results, useful behavior changes, and any remaining risks.`;
    default:
      return `Complete the next concrete action for ${subject}.`;
  }
}

function makeExpectedOutput(type: PlannerStepType, task: string, context = ''): string {
  const subject = taskProfile(task, context).subject;
  switch (type) {
    case 'inspect':
      return `Relevant ${subject} files, behavior, and constraints are mapped.`;
    case 'research':
      return `Focused facts and sources for ${subject} are collected.`;
    case 'configure':
      return `Prerequisites for ${subject} are ready and scoped.`;
    case 'edit':
      return `A focused patch for ${subject} is applied.`;
    case 'create':
      return `The requested ${subject} artifact or implementation exists.`;
    case 'run':
      return `The ${subject} command/workflow output is captured.`;
    case 'verify':
      return `Validation results for ${subject} are known and blocking failures are addressed.`;
    case 'communicate':
      return `Required user confirmation or missing details are captured.`;
    case 'deliver':
      return `The user receives a concise completion summary for ${subject}.`;
    default:
      return `${titleCase(subject)} has a concrete result.`;
  }
}

function inferRisk(type: PlannerStepType, task: string, context = ''): PlannerRisk {
  const profile = taskProfile(task, context);
  if (type === 'communicate' || profile.isAutomation || /\b(delete|remove|credential|secret|payment|production|database|deploy|external|send)\b/i.test(`${task}\n${context}`)) {
    return 'high';
  }
  if (type === 'edit' || type === 'create' || type === 'configure' || type === 'run') return 'medium';
  return 'low';
}

function inferTools(type: PlannerStepType, task: string, context = ''): string[] {
  const profile = taskProfile(task, context);
  switch (type) {
    case 'inspect':
      return ['workspace_run_command'];
    case 'research':
      return profile.isResearch ? ['web_search'] : ['workspace_run_command'];
    case 'configure':
      return ['workspace_run_command', 'workspace_edit_file'];
    case 'edit':
      return ['workspace_edit_file'];
    case 'create':
      if (profile.isDocument || profile.isData) return ['workspace_run_command'];
      return ['workspace_edit_file'];
    case 'run':
      return ['workspace_run_command'];
    case 'verify':
      if (profile.explicitBrowser) return ['workspace_run_command', 'browser_control'];
      return ['workspace_run_command'];
    case 'communicate':
      // Communication is an execution lane, not a request for permission.
      // The selected connector tool owns its safety/approval policy; the
      // planner must not manufacture a blocking ask_user step.
      return [];
    case 'deliver':
      return [];
    default:
      return [];
  }
}

function sanitizePriority(value: unknown, fallback: 'low' | 'medium' | 'high' = 'high'): 'low' | 'medium' | 'high' {
  const text = cleanText(value).toLowerCase();
  if (text === 'low' || text === 'medium' || text === 'high') return text;
  return fallback;
}

function sanitizeRisk(value: unknown, fallback: PlannerRisk): PlannerRisk {
  const text = cleanText(value).toLowerCase();
  if (text === 'low' || text === 'medium' || text === 'high') return text;
  return fallback;
}

function sanitizeStepType(value: unknown, fallback: PlannerStepType): PlannerStepType {
  const text = cleanText(value).toLowerCase();
  const allowed: PlannerStepType[] = ['inspect', 'research', 'configure', 'edit', 'create', 'run', 'verify', 'communicate', 'deliver'];
  return allowed.includes(text as PlannerStepType) ? text as PlannerStepType : fallback;
}

function sanitizeDependsOn(value: unknown, currentStep: number): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map(item => Number(item))
      .filter(item => Number.isInteger(item) && item > 0 && item < currentStep),
  ));
}

function sanitizeArtifacts(value: unknown, task: string, context = ''): string[] {
  const raw = Array.isArray(value) ? value.map(item => cleanText(item)) : [];
  return uniq(raw).slice(0, 10);
}

function normalizeToolList(value: unknown, type: PlannerStepType, task: string, context = ''): string[] {
  const profile = taskProfile(task, context);
  const registered = getRegisteredToolNames();
  const rawTools = Array.isArray(value) ? value : [];
  const normalized = rawTools
    .map(tool => cleanText(tool).toLowerCase())
    .map(tool => normalizeRegistryToolName(tool))
    .filter(tool => {
      if (!tool) return false;
      if (DISALLOWED_PLANNER_TOOLS.has(tool)) return false;
      if (EXTERNAL_COMMS_TOOLS.has(tool) && !profile.externalCommsIntent) return false;
      return registered.has(tool);
    });

  const inferred = inferTools(type, task, context).filter(tool => registered.has(tool));
  return uniq(Array.isArray(value) ? normalized : inferred).slice(0, 4);
}

function makeDoneWhen(type: PlannerStepType, task: string, context = ''): string {
  const expected = makeExpectedOutput(type, task, context);
  switch (type) {
    case 'inspect':
      return `${expected} The next edit target is clear.`;
    case 'edit':
      return `${expected} No unrelated files are changed.`;
    case 'create':
      return `${expected} It is complete enough to verify.`;
    case 'verify':
      return `${expected} Any remaining failures are documented with exact blockers.`;
    case 'deliver':
      return `${expected} The final response is ready.`;
    default:
      return expected;
  }
}

function estimateComplexity(stepCount: number, task: string, context = ''): 'simple' | 'moderate' | 'complex' {
  const profile = taskProfile(task, context);
  if (stepCount >= 8 || profile.isAutomation || (profile.isCode && profile.isUi && profile.files.length >= 4)) return 'complex';
  if (stepCount >= 5 || profile.isCode || profile.isDocument || profile.isData || profile.isResearch) return 'moderate';
  return 'simple';
}

function estimateMinutes(stepCount: number, task: string, context = ''): number {
  const profile = taskProfile(task, context);
  const perStep = profile.isCode || profile.isUi ? 5 : profile.isResearch || profile.isDocument ? 6 : 4;
  return Math.max(5, Math.min(180, stepCount * perStep));
}

function sortAndReindexSteps(steps: PlannerStep[], task: string, context: string): PlannerStep[] {
  return steps.map((step, index) => {
    const stepNumber = index + 1;
    return {
      ...step,
      step: stepNumber,
      depends_on: sanitizeDependsOn(step.depends_on, stepNumber),
      tools: normalizeToolList(step.tools, step.step_type, task, context),
      artifacts: sanitizeArtifacts(step.artifacts, task, context),
    };
  });
}

function hasMeaningfulCoverage(steps: PlannerStep[], task: string, context: string): boolean {
  // Outcomes, not a fixed inspect/edit/verify template, define useful coverage.
  // Read-only investigations and verification-free requests are valid plans.
  return steps.length > 0 && steps.every(step => Boolean(step.name && step.done_when && step.expected_output)) &&
    steps.some(step => step.step_type !== 'deliver');
}

function cleanJsonText(rawText: string): string {
  let cleanJson = rawText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  const jsonMatch = cleanJson.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleanJson = jsonMatch[0];
  return cleanJson;
}

export class TaskPlannerClient {
  private ai: GoogleGenAI | null = null;
  private geminiApiKey = '';

  private getGeminiClient(): GoogleGenAI | null {
    const apiKey = getRuntimeApiKey('gemini');
    if (!apiKey) {
      console.warn('[TaskPlanner] No Gemini key is configured in Settings.');
      return null;
    }
    if (!this.ai || this.geminiApiKey !== apiKey) {
      this.ai = new GoogleGenAI({ httpOptions: { timeout: MODEL_REQUEST_TIMEOUT_MS }, apiKey });
      this.geminiApiKey = apiKey;
    }
    return this.ai;
  }

  private maxSteps(options?: TaskPlanningOptions): number {
    return clampInt(options?.maxSubtasks, DEFAULT_MAX_STEPS, 1, MAX_ALLOWED_STEPS);
  }

  private normalizePlannerOutput(parsed: any, task: string, context: string, options: TaskPlanningOptions, modelName: string, startTime: number): PlannerPlan {
    const maxSteps = this.maxSteps(options);
    const warnings: string[] = [];
    const rawSteps = Array.isArray(parsed?.steps) ? parsed.steps : [];
    if (rawSteps.length === 0) {
      throw new Error('No steps generated');
    }
    if (rawSteps.length > maxSteps) {
      throw new Error(`The configured planning model returned ${rawSteps.length} steps, exceeding the requested maximum of ${maxSteps}.`);
    }

    const sourceStepPositions = new Map<string, number>();
    rawSteps.forEach((raw: any, index: number) => {
      const key = String(raw?.step ?? raw?.id ?? index + 1);
      if (sourceStepPositions.has(key)) throw new Error(`Duplicate planning step identifier: ${key}.`);
      sourceStepPositions.set(key, index + 1);
    });
    let steps: PlannerStep[] = rawSteps.slice(0, MAX_ALLOWED_STEPS).map((raw: any, index: number) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Step ${index + 1} must be an object.`);
      const inferredType = inferStepType(raw, index, rawSteps.length, task, context);
      const stepType = sanitizeStepType(raw?.step_type || raw?.type || raw?.kind, inferredType);
      const repairedName = isGenericName(raw?.name);
      const repairedDescription = isGenericDescription(raw?.description);
      if (repairedName) warnings.push(`Repaired vague step name at position ${index + 1}.`);
      if (repairedDescription) warnings.push(`Repaired vague step description at position ${index + 1}.`);

      const stepNumber = index + 1;
      const dependencies = Array.isArray(raw.depends_on) ? raw.depends_on.map((dependency: unknown) => {
        const position = sourceStepPositions.get(String(dependency));
        if (position === undefined || position >= stepNumber) {
          throw new Error(`Step ${stepNumber} has an unknown, self, or forward dependency: ${String(dependency)}.`);
        }
        return position;
      }) : [];
      const expectedOutput = compactSentence(
        raw?.expected_output || raw?.output || raw?.deliverable || '',
        makeExpectedOutput(stepType, task, context),
      );
      return {
        step: stepNumber,
        name: compactSentence(
          repairedName ? '' : raw?.name,
          makeStepName(stepType, task, context, index, rawSteps.length),
          80,
        ),
        description: compactSentence(
          repairedDescription ? '' : raw?.description,
          makeDescription(stepType, task, context),
        ),
        tools: normalizeToolList(raw?.tools, stepType, task, context),
        done_when: compactSentence(
          isGenericDescription(raw?.done_when || raw?.verification) ? '' : raw?.done_when || raw?.verification,
          makeDoneWhen(stepType, task, context),
        ),
        depends_on: sanitizeDependsOn(dependencies, stepNumber),
        priority: sanitizePriority(raw?.priority, stepType === 'deliver' ? 'medium' : 'high'),
        step_type: stepType,
        expected_output: expectedOutput,
        risk: sanitizeRisk(raw?.risk, inferRisk(stepType, task, context)),
        artifacts: sanitizeArtifacts(raw?.artifacts || raw?.files, task, context),
      } satisfies PlannerStep;
    });

    steps = sortAndReindexSteps(steps, task, context);

    if (!hasMeaningfulCoverage(steps, task, context)) {
      throw new Error('The configured planning model returned no substantive outcome with a completion condition.');
    }

    const elapsed = Date.now() - startTime;
    const complexity = ['simple', 'moderate', 'complex'].includes(parsed?.estimated_complexity)
      ? parsed.estimated_complexity
      : estimateComplexity(steps.length, task, context);
    const minutes = clampInt(parsed?.estimated_time_minutes, estimateMinutes(steps.length, task, context), 5, 180);

    console.log(`[TaskPlanner] Generated ${steps.length} normalized steps in ${elapsed}ms via ${modelName} (complexity: ${complexity})`);

    return {
      steps,
      estimated_complexity: complexity,
      estimated_time_minutes: minutes,
      planner_version: 'task_planner_v5_model_driven',
      quality_warnings: uniq(warnings),
    };
  }

  private parsePlannerResponse(rawText: string, task: string, context: string, options: TaskPlanningOptions, startTime: number, modelName: string): PlannerPlan {
    const parsed = JSON.parse(cleanJsonText(rawText));
    return this.normalizePlannerOutput(parsed, task, context, options, modelName, startTime);
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    if (ms <= 0) return promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public async decompose(task: string, context = '', mode: MainAgentMode = 'think', options: TaskPlanningOptions = {}): Promise<PlannerPlan> {
    const safeMode = normalizeMainAgentMode(mode);
    const selectedConfig = getMainAgentModelConfig(safeMode);
    const provider = options.provider || selectedConfig.provider;
    const modelName = cleanText(options.modelName, selectedConfig.modelName);
    const maxSteps = this.maxSteps(options);
    console.log(`[TaskPlanner] Generating execution plan via selected model: ${provider}/${modelName} (max ${maxSteps})`);
    const startTime = Date.now();

    const prompt = [
      `Task: ${task}`,
      context ? `Additional context: ${context}` : '',
      `AVAILABLE TOOLS:\n${globalToolRegistry.getAllTools()
        .filter(tool => tool?.name && !DISALLOWED_PLANNER_TOOLS.has(tool.name))
        .map(tool => `- ${tool.name}: ${compactSentence(tool.description || '', 'No description available.', 180)}`)
        .join('\n')}`,
      `Planner constraints: max_steps=${maxSteps}. Produce concrete, task-specific operational steps. No generic "fix code" or "implement core" items.`,
    ].filter(Boolean).join('\n\n');

    try {
      let rawText = '';
      if (provider === 'gemini') {
        const gemini = this.getGeminiClient();
        if (!gemini) throw new Error('Gemini planning requires a configured Gemini API key.');
        const response = await this.withTimeout(
          gemini.models.generateContent({
            model: modelName,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
              systemInstruction: PLANNER_SYSTEM_PROMPT,
              responseMimeType: 'application/json',
            },
          }),
          MODEL_REQUEST_TIMEOUT_MS,
        );
        rawText = response.text || '';
      } else if (provider === 'anthropic') {
        const apiKey = getRuntimeApiKey('anthropic');
        if (!apiKey) throw new Error('Anthropic planning requires a configured Anthropic API key.');
        const client = new Anthropic({ timeout: MODEL_REQUEST_TIMEOUT_MS, apiKey, baseURL: getProviderBaseURL('anthropic'), maxRetries: 0 });
        const response: any = await this.withTimeout(client.messages.create({
          model: modelName,
          max_tokens: 5000,
          system: PLANNER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
        }), MODEL_REQUEST_TIMEOUT_MS);
        rawText = (response.content || []).filter((part: any) => part?.type === 'text').map((part: any) => part.text || '').join('');
      } else {
        const baseURL = getProviderBaseURL(provider);
        if (!baseURL) throw new Error(`${provider} planning requires a configured provider endpoint.`);
        const apiKey = getRuntimeApiKey(provider as RuntimeApiKeyProvider) || (isLocalModelProvider(provider) ? 'local-provider' : '');
        if (!apiKey) throw new Error(`${provider} planning requires a configured API key.`);
        const client = new OpenAI({ timeout: MODEL_REQUEST_TIMEOUT_MS, apiKey, baseURL, maxRetries: 0 });
        const response: any = await this.withTimeout(client.chat.completions.create({
          model: modelName,
          messages: [
            { role: 'system', content: PLANNER_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
        } as any), MODEL_REQUEST_TIMEOUT_MS);
        rawText = String(response.choices?.[0]?.message?.content || '');
      }

      return this.parsePlannerResponse(rawText, task, context, options, startTime, `${provider}/${modelName}`);
    } catch (error: any) {
      throw new Error(`Real planning failed with ${provider}/${modelName}: ${String(error?.message || error)}`);
    }
  }
}

export const globalTaskPlanner = new TaskPlannerClient();
