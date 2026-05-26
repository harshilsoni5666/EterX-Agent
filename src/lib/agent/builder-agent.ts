import fs from 'fs-extra';
import path from 'path';
import { globalToolRegistry } from './tools/registry';
import type { MainAgentMode } from './model-routing';

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

export interface AgentBuilderProfile {
  agentId: string;
  version: 1;
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
}

const AGENT_BUILDER_ROOT = path.resolve(process.cwd(), '.workspaces', 'agent-builder', 'agents');
const BUILDER_TOOL_PREFIX = 'agent_builder_';
const LEGACY_BUILDER_TOOL_NAMES = new Set(['agent_cron_scheduler', 'agent_connector_trigger']);
const GLOBAL_DYNAMIC_TOOL_NAMES = new Set(['create_dynamic_tool']);

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
  return toolName.startsWith(BUILDER_TOOL_PREFIX) || LEGACY_BUILDER_TOOL_NAMES.has(toolName);
}

export function shouldExposeToolToRuntime(toolName: string, isBuilder: boolean): boolean {
  if (!isBuilder && isBuilderOnlyToolName(toolName)) return false;
  if (isBuilder && GLOBAL_DYNAMIC_TOOL_NAMES.has(toolName)) return false;
  return true;
}

export function buildAgentBuilderPinnedContext(chatId: string, pinnedContext: any = null): Record<string, unknown> {
  if (!isAgentBuilderChatId(chatId)) return pinnedContext || {};
  return {
    ...(pinnedContext || {}),
    agentRuntime: AGENT_BUILDER_RUNTIME,
    agentId: getAgentIdFromBuilderChatId(chatId),
    disableOverdelivery: false,
  };
}

export function getAgentBuilderMode(mode: MainAgentMode): MainAgentMode {
  return mode === 'mistral' ? mode : 'think';
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
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
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
  return path.join(AGENT_BUILDER_ROOT, sanitizeAgentBuilderId(agentId), 'profile.json');
}

export function getAgentBuilderToolPath(agentId: string, toolName: string): string {
  return path.join(AGENT_BUILDER_ROOT, sanitizeAgentBuilderId(agentId), 'tools', `${sanitizeAgentToolName(toolName)}.json`);
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
  await fs.ensureDir(path.dirname(profilePath));
  await fs.writeJson(profilePath, normalized, { spaces: 2 });
  return profilePath;
}

export async function upsertAgentBuilderProfile(
  agentId: string,
  mutate: (profile: AgentBuilderProfile) => AgentBuilderProfile | Promise<AgentBuilderProfile>
): Promise<{ profile: AgentBuilderProfile; path: string }> {
  const current = await readAgentBuilderProfile(agentId);
  const next = await mutate(current);
  const savedPath = await writeAgentBuilderProfile(next);
  return { profile: next, path: savedPath };
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

export function buildAgentBuilderRuntimePrompt(agentId: string): string {
  const mainToolNames = globalToolRegistry.getAllTools()
    .map(tool => tool.name)
    .filter(name => !isBuilderOnlyToolName(name))
    .filter(name => !GLOBAL_DYNAMIC_TOOL_NAMES.has(name))
    .sort()
    .join(', ');

  return `
AGENT BUILDER CORE
Target agent ID: ${sanitizeAgentBuilderId(agentId)}

You are a separate builder agent. You configure custom agents. You do not rewrite, mutate, or depend on the main EterX system prompt. Your persistent output is an agent-scoped profile under .workspaces/agent-builder/agents/.

Five-task builder contract:
1. Clarify the target agent's job from the user's words. If enough signal exists, proceed without asking.
2. Write a deep professional system prompt for that target agent: role, mission, operating principles, tool policy, safety boundaries, decision rules, output style, and completion criteria.
3. Design the target agent's toolset before adding tools. Prefer direct main-tool references when an existing tool already fits.
4. Add tools safely in real time by calling builder-only tools:
   - agent_builder_save_profile for the prompt and agent behavior.
   - agent_builder_attach_main_tool for direct access to existing main tools.
   - agent_builder_define_tool for agent-scoped custom tools.
   - agent_builder_finalize when the agent is ready.
5. Report exactly what was configured, which tools were attached or drafted, and what remains missing.

Prompt-writing standard:
- The target agent prompt must be specific, operational, and reusable across many cases.
- Include explicit "when to use tools" and "when to ask the user" rules.
- Include anti-hallucination, verification, security, and scope-control rules.
- Include output contracts for common outcomes: code, research, docs, data, automation, UI, and integrations when relevant.
- Avoid fluffy persona text. Use precise professional instructions the runtime can obey.

Tool-design standard:
- If the user names a tool with @tool_name, treat it as a direct main-tool attach request.
- If an existing main tool solves the need, use agent_builder_attach_main_tool. Do not write duplicate code.
- Use agent_builder_define_tool with implementationType="prompt_macro" for pure prompt behavior.
- Use implementationType="tool_chain" for a safe chain of existing tools.
- Use implementationType="agent_scoped_code" only when a real custom implementation is needed. Code drafts are stored per agent and must never be globally registered.
- Never call create_dynamic_tool in builder mode. It is global, not agent-scoped.

Security and separation:
- Builder changes are for the target agent only.
- Do not edit src/lib/agent/gemini.ts, orchestrator.ts, agent-registry.ts, tools/index.ts, or the main prompt to configure a user agent.
- Do not create or modify global runtime tools for a custom agent.
- Do not expose secrets or ask for connector credentials. Connector auth is handled by connector tools.
- Custom code must be non-destructive and must pass the agent-scoped code safety check.

Existing main tools that can be attached by reference:
${mainToolNames || 'No main tools loaded yet.'}
`.trim();
}

export function buildAgentBuilderStandaloneSystemInstruction(agentId = 'standalone-builder'): string {
  return [
    buildAgentBuilderRuntimePrompt(agentId),
    '',
    'Communication style for the standalone builder route:',
    '- Short bullets.',
    '- No paragraphs unless producing the final prompt.',
    '- If persisting is unavailable in this route, produce a complete agent prompt and tool plan the user can apply.',
  ].join('\n');
}

function normalizeAgentBuilderProfile(value: any, fallbackAgentId: string): AgentBuilderProfile {
  const now = new Date().toISOString();
  const agentId = sanitizeAgentBuilderId(value?.agentId || fallbackAgentId);
  return {
    agentId,
    version: 1,
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
    directMainTools: Array.isArray(value?.directMainTools) ? value.directMainTools : [],
    customTools: Array.isArray(value?.customTools) ? value.customTools : [],
    notes: Array.isArray(value?.notes) ? value.notes.map(String) : [],
  };
}
