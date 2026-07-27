import fs from 'fs-extra';
import { randomUUID } from 'crypto';
import { createIsolatedClient } from '../Agent';
import { agentRegistry } from '../agent-registry';
import { MODEL_PROVIDER_MODE, isModelProvider } from '../model-selector-store';
import { buildScopedRuntimeSettings, getScopedRuntimeApiKey, type ScopedRuntimeSettings } from '../runtime-api-keys';
import type { MainAgentMode, MainAgentProvider } from '../model-routing';
import { getEterxWorkspaceDir } from '../storage-paths';
import { taskStore } from '../task-store';
import { readProxyControl } from './proxy-control-plane';

export type ProxyManagerChatMessage = {
  id: string;
  role: 'user' | 'proxy';
  text: string;
  createdAt: number;
  operation?: ProxyManagerOperation;
  delivery?: 'none' | 'active' | 'pending' | 'delivered' | 'rejected' | 'expired' | 'unavailable';
  work?: Array<{ text: string; tool: string }>;
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
  operation: ProxyManagerOperation;
  target: 'proxy' | 'main' | 'both';
  instruction: string;
  intent: 'goal' | 'constraint' | 'correction' | 'preference' | 'follow_up';
  rationale: string;
  confidence: number;
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

const MAX_MESSAGES = 80;
const proxyManagerTurnChains = new Map<string, Promise<void>>();
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

const storePath = (chatId: string) => {
  const safe = chatId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 140);
  return getEterxWorkspaceDir('autonomy', 'proxy-manager', `${safe}.json`);
};

function readStore(chatId: string): ManagerStore {
  try {
    const saved = fs.readJsonSync(storePath(chatId));
    if ([1, 2, 3].includes(saved?.version) && saved?.chatId === chatId && Array.isArray(saved.messages)) {
      return {
        version: 3,
        chatId,
        messages: saved.messages.slice(-MAX_MESSAGES),
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
  } catch { }
  return { version: 3, chatId, messages: [], pendingConcepts: [], coordinationModel: { ...EMPTY_COORDINATION_MODEL }, updatedAt: Date.now() };
}

function writeStore(store: ManagerStore): void {
  fs.ensureDirSync(getEterxWorkspaceDir('autonomy', 'proxy-manager'));
  fs.writeJsonSync(storePath(store.chatId), { ...store, messages: store.messages.slice(-MAX_MESSAGES), updatedAt: Date.now() }, { spaces: 2 });
}

function extractDecision(raw: string): ManagerDecision {
  const cleaned = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { reply: compact(cleaned, 8000) || 'I could not form a reliable response.', operation: 'none', target: 'proxy', instruction: '', intent: 'preference', rationale: '', confidence: 0, urgency: 'normal', activationCondition: '', scope: 'current_task', supersedesDirectiveId: '', supersedesTaskId: '', tasks: [], stateUpdate: { ...EMPTY_COORDINATION_MODEL } };
  try {
    const parsed = JSON.parse(match[0]);
    const operations = new Set<ProxyManagerOperation>(['none', 'brief_proxy', 'guide_adaptively', 'watch_condition', 'before_completion', 'queue_after_current', 'start_main', 'schedule_workflow', 'replace_queued_task', 'interrupt_main', 'stop_main']);
    const targets = new Set(['proxy', 'main', 'both']);
    const intents = new Set(['goal', 'constraint', 'correction', 'preference', 'follow_up']);
    return {
      reply: compact(parsed.reply, 8000),
      operation: operations.has(parsed.operation) ? parsed.operation : 'none',
      target: targets.has(parsed.target) ? parsed.target : 'proxy',
      instruction: compact(parsed.instruction, 2400),
      intent: intents.has(parsed.intent) ? parsed.intent : 'preference',
      rationale: compact(parsed.rationale, 1200),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      urgency: new Set(['low', 'normal', 'high', 'critical']).has(parsed.urgency) ? parsed.urgency : 'normal',
      activationCondition: compact(parsed.activationCondition, 1200),
      scope: new Set(['current_step', 'current_task', 'next_task', 'persistent_mandate']).has(parsed.scope) ? parsed.scope : 'current_task',
      supersedesDirectiveId: compact(parsed.supersedesDirectiveId, 160),
      supersedesTaskId: compact(parsed.supersedesTaskId, 160),
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.slice(0, 8).map((task: any) => ({
        prompt: compact(task?.prompt, 12000),
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
    return { reply: compact(cleaned, 8000) || 'I could not form a reliable response.', operation: 'none', target: 'proxy', instruction: '', intent: 'preference', rationale: '', confidence: 0, urgency: 'normal', activationCondition: '', scope: 'current_task', supersedesDirectiveId: '', supersedesTaskId: '', tasks: [], stateUpdate: { ...EMPTY_COORDINATION_MODEL } };
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
  const autoOrder: MainAgentProvider[] = ['gemini', 'openai', 'anthropic', 'openrouter', 'mistral', 'groq'];
  const provider = requestedProvider || autoOrder.find(item => (settings.apiKeys[item] || []).length > 0) || 'gemini';
  const modelId = compact(selection?.modelId, 220);
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

export function getProxyManagerHistory(chatId: string): ProxyManagerChatMessage[] {
  return readStore(chatId).messages;
}

async function runProxyManagerTurn(input: {
  chatId: string;
  message: string;
  model?: { provider?: string; modelId?: string };
  onProgress?: (event: ProxyManagerProgress) => void;
}): Promise<{ message: ProxyManagerChatMessage; history: ProxyManagerChatMessage[]; model: { provider: string; modelId: string }; wakeRequested: boolean }> {
  const stopGenerationAtStart = readProxyControl(input.chatId).stopGeneration;
  const store = readStore(input.chatId);
  const userMessage: ProxyManagerChatMessage = { id: randomUUID(), role: 'user', text: compact(input.message, 12000), createdAt: Date.now() };
  store.messages.push(userMessage);
  store.model = input.model;

  const live = agentRegistry.getProxyManagerContext(input.chatId);
  if (live?.run?.status === 'idle') {
    const persisted = await taskStore.getTask(input.chatId).catch(() => null);
    if (persisted) {
      live.run = {
        status: persisted.status,
        objective: compact(persisted.prompt, 6000),
        startedAt: persisted.startedAt,
        finalAnswer: compact(persisted.finalAnswer, 5000),
      };
      live.activity = (persisted.traceLogs || []).filter((trace: any) =>
        ['task_plan', 'plan', 'work_note', 'tool_call', 'tool_result', 'file_preview', 'evidence', 'error', 'steering_received', 'steering_applied', 'autonomy_proxy_status', 'answer', 'done'].includes(String(trace?.type || '')),
      ).slice(-36).map((trace: any) => ({
        type: String(trace.type || ''),
        text: compact(trace.text || trace.data || trace.output || trace.error, 1400),
        tool: compact(trace.tool || trace.toolName || trace.name, 120),
        success: trace.success,
        phase: trace.phase,
        timestamp: trace.timestamp,
      }));
    }
  }
  const recentConversation = store.messages.slice(-24).map(item => `${item.role === 'user' ? 'USER' : 'PROXY MANAGER'}: ${item.text}`).join('\n');
  const prompt = [
    'You are Proxy Manager, the persistent user-facing coordination agent beside a separate runtime User Proxy and Main execution agent. You remain useful whether Main is running, finishing, idle, stopped, or between goals. You converse naturally and turn user intent into durable, precisely routed work without mixing independent objectives.',
    'ROLE SEPARATION: Main executes tasks and owns tools. Runtime User Proxy silently supervises one active Main task. You own the side conversation, intent interpretation, temporal routing, durable future work, and wake-up decisions. Never pretend to be Main, never perform its work in chat, and never collapse these three roles into one.',
    'You are a bounded coordination agent, not a single-pass classifier. When the user\'s request depends on facts not present in the snapshot, use your isolated read-only investigation tools, inspect the result, update your understanding, and continue until the routing decision is grounded. Do not use tools when the supplied context already answers the question. Tool findings inform your final decision but never become runtime-Proxy evidence unless you explicitly encode the relevant user-facing constraint in a directive.',
    'Your tools are deliberately non-mutating. You may research, calculate, inspect workspace structure or content, and discover capabilities. You cannot edit files, run shell commands, operate Main\'s tools, or alter the active task except through the typed operation in your final JSON. This separation is mandatory.',
    'You are an agent, not a settings form. Infer timing, target, urgency, boundaries, dependencies, and the safest useful action from meaning and live context. Never force a cross-question ritual. Ask a concise question only when the missing answer genuinely changes the result and cannot be safely inferred.',
    'Build an intent ledger before routing: identify the active objective, whether the user is revising it, whether the request depends on its artifact, whether it is an independent new goal, what must remain true, and what completion boundary makes the instruction useful. Preserve the user\'s complete meaning in a standalone directive instead of forwarding a vague chat fragment.',
    'Protect the quality of the current task. Over-guidance can degrade a capable Main agent: predict whether Main or its runtime supervisor will naturally handle the issue before sending anything. Prefer silence when intervention has no clear counterfactual benefit. A new or unrelated goal must become a separate queued task. A dependent next step must wait until the current artifact or result exists. A current correction should go through the runtime Proxy for adaptive timing unless delay would cause concrete harm.',
    'Never merge goals just because they arrived close together. Keep the current task contract stable. Queue each independent goal in user order. If a later message refines a queued goal, supersede or clarify that queued concept rather than disturbing Main. If Main is idle and the user clearly authorizes work, start_main wakes it. If Main is running, queue_after_current creates a durable successor task that starts only after the current run settles. A failed prior result remains visible to the successor so it can recover, revise the approach, or report a truly blocked dependency. An explicit user stop never auto-continues the queue.',
    'For a request containing multiple substantial deliverables, use schedule_workflow only when separate Main runs materially improve isolation, dependency handling, or completion clarity. Return the smallest ordered task list that preserves the user\'s outcome. Each task prompt must stand alone; dependency describes what it consumes from the immediately prior result. Keep tightly coupled edits in one task instead of fragmenting work mechanically.',
    'If the user corrects a task that is visibly still pending in proxyControl.taskQueue, use replace_queued_task with its exact id in supersedesTaskId. Never replace a task already starting or started; route that as current guidance or a later corrective task according to live status.',
    'Use none for ordinary conversation, explanations, status questions, brainstorming, or when the user has not actually authorized an instruction. Do not claim delivery unless an operation is selected; the server reports final delivery state.',
    'Treat the runtime snapshot as incomplete operational telemetry. Never expose private chain-of-thought. You may summarize visible plans, actions, gaps, and status. Respect explicit user boundaries and never silently weaken them.',
    'Your operations are: brief_proxy (change what the supervisor watches), guide_adaptively (ask it to decide how/when to guide the current task), watch_condition (activate only if a semantic condition becomes relevant), before_completion (enforce a requirement at final review without distracting current work), queue_after_current (create one separate successor task), start_main (wake idle Main with one task), schedule_workflow (queue two or more ordered isolated tasks and wake Main when idle), replace_queued_task (replace one pending task), interrupt_main (urgent reorientation), and stop_main (explicit stop or critical active violation). Choose at most one.',
    'Represent temporal intent precisely. A request may apply only to the current step, the whole current task, the next task, or a persistent supervisory mandate. Use activationCondition for dependencies such as after an artifact exists, if the current strategy fails, before a destructive action, or once Main reaches verification. If the user revises an earlier unsettled directive, set supersedesDirectiveId instead of leaving contradictory instructions alive.',
    'Route by consequence, not excitement: interrupt_main is the narrow direct path for a current, time-sensitive correction where waiting for the runtime Proxy review would cause concrete harm, irreversible action, or substantial rework. It reaches Main at the next model boundary and is mirrored to the runtime Proxy. Ordinary improvements, preferences, and non-urgent corrections must use guide_adaptively. Unrelated/new work must use queue_after_current so it cannot dilute the current task.',
    'Wake-up doctrine: use start_main only when the snapshot says Main is not running, the message is an executable request rather than discussion, and the user has authorized action. Use queue_after_current when Main is running or settling. Do not wake Main for a status question, hypothetical idea, or unresolved choice. The instruction for start_main or queue_after_current must be a complete Main-ready task prompt with required context, constraints, deliverables, and dependency results that are already known.',
    'The capability map summarizes all registered Main tools and recent usage. Use it to suggest viable approaches when a real gap exists, but never prescribe tools routinely and never imply that you executed them. Tool availability is context, not a reason to intervene.',
    'Read proxy.coordinationEvents and managerDirectives as messages back from the runtime supervisor: acknowledgements, deferrals, deliveries, rejections, stops, and observed outcomes. Incorporate them naturally when answering status questions and do not resend already settled instructions.',
    'Professional response doctrine: lead with what is understood or what changed. State an operational action only if one was actually selected. Keep ordinary replies concise and calm; use a short structured list only for multiple goals, constraints, or queued stages. Never use hype, filler, fake certainty, or generic phrases such as "I will handle everything." If clarification is necessary, explain the exact decision it blocks in one sentence.',
    'Conversation-mode discipline: for a greeting, acknowledgement, thanks, or casual message, reply naturally in one short sentence and choose none—do not introduce yourself, summarize Main, list capabilities, or ask a broad follow-up. For a status question, answer only the requested status in at most three short points. For an authorized action, confirm the concrete routing result without repeating the full task. For a complex workflow, summarize only the stage boundaries and dependencies that help the user understand what will happen.',
    'Do not end every response with a question. Ask one only when a specific unresolved decision blocks safe routing. Never respond to "hi" with workspace history or a long menu of possibilities.',
    `LIVE MAIN + RUNTIME PROXY CONTEXT:\n${JSON.stringify(live, null, 2)}`,
    `DURABLE PER-CHAT COORDINATION MODEL:\n${JSON.stringify(store.coordinationModel, null, 2)}`,
    `THIS CHAT'S SAVED PROXY-MANAGER CONVERSATION:\n${recentConversation || '(new conversation)'}`,
    'Return exactly one JSON object with no markdown:',
    '{"reply":"natural professional answer","operation":"none|brief_proxy|guide_adaptively|watch_condition|before_completion|queue_after_current|start_main|schedule_workflow|replace_queued_task|interrupt_main|stop_main","target":"proxy|main|both","instruction":"standalone directive for single-task operations, blank for none or schedule_workflow","intent":"goal|constraint|correction|preference|follow_up","rationale":"short private routing reason","confidence":0.0,"urgency":"low|normal|high|critical","activationCondition":"semantic activation condition or blank","scope":"current_step|current_task|next_task|persistent_mandate","supersedesDirectiveId":"prior directive id or blank","supersedesTaskId":"pending task id for replacement or blank","tasks":[{"prompt":"complete Main-ready task","dependency":"what this consumes from the prior task, blank if independent","rationale":"why this is a separate stage"}],"stateUpdate":{"activeIntent":"current durable user intent","constraints":[],"dependencies":[],"openDecisions":[],"durableOutcomes":[]}}',
  ].join('\n\n');

  const resolved = resolveModel(input.model);
  const client = createIsolatedClient(resolved.apiKey, resolved.mode, resolved.settings);
  const context: any = {
    projectId: `${input.chatId}::proxy-manager`,
    agentRuntime: 'proxy_manager',
    isUserProxy: true,
    isProxyManager: true,
    disableSubAgents: true,
    disableLongTermMemory: true,
    disableSessionPersistence: true,
    disableTaskStore: true,
    disableSharedCache: true,
    selectedModelMode: resolved.mode,
    selectedModelName: resolved.modelId || undefined,
    selectedModelProvider: resolved.provider,
    selectedThinkingLevel: 'high',
    runtimeSettings: resolved.settings,
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
  const response = await client.executeMessageLoop(context, prompt, [], (trace: any) => {
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
  }, []);
  const decision = extractDecision(response.text);
  if (readProxyControl(input.chatId).stopGeneration !== stopGenerationAtStart && decision.operation !== 'none') {
    decision.operation = 'none';
    decision.instruction = '';
    decision.tasks = [];
    decision.reply = 'Main was stopped while I was reviewing this request, so I did not start or queue more work.';
    input.onProgress?.({
      type: 'status',
      text: 'Main was stopped; the pending routing decision was safely discarded',
      phase: 'stopped',
      timestamp: Date.now(),
    });
  }
  const conversationalText = input.message.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  const isGreetingOnly = /^(hi|hello|hey|hiya|yo|good morning|good afternoon|good evening)$/.test(conversationalText);
  const isThanksOnly = /^(thanks|thank you|thx|got it|okay thanks|ok thanks)$/.test(conversationalText);
  if (isGreetingOnly || isThanksOnly) {
    decision.operation = 'none';
    decision.instruction = '';
    decision.tasks = [];
    decision.reply = isThanksOnly ? 'You’re welcome.' : 'Hi — what would you like to coordinate?';
  }
  const freshMainContext = agentRegistry.getProxyManagerContext(input.chatId);
  const mainIsRunning = freshMainContext?.run?.status === 'running';
  if (decision.operation === 'start_main' && mainIsRunning) {
    const belongsToCurrentRun =
      decision.scope === 'current_step' ||
      decision.scope === 'current_task' ||
      decision.intent === 'correction' ||
      decision.intent === 'preference';
    decision.operation = belongsToCurrentRun ? 'guide_adaptively' : 'queue_after_current';
    decision.target = belongsToCurrentRun ? 'both' : 'main';
    decision.reply = belongsToCurrentRun
      ? 'Main is already active, so I routed this request into the current run through Proxy-Agent supervision.'
      : 'Main is already active, so I queued this as a separate next task.';
  } else if (decision.operation === 'queue_after_current' && !mainIsRunning) {
    decision.operation = 'start_main';
    decision.target = 'main';
    decision.reply = 'Main was idle, so I started this task now.';
  }
  const work = (isGreetingOnly || isThanksOnly ? [] : (Array.isArray(response.trace) ? response.trace : []))
    .filter((item: any) => item?.tool && item?.text)
    .map((item: any) => ({ text: compact(item.text, 180), tool: compact(item.tool, 100) }))
    .filter((item: { text: string; tool: string }, index: number, items: Array<{ text: string; tool: string }>) =>
      items.findIndex(candidate => candidate.text === item.text && candidate.tool === item.tool) === index,
    )
    .slice(-8);

  let delivery: ProxyManagerChatMessage['delivery'] = 'none';
  let wakeRequested = false;
  const operationThreshold = decision.operation === 'stop_main' || decision.operation === 'interrupt_main' ? 0.82 : 0.6;
  const hasOperationPayload = decision.operation === 'schedule_workflow'
    ? decision.tasks.length >= 2
    : Boolean(decision.instruction);
  if (decision.operation !== 'none' && hasOperationPayload && decision.confidence >= operationThreshold) {
    input.onProgress?.({
      type: 'status',
      text: decision.operation === 'schedule_workflow'
        ? 'Scheduling the autonomous workflow'
        : 'Applying the coordination decision',
      phase: 'routing',
      timestamp: Date.now(),
    });
    if (decision.operation === 'schedule_workflow') {
      let firstStatus: 'pending' | 'starting' = 'pending';
      decision.tasks.forEach((task, index) => {
        const queued = agentRegistry.queueProxyTask(input.chatId, task.prompt, task.rationale, {
          dependency: task.dependency,
        });
        if (index === 0) firstStatus = queued.status;
      });
      delivery = firstStatus === 'starting' ? 'active' : 'pending';
      wakeRequested = firstStatus === 'starting';
    } else if (decision.operation === 'queue_after_current' || decision.operation === 'start_main' || decision.operation === 'replace_queued_task') {
      const queued = agentRegistry.queueProxyTask(input.chatId, decision.instruction, decision.rationale, {
        dependency: decision.activationCondition,
        supersedesTaskId: decision.operation === 'replace_queued_task' ? decision.supersedesTaskId : undefined,
      });
      delivery = queued.status === 'starting' ? 'active' : 'pending';
      wakeRequested = queued.status === 'starting';
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
      delivery = result.accepted ? result.status : 'unavailable';
    }
  }

  const deliveryNote = delivery === 'unavailable'
    ? ' The runtime Proxy is not active in this chat, so I did not claim or apply that operational change.'
    : '';
  const proxyMessage: ProxyManagerChatMessage = {
    id: randomUUID(),
    role: 'proxy',
    text: `${decision.reply || 'Understood.'}${deliveryNote}`.trim(),
    createdAt: Date.now(),
    operation: decision.operation,
    delivery,
    work,
  };
  if (decision.stateUpdate.activeIntent) {
    store.coordinationModel = {
      activeIntent: decision.stateUpdate.activeIntent,
      constraints: decision.stateUpdate.constraints,
      dependencies: decision.stateUpdate.dependencies,
      openDecisions: decision.stateUpdate.openDecisions,
      durableOutcomes: decision.stateUpdate.durableOutcomes,
      lastOperation: decision.operation,
    };
  } else {
    store.coordinationModel.lastOperation = decision.operation;
  }
  store.messages.push(proxyMessage);
  writeStore(store);
  return {
    message: proxyMessage,
    history: store.messages.slice(-MAX_MESSAGES),
    model: { provider: resolved.provider, modelId: resolved.modelId },
    wakeRequested,
  };
}

export async function talkToProxyManager(input: {
  chatId: string;
  message: string;
  model?: { provider?: string; modelId?: string };
  onProgress?: (event: ProxyManagerProgress) => void;
}): Promise<{ message: ProxyManagerChatMessage; history: ProxyManagerChatMessage[]; model: { provider: string; modelId: string }; wakeRequested: boolean }> {
  const previous = proxyManagerTurnChains.get(input.chatId) || Promise.resolve();
  const turn = previous.catch(() => undefined).then(() => runProxyManagerTurn(input));
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
