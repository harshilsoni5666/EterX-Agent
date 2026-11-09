import fs from 'fs-extra';
import { randomUUID } from 'crypto';
import { createIsolatedClient } from '../Agent';
import { agentRegistry } from '../agent-registry';
import { MODEL_PROVIDER_MODE, isModelProvider, parseModelEntryKey } from '../model-selector-store';
import { buildScopedRuntimeSettings, getScopedRuntimeApiKey, type ScopedRuntimeSettings } from '../runtime-api-keys';
import type { MainAgentMode, MainAgentProvider } from '../model-routing';
import { getEterxWorkspaceDir } from '../storage-paths';
import { taskStore } from '../task-store';
import { readProxyControl, subscribeProxyControl, type ProxyTaskInput } from './proxy-control-plane';
import { adaptiveExperience, resolveSelfImprovementEnabled } from '../self-improvement/engine';
import { delegationTelemetryFromTrace } from '../delegation-evidence';
import { CONVERSATION_INTENT_POLICY } from '../conversation-intent-policy';
import { rebaseContextCompactionWindow } from '../model-context-window';

export type ProxyManagerChatMessage = {
  id: string;
  role: 'user' | 'proxy';
  text: string;
  createdAt: number;
  operation?: ProxyManagerOperation;
  delivery?: 'none' | 'active' | 'pending' | 'delivered' | 'rejected' | 'expired' | 'unavailable';
  work?: Array<{ text: string; tool: string }>;
  requestId?: string;
};

type ProxyManagerInput = {
  chatId: string;
  message: string;
  requestId?: string;
  attachmentContext?: string;
  controlGeneration?: number;
  mediaAttachments?: Array<{ path: string; mimeType: string; name?: string; id?: string }>;
  mainModel?: { provider: string; modelId: string };
  workspace?: ProxyTaskInput['workspace'];
  model?: { provider?: string; modelId?: string };
  contextCompaction?: unknown;
  onProgress?: (event: ProxyManagerProgress) => void;
};

export type ProxyManagerOperation = 'none' | 'brief_proxy' | 'guide_adaptively' | 'watch_condition' | 'before_completion' | 'queue_after_current' | 'start_main' | 'schedule_workflow' | 'replace_queued_task' | 'interrupt_main' | 'stop_main';

export type ProxyManagerProgress = {
  type: 'work' | 'status';
  text: string;
  tool?: string;
  phase?: string;
  timestamp: number;
};

type ManagerDecision = {
  reply: string;
  deliveryReplies?: Partial<Record<NonNullable<ProxyManagerChatMessage['delivery']>, string>>;
  stateUpdateProvided?: string[];
  operation: ProxyManagerOperation;
  target: 'proxy' | 'main' | 'both';
  instruction: string;
  intent: 'goal' | 'constraint' | 'correction' | 'preference' | 'follow_up';
  rationale: string;
  evidenceQuality: 'none' | 'contextual' | 'direct' | 'explicit_user';
  counterfactualImpact: 'none' | 'minor' | 'material' | 'critical';
  coordinationCost: 'low' | 'medium' | 'high';
  urgency: 'low' | 'normal' | 'high' | 'critical';
  activationCondition: string;
  scope: 'current_step' | 'current_task' | 'next_task' | 'persistent_mandate';
  supersedesDirectiveId: string;
  supersedesTaskId: string;
  tasks: Array<{ prompt: string; dependency: string; rationale: string }>;
  stateUpdate: {
    activeIntent: string;
    constraints: string[];
    dependencies: string[];
    openDecisions: string[];
    durableOutcomes: string[];
  };
};

type ManagerStore = {
  version: 3;
  chatId: string;
  messages: ProxyManagerChatMessage[];
  pendingConcepts: Array<{
    id: string;
    instruction: string;
    activationCondition: string;
    target: 'proxy' | 'main' | 'both';
    intent: ManagerDecision['intent'];
    rationale: string;
    scope: ManagerDecision['scope'];
    createdAt: number;
    expiresAt: number;
  }>;
  model?: { provider?: string; modelId?: string };
  coordinationModel: ManagerDecision['stateUpdate'] & {
    lastOperation: ProxyManagerOperation;
  };
  updatedAt: number;
};

const proxyManagerGlobal = globalThis as typeof globalThis & {
  __eterxProxyManagerTurnChains?: Map<string, Promise<void>>;
};
const proxyManagerTurnChains = proxyManagerGlobal.__eterxProxyManagerTurnChains
  || (proxyManagerGlobal.__eterxProxyManagerTurnChains = new Map<string, Promise<void>>());
const EMPTY_COORDINATION_MODEL: ManagerStore['coordinationModel'] = {
  activeIntent: '',
  constraints: [],
  dependencies: [],
  openDecisions: [],
  durableOutcomes: [],
  lastOperation: 'none',
};

const compact = (value: unknown, max = 6000) =>
  String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const instructionText = (value: unknown) => typeof value === 'string' ? value.replace(/\u0000/g, '').trim() : '';

const storePath = (chatId: string) => {
  const safe = chatId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 140);
  return getEterxWorkspaceDir('autonomy', 'proxy-manager', `${safe}.json`);
};

function readStore(chatId: string): ManagerStore {
  const target = storePath(chatId);
  for (const source of [target, `${target}.backup`]) {
    try {
      if (!fs.existsSync(source)) continue;
      const saved = fs.readJsonSync(source);
      if ([1, 2, 3].includes(saved?.version) && saved?.chatId === chatId && Array.isArray(saved.messages)) {
        return {
        version: 3,
        chatId,
        messages: saved.messages,
        pendingConcepts: Array.isArray(saved.pendingConcepts) ? saved.pendingConcepts.slice(-16) : [],
        model: saved.model,
        coordinationModel: {
          activeIntent: compact(saved?.coordinationModel?.activeIntent, 2400),
          constraints: Array.isArray(saved?.coordinationModel?.constraints) ? saved.coordinationModel.constraints.slice(-16) : [],
          dependencies: Array.isArray(saved?.coordinationModel?.dependencies) ? saved.coordinationModel.dependencies.slice(-16) : [],
          openDecisions: Array.isArray(saved?.coordinationModel?.openDecisions) ? saved.coordinationModel.openDecisions.slice(-12) : [],
          durableOutcomes: Array.isArray(saved?.coordinationModel?.durableOutcomes) ? saved.coordinationModel.durableOutcomes.slice(-12) : [],
          lastOperation: saved?.coordinationModel?.lastOperation || 'none',
        },
        updatedAt: Number(saved.updatedAt || Date.now()),
        };
      }
    } catch {
      if (source === target) try { fs.renameSync(target, `${target}.corrupt-${Date.now()}`); } catch { }
    }
  }
  return { version: 3, chatId, messages: [], pendingConcepts: [], coordinationModel: { ...EMPTY_COORDINATION_MODEL }, updatedAt: Date.now() };
}

function writeStore(store: ManagerStore): void {
  fs.ensureDirSync(getEterxWorkspaceDir('autonomy', 'proxy-manager'));
  const target = storePath(store.chatId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeJsonSync(temporary, { ...store, messages: store.messages, updatedAt: Date.now() }, { spaces: 2 });
    if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.backup`);
    fs.moveSync(temporary, target, { overwrite: true });
  } finally {
    if (fs.existsSync(temporary)) fs.removeSync(temporary);
  }
}

function extractDecision(raw: string): ManagerDecision {
  const cleaned = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { reply: compact(cleaned, 8000) || 'I could not form a reliable response.', operation: 'none', target: 'proxy', instruction: '', intent: 'preference', rationale: '', evidenceQuality: 'none', counterfactualImpact: 'none', coordinationCost: 'low', urgency: 'normal', activationCondition: '', scope: 'current_task', supersedesDirectiveId: '', supersedesTaskId: '', tasks: [], stateUpdate: { ...EMPTY_COORDINATION_MODEL } };
  try {
    const parsed = JSON.parse(match[0]);
    const operations = new Set<ProxyManagerOperation>(['none', 'brief_proxy', 'guide_adaptively', 'watch_condition', 'before_completion', 'queue_after_current', 'start_main', 'schedule_workflow', 'replace_queued_task', 'interrupt_main', 'stop_main']);
    const targets = new Set(['proxy', 'main', 'both']);
    const intents = new Set(['goal', 'constraint', 'correction', 'preference', 'follow_up']);
    return {
      reply: instructionText(parsed.reply),
      deliveryReplies: parsed.deliveryReplies && typeof parsed.deliveryReplies === 'object'
        ? Object.fromEntries(Object.entries(parsed.deliveryReplies).filter(([key, value]) => ['active', 'pending', 'delivered', 'rejected', 'expired', 'unavailable'].includes(key) && typeof value === 'string').map(([key, value]) => [key, instructionText(value)]))
        : undefined,
      stateUpdateProvided: parsed.stateUpdate && typeof parsed.stateUpdate === 'object' ? Object.keys(parsed.stateUpdate) : [],
      operation: operations.has(parsed.operation) ? parsed.operation : 'none',
      target: targets.has(parsed.target) ? parsed.target : 'proxy',
      instruction: instructionText(parsed.instruction),
      intent: intents.has(parsed.intent) ? parsed.intent : 'preference',
      rationale: compact(parsed.rationale, 1200),
      evidenceQuality: new Set(['none', 'contextual', 'direct', 'explicit_user']).has(parsed.evidenceQuality) ? parsed.evidenceQuality : 'none',
      counterfactualImpact: new Set(['none', 'minor', 'material', 'critical']).has(parsed.counterfactualImpact) ? parsed.counterfactualImpact : 'none',
      coordinationCost: new Set(['low', 'medium', 'high']).has(parsed.coordinationCost) ? parsed.coordinationCost : 'medium',
      urgency: new Set(['low', 'normal', 'high', 'critical']).has(parsed.urgency) ? parsed.urgency : 'normal',
      activationCondition: compact(parsed.activationCondition, 1200),
      scope: new Set(['current_step', 'current_task', 'next_task', 'persistent_mandate']).has(parsed.scope) ? parsed.scope : 'current_task',
      supersedesDirectiveId: compact(parsed.supersedesDirectiveId, 160),
      supersedesTaskId: compact(parsed.supersedesTaskId, 160),
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map((task: any) => ({
        prompt: instructionText(task?.prompt),
        dependency: compact(task?.dependency, 1200),
        rationale: compact(task?.rationale, 1200),
      })).filter((task: any) => task.prompt) : [],
      stateUpdate: {
        activeIntent: compact(parsed?.stateUpdate?.activeIntent, 2400),
        constraints: Array.isArray(parsed?.stateUpdate?.constraints) ? parsed.stateUpdate.constraints.map((item: any) => compact(item, 500)).filter(Boolean).slice(0, 16) : [],
        dependencies: Array.isArray(parsed?.stateUpdate?.dependencies) ? parsed.stateUpdate.dependencies.map((item: any) => compact(item, 500)).filter(Boolean).slice(0, 16) : [],
        openDecisions: Array.isArray(parsed?.stateUpdate?.openDecisions) ? parsed.stateUpdate.openDecisions.map((item: any) => compact(item, 500)).filter(Boolean).slice(0, 12) : [],
        durableOutcomes: Array.isArray(parsed?.stateUpdate?.durableOutcomes) ? parsed.stateUpdate.durableOutcomes.map((item: any) => compact(item, 700)).filter(Boolean).slice(0, 12) : [],
      },
    };
  } catch {
    return { reply: 'I could not interpret the coordination response. No instruction was delivered; please try again.', operation: 'none', target: 'proxy', instruction: '', intent: 'preference', rationale: '', evidenceQuality: 'none', counterfactualImpact: 'none', coordinationCost: 'low', urgency: 'normal', activationCondition: '', scope: 'current_task', supersedesDirectiveId: '', supersedesTaskId: '', tasks: [], stateUpdate: { ...EMPTY_COORDINATION_MODEL } };
  }
}

function resolveModel(selection?: { provider?: string; modelId?: string }): {
  provider: MainAgentProvider;
  mode: MainAgentMode;
  modelId: string;
  settings: ScopedRuntimeSettings;
  apiKey: string;
} {
  const settings = buildScopedRuntimeSettings();
  const requestedProvider = isModelProvider(selection?.provider) ? selection!.provider : null;
  const modelId = compact(selection?.modelId, 220);
  if (!requestedProvider || !modelId) {
    throw new Error('MODEL_SELECTION_REQUIRED: select one exact added model for Proxy Manager.');
  }
  const provider = requestedProvider;
  const scopedSettings: ScopedRuntimeSettings = {
    ...settings,
    modelOverrides: { ...settings.modelOverrides, ...(modelId ? { [provider]: modelId } : {}) },
  };
  return {
    provider,
    mode: MODEL_PROVIDER_MODE[provider],
    modelId,
    settings: scopedSettings,
    apiKey: getScopedRuntimeApiKey(scopedSettings, provider),
  };
}

function groundedOperationReply(
  operation: ProxyManagerOperation,
  delivery: ProxyManagerChatMessage['delivery'],
): string {
  if (delivery === 'unavailable' || delivery === 'rejected' || delivery === 'expired') {
    return 'I could not deliver that request because the required runtime is not active in this chat.';
  }
  const started = delivery === 'active' || delivery === 'delivered';
  if (operation === 'schedule_workflow') {
    return started
      ? 'The workflow has started. Each stage will appear in the Main chat as a delegated user request when it begins.'
      : 'The workflow is queued. Each stage will appear in the Main chat as a delegated user request when it begins.';
  }
  if (operation === 'start_main') return started
    ? 'The request has started and is now visible in the Main chat.'
    : 'The request is queued and will start after the current work settles.';
  if (operation === 'queue_after_current' || operation === 'replace_queued_task') {
    return started
      ? 'The delegated request has started and is now visible in the Main chat.'
      : 'The delegated request is queued and will appear in the Main chat when the current run finishes.';
  }
  if (operation === 'stop_main') return 'The stop request was delivered.';
  if (operation === 'interrupt_main') return delivery === 'delivered'
    ? 'The correction was accepted for Main’s next model boundary.'
    : 'The correction is pending supervisor review.';
  if (operation === 'before_completion') return 'The completion requirement is staged for the final review boundary.';
  if (operation === 'watch_condition') return 'The condition is being watched and will only be delivered if it becomes relevant.';
  if (operation === 'brief_proxy' || operation === 'guide_adaptively') {
    return 'The request was accepted for contextual supervision and will be delivered only if intervention is useful.';
  }
  return '';
}

export function getProxyManagerHistory(chatId: string, afterMessageId?: string): ProxyManagerChatMessage[] {
  const messages = readStore(chatId).messages;
  const index = afterMessageId ? messages.findIndex(message => message.id === afterMessageId) : -1;
  return index < 0 ? messages : messages.slice(index + 1);
}

export function isProxyManagerBusy(chatId: string): boolean {
  return proxyManagerTurnChains.has(chatId);
}

async function runProxyManagerTurn(input: ProxyManagerInput, signal: AbortSignal, stopGenerationAtStart: number): Promise<{ message: ProxyManagerChatMessage; history: ProxyManagerChatMessage[]; model: { provider: string; modelId: string }; wakeRequested: boolean }> {
  const admissionControl = readProxyControl(input.chatId);
  if (!admissionControl.enabled || admissionControl.paused) throw new Error(admissionControl.paused ? 'Proxy is paused. Resume Proxy to continue coordinating.' : 'Turn on Autonomous mode to use Proxy.');
  if (admissionControl.stopGeneration !== stopGenerationAtStart) throw new Error('Proxy controls changed while this request was waiting. Send it again to continue.');
  const store = readStore(input.chatId);
  // A model may change while this turn waits behind another request. Resolve
  // from the saved controls when work starts, not from the earlier UI snapshot.
  const resolved = resolveModel(parseModelEntryKey(admissionControl.modelSelection) || input.model);
  const existingReply = input.requestId ? store.messages.find(item => item.role === 'proxy' && item.requestId === input.requestId) : undefined;
  if (existingReply) return { message: existingReply, history: store.messages, model: { provider: resolved.provider, modelId: resolved.modelId }, wakeRequested: agentRegistry.getProxyManagerContext(input.chatId)?.run?.status === 'running' };
  const userMessage: ProxyManagerChatMessage = {
    id: input.requestId || randomUUID(),
    requestId: input.requestId,
    role: 'user',
    text: String(input.message || '').replace(/\u0000/g, '').trim(),
    createdAt: Date.now(),
  };
  if (!store.messages.some(item => item.id === userMessage.id)) store.messages.push(userMessage);
  store.model = { provider: resolved.provider, modelId: resolved.modelId };
  // Persist the accepted user turn before model/tool work begins. A provider
  // failure must not make the prompt disappear from the side conversation.
  writeStore(store);

  const live = agentRegistry.getProxyManagerContext(input.chatId);
  if (input.workspace) live.workspace = { path: input.workspace.path || '', pinnedPaths: input.workspace.paths };
  if (live?.run?.status === 'idle') {
    const persisted = await taskStore.getTask(input.chatId).catch(() => null);
    if (persisted) {
      live.run = {
        status: persisted.status,
        objective: compact(persisted.prompt, 6000),
        startedAt: persisted.startedAt,
        finalAnswer: compact(persisted.finalAnswer, 5000),
      };
      const internalProxyControlPhases = new Set(['independent_supervision', 'watching', 'policy_changed', 'model_changed']);
      live.activity = (persisted.traceLogs || []).filter((trace: any) =>
        ['task_plan', 'plan', 'work_note', 'tool_call', 'tool_result', 'tool_result_preview', 'file_preview', 'evidence', 'error', 'steering_received', 'steering_applied', 'autonomy_proxy_status', 'sub_agent_spawn', 'sub_agent_complete', 'sub_agent_error', 'inter_agent_message', 'answer', 'done'].includes(String(trace?.type || '')) &&
        !(
          trace?.type === 'autonomy_proxy_status' &&
          internalProxyControlPhases.has(String(trace?.phase || '').trim().toLowerCase())
        ),
      ).slice(-36).map((trace: any) => {
        const delegation = delegationTelemetryFromTrace(trace);
        return {
          type: String(trace.type || ''),
          text: compact(delegation?.summary || trace.text || trace.data || trace.output || trace.result || trace.error, 2400),
          tool: compact(trace.tool || trace.toolName || trace.name, 120),
          success: trace.success,
          phase: trace.phase,
          delegation: delegation || undefined,
          timestamp: trace.timestamp,
        };
      });
    }
  }
  const priorConversation = store.messages.filter(item => item.id !== userMessage.id).map(item => ({
    role: item.role === 'user' ? 'user' : 'model',
    parts: [{ text: item.text }],
  }));
  const learnedOperatingModel = resolveSelfImprovementEnabled()
    ? await adaptiveExperience.getExecutionContext({
      enabled: true,
      userId: 'user',
      projectId: input.chatId,
      workspaceKey: String(live?.workspace?.path || ''),
      agentRuntime: 'proxy_manager',
      role: 'proxy_manager',
      request: input.message,
      mode: resolved.mode,
      selectedModel: { provider: resolved.provider, modelId: resolved.modelId },
      runtimeSettings: resolved.settings,
    }).catch(() => '')
    : '';
  const prompt = [
    CONVERSATION_INTENT_POLICY,
    'You are Proxy Manager, the persistent user-facing coordination agent beside a separate runtime User Proxy and Main execution agent. You remain useful whether Main is running, finishing, idle, stopped, or between goals. You converse naturally and turn user intent into durable, precisely routed work without mixing independent objectives.',
    'ROLE SEPARATION: Main executes tasks and owns tools. Runtime User Proxy silently supervises one active Main task. You own the side conversation, intent interpretation, temporal routing, durable future work, and wake-up decisions. Never pretend to be Main, never perform its work in chat, and never collapse these three roles into one.',
    'You are a bounded coordination agent, not a single-pass classifier. When the user\'s request depends on facts not present in the snapshot, use your isolated read-only investigation tools, inspect the result, update your understanding, and continue until the routing decision is grounded. Do not use tools when the supplied context already answers the question. Tool findings inform your final decision but never become runtime-Proxy evidence unless you explicitly encode the relevant user-facing constraint in a directive.',
    'Your tools are deliberately non-mutating. You may research, calculate, inspect workspace structure or content, and discover capabilities. You cannot edit files, run shell commands, operate Main\'s tools, or alter the active task except through the typed operation in your final JSON. This separation is mandatory.',
    'You are an agent, not a settings form. Infer timing, target, urgency, boundaries, dependencies, and the safest useful action from meaning and live context. Never force a cross-question ritual. Ask a concise question only when the missing answer genuinely changes the result and cannot be safely inferred.',
    'Build an intent ledger before routing: identify the active objective, whether the user is revising it, whether the request depends on its artifact, whether it is an independent new goal, what must remain true, and what completion boundary makes the instruction useful. Preserve the user\'s complete meaning in a standalone directive instead of forwarding a vague chat fragment.',
    'Protect the quality of the current task. Over-guidance can degrade a capable Main agent: predict whether Main or its runtime supervisor will naturally handle the issue before sending anything. Prefer silence when intervention has no clear counterfactual benefit. A new or unrelated goal must become a separate queued task. A dependent next step must wait until the current artifact or result exists. A current correction should go through the runtime Proxy for adaptive timing unless delay would cause concrete harm.',
    'Never merge independent goals just because they arrived close together. Amend the active task contract when the human corrects it; stable context does not mean preserving a replaced choice. Queue independent goals in user order. If a later message refines a queued goal, update that queued concept. If Main is idle and the user authorizes work, start_main wakes it. If Main is running, queue_after_current creates a successor after the current run settles. Preserve partial results and unresolved dependencies for that successor without replaying completed work. An explicit user stop never auto-continues the queue.',
    'For a request containing multiple substantial deliverables, use schedule_workflow only when separate Main runs materially improve isolation, dependency handling, or completion clarity. Return the smallest ordered task list that preserves the user\'s outcome. Each task prompt must stand alone; dependency describes what it consumes from the immediately prior result. Keep tightly coupled edits in one task instead of fragmenting work mechanically.',
    'If the user corrects a task that is visibly still pending in proxyControl.taskQueue, use replace_queued_task with its exact id in supersedesTaskId. Never replace a task already starting or started; route that as current guidance or a later corrective task according to live status.',
    'Use none for ordinary conversation, explanations, status questions, brainstorming, or when the user has not actually authorized an instruction. Do not claim delivery unless an operation is selected; the server reports final delivery state.',
    'Treat the runtime snapshot as incomplete operational telemetry. Never expose private chain-of-thought. You may summarize visible plans, actions, gaps, and status. Respect explicit user boundaries and never silently weaken them.',
    'Delegation lineage is first-class evidence. Inspect activity.delegation and proxy.delegationModel, not just lifecycle text. Spawned/running/completed describe orchestration only; they do not prove that Main received a semantic payload. Distinguish result available, result usable, and result collected. If a worker completed with empty/failed evidence or its usable payload remains uncollected, state that gap plainly and never describe its findings as integrated.',
    'When answering delegation status, report the evidence transition precisely: assignment started -> payload produced or failed -> payload collected -> payload actually usable. Never collapse these stages into "the sub-agent handled it." Route a correction only when the missing lineage materially affects the active outcome; otherwise explain the gap without disrupting Main.',
    'Your operations are: brief_proxy (change what the supervisor watches), guide_adaptively (ask it to decide how/when to guide the current task), watch_condition (activate only if a semantic condition becomes relevant), before_completion (enforce a requirement at final review without distracting current work), queue_after_current (create one separate successor task), start_main (wake idle Main with one task), schedule_workflow (queue two or more ordered isolated tasks and wake Main when idle), replace_queued_task (replace one pending task), interrupt_main (urgent reorientation), and stop_main (explicit stop or critical active violation). Choose at most one.',
    'Represent temporal intent precisely. A request may apply only to the current step, the whole current task, the next task, or a persistent supervisory mandate. Use activationCondition for dependencies such as after an artifact exists, if the current strategy fails, before a destructive action, or once Main reaches verification. If the user revises an earlier unsettled directive, set supersedesDirectiveId instead of leaving contradictory instructions alive.',
    'Route by consequence, not excitement: interrupt_main is the narrow direct path for a current, time-sensitive correction where waiting for the runtime Proxy review would cause concrete harm, irreversible action, or substantial rework. It reaches Main at the next model boundary and is mirrored to the runtime Proxy. Ordinary improvements, preferences, and non-urgent corrections must use guide_adaptively. Unrelated/new work must use queue_after_current so it cannot dilute the current task.',
    'Do not output a numeric confidence. Classify evidenceQuality (none/contextual/direct/explicit_user), counterfactualImpact if no operation occurs (none/minor/material/critical), and coordinationCost (low/medium/high). These are situation semantics, not decaying scores. Choose an operation only when its evidence and counterfactual value justify its disruption.',
    'Wake-up doctrine: use start_main only when the snapshot says Main is not running, the message is an executable request rather than discussion, and the user has authorized action. Use queue_after_current when Main is running or settling. Do not wake Main for a status question, hypothetical idea, or unresolved choice. The instruction for start_main or queue_after_current must be a complete Main-ready task prompt with required context, constraints, deliverables, and dependency results that are already known.',
    'Every instruction or task prompt you route becomes a real user turn in Main\'s conversation. Write it as a direct human request that stands on its own. Never include routing narration such as “tell Main”, “Main should”, “the agent is failing”, “Proxy-Agent noticed”, internal component names, or commentary about who sent it.',
    'The capability map summarizes all registered Main tools and recent usage. Use it to suggest viable approaches when a real gap exists, but never prescribe tools routinely and never imply that you executed them. Tool availability is context, not a reason to intervene.',
    'Read proxy.coordinationEvents and managerDirectives as messages back from the runtime supervisor: acknowledgements, deferrals, deliveries, rejections, stops, and observed outcomes. Incorporate them naturally when answering status questions and do not resend already settled instructions.',
    learnedOperatingModel
      ? `SHARED LEARNED USER + COLLABORATION MODEL:\n${learnedOperatingModel}\nUse this durable model to interpret shorthand, choose a useful level of initiative, form messages in the user's preferred working style, and predict whether guidance would help or merely interrupt. Current explicit intent, safety, authority, and the active task contract always take priority.`
      : '',
    'Professional response doctrine: lead with what is understood or what changed. State an operational action only if one was actually selected. Keep ordinary replies concise and calm; use a short structured list only for multiple goals, constraints, or queued stages. Never use hype, filler, fake certainty, or generic phrases such as "I will handle everything." If clarification is necessary, explain the exact decision it blocks in one sentence.',
    'Conversation-mode discipline: for a greeting, acknowledgement, thanks, or casual message, reply naturally in one short sentence and choose none—do not introduce yourself, summarize Main, list capabilities, or ask a broad follow-up. For a status question, answer only the requested status in at most three short points. For an authorized action, confirm the concrete routing result without repeating the full task. For a complex workflow, summarize only the stage boundaries and dependencies that help the user understand what will happen.',
    'Do not end every response with a question. Ask one only when a specific unresolved decision blocks safe routing. Never respond to "hi" with workspace history or a long menu of possibilities.',
    'Let meaning and the current task decide your behavior. Handle shorthand, typos, multilingual instructions, corrections, and references to earlier turns naturally. Preserve explicit exclusions and exact user requirements in every dependent task. Do not invent approvals, checks, tests, or extra stages. Track unfinished goals, completed artifacts, unresolved decisions, and the user’s latest corrections in stateUpdate; omitted fields stay unchanged, while an explicit empty array clears a resolved list.',
    'For an operation, optionally return deliveryReplies with short, task-specific replies keyed by active, pending, delivered, rejected, or unavailable. The server selects the actual delivery state. active means a task started or a supervisor accepted guidance, depending on the operation; pending means queued or staged, never executed; delivered means handed off, never proof the requested work is complete. Include useful workflow stages and constraints without repeating the full request. For none, use reply as your natural answer.',
    `LIVE MAIN + RUNTIME PROXY CONTEXT:\n${JSON.stringify(live, null, 2)}`,
    `DURABLE PER-CHAT COORDINATION MODEL:\n${JSON.stringify(store.coordinationModel, null, 2)}`,
    `CURRENT USER REQUEST:\n${input.message}`,
    input.attachmentContext
      ? `USER-PROVIDED ATTACHMENT CONTEXT FOR THIS TURN:\n${input.attachmentContext}`
      : '',
    input.mediaAttachments?.length ? `ATTACHMENTS AVAILABLE TO THIS MODEL AND TO DELEGATED TASKS:\n${input.mediaAttachments.map(item => `${item.name || 'Attachment'} (${item.mimeType}): ${item.path}`).join('\n')}` : '',
    'Return exactly one JSON object with no markdown:',
    '{"reply":"natural professional answer","operation":"none|brief_proxy|guide_adaptively|watch_condition|before_completion|queue_after_current|start_main|schedule_workflow|replace_queued_task|interrupt_main|stop_main","target":"proxy|main|both","instruction":"standalone directive for single-task operations, blank for none or schedule_workflow","intent":"goal|constraint|correction|preference|follow_up","rationale":"short private routing reason","evidenceQuality":"none|contextual|direct|explicit_user","counterfactualImpact":"none|minor|material|critical","coordinationCost":"low|medium|high","urgency":"low|normal|high|critical","activationCondition":"semantic activation condition or blank","scope":"current_step|current_task|next_task|persistent_mandate","supersedesDirectiveId":"prior directive id or blank","supersedesTaskId":"pending task id for replacement or blank","tasks":[{"prompt":"complete Main-ready task","dependency":"what this consumes from the prior task, blank if independent","rationale":"why this is a separate stage"}],"stateUpdate":{"activeIntent":"current durable user intent","constraints":[],"dependencies":[],"openDecisions":[],"durableOutcomes":[]}}',
  ].join('\n\n');

  const client = createIsolatedClient(resolved.apiKey, resolved.mode, resolved.settings);
  signal.throwIfAborted();
  const context: any = {
    projectId: `${input.chatId}::proxy-manager`,
    abortSignal: signal,
    agentRuntime: 'proxy_manager',
    isUserProxy: true,
    isProxyManager: true,
    selfImprovementEnabled: false,
    disableSubAgents: true,
    disableLongTermMemory: true,
    disableSessionPersistence: true,
    disableTaskStore: true,
    disableSharedCache: true,
    selectedModelMode: resolved.mode,
    selectedModelName: resolved.modelId || undefined,
    selectedModelProvider: resolved.provider,
    strictModelSelection: Boolean(resolved.modelId),
    selectedThinkingLevel: 'high',
    runtimeSettings: resolved.settings,
    contextCompaction: rebaseContextCompactionWindow(input.contextCompaction, resolved.provider, resolved.modelId),
    durableContextPersistence: true,
    workspacePath: live?.workspace?.path || undefined,
    paths: live?.workspace?.pinnedPaths || [],
    isFocusedWorkspace: Boolean(live?.workspace?.path),
  };
  input.onProgress?.({
    type: 'status',
    text: 'Reviewing the request and live workspace context',
    phase: 'reviewing',
    timestamp: Date.now(),
  });
  const reportProgress = (trace: any) => {
    const type = String(trace?.type || '');
    const text = compact(trace?.text || trace?.message || '', 240);
    const tool = compact(trace?.tool || trace?.toolName || trace?.name || '', 100);
    if (type === 'work_note' && text) {
      input.onProgress?.({ type: 'work', text, phase: 'reasoning', timestamp: Date.now() });
      return;
    }
    if (tool && text && !['tool_result_preview', 'console_output'].includes(type)) {
      input.onProgress?.({ type: 'work', text, tool, phase: 'tool', timestamp: Date.now() });
      return;
    }
    if (type === 'error' && text) {
      input.onProgress?.({ type: 'status', text, phase: 'error', timestamp: Date.now() });
    }
  };
  let response = await client.executeMessageLoop(context, prompt, priorConversation, reportProgress, input.mediaAttachments || []);
  signal.throwIfAborted();
  let decision = extractDecision(response.text);
  let freshMainContext = agentRegistry.getProxyManagerContext(input.chatId);
  const executionBoundary = (snapshot: any) => `${snapshot?.run?.runId || ''}:${snapshot?.run?.status || 'idle'}:${snapshot?.run?.settling === true}`;
  if (decision.operation !== 'none' && executionBoundary(live) !== executionBoundary(freshMainContext)
    && readProxyControl(input.chatId).stopGeneration === stopGenerationAtStart) {
    // Give the model the changed situation instead of mechanically converting
    // a correction for one run into an instruction for an unrelated successor.
    const replanningBoundary = executionBoundary(freshMainContext);
    input.onProgress?.({ type: 'status', text: 'Main changed state; updating the handoff', phase: 'reviewing', timestamp: Date.now() });
    const revised = await client.executeMessageLoop(context,
      `${prompt}\n\nLATEST EXECUTION SNAPSHOT — this replaces the earlier live snapshot:\n${JSON.stringify(freshMainContext, null, 2)}\nYour earlier proposed operation was ${decision.operation}. No operation has been delivered. Reconsider timing and task ownership using the latest state, keep the original user intent, and return the same JSON contract. Do not attach an old correction to unrelated new work.`,
      priorConversation, reportProgress, input.mediaAttachments || []);
    signal.throwIfAborted();
    response = { ...revised, trace: [...(response.trace || []), ...(revised.trace || [])] };
    decision = extractDecision(revised.text);
    freshMainContext = agentRegistry.getProxyManagerContext(input.chatId);
    if (decision.operation !== 'none' && replanningBoundary !== executionBoundary(freshMainContext)) {
      decision.operation = 'none';
      decision.reply = 'Main changed tasks again while I was coordinating. Your request is saved, but I have not delivered an instruction to the new task.';
    }
  }
  const deliveryControl = readProxyControl(input.chatId);
  if ((deliveryControl.stopGeneration !== stopGenerationAtStart || !deliveryControl.enabled || deliveryControl.paused) && decision.operation !== 'none') {
    decision.operation = 'none';
    decision.instruction = '';
    decision.tasks = [];
    decision.reply = 'Execution controls changed while I was reviewing this request, so I did not deliver further instructions. Resume Proxy when you are ready.';
    input.onProgress?.({
      type: 'status',
      text: 'Main was stopped; the pending routing decision was safely discarded',
      phase: 'stopped',
      timestamp: Date.now(),
    });
  }
  // Conversation intent belongs to the model; keyword overrides lose meaning
  // when a short message refers to an attachment or an earlier decision.
  const mainIsRunning = freshMainContext?.run?.status === 'running' || freshMainContext?.run?.settling === true;
  if (decision.operation === 'start_main' && mainIsRunning) {
    decision.operation = 'queue_after_current';
    decision.target = 'main';
    decision.deliveryReplies = undefined;
  } else if (decision.operation === 'queue_after_current' && !mainIsRunning) {
    decision.operation = 'start_main';
    decision.target = 'main';
    decision.reply = 'Main was idle, so I started this task now.';
    decision.deliveryReplies = undefined;
  }
  const work = (Array.isArray(response.trace) ? response.trace : [])
    .filter((item: any) => item?.tool && item?.text)
    .map((item: any) => ({ text: compact(item.text, 180), tool: compact(item.tool, 100) }))
    .filter((item: { text: string; tool: string }, index: number, items: Array<{ text: string; tool: string }>) =>
      items.findIndex(candidate => candidate.text === item.text && candidate.tool === item.tool) === index,
    )
    .slice(-8);

  let delivery: ProxyManagerChatMessage['delivery'] = 'none';
  let wakeRequested = false;
  let deliveryError = '';
  const hasOperationPayload = decision.operation === 'schedule_workflow'
    ? decision.tasks.length >= 2
    : Boolean(decision.instruction);
  const highDisruption = decision.operation === 'stop_main' || decision.operation === 'interrupt_main';
  const categoricalGrounding = decision.evidenceQuality !== 'none'
    && decision.counterfactualImpact !== 'none'
    && (!highDisruption || (
      ['direct', 'explicit_user'].includes(decision.evidenceQuality)
      && ['material', 'critical'].includes(decision.counterfactualImpact)
    ))
    && !(decision.coordinationCost === 'high' && decision.counterfactualImpact === 'minor');
  if (decision.operation !== 'none' && hasOperationPayload && categoricalGrounding) {
    input.onProgress?.({
      type: 'status',
      text: decision.operation === 'schedule_workflow'
        ? 'Scheduling the autonomous workflow'
        : 'Applying the coordination decision',
      phase: 'routing',
      timestamp: Date.now(),
    });
    if (decision.operation === 'schedule_workflow') {
      const queued = agentRegistry.queueProxyWorkflow(input.chatId, decision.tasks.map(task => ({ ...task, mediaAttachments: input.mediaAttachments, model: input.mainModel, workspace: input.workspace })));
      deliveryError = queued.error || '';
      delivery = !queued.accepted || queued.status === 'failed'
        ? 'unavailable'
        : queued.status === 'starting' ? 'active' : 'pending';
      wakeRequested = delivery === 'active';
    } else if (decision.operation === 'queue_after_current' || decision.operation === 'start_main' || decision.operation === 'replace_queued_task') {
      const queued = agentRegistry.queueProxyTask(input.chatId, decision.instruction, decision.rationale, {
        dependency: decision.activationCondition,
        supersedesTaskId: decision.operation === 'replace_queued_task' ? decision.supersedesTaskId : undefined,
        mediaAttachments: input.mediaAttachments,
        model: input.mainModel,
        workspace: input.workspace,
      });
      delivery = !queued.accepted || queued.status === 'failed'
        ? 'unavailable'
        : queued.status === 'starting' ? 'active' : 'pending';
      wakeRequested = delivery === 'active';
      deliveryError = queued.error || '';
    } else {
      const timing = decision.operation === 'watch_condition'
        ? 'when_relevant'
        : decision.operation === 'before_completion' ? 'before_completion' : 'now';
      const target = decision.operation === 'brief_proxy' ? 'proxy' : decision.target;
      const result = agentRegistry.deliverProxyManagerDirective(input.chatId, {
        message: decision.instruction,
        target,
        timing,
        intent: decision.intent,
        rationale: decision.rationale,
        requestedAction: decision.operation === 'brief_proxy'
          ? 'advise_proxy'
          : decision.operation === 'interrupt_main'
            ? 'interrupt_main'
            : decision.operation === 'stop_main' ? 'stop_main' : 'steer_adaptively',
        urgency: decision.operation === 'stop_main' ? 'critical' : decision.urgency,
        activationCondition: decision.activationCondition,
        scope: decision.scope,
        supersedesDirectiveId: decision.supersedesDirectiveId || undefined,
      });
      delivery = result.accepted ? result.status : result.status === 'rejected' ? 'rejected' : 'unavailable';
    }
  }

  const deliveredOperation: ProxyManagerOperation = delivery === 'none' ? 'none' : decision.operation;
  const groundedReply = deliveryError || (deliveredOperation === 'none'
    ? decision.operation === 'none' ? decision.reply || 'Understood.' : 'No instruction was delivered. The proposed action did not contain a complete, grounded request.'
    : decision.deliveryReplies?.[delivery || 'none'] || groundedOperationReply(deliveredOperation, delivery));
  const proxyMessage: ProxyManagerChatMessage = {
    id: randomUUID(),
    requestId: input.requestId,
    role: 'proxy',
    text: groundedReply.trim(),
    createdAt: Date.now(),
    operation: deliveredOperation,
    delivery,
    work,
  };
  if (decision.stateUpdateProvided?.length) {
    store.coordinationModel = {
      ...store.coordinationModel,
      ...Object.fromEntries(Object.entries(decision.stateUpdate).filter(([key]) => decision.stateUpdateProvided?.includes(key))),
      lastOperation: deliveredOperation,
    };
  } else {
    store.coordinationModel.lastOperation = deliveredOperation;
  }
  store.messages.push(proxyMessage);
  writeStore(store);
  if (resolveSelfImprovementEnabled()) {
    void adaptiveExperience.queueReflection({
      enabled: true,
      userId: 'user',
      projectId: input.chatId,
      chatId: input.chatId,
      workspacePath: live?.workspace?.path || input.chatId,
      agentRuntime: 'proxy_manager',
      task: input.message,
      history: store.messages.map(message => ({
        role: message.role === 'user' ? 'user' : 'assistant',
        content: message.text,
      })),
      finalAnswer: groundedReply,
      success: delivery !== 'unavailable',
      durationMs: 0,
      trace: response.trace,
      mode: resolved.mode,
      selectedModel: { provider: resolved.provider, modelId: resolved.modelId },
      runtimeSettings: resolved.settings,
    }).catch(() => undefined);
  }
  return {
    message: proxyMessage,
    history: store.messages,
    model: { provider: resolved.provider, modelId: resolved.modelId },
    wakeRequested,
  };
}

export async function talkToProxyManager(input: ProxyManagerInput): Promise<{ message: ProxyManagerChatMessage; history: ProxyManagerChatMessage[]; model: { provider: string; modelId: string }; wakeRequested: boolean }> {
  input = { ...input, requestId: input.requestId || randomUUID() };
  const stopGenerationAtAdmission = input.controlGeneration ?? readProxyControl(input.chatId).stopGeneration;
  const previous = proxyManagerTurnChains.get(input.chatId) || Promise.resolve();
  if (proxyManagerTurnChains.has(input.chatId)) input.onProgress?.({ type: 'status', text: 'Waiting for the previous coordination request', phase: 'queued', timestamp: Date.now() });
  const turn = previous.catch(() => undefined).then(async () => {
    const controller = new AbortController();
    const unsubscribe = subscribeProxyControl(input.chatId, state => {
      if (!state.enabled || state.paused) controller.abort(new Error(state.paused ? 'Proxy paused. Autonomous mode remains on.' : 'Autonomous mode turned off.'));
    });
    let onAbort: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason || new Error('Proxy interrupted.'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error('The side agent took too long to respond. Your message is saved; Main continues independently.');
        controller.abort(error);
        reject(error);
      }, 150_000);
      timeout.unref?.();
    });
    try {
      return await Promise.race([runProxyManagerTurn(input, controller.signal, stopGenerationAtAdmission), deadline, interrupted]);
    } catch (error: any) {
      const store = readStore(input.chatId);
      if (!input.requestId || !store.messages.some(message => message.id === input.requestId)) {
        store.messages.push({ id: input.requestId || randomUUID(), requestId: input.requestId, role: 'user', text: input.message, createdAt: Date.now() });
      }
      const failure: ProxyManagerChatMessage = { id: randomUUID(), requestId: input.requestId, role: 'proxy', text: error?.message || 'Proxy Manager is temporarily unavailable.', createdAt: Date.now(), operation: 'none', delivery: 'unavailable' };
      store.messages.push(failure);
      writeStore(store);
      throw error;
    } finally {
      clearTimeout(timeout!);
      unsubscribe();
      controller.signal.removeEventListener('abort', onAbort!);
    }
  });
  const settled = turn.then(() => undefined, () => undefined);
  proxyManagerTurnChains.set(input.chatId, settled);
  try {
    return await turn;
  } finally {
    if (proxyManagerTurnChains.get(input.chatId) === settled) {
      proxyManagerTurnChains.delete(input.chatId);
    }
  }
}
