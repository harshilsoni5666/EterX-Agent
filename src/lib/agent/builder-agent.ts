import fs from 'fs-extra';
import path from 'path';
import { WORK_NOTE_POLICY } from './work-note';
import { FINAL_ANSWER_POLICY } from './response-format';
import { SOURCE_READING_POLICY } from './source-read-policy';
import { WORKSPACE_EDIT_DESCRIPTION, WORKSPACE_EDIT_POLICY } from './workspace-edit-contract';
import { AGENT_EXECUTION_POLICY } from './execution-operating-policy';
import { globalToolRegistry, normalizeRegistryToolName } from './tools/registry';
import type { MainAgentMode } from './model-routing';
import { getEterxWorkspaceDir } from './storage-paths';

export const AGENT_BUILDER_RUNTIME = 'agent_builder';

export type AgentBuilderImplementationType = 'prompt_macro' | 'tool_chain' | 'agent_scoped_code';

export interface AgentBuilderDirectTool {
  toolName: string;
  purpose: string;
  whenToUse: string;
  inputPolicy?: string;
  outputPolicy?: string;
  promptInjection?: string;
  attachedAt: string;
}

export interface AgentBuilderCustomTool {
  toolName: string;
  description: string;
  implementationType: AgentBuilderImplementationType;
  inputSchema?: Record<string, unknown>;
  behaviorPrompt?: string;
  toolChain?: Array<{ tool: string; purpose: string; argsTemplate?: Record<string, unknown> }>;
  code?: string;
  safetyStatus: 'safe' | 'needs_review' | 'blocked';
  safetyNotes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentBuilderRevision {
  revision: number;
  timestamp: string;
  summary: string;
  changedFields: string[];
}

export interface AgentBuilderProfile {
  agentId: string;
  version: 1;
  revision?: number;
  revisionHistory?: AgentBuilderRevision[];
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'ready';
  name?: string;
  mission?: string;
  professionalPrompt?: string;
  responseStyle?: string;
  behaviorRules: string[];
  safetyRules: string[];
  skills: string[];
  toolUsePolicy?: string;
  completionCriteria?: string;
  directMainTools: AgentBuilderDirectTool[];
  customTools: AgentBuilderCustomTool[];
  notes: string[];
  presentation: {
    description?: string;
    category?: string;
    accentColor?: string;
    starterPrompts: string[];
  };
}

export interface AgentBuilderProfileSummary {
  agentId: string;
  revision: number;
  status: 'draft' | 'ready';
  name?: string;
  mission?: string;
  promptCharacters: number;
  behaviorRuleCount: number;
  safetyRuleCount: number;
  skillCount: number;
  directToolNames: string[];
  customToolNames: string[];
  presentation: AgentBuilderProfile['presentation'];
  updatedAt: string;
  recentRevisions: AgentBuilderRevision[];
}

/**
 * Every finalized agent gets a dependable baseline capability set. The
 * builder can still attach additional tools, but a profile is never left
 * unusable just because the model forgot one of the foundational calls.
 */
export const AGENT_BUILDER_BASELINE_TOOL_NAMES = [
  'web_search',
  'workspace_edit_file',
  'workspace_run_command',
] as const;

const CUSTOM_AGENT_TRAINING_MARKER = 'CUSTOM AGENT TRAINING STANDARD v1';

const uniqueStrings = (values: unknown[] = []): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
};

/** Return the exact tool names a saved custom agent is allowed to call. */
export function getCustomAgentAllowedToolNames(profile: Partial<AgentBuilderProfile> | null | undefined): Set<string> {
  // Exact recall is part of the runtime's context contract, not an optional
  // business capability. Compaction capsules can carry integrity-checked page
  // references, so every custom agent must be able to open those references
  // even when its saved profile did not explicitly attach the internal tool.
  const names = new Set<string>(['context_memory']);
  for (const ref of profile?.directMainTools || []) {
    const name = normalizeRegistryToolName(String(ref?.toolName || '').trim());
    if (name && !isBuilderOnlyToolName(name)) names.add(name);
  }
  for (const tool of profile?.customTools || []) {
    const name = String(tool?.toolName || '').trim();
    if (name && tool?.safetyStatus !== 'blocked') names.add(name);
  }
  return names;
}

function buildAttachedToolReference(toolName: string, existing?: AgentBuilderDirectTool): AgentBuilderDirectTool {
  if (existing) return existing;
  if (toolName === 'workspace_edit_file') {
    return {
      toolName,
      purpose: 'Create, edit, or delete one file, or apply one related multi-file change through the shared live file lifecycle.',
      whenToUse: 'Use for authoring source, text, and generator scripts. Execute generators and converters with the terminal to create binary deliverables.',
      inputPolicy: WORKSPACE_EDIT_DESCRIPTION,
      outputPolicy: 'Inspect the settled result and real diff. Treat the live preview and final diff as one operation; do not repeat the edit merely to refresh UI state.',
      attachedAt: new Date().toISOString(),
    };
  }
  return {
    toolName,
    purpose: `Use ${toolName} when the user's request requires the capability it provides.`,
    whenToUse: `Use when the current request needs ${toolName}; do not call it when the answer is already grounded in the conversation.`,
    inputPolicy: 'Validate arguments against the tool schema and keep identifiers, paths, dates, and units explicit.',
    outputPolicy: 'Use the actual result, handle errors, and preserve source details. Verify only when relevant and permitted; report skipped verification honestly.',
    attachedAt: new Date().toISOString(),
  };
}

/** Add the baseline tools without overwriting deliberate guidance. */
export function ensureAgentBaselineTools(profile: AgentBuilderProfile): AgentBuilderProfile {
  const names = [...AGENT_BUILDER_BASELINE_TOOL_NAMES];
  const existing = new Map<string, AgentBuilderDirectTool>();
  for (const ref of profile.directMainTools || []) {
    const toolName = normalizeRegistryToolName(String(ref?.toolName || '').trim());
    if (!toolName || isBuilderOnlyToolName(toolName) || !globalToolRegistry.getTool(toolName)) continue;
    const reference = { ...ref, toolName };
    if (toolName === 'workspace_edit_file' && reference.whenToUse === 'Use for every persistent file mutation. Do not create or edit source files through shell commands.') {
      reference.whenToUse = 'Use for authoring source, text, and generator scripts. Execute generators and converters with the terminal to create binary deliverables.';
    }
    existing.set(toolName, reference);
  }
  for (const toolName of names) {
    if (!globalToolRegistry.getTool(toolName) || existing.has(toolName)) continue;
    existing.set(toolName, buildAttachedToolReference(toolName));
  }
  return { ...profile, directMainTools: Array.from(existing.values()) };
}

/**
 * This is deliberately domain-neutral. It teaches the builder how to adapt
 * to different requests instead of hard-coding one agent persona or output
 * format into every profile.
 */
export function buildCustomAgentTrainingStandard(agentName = 'Custom Agent'): string {
  return `
## ${CUSTOM_AGENT_TRAINING_MARKER}

You are ${agentName}, a configurable custom agent. Adapt your behavior to the user's current request, not to a fixed persona or hard-coded response template.

### Request interpretation and mode switching
1. Classify the request before acting: domain, task type, audience, desired outcome, constraints, risk level, freshness requirement, and whether the user wants an answer, analysis, plan, file, code, or external action.
2. Reuse the target agent's mission as a boundary, then select the right operating mode for the current request. A single agent may switch between concise answers, research, structured analysis, coding, data work, document creation, or controlled actions when its attached tools and mission support them.
3. Ask no more than one clarifying question when a missing detail truly blocks a safe, accurate result. Otherwise state a reasonable assumption and continue. Never ask for permission to perform an ordinary reversible step.
4. Match depth and format to the request. Be brief for simple questions, thorough for complex work, and use tables, steps, code, or files only when they improve the requested outcome.

### Real-data and evidence discipline
1. Treat user-provided files, workspace data, connector results, and verified tool outputs as evidence. Do not invent facts, records, metrics, prices, names, citations, test results, or completed actions.
2. For current, changing, or high-consequence information, use an appropriate attached research or data tool. Record the source and relevant date, period, units, assumptions, or limitations. Prefer primary or authoritative sources when available.
3. Distinguish observed data, derived calculations, estimates, scenarios, and recommendations. Use a small terminal script for arithmetic and verify important transformations, units, and totals.
4. If real data is missing, stale, contradictory, or inaccessible, say exactly what is known, what is not verified, and what input would resolve it. Never turn a placeholder into a factual claim.

### Tool and recovery behavior
${AGENT_EXECUTION_POLICY}
- ${SOURCE_READING_POLICY}
- Use only attached tools. The current host environment and declared schemas override older profile examples of paths, shell commands, dependencies, and tool names. No startup inventory or environment action is needed.

### Adaptive output and completion
Follow the current runtime's shared final-answer and work-note guidance for ordinary replies. Preserve user-requested and specialist deliverable formats; keep domain-specific output requirements here instead of copying a universal reply template into the profile.
`.trim();
}

export function applyAgentBuilderDefaults(profile: AgentBuilderProfile): AgentBuilderProfile {
  const next = ensureAgentBaselineTools(profile);
  // Refresh exact defaults emitted by older builders, preserving bespoke rules.
  const toolUseDefault = 'Use attached tools when they advance the task. Reuse supplied host paths and prior results. Author source/text with workspace_edit_file and execute generators for binary outputs. Respect user constraints on checks and tests.';
  const completionDefault = 'Deliver the requested outcome in its requested format, ground material claims in actual results, and state relevant limitations, blockers, or skipped verification.';
  const oldToolUseDefault = 'Use attached tools only when they materially help. For current or consequential claims, gather and verify real evidence; use the terminal for calculations and checks; use workspace_edit_file for every file creation, edit, deletion, or related multi-file mutation.';
  const oldCompletionDefault = 'The requested outcome is delivered in the appropriate format, material claims are grounded in real evidence, important outputs are verified, and assumptions, limitations, or blockers are explicit.';
  const prompt = String(next.professionalPrompt || '').trim();
  const trainingMarkerIndex = prompt.indexOf(`## ${CUSTOM_AGENT_TRAINING_MARKER}`);
  const bespokePrompt = (trainingMarkerIndex >= 0 ? prompt.slice(0, trainingMarkerIndex) : prompt).trim();
  return {
    ...next,
    professionalPrompt: `${bespokePrompt}\n\n${buildCustomAgentTrainingStandard(next.name || next.agentId)}`.trim(),
    responseStyle: next.responseStyle || 'Adaptive, direct, accurate, and proportional to the request.',
    behaviorRules: uniqueStrings([
      ...(next.behaviorRules || []).filter(rule => rule !== 'Verify important outputs and state assumptions or limitations clearly.'),
      'Interpret each request before choosing a response mode or tool plan.',
      'Use real user, workspace, connector, or verified external data; never invent missing values.',
      'Match response depth and format to the request instead of using a fixed template.',
      'Verify important outputs when relevant and permitted; state assumptions, limitations, and skipped verification clearly.',
    ]),
    safetyRules: uniqueStrings([
      ...(next.safetyRules || []),
      'Never fabricate data, sources, actions, tool results, or completion status.',
      'Do not exceed the mission or call tools that are not attached to the profile.',
      'Never expose credentials, secrets, or private data in output or artifacts.',
    ]),
    skills: uniqueStrings([
      ...(next.skills || []),
      'request interpretation and mode switching',
      'real-data grounding and source evaluation',
      'tool planning and bounded recovery',
    ]),
    toolUsePolicy: !next.toolUsePolicy || next.toolUsePolicy === oldToolUseDefault ? toolUseDefault : next.toolUsePolicy,
    completionCriteria: !next.completionCriteria || next.completionCriteria === oldCompletionDefault ? completionDefault : next.completionCriteria,
    notes: uniqueStrings([...(next.notes || []), 'Adaptive custom-agent training standard applied by Agent Builder.']),
  };
}

export function evaluateAgentBuilderProfile(profile: AgentBuilderProfile): {
  score: number;
  ready: boolean;
  trainingStandard: boolean;
  checks: Array<{ id: string; label: string; passed: boolean; detail: string }>;
  missing: string[];
  warnings: string[];
} {
  const trainingStandard = String(profile.professionalPrompt || '').includes(CUSTOM_AGENT_TRAINING_MARKER);
  const allowedTools = getCustomAgentAllowedToolNames(profile);
  const missionText = String(profile.mission || '').trim();
  const promptText = String(profile.professionalPrompt || '').trim();
  const trainingMarkerIndex = promptText.indexOf(`## ${CUSTOM_AGENT_TRAINING_MARKER}`);
  const bespokePromptText = (trainingMarkerIndex >= 0 ? promptText.slice(0, trainingMarkerIndex) : promptText).trim();
  const checks = [
    { id: 'mission', label: 'Mission', passed: missionText.length >= 32 && !/being configured|configure this agent/i.test(missionText), detail: 'A specific mission anchors scope and distinguishes the target agent.' },
    { id: 'prompt', label: 'Professional prompt', passed: promptText.length >= 1200 && bespokePromptText.length >= 500 && !/configure this agent according to the builder conversation/i.test(promptText), detail: 'The prompt contains bespoke operating guidance in addition to the shared training standard.' },
    { id: 'behavior', label: 'Behavior rules', passed: profile.behaviorRules.length >= 3, detail: 'At least three testable operating rules are present.' },
    { id: 'safety', label: 'Safety rules', passed: profile.safetyRules.length >= 2, detail: 'At least two explicit safety boundaries are present.' },
    { id: 'tools', label: 'Baseline tools', passed: AGENT_BUILDER_BASELINE_TOOL_NAMES.filter(name => globalToolRegistry.getTool(name)).every(name => allowedTools.has(name)), detail: 'Core web, workspace-edit, and terminal tools are attached.' },
    { id: 'policy', label: 'Tool-use policy', passed: !!profile.toolUsePolicy?.trim(), detail: 'The agent knows when to use tools and how to validate results.' },
    { id: 'completion', label: 'Completion criteria', passed: !!profile.completionCriteria?.trim(), detail: 'The agent has a concrete done condition.' },
    { id: 'training-standard', label: 'Adaptive training standard', passed: trainingStandard, detail: 'The agent can shift modes across different request types while preserving real-data and scope discipline.' },
  ];
  const missing = checks.filter(check => !check.passed).map(check => check.label);
  const warnings: string[] = [];
  if (!String(profile.presentation?.description || '').trim()) {
    warnings.push('Add a concise library description so users can understand the agent before opening it.');
  }
  if (!String(profile.presentation?.category || '').trim()) {
    warnings.push('Add a short category for clearer discovery in the Agents library.');
  }
  if ((profile.presentation?.starterPrompts || []).length < 2) {
    warnings.push('Add at least two realistic starter prompts that demonstrate distinct supported jobs.');
  }
  if (profile.directMainTools.length > 24) {
    warnings.push('The agent has a broad tool surface. Remove unrelated capabilities or make the tool-use policy especially selective.');
  }
  const genericToolPolicies = profile.directMainTools.filter(tool =>
    new RegExp(`Use ${tool.toolName} when (?:it is )?relevant`, 'i').test(tool.purpose)
    || /when the user's request requires the capability/i.test(tool.whenToUse),
  );
  if (genericToolPolicies.length > 3) {
    warnings.push(`${genericToolPolicies.length} attached capabilities still have generic usage policies; tailor them to this agent's mission.`);
  }
  if (promptText.length > 18_000) {
    warnings.push('The professional prompt is unusually long. Remove repeated universal guidance and keep domain-specific instructions operational.');
  }
  const score = Math.round((checks.filter(check => check.passed).length / Math.max(1, checks.length)) * 100);
  return { score, ready: missing.length === 0, trainingStandard, checks, missing, warnings };
}

const AGENT_BUILDER_ROOT = getEterxWorkspaceDir('agent-builder', 'agents');
const BUILDER_TOOL_PREFIX = 'agent_builder_';
const BUILDER_RUNTIME_TOOL_NAMES = new Set([
  'agent_tool_load',
  'agent_tool_unload',
  'agent_flow_blackboard_set',
  'agent_flow_blackboard_get',
  'agent_flow_blackboard_list',
]);
// The builder needs a small live connector surface so it can inspect and
// verify the real connection state while configuring a target agent. These
// are not builder-only tools: they remain attachable to finalized agents.
const BUILDER_LIVE_CONNECTOR_TOOL_NAMES = new Set([
  'gateway_bridge',
  'connector_mcp',
]);

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

export function isAgentBuilderChatId(chatId?: string | null): boolean {
  return typeof chatId === 'string' && chatId.startsWith('agent_builder_');
}

export function getAgentIdFromBuilderChatId(chatId: string): string {
  return chatId.replace(/^agent_builder_/, '').trim() || 'unknown-agent';
}

export function isAgentBuilderRuntimeContext(context: any): boolean {
  return context?.agentRuntime === AGENT_BUILDER_RUNTIME || isAgentBuilderChatId(context?.projectId);
}

export function isBuilderOnlyToolName(toolName: string): boolean {
  return toolName.startsWith(BUILDER_TOOL_PREFIX) || BUILDER_RUNTIME_TOOL_NAMES.has(toolName);
}

export function isBuilderLiveConnectorToolName(toolName: string): boolean {
  return BUILDER_LIVE_CONNECTOR_TOOL_NAMES.has(toolName);
}

export function shouldExposeToolToRuntime(toolName: string, isBuilder: boolean): boolean {
  if (isBuilder) {
    // Agent Builder has its own control surface, plus the two real connector
    // bridges needed to inspect/verify live integrations during setup. Other
    // main-agent tools are attached to the target profile by reference and
    // must not be callable by the builder conversation.
    return isBuilderOnlyToolName(toolName) || isBuilderLiveConnectorToolName(toolName);
  }
  return !isBuilderOnlyToolName(toolName);
}

export function buildAgentBuilderPinnedContext(chatId: string, pinnedContext: any = null): Record<string, unknown> {
  if (!isAgentBuilderChatId(chatId)) return pinnedContext || {};
  return {
    ...(pinnedContext || {}),
    agentRuntime: AGENT_BUILDER_RUNTIME,
    agentId: getAgentIdFromBuilderChatId(chatId),
    ...(String(pinnedContext?.agentName || '').trim() ? { agentName: String(pinnedContext.agentName).trim() } : {}),
    disableOverdelivery: false,
  };
}

export function getAgentBuilderMode(mode: MainAgentMode): MainAgentMode {
  // Keep the user's exact provider route. Builder used to collapse every
  // provider except Mistral to `think`, which made the registry acquire a
  // Gemini route before the selected provider/model reached the orchestrator.
  return mode;
}

export function buildAgentBuilderUserRequest(agentId: string, userPrompt: string): string {
  return [
    '[AGENT BUILDER REQUEST]',
    `Target agent ID: ${agentId}`,
    '',
    '[USER REQUEST]',
    userPrompt,
  ].join('\n');
}

export function sanitizeAgentBuilderId(value: string): string {
  return String(value || 'agent')
    .trim()
    .replace(/^agent_builder_/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 96) || 'agent';
}

export function sanitizeAgentToolName(value: string): string {
  const safe = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || `agent_tool_${Date.now()}`;
}

export function getAgentBuilderProfilePath(agentId: string): string {
  return resolveUnder(AGENT_BUILDER_ROOT, sanitizeAgentBuilderId(agentId), 'profile.json');
}

export function getAgentBuilderToolPath(agentId: string, toolName: string): string {
  return resolveUnder(AGENT_BUILDER_ROOT, sanitizeAgentBuilderId(agentId), 'tools', `${sanitizeAgentToolName(toolName)}.json`);
}

export async function readAgentBuilderProfile(agentId: string): Promise<AgentBuilderProfile> {
  const now = new Date().toISOString();
  const profilePath = getAgentBuilderProfilePath(agentId);
  if (await fs.pathExists(profilePath)) {
    const saved = await fs.readJson(profilePath);
    return normalizeAgentBuilderProfile(saved, agentId);
  }
  return normalizeAgentBuilderProfile({
    agentId: sanitizeAgentBuilderId(agentId),
    version: 1,
    createdAt: now,
    updatedAt: now,
    status: 'draft',
    behaviorRules: [],
    safetyRules: [],
    skills: [],
    directMainTools: [],
    customTools: [],
    notes: [],
  }, agentId);
}

export async function writeAgentBuilderProfile(profile: AgentBuilderProfile): Promise<string> {
  const normalized = normalizeAgentBuilderProfile(profile, profile.agentId);
  normalized.updatedAt = new Date().toISOString();
  const profilePath = getAgentBuilderProfilePath(normalized.agentId);
  await writeJsonAtomic(profilePath, normalized);
  return profilePath;
}

export function summarizeAgentBuilderProfile(profile: AgentBuilderProfile): AgentBuilderProfileSummary {
  return {
    agentId: profile.agentId,
    revision: Math.max(0, Number(profile.revision || 0)),
    status: profile.status,
    name: profile.name,
    mission: profile.mission,
    promptCharacters: String(profile.professionalPrompt || '').length,
    behaviorRuleCount: profile.behaviorRules.length,
    safetyRuleCount: profile.safetyRules.length,
    skillCount: profile.skills.length,
    directToolNames: profile.directMainTools.map(tool => tool.toolName),
    customToolNames: profile.customTools.map(tool => tool.toolName),
    presentation: profile.presentation,
    updatedAt: profile.updatedAt,
    recentRevisions: (profile.revisionHistory || []).slice(-6),
  };
}

const REVISION_TRACKED_FIELDS: Array<keyof AgentBuilderProfile> = [
  'status',
  'name',
  'mission',
  'professionalPrompt',
  'responseStyle',
  'behaviorRules',
  'safetyRules',
  'skills',
  'toolUsePolicy',
  'completionCriteria',
  'directMainTools',
  'customTools',
  'notes',
  'presentation',
];

function getChangedAgentBuilderFields(before: AgentBuilderProfile, after: AgentBuilderProfile): string[] {
  return REVISION_TRACKED_FIELDS.filter(field => {
    try {
      return JSON.stringify(before[field]) !== JSON.stringify(after[field]);
    } catch {
      return before[field] !== after[field];
    }
  }).map(String);
}

export async function upsertAgentBuilderProfile(
  agentId: string,
  mutate: (profile: AgentBuilderProfile) => AgentBuilderProfile | Promise<AgentBuilderProfile>,
  revisionSummary?: string,
): Promise<{ profile: AgentBuilderProfile; path: string; changedFields: string[] }> {
  const current = await readAgentBuilderProfile(agentId);
  const next = normalizeAgentBuilderProfile(await mutate(current), current.agentId);
  const changedFields = getChangedAgentBuilderFields(current, next);
  const revision = Math.max(0, Number(current.revision || 0)) + (changedFields.length > 0 ? 1 : 0);
  const profile: AgentBuilderProfile = changedFields.length > 0
    ? {
        ...next,
        revision,
        revisionHistory: [
          ...(current.revisionHistory || []),
          {
            revision,
            timestamp: new Date().toISOString(),
            summary: String(revisionSummary || `Updated ${changedFields.join(', ')}`).trim(),
            changedFields,
          },
        ].slice(-30),
      }
    : next;
  const savedPath = await writeAgentBuilderProfile(profile);
  return { profile, path: savedPath, changedFields };
}

export function validateAgentScopedCode(code: string): { allowed: boolean; notes: string[] } {
  const source = String(code || '');
  const notes: string[] = [];
  const blockedPatterns: Array<[RegExp, string]> = [
    [/\bprocess\.exit\b/i, 'process.exit is not allowed'],
    [/\bchild_process\b/i, 'child_process access is not allowed in agent-scoped tools'],
    [/\beval\s*\(/i, 'eval is not allowed'],
    [/\bnew\s+Function\b/i, 'dynamic Function construction is not allowed'],
    [/\bfs\.(rm|rmdir|unlink)\b/i, 'destructive filesystem deletion is not allowed'],
    [/\brm\s+-rf\b/i, 'recursive shell deletion is not allowed'],
    [/\bdel\s+\/[fq]\b/i, 'forced Windows deletion is not allowed'],
    [/\bformat\s+[a-z]:/i, 'drive formatting is not allowed'],
    [/\bpowershell\b.*-encodedcommand/i, 'encoded PowerShell commands are not allowed'],
    [/\bnet\s+user\b/i, 'user account management is not allowed'],
    [/\breg\s+(add|delete)\b/i, 'registry mutation is not allowed'],
  ];

  for (const [pattern, reason] of blockedPatterns) {
    if (pattern.test(source)) notes.push(reason);
  }

  if (source.length > 20000) notes.push('code is too large for a single agent-scoped tool draft');
  if (!source.trim()) notes.push('code is empty');

  return { allowed: notes.length === 0, notes };
}

export function buildAgentBuilderRuntimePrompt(agentId: string, agentName?: string): string {
  return `
You are Agent Builder, the persistent editor for one custom EterX agent.
Target agent ID: ${sanitizeAgentBuilderId(agentId)}
${agentName ? `Current display name: ${String(agentName).trim()}` : ''}

Your job is to turn the user's intent into a durable, editable agent profile. Build the smallest coherent configuration that fully supports the requested work. Prefer precise behavior and relevant capabilities over prompt length, ornamental frameworks, or attaching every available tool.

## Persistent editing model
- The persisted profile is authoritative. A ready agent remains editable in later turns.
- For a new profile, infer a specific mission, write a complete operating prompt, choose relevant capabilities, check quality, and finalize when ready.
- For an existing profile, treat the request as a patch. Preserve every unspecified field and capability. Change only what the user asked for and keep the agent ready by checking and finalizing the revised profile.
- Use agent_builder_get_profile when an exact prior value is needed. The current profile summary and editable text are also supplied by the runtime.
- agent_builder_save_profile accepts partial updates. Omitted fields remain unchanged. Set replaceCollections only when the user explicitly wants a collection replaced.
- Record a short changeSummary on material profile revisions so later turns can understand what changed.

## Design standard
- Translate the request into domain, users, supported jobs, evidence needs, constraints, risk, output expectations, and completion conditions.
- Write an operational prompt, not a manifesto. Include only the identity, domain workflow, decision rules, tool triggers, evidence discipline, recovery behavior, safety boundaries, and output guidance this agent actually needs.
- Keep specialist output requirements in the profile. The runtime supplies shared presentation guidance; do not copy generic formatting rules or force one response template across tasks.
- Make rules testable and resolve conflicts explicitly. Match depth to complexity; never pad a simple agent to a word quota or copy a universal template into every profile.
- Preserve private reasoning. The target agent should communicate conclusions, evidence, assumptions, and useful progress without exposing chain-of-thought.
- Create custom tools only when a genuine capability cannot be expressed with an existing registered tool or ordinary prompt behavior. Do not turn instructions into fake tools.
- The host supplies the OS, shell, native user folders, chat workspace, and process context. Do not encode machine-specific paths, environment surveys, mandatory staging folders, or repeated setup in generated profiles. Preserve user constraints across continuations.

## Capability selection
- Baseline research, workspace editing, and command/verification capabilities are applied deterministically during profile saves.
- Use agent_builder_list_capabilities to discover attachable tools by goal or category. Attach only tools with a clear mission-level use case and precise usage policy.
- Use agent_builder_attach_all_main_tools only when the user explicitly asks for a universal/general-purpose tool surface. It is not the default.
- Use agent_builder_attach_connector_tools only when the mission requires external services. Verify live connector state before claiming that a service is ready.
- Use agent_builder_remove_tool for real removal. Never imply that prose changes detached a capability.

## Quality and completion
- After a material revision, run agent_builder_run_quality_check. Fix failed checks that matter to the requested agent, then call agent_builder_finalize.
- Do not repeatedly save unchanged data, reattach existing tools, or rerun the same check without a change.
- In the final response, lead with what is now ready or what changed. Mention the most relevant capabilities and any real limitation. Include a short try-it prompt for a new agent; for a small later edit, keep the response proportional.
- Keep this builder handoff specific to the agent being created or revised. Explain how to use it when useful, without a compulsory title, capability table, or section sequence. Put a requested full operating prompt in the deliverable; do not repeat it inside a routine completion message.

## Builder communication
- ${WORK_NOTE_POLICY}
- Respond to the current builder request using earlier turns as context. Do not reannounce prior setup as newly completed; distinguish a requested explanation or example from an actual profile revision.
- Do not narrate function names, schema fields, iteration counts, or mechanical steps. Do not emit a note for every tool.

## Safety and separation
- Modify only the target agent profile, its agent-scoped tools, or an explicitly requested agent flow. Never modify the main EterX prompt or global tool code from Builder.
- Never store or reveal secrets in prompts, notes, trace labels, or connector metadata.
- Custom code must pass the scoped safety review. Stop for a genuinely missing secret, irreversible external action, or irreducible user decision; otherwise continue autonomously.
`.trim();
}

export function buildAgentBuilderStandaloneSystemInstruction(agentId = 'standalone-builder'): string {
  return [
    buildAgentBuilderRuntimePrompt(agentId),
    FINAL_ANSWER_POLICY,
    '- If persisting is unavailable in this route, produce a complete agent prompt and tool plan the user can apply.',
  ].join('\n');
}

function normalizeAgentBuilderProfile(value: any, fallbackAgentId: string): AgentBuilderProfile {
  const now = new Date().toISOString();
  const agentId = sanitizeAgentBuilderId(value?.agentId || fallbackAgentId);
  const directMainTools: AgentBuilderDirectTool[] = [];
  const seenDirectTools = new Set<string>();
  for (const raw of Array.isArray(value?.directMainTools) ? value.directMainTools : []) {
    const toolName = normalizeRegistryToolName(String(raw?.toolName || '').trim());
    if (!toolName || seenDirectTools.has(toolName)) continue;
    seenDirectTools.add(toolName);
    directMainTools.push({
      toolName,
      purpose: String(raw?.purpose || `Use ${toolName} when relevant to the mission.`).trim(),
      whenToUse: String(raw?.whenToUse || `Use when the request requires ${toolName}.`).trim(),
      inputPolicy: raw?.inputPolicy ? String(raw.inputPolicy).trim() : undefined,
      outputPolicy: raw?.outputPolicy ? String(raw.outputPolicy).trim() : undefined,
      promptInjection: raw?.promptInjection ? String(raw.promptInjection).trim() : undefined,
      attachedAt: typeof raw?.attachedAt === 'string' ? raw.attachedAt : now,
    });
  }
  const customTools: AgentBuilderCustomTool[] = [];
  const seenCustomTools = new Set<string>();
  for (const raw of Array.isArray(value?.customTools) ? value.customTools : []) {
    const toolName = sanitizeAgentToolName(raw?.toolName);
    if (!toolName || seenCustomTools.has(toolName)) continue;
    seenCustomTools.add(toolName);
    customTools.push({
      toolName,
      description: String(raw?.description || '').trim(),
      implementationType: ['prompt_macro', 'tool_chain', 'agent_scoped_code'].includes(raw?.implementationType)
        ? raw.implementationType
        : 'prompt_macro',
      inputSchema: raw?.inputSchema && typeof raw.inputSchema === 'object' && !Array.isArray(raw.inputSchema) ? raw.inputSchema : undefined,
      behaviorPrompt: raw?.behaviorPrompt ? String(raw.behaviorPrompt) : undefined,
      toolChain: Array.isArray(raw?.toolChain) ? raw.toolChain : undefined,
      code: raw?.code ? String(raw.code) : undefined,
      safetyStatus: raw?.safetyStatus === 'blocked' ? 'blocked' : raw?.safetyStatus === 'needs_review' ? 'needs_review' : 'safe',
      safetyNotes: Array.isArray(raw?.safetyNotes) ? raw.safetyNotes.map(String) : [],
      createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : now,
      updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : now,
    });
  }
  return {
    agentId,
    version: 1,
    revision: Number.isFinite(Number(value?.revision)) ? Math.max(0, Math.floor(Number(value.revision))) : 0,
    revisionHistory: (Array.isArray(value?.revisionHistory) ? value.revisionHistory : [])
      .map((entry: any) => ({
        revision: Math.max(0, Math.floor(Number(entry?.revision || 0))),
        timestamp: typeof entry?.timestamp === 'string' ? entry.timestamp : now,
        summary: String(entry?.summary || 'Updated agent profile').trim(),
        changedFields: uniqueStrings(Array.isArray(entry?.changedFields) ? entry.changedFields : []),
      }))
      .filter((entry: AgentBuilderRevision) => entry.revision > 0)
      .slice(-30),
    createdAt: typeof value?.createdAt === 'string' ? value.createdAt : now,
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : now,
    status: value?.status === 'ready' ? 'ready' : 'draft',
    name: typeof value?.name === 'string' ? value.name : undefined,
    mission: typeof value?.mission === 'string' ? value.mission : undefined,
    professionalPrompt: typeof value?.professionalPrompt === 'string' ? value.professionalPrompt : undefined,
    responseStyle: typeof value?.responseStyle === 'string' ? value.responseStyle : undefined,
    behaviorRules: Array.isArray(value?.behaviorRules) ? value.behaviorRules.map(String) : [],
    safetyRules: Array.isArray(value?.safetyRules) ? value.safetyRules.map(String) : [],
    skills: Array.isArray(value?.skills) ? value.skills.map(String) : [],
    toolUsePolicy: typeof value?.toolUsePolicy === 'string' ? value.toolUsePolicy : undefined,
    completionCriteria: typeof value?.completionCriteria === 'string' ? value.completionCriteria : undefined,
    directMainTools,
    customTools,
    notes: uniqueStrings(Array.isArray(value?.notes) ? value.notes : []),
    presentation: {
      description: typeof value?.presentation?.description === 'string'
        ? value.presentation.description.trim()
        : undefined,
      category: typeof value?.presentation?.category === 'string'
        ? value.presentation.category.trim()
        : undefined,
      accentColor: typeof value?.presentation?.accentColor === 'string'
        ? value.presentation.accentColor.trim()
        : undefined,
      starterPrompts: uniqueStrings(Array.isArray(value?.presentation?.starterPrompts)
        ? value.presentation.starterPrompts
        : []),
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// CUSTOM AGENT RUNTIME — Route custom agents through main pipeline
// ═══════════════════════════════════════════════════════════════

export const CUSTOM_AGENT_RUNTIME = 'custom_agent';
export const AGENT_FLOW_RUNTIME = 'agent_flow';

/**
 * Detect if a context is running a custom agent.
 */
export function isCustomAgentRuntimeContext(context: any): boolean {
  return context?.agentRuntime === CUSTOM_AGENT_RUNTIME && !!context?.customAgentId;
}

/**
 * Build pinnedContext for a custom agent run.
 * Called from /api/chat when agentId is provided.
 */
export function buildCustomAgentPinnedContext(agentId: string, agentName: string, pinnedContext: any = null): Record<string, unknown> {
  return {
    ...(pinnedContext || {}),
    agentRuntime: CUSTOM_AGENT_RUNTIME,
    customAgentId: sanitizeAgentBuilderId(agentId),
    customAgentName: agentName || agentId,
  };
}

/** True when the shared main-agent pipeline is executing a saved workflow. */
export function isAgentFlowRuntimeContext(context: any): boolean {
  return context?.agentRuntime === AGENT_FLOW_RUNTIME && !!context?.flowId;
}

/**
 * Keep flow execution inside the normal chat registry. This gives a flow the
 * same lifecycle, cancellation, workspace policy, transcript, and UI traces
 * as the General agent instead of starting a second transport.
 */
export function buildAgentFlowPinnedContext(flowId: string, flowName: string, pinnedContext: any = null): Record<string, unknown> {
  return {
    ...(pinnedContext || {}),
    agentRuntime: AGENT_FLOW_RUNTIME,
    flowId: sanitizeFlowId(flowId),
    flowName: flowName || flowId,
  };
}

/**
 * Build the runtime prompt injection for a custom agent.
 * Loads the agent's profile from disk and constructs a prompt that
 * overrides the main agent's identity to become the custom agent.
 *
 * This runs synchronously from cached profile data — the profile
 * is loaded once in the chat route and cached in pinnedContext.
 */
export function buildCustomAgentRuntimePrompt(profile: AgentBuilderProfile): string {
  if (!profile || !profile.professionalPrompt) {
    return `--- CUSTOM AGENT ERROR ---\nCustom agent profile is missing or incomplete.\n--- END ---`;
  }

  const parts: string[] = [];

  parts.push(`
═══════════════════════════════════════════════════════════════
CUSTOM AGENT IDENTITY OVERRIDE
═══════════════════════════════════════════════════════════════

You are NOW operating as the custom agent "${profile.name || profile.agentId}".
Use the custom agent profile below for your domain, identity, and response style. Current user instructions and the host execution contract take precedence over generic workflows and stale examples in that profile.
You are NOT the default EterX agent for this conversation.
Introduce yourself as "${profile.name || profile.agentId}" if asked who you are.
`.trim());

  parts.push(`
## EterX Host Runtime Contract
Your custom identity changes the specialist behavior, not the quality of the host runtime. You operate through the same conversation history, provider routing, workspace context, attachments, stopping, recovery, persistence, work timeline, and tool-result UI used by the main agent.

- Treat earlier user turns, answers, tool evidence, and artifact paths in this chat as active continuity. When the user asks for a revision, update the existing artifact or decision in place instead of starting an unrelated replacement.
- ${WORK_NOTE_POLICY}
- Use the exact path, identifier, agent name, tool result, and status returned by the runtime. Do not invent UI state or claim that a card, file, setting, message, or action exists unless the runtime confirms it.
- Your own tool calls remain owned by this custom agent in the main chat feed. Reserve sub-agent identity fields for real delegated workers so the UI does not create false agent tabs.
- The host runtime's security, permission, cancellation, trace, and output contracts remain authoritative even if profile text conflicts with them.
- The current workspace, OS paths, shell, executable discovery, and tool schemas override saved environment assumptions. Honor explicit destinations; use this chat's workspace by default. Author text with the editor and run generators/converters for binary artifacts. User constraints such as no tests or checks take precedence over generic profile verification routines.
`.trim());

  // Core professional prompt (the agent's soul)
  parts.push(`\n## Agent Profile: ${profile.name || profile.agentId}\n\n${profile.professionalPrompt}`);

  // Mission
  if (profile.mission) {
    parts.push(`\n## Mission\n${profile.mission}`);
  }

  // Behavior rules
  if (profile.behaviorRules.length > 0) {
    parts.push(`\n## Operating Rules\n${profile.behaviorRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`);
  }

  // Safety rules
  if (profile.safetyRules.length > 0) {
    parts.push(`\n## Safety Rules\n${profile.safetyRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`);
  }

  // Response style
  if (profile.responseStyle) {
    parts.push(`\n## Response Style\n${profile.responseStyle}`);
  }

  // Tool use policy
  if (profile.toolUsePolicy) {
    parts.push(`\n## Tool Use Policy\n${profile.toolUsePolicy}`);
  }

  const availableToolGuidance = [
    ...profile.directMainTools.map(tool => [
      `### ${tool.toolName}`,
      `Purpose: ${tool.purpose}`,
      `Use when: ${tool.whenToUse}`,
      tool.inputPolicy ? `Input rules: ${tool.inputPolicy}` : '',
      tool.outputPolicy ? `Output rules: ${tool.outputPolicy}` : '',
      tool.promptInjection ? `Special instructions: ${tool.promptInjection}` : '',
    ].filter(Boolean).join('\n')),
    ...profile.customTools
      .filter(tool => tool.safetyStatus !== 'blocked')
      .map(tool => [
        `### ${tool.toolName} (${tool.implementationType})`,
        tool.description,
        tool.behaviorPrompt ? `Behavior: ${tool.behaviorPrompt}` : '',
      ].filter(Boolean).join('\n')),
  ];
  if (availableToolGuidance.length > 0) {
    parts.push(`\n## Attached Runtime Tools\n${availableToolGuidance.join('\n\n')}`);
  }
  // Inject at runtime so existing saved profiles also get the current contract.
  if (getCustomAgentAllowedToolNames(profile).has('workspace_edit_file')) {
    parts.push(`\n## Workspace editing contract\n${WORKSPACE_EDIT_POLICY}`);
  }

  // Completion criteria
  if (profile.completionCriteria) {
    parts.push(`\n## Completion Criteria\n${profile.completionCriteria}`);
  }

  // Scope guard
  parts.push(`
## Scope Guard
You are "${profile.name || profile.agentId}". Stay within your defined mission and capabilities.
If a request is outside your scope, politely explain what you can help with instead.
Use only the tools explicitly attached to this profile and shown in the runtime tool list. If a capability is not attached, do not claim to have it and do not attempt to call it.
`.trim());

  // Preserve useful continuity without imposing a startup ritual on each turn.
  parts.push(`
## Continuity
Resume the active objective using current evidence, existing artifacts, selected workspace, user constraints, and pending process IDs. Do not restart setup, repeat successful dependency probes, or reannounce the same intent after each tool call. Reason privately and report meaningful progress and actual results.
`.trim());

  parts.push(`\n═══════════════════════════════════════════════════════════════`);

  return parts.join('\n');
}

/**
 * Load a custom agent profile and return it, or null if not found/not ready.
 */
export async function loadCustomAgentProfile(agentId: string): Promise<AgentBuilderProfile | null> {
  try {
    const profile = await readAgentBuilderProfile(agentId);
    if (profile.status !== 'ready') return null;
    if (!profile.professionalPrompt || profile.professionalPrompt.length < 50) return null;
    // Apply the current shared runtime contract in memory on every load so
    // previously-created custom agents and flow workers gain tool/schema fixes
    // without rewriting or erasing their bespoke persisted configuration.
    return applyAgentBuilderDefaults(profile);
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// MULTI-AGENT LOOP/FLOW ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════

export interface AgentFlowStep {
  stepId: string;
  agentId: string; // The custom agent or 'default-1' to run (ignored if parallelAgentIds is set)
  promptTemplate: string; // Prompt template, e.g. "Generate data for: {{input}}" (ignored if promptTemplates is set)
  parallelAgentIds?: string[]; // Array of agent IDs to run in parallel
  promptTemplates?: string[]; // Corresponding prompts for parallel agents
  reflection?: {
    evaluatorAgentId: string;
    criteria: string;
    maxRetries: number;
  };
  expectedOutputSchema?: Record<string, unknown>;
  nextStepId?: string; // Standard sequential flow
  conditionalBranches?: Array<{
    conditionExpression: string; // e.g. "output.includes('ERROR')"
    targetStepId: string;
  }>;
}

export interface AgentFlowProfile {
  flowId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'ready';
  steps: AgentFlowStep[];
  maxIterations?: number; // Optional user-configured cycle cap
  notes: string[];
}

const AGENT_FLOWS_ROOT = getEterxWorkspaceDir('agent-builder', 'flows');

export function sanitizeFlowId(value: string): string {
  return String(value || 'flow')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 96) || 'flow';
}

export function getAgentFlowProfilePath(flowId: string): string {
  return resolveUnder(AGENT_FLOWS_ROOT, `${sanitizeFlowId(flowId)}.json`);
}

export async function readAgentFlowProfile(flowId: string): Promise<AgentFlowProfile> {
  const now = new Date().toISOString();
  const filePath = getAgentFlowProfilePath(flowId);
  if (await fs.pathExists(filePath)) {
    const saved = await fs.readJson(filePath);
    return {
      flowId: sanitizeFlowId(flowId),
      name: typeof saved.name === 'string' ? saved.name : flowId,
      description: typeof saved.description === 'string' ? saved.description : '',
      createdAt: typeof saved.createdAt === 'string' ? saved.createdAt : now,
      updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : now,
      status: saved.status === 'ready' ? 'ready' : 'draft',
      steps: Array.isArray(saved.steps) ? saved.steps : [],
      maxIterations: typeof saved.maxIterations === 'number' ? saved.maxIterations : undefined,
      notes: Array.isArray(saved.notes) ? saved.notes.map(String) : [],
    };
  }
  return {
    flowId: sanitizeFlowId(flowId),
    name: flowId,
    description: '',
    createdAt: now,
    updatedAt: now,
    status: 'draft',
    steps: [],
    maxIterations: undefined,
    notes: [],
  };
}

export async function writeAgentFlowProfile(profile: AgentFlowProfile): Promise<string> {
  const flowId = sanitizeFlowId(profile.flowId);
  const filePath = getAgentFlowProfilePath(flowId);
  const normalized: AgentFlowProfile = {
    flowId,
    name: profile.name || flowId,
    description: profile.description || '',
    createdAt: profile.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: profile.status === 'ready' ? 'ready' : 'draft',
    steps: Array.isArray(profile.steps) ? profile.steps : [],
    maxIterations: typeof profile.maxIterations === 'number' ? profile.maxIterations : undefined,
    notes: Array.isArray(profile.notes) ? profile.notes.map(String) : [],
  };
  await fs.ensureDir(path.dirname(filePath));
  await writeJsonAtomic(filePath, normalized);
  return filePath;
}

export async function listAgentFlowProfiles(): Promise<AgentFlowProfile[]> {
  if (!(await fs.pathExists(AGENT_FLOWS_ROOT))) return [];
  const entries = await fs.readdir(AGENT_FLOWS_ROOT);
  const flows: AgentFlowProfile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const flowId = entry.replace('.json', '');
      const flow = await readAgentFlowProfile(flowId);
      flows.push(flow);
    } catch {
      // Ignore corrupted files
    }
  }
  return flows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteAgentFlowProfile(flowId: string): Promise<boolean> {
  const filePath = getAgentFlowProfilePath(flowId);
  if (await fs.pathExists(filePath)) {
    await fs.remove(filePath);
    return true;
  }
  return false;
}

