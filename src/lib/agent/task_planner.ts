import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import OpenAI from 'openai';
import { getMainAgentModelConfig, normalizeMainAgentMode, resolveModelName, type MainAgentMode } from './model-routing';
import { getRuntimeApiKey } from './runtime-api-keys';
import { globalToolRegistry, normalizeRegistryToolName } from './tools/registry';

/**
 * Task Planner - selected-model client for real execution-oriented task plans.
 *
 * Model output is treated as a draft. The normalizer below validates tool names,
 * repairs vague steps, adds missing inspect/edit/verify coverage, and falls back
 * to a task-aware plan when the model is unavailable or returns low-quality JSON.
 */

/** Resolve planner fallback models dynamically instead of hardcoding a model name. */
function getPlannerFallbackModels(): string[] {
  try {
    return [resolveModelName('fast')];
  } catch {
    return ['gemini-2.0-flash'];
  }
}

const MAX_ALLOWED_STEPS = 20;
const DEFAULT_MAX_STEPS = 15;

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
};

const BASE_PLANNER_TOOLS = new Set([
  'workspace_read_file',
  'workspace_read_many_files',
  'workspace_list_directory',
  'workspace_search_text',
  'workspace_find_files',
  'workspace_semantic_search',
  'workspace_symbol_lookup',
  'workspace_file_outline',
  'smart_file_analyzer',
  'workspace_str_replace',
  'workspace_apply_patch',
  'workspace_edit_file',
  'workspace_edit_many_files',
  'workspace_write_file',
  'workspace_run_command',
  'workspace_verify_code',
  'browser_control',
  'realtime_verify',
  'screenshot_capture',
  'web_search',
  'web_scraper',
  'deep_research',
  'parse_pdf',
  'youtube_transcript',
  'rss_feed_reader',
  'get_skill_guidelines',
  'docx_generator',
  'office_artifact_builder',
  'chart_generator',
  'csv_data_analyzer',
  'json_yaml_transform',
  'markdown_to_html',
  'code_execution_js',
  'calculator',
  'image_generator',
  'image_asset_search',
  'api_caller',
  'smart_api_hub',
  'ask_user',
  'git_operations',
]);

const TOOL_ALIASES: Record<string, string> = {
  system_shell: 'workspace_run_command',
  shell_command: 'workspace_run_command',
  workspace_shell: 'workspace_run_command',
  read_file: 'workspace_read_file',
  read_many_files: 'workspace_read_many_files',
  search_text: 'workspace_search_text',
  find_files: 'workspace_find_files',
  apply_patch: 'workspace_apply_patch',
  edit_file: 'workspace_str_replace',
  semantic_search: 'workspace_semantic_search',
  symbol_lookup: 'workspace_symbol_lookup',
  csv_analyzer: 'csv_data_analyzer',
  data_analyzer: 'csv_data_analyzer',
  js_execution: 'code_execution_js',
  code_execution: 'code_execution_js',
  browser: 'browser_control',
  screenshot: 'screenshot_capture',
  scraper: 'web_scraper',
  pdf_parser: 'parse_pdf',
};

const DISALLOWED_PLANNER_TOOLS = new Set([
  'task_decomposer',
  'task_checkpoint',
  'spawn_sub_agent',
  'background_task',
  'create_dynamic_tool',
  'run_macro',
  'self_improve',
  'desktop_control',
  'computer',
  'screen_agent',
  'file_watcher',
  'process_manager',
]);

const EXTERNAL_COMMS_TOOLS = new Set([
  'slack_controller',
  'telegram_user_controller',
  'whatsapp_controller',
  'email_manager',
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
4. For code/product work, include inspect before edit, focused edit/create steps, and verification. For UI work, include the exact UI surface and state being checked.
5. Do not plan sub-agents, background workers, dynamic tools, connector triggers, or hidden scheduler work unless the user explicitly asks for those systems.
6. Do not include task_decomposer or tracker-management as a step.
7. Use exact filenames, folders, UI areas, tools, constraints, and deliverables from the request/context when present.
8. Dependencies must point only to earlier step numbers.
9. Tools must be real tool names from this set when relevant:
   workspace_read_file, workspace_read_many_files, workspace_list_directory, workspace_search_text, workspace_find_files, workspace_semantic_search, workspace_symbol_lookup, workspace_file_outline, smart_file_analyzer,
   workspace_str_replace, workspace_apply_patch, workspace_edit_file, workspace_edit_many_files, workspace_write_file,
   workspace_run_command, workspace_verify_code,
   browser_control, realtime_verify, screenshot_capture,
   web_search, web_scraper, deep_research, parse_pdf, youtube_transcript, rss_feed_reader,
   get_skill_guidelines,
   docx_generator, office_artifact_builder, chart_generator, csv_data_analyzer, json_yaml_transform, markdown_to_html,
   code_execution_js, calculator, image_generator, image_asset_search, api_caller, smart_api_hub, ask_user, git_operations.

Return ONLY valid JSON:
{
  "steps": [
    {
      "step": 1,
      "name": "Inspect task planner files",
      "description": "Read the task planner, decomposer, tracker store, and dock UI code to locate the current planning and progress flow.",
      "tools": ["workspace_read_many_files", "workspace_search_text"],
      "done_when": "The relevant files, entry points, and current behavior are identified.",
      "depends_on": [],
      "priority": "high",
      "step_type": "inspect",
      "expected_output": "A concrete map of files and behaviors to change.",
      "risk": "low",
      "artifacts": ["src/lib/agent/task_planner.ts"]
    }
  ],
  "estimated_complexity": "simple|moderate|complex",
  "estimated_time_minutes": 15
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
  const text = `${raw?.name || ''} ${raw?.description || ''} ${(raw?.tools || []).join(' ')} ${raw?.step_type || ''}`.toLowerCase();
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

  if (index === 0 && (profile.isCode || profile.isUi || profile.files.length > 0)) return 'inspect';
  if (index === total - 1) return profile.isCode || profile.isUi || profile.isData || profile.isDocument ? 'verify' : 'deliver';
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
      if (profile.files.length > 1) return ['workspace_read_many_files', 'workspace_search_text'];
      return ['workspace_search_text', 'workspace_read_file'];
    case 'research':
      return profile.isResearch ? ['web_search', 'web_scraper'] : ['workspace_search_text', 'workspace_read_file'];
    case 'configure':
      return ['workspace_read_file', 'workspace_apply_patch'];
    case 'edit':
      return ['workspace_apply_patch', 'workspace_str_replace'];
    case 'create':
      if (profile.isDocument) return ['docx_generator', 'workspace_write_file'];
      if (profile.isData) return ['csv_data_analyzer', 'office_artifact_builder'];
      return ['workspace_write_file', 'workspace_apply_patch'];
    case 'run':
      return ['workspace_run_command'];
    case 'verify':
      if (profile.explicitBrowser) return ['workspace_run_command', 'browser_control'];
      if (profile.isCode || profile.isUi) return ['workspace_run_command', 'workspace_verify_code'];
      if (profile.isDocument || profile.isData) return ['workspace_read_file', 'workspace_verify_code'];
      return ['workspace_verify_code'];
    case 'communicate':
      return ['ask_user'];
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
  if (!Array.isArray(value)) return currentStep > 1 ? [currentStep - 1] : [];
  return Array.from(new Set(
    value
      .map(item => Number(item))
      .filter(item => Number.isInteger(item) && item > 0 && item < currentStep),
  ));
}

function sanitizeArtifacts(value: unknown, task: string, context = ''): string[] {
  const raw = Array.isArray(value) ? value.map(item => cleanText(item)) : [];
  return uniq([...raw, ...extractFileHints(task, context)]).slice(0, 10);
}

function normalizeToolList(value: unknown, type: PlannerStepType, task: string, context = ''): string[] {
  const profile = taskProfile(task, context);
  const registered = getRegisteredToolNames();
  const rawTools = Array.isArray(value) ? value : [];
  const normalized = rawTools
    .map(tool => cleanText(tool).toLowerCase())
    .map(tool => TOOL_ALIASES[tool] || normalizeRegistryToolName(tool))
    .filter(tool => {
      if (!tool) return false;
      if (DISALLOWED_PLANNER_TOOLS.has(tool)) return false;
      if (tool === 'git_operations' && !profile.gitIntent) return false;
      if (EXTERNAL_COMMS_TOOLS.has(tool) && !profile.externalCommsIntent) return false;
      return registered.has(tool);
    });

  const inferred = inferTools(type, task, context).filter(tool => registered.has(tool));
  return uniq([...normalized, ...inferred]).slice(0, 4);
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

function buildOperationalStep(type: PlannerStepType, task: string, context: string, index: number, total: number): PlannerStep {
  const stepNumber = index + 1;
  return {
    step: stepNumber,
    name: makeStepName(type, task, context, index, total),
    description: makeDescription(type, task, context),
    tools: normalizeToolList([], type, task, context),
    done_when: makeDoneWhen(type, task, context),
    depends_on: stepNumber > 1 ? [stepNumber - 1] : [],
    priority: type === 'deliver' ? 'medium' : 'high',
    step_type: type,
    expected_output: makeExpectedOutput(type, task, context),
    risk: inferRisk(type, task, context),
    artifacts: sanitizeArtifacts([], task, context),
  };
}

function chooseFallbackTypes(task: string, context: string, maxSteps: number): PlannerStepType[] {
  const profile = taskProfile(task, context);
  let types: PlannerStepType[];

  if (profile.isResearch && !profile.isCode) {
    types = ['research', 'inspect', 'create', 'verify', 'deliver'];
  } else if (profile.isDocument || profile.isData) {
    types = ['inspect', profile.needsCreate ? 'create' : 'edit', 'verify', 'deliver'];
  } else if (profile.isCode || profile.isUi || profile.files.length > 0) {
    types = ['inspect'];
    if (profile.needsCreate && !profile.needsEdit) types.push('create');
    else types.push('edit');
    if (profile.isUi) types.push('verify');
    else types.push('verify');
    types.push('deliver');
  } else if (profile.isAutomation) {
    types = ['inspect', 'configure', 'edit', 'verify', 'deliver'];
  } else {
    types = ['inspect', profile.needsCreate ? 'create' : 'edit', 'verify', 'deliver'];
  }

  if (maxSteps <= 3) {
    return types.filter(type => type !== 'deliver').slice(0, maxSteps);
  }
  return types.slice(0, maxSteps);
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
      depends_on: sanitizeDependsOn(index === 0 ? [] : step.depends_on?.length ? step.depends_on : [index], stepNumber),
      tools: normalizeToolList(step.tools, step.step_type, task, context),
      artifacts: sanitizeArtifacts(step.artifacts, task, context),
    };
  });
}

function trimPreservingVerification(steps: PlannerStep[], maxSteps: number, task: string, context: string): PlannerStep[] {
  if (steps.length <= maxSteps) return steps;
  const profile = taskProfile(task, context);
  let trimmed = steps.slice(0, maxSteps);
  const needsVerify = profile.isCode || profile.isUi || profile.isData || profile.isDocument || profile.needsEdit || profile.needsCreate;
  const hasVerify = trimmed.some(step => step.step_type === 'verify');
  if (needsVerify && !hasVerify && maxSteps > 1) {
    trimmed[trimmed.length - 1] = buildOperationalStep('verify', task, context, trimmed.length - 1, maxSteps);
  }
  return trimmed;
}

function hasMeaningfulCoverage(steps: PlannerStep[], task: string, context: string): boolean {
  const profile = taskProfile(task, context);
  if (steps.length === 0) return false;
  if ((profile.isCode || profile.isUi || profile.files.length > 0) && !steps.some(step => step.step_type === 'inspect')) return false;
  if ((profile.needsEdit || profile.isCode || profile.isUi) && !steps.some(step => step.step_type === 'edit' || step.step_type === 'create')) return false;
  if ((profile.needsEdit || profile.needsCreate || profile.isCode || profile.isUi || profile.isData || profile.isDocument) && !steps.some(step => step.step_type === 'verify')) return false;
  return true;
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
  private mistral: OpenAI | null = null;
  private geminiApiKey = '';
  private mistralApiKey = '';

  private getGeminiClient(): GoogleGenAI | null {
    const apiKey = getRuntimeApiKey('gemini');
    if (!apiKey) {
      console.warn('[TaskPlanner] No Gemini key is configured in Settings. Will use task-aware fallback decomposition.');
      return null;
    }
    if (!this.ai || this.geminiApiKey !== apiKey) {
      this.ai = new GoogleGenAI({ apiKey });
      this.geminiApiKey = apiKey;
    }
    return this.ai;
  }

  private maxSteps(options?: TaskPlanningOptions): number {
    return clampInt(options?.maxSubtasks, DEFAULT_MAX_STEPS, 3, MAX_ALLOWED_STEPS);
  }

  private normalizePlannerOutput(parsed: any, task: string, context: string, options: TaskPlanningOptions, modelName: string, startTime: number): PlannerPlan {
    const maxSteps = this.maxSteps(options);
    const warnings: string[] = [];
    const rawSteps = Array.isArray(parsed?.steps) ? parsed.steps : [];
    if (rawSteps.length === 0) {
      throw new Error('No steps generated');
    }

    let steps: PlannerStep[] = rawSteps.slice(0, MAX_ALLOWED_STEPS).map((raw: any, index: number) => {
      const inferredType = inferStepType(raw, index, rawSteps.length, task, context);
      const stepType = sanitizeStepType(raw?.step_type || raw?.type || raw?.kind, inferredType);
      const repairedName = isGenericName(raw?.name);
      const repairedDescription = isGenericDescription(raw?.description);
      if (repairedName) warnings.push(`Repaired vague step name at position ${index + 1}.`);
      if (repairedDescription) warnings.push(`Repaired vague step description at position ${index + 1}.`);

      const stepNumber = index + 1;
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
        depends_on: sanitizeDependsOn(raw?.depends_on, stepNumber),
        priority: sanitizePriority(raw?.priority, stepType === 'deliver' ? 'medium' : 'high'),
        step_type: stepType,
        expected_output: expectedOutput,
        risk: sanitizeRisk(raw?.risk, inferRisk(stepType, task, context)),
        artifacts: sanitizeArtifacts(raw?.artifacts || raw?.files, task, context),
      } satisfies PlannerStep;
    });

    const profile = taskProfile(task, context);
    if ((profile.isCode || profile.isUi || profile.files.length > 0) && !steps.some(step => step.step_type === 'inspect')) {
      warnings.push('Added missing inspection step for code/product work.');
      steps.unshift(buildOperationalStep('inspect', task, context, 0, steps.length + 1));
    }
    if ((profile.needsEdit || profile.isCode || profile.isUi) && !steps.some(step => step.step_type === 'edit' || step.step_type === 'create')) {
      warnings.push('Added missing implementation step.');
      const insertAt = Math.min(1, steps.length);
      steps.splice(insertAt, 0, buildOperationalStep(profile.needsCreate && !profile.needsEdit ? 'create' : 'edit', task, context, insertAt, steps.length + 1));
    }
    if ((profile.needsEdit || profile.needsCreate || profile.isCode || profile.isUi || profile.isData || profile.isDocument) && !steps.some(step => step.step_type === 'verify')) {
      warnings.push('Added missing verification step.');
      steps.push(buildOperationalStep('verify', task, context, steps.length, steps.length + 1));
    }
    if (maxSteps >= 4 && !steps.some(step => step.step_type === 'deliver')) {
      steps.push(buildOperationalStep('deliver', task, context, steps.length, steps.length + 1));
    }

    steps = trimPreservingVerification(sortAndReindexSteps(steps, task, context), maxSteps, task, context);
    steps = sortAndReindexSteps(steps, task, context);

    if (!hasMeaningfulCoverage(steps, task, context)) {
      warnings.push('Model plan lacked required lifecycle coverage; using task-aware fallback.');
      const fallback = this.fallbackDecompose(task, context, options);
      fallback.quality_warnings = uniq([...fallback.quality_warnings, ...warnings]);
      return fallback;
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
      planner_version: 'task_planner_v4_normalized',
      quality_warnings: uniq(warnings),
    };
  }

  private parsePlannerResponse(rawText: string, task: string, context: string, options: TaskPlanningOptions, startTime: number, modelName: string): PlannerPlan {
    const parsed = JSON.parse(cleanJsonText(rawText));
    return this.normalizePlannerOutput(parsed, task, context, options, modelName, startTime);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
    ]);
  }

  private getMistralClient(): OpenAI | null {
    const apiKey = getRuntimeApiKey('mistral');
    if (!apiKey) {
      console.warn('[TaskPlanner] No Mistral key is configured in Settings. Will use fallback decomposition.');
      return null;
    }
    if (!this.mistral || this.mistralApiKey !== apiKey) {
      this.mistral = new OpenAI({
        apiKey,
        baseURL: 'https://api.mistral.ai/v1',
      });
      this.mistralApiKey = apiKey;
    }
    return this.mistral;
  }

  public async decompose(task: string, context = '', mode: MainAgentMode = 'think', options: TaskPlanningOptions = {}): Promise<PlannerPlan> {
    const safeMode = normalizeMainAgentMode(mode);
    const modelConfig = getMainAgentModelConfig(safeMode);
    const maxSteps = this.maxSteps(options);
    console.log(`[TaskPlanner] Generating execution plan via selected model: ${modelConfig.modelName} (max ${maxSteps})`);
    const startTime = Date.now();

    const prompt = [
      `Task: ${task}`,
      context ? `Additional context: ${context}` : '',
      `Planner constraints: max_steps=${maxSteps}. Produce concrete, task-specific operational steps. No generic "fix code" or "implement core" items.`,
    ].filter(Boolean).join('\n\n');

    if (modelConfig.provider === 'mistral') {
      const client = this.getMistralClient();
      if (!client) return this.fallbackDecompose(task, context, options);
      try {
        const response = await this.withTimeout(
          client.chat.completions.create({
            model: modelConfig.modelName,
            messages: [
              { role: 'system', content: PLANNER_SYSTEM_PROMPT },
              { role: 'user', content: prompt },
            ],
            temperature: 0.15,
            response_format: { type: 'json_object' },
          } as any),
          15000,
        );
        return this.parsePlannerResponse(String(response.choices?.[0]?.message?.content || ''), task, context, options, startTime, modelConfig.modelName);
      } catch (error: any) {
        console.warn(`[TaskPlanner] Selected model ${modelConfig.modelName} failed: ${error.message}. Using fallback decomposition.`);
        return this.fallbackDecompose(task, context, options);
      }
    }

    const gemini = this.getGeminiClient();
    if (!gemini) {
      console.warn('[TaskPlanner] No API client available. Using fallback.');
      return this.fallbackDecompose(task, context, options);
    }

    const plannerModels = Array.from(new Set([modelConfig.modelName, ...getPlannerFallbackModels()]));
    for (const modelName of plannerModels) {
      try {
        console.log(`[TaskPlanner] Trying model: ${modelName}...`);
        const response = await this.withTimeout(
          gemini.models.generateContent({
            model: modelName,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
              systemInstruction: PLANNER_SYSTEM_PROMPT,
              thinkingConfig: {
                thinkingLevel: ThinkingLevel.LOW,
                includeThoughts: false,
              },
            },
          }),
          15000,
        );

        return this.parsePlannerResponse(response.text || '', task, context, options, startTime, modelName);
      } catch (modelError: any) {
        console.warn(`[TaskPlanner] Model ${modelName} failed: ${modelError.message}. Trying next...`);
      }
    }

    console.error('[TaskPlanner] All models failed. Using fallback decomposition.');
    return this.fallbackDecompose(task, context, options);
  }

  private fallbackDecompose(task: string, context = '', options: TaskPlanningOptions = {}): PlannerPlan {
    const maxSteps = this.maxSteps(options);
    const types = chooseFallbackTypes(task, context, maxSteps);
    const steps = sortAndReindexSteps(
      types.map((type, index) => buildOperationalStep(type, task, context, index, types.length)),
      task,
      context,
    );

    return {
      steps,
      estimated_complexity: estimateComplexity(steps.length, task, context),
      estimated_time_minutes: estimateMinutes(steps.length, task, context),
      planner_version: 'task_planner_v4_fallback',
      quality_warnings: ['Used task-aware fallback planner because model planning was unavailable or invalid.'],
    };
  }
}

export const globalTaskPlanner = new TaskPlannerClient();
