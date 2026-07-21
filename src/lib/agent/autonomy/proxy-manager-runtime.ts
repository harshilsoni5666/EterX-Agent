import fs from 'fs-extra';
import { randomUUID } from 'crypto';
import { createIsolatedClient } from '../Agent';
import { agentRegistry } from '../agent-registry';
import { MODEL_PROVIDER_MODE, isModelProvider } from '../model-selector-store';
import { buildScopedRuntimeSettings, getScopedRuntimeApiKey, type ScopedRuntimeSettings } from '../runtime-api-keys';
import type { MainAgentMode, MainAgentProvider } from '../model-routing';
import { getEterxWorkspaceDir } from '../storage-paths';
import { taskStore } from '../task-store';

export type ProxyManagerChatMessage = {
  id: string;
  role: 'user' | 'proxy';
  text: string;
  createdAt: number;
  operation?: ProxyManagerOperation;
  delivery?: 'none' | 'active' | 'pending' | 'delivered' | 'rejected' | 'expired' | 'unavailable';
};

export type ProxyManagerOperation = 'none' | 'brief_proxy' | 'guide_adaptively' | 'watch_condition' | 'before_completion' | 'queue_after_current' | 'interrupt_main' | 'stop_main';

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
};

type ManagerStore = {
  version: 2;
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
  updatedAt: number;
};

const MAX_MESSAGES = 80;

const compact = (value: unknown, max = 6000) =>
  String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const storePath = (chatId: string) => {
  const safe = chatId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 140);
  return getEterxWorkspaceDir('autonomy', 'proxy-manager', `${safe}.json`);
};

function readStore(chatId: string): ManagerStore {
  try {
    const saved = fs.readJsonSync(storePath(chatId));
    if ((saved?.version === 1 || saved?.version === 2) && saved?.chatId === chatId && Array.isArray(saved.messages)) {
      return { version: 2, chatId, messages: saved.messages.slice(-MAX_MESSAGES), pendingConcepts: Array.isArray(saved.pendingConcepts) ? saved.pendingConcepts.slice(-16) : [], model: saved.model, updatedAt: Number(saved.updatedAt || Date.now()) };
    }
  } catch { }
  return { version: 2, chatId, messages: [], pendingConcepts: [], updatedAt: Date.now() };
}

function writeStore(store: ManagerStore): void {
  fs.ensureDirSync(getEterxWorkspaceDir('autonomy', 'proxy-manager'));
  fs.writeJsonSync(storePath(store.chatId), { ...store, messages: store.messages.slice(-MAX_MESSAGES), updatedAt: Date.now() }, { spaces: 2 });
}

function extractDecision(raw: string): ManagerDecision {
  const cleaned = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { reply: compact(cleaned, 8000) || 'I could not form a reliable response.', operation: 'none', target: 'proxy', instruction: '', intent: 'preference', rationale: '', confidence: 0, urgency: 'normal', activationCondition: '', scope: 'current_task', supersedesDirectiveId: '' };
  try {
    const parsed = JSON.parse(match[0]);
    const operations = new Set<ProxyManagerOperation>(['none', 'brief_proxy', 'guide_adaptively', 'watch_condition', 'before_completion', 'queue_after_current', 'interrupt_main', 'stop_main']);
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
    };
  } catch {
    return { reply: compact(cleaned, 8000) || 'I could not form a reliable response.', operation: 'none', target: 'proxy', instruction: '', intent: 'preference', rationale: '', confidence: 0, urgency: 'normal', activationCondition: '', scope: 'current_task', supersedesDirectiveId: '' };
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

export async function talkToProxyManager(input: {
  chatId: string;
  message: string;
  model?: { provider?: string; modelId?: string };
}): Promise<{ message: ProxyManagerChatMessage; history: ProxyManagerChatMessage[]; model: { provider: string; modelId: string } }> {
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
    'You are Proxy Manager, the user-facing intelligence beside a separate runtime User Proxy. You converse naturally with the user and can translate their intent into precisely timed directives for the runtime Proxy and Main agent.',
    'You are an agent, not a settings form. Infer timing, target, urgency, boundaries, dependencies, and the safest useful action from meaning and live context. Never force a cross-question ritual. Ask a concise question only when the missing answer genuinely changes the result and cannot be safely inferred.',
    'Protect the quality of the current task. Over-guidance can degrade a capable Main agent: predict whether Main or its runtime supervisor will naturally handle the issue before sending anything. Prefer silence when intervention has no clear counterfactual benefit. Future or unrelated goals belong after_current. Current corrections should be handed to the runtime Proxy for adaptive timing, not injected directly into Main.',
    'Use none for ordinary conversation, explanations, status questions, brainstorming, or when the user has not actually authorized an instruction. Do not claim delivery unless an operation is selected; the server reports final delivery state.',
    'Treat the runtime snapshot as incomplete operational telemetry. Never expose private chain-of-thought. You may summarize visible plans, actions, gaps, and status. Respect explicit user boundaries and never silently weaken them.',
    'You do not directly operate Main. You coordinate with its runtime Proxy, which can absorb guidance, choose a boundary, steer, interrupt, stop, defer, or reject it using richer live evidence. Your operations are: brief_proxy (change what the supervisor watches), guide_adaptively (ask it to decide how/when to guide the current task), watch_condition (activate only if a semantic condition becomes relevant), before_completion (enforce a requirement at final review without distracting current work), queue_after_current (stage a later goal), interrupt_main (request urgent interruption/reorientation), and stop_main (request termination only when the user explicitly asks to stop or a critical active safety/authority violation is visible). Choose at most one.',
    'Represent temporal intent precisely. A request may apply only to the current step, the whole current task, the next task, or a persistent supervisory mandate. Use activationCondition for dependencies such as after an artifact exists, if the current strategy fails, before a destructive action, or once Main reaches verification. If the user revises an earlier unsettled directive, set supersedesDirectiveId instead of leaving contradictory instructions alive.',
    'Route by consequence, not excitement: interrupt_main is the narrow direct path for a current, time-sensitive correction where waiting for the runtime Proxy review would cause concrete harm, irreversible action, or substantial rework. It reaches Main at the next model boundary and is mirrored to the runtime Proxy. Ordinary improvements, preferences, and non-urgent corrections must use guide_adaptively. Unrelated/new work must use queue_after_current so it cannot dilute the current task.',
    'The capability map summarizes all registered Main tools and recent usage. Use it to suggest viable approaches when a real gap exists, but never prescribe tools routinely and never imply that you executed them. Tool availability is context, not a reason to intervene.',
    'Read proxy.coordinationEvents and managerDirectives as messages back from the runtime supervisor: acknowledgements, deferrals, deliveries, rejections, stops, and observed outcomes. Incorporate them naturally when answering status questions and do not resend already settled instructions.',
    `LIVE MAIN + RUNTIME PROXY CONTEXT:\n${JSON.stringify(live, null, 2)}`,
    `THIS CHAT'S SAVED PROXY-MANAGER CONVERSATION:\n${recentConversation || '(new conversation)'}`,
    'Return exactly one JSON object with no markdown:',
    '{"reply":"natural helpful answer to the user","operation":"none|brief_proxy|guide_adaptively|watch_condition|before_completion|queue_after_current|interrupt_main|stop_main","target":"proxy|main|both","instruction":"standalone directive preserving all necessary context, blank for none","intent":"goal|constraint|correction|preference|follow_up","rationale":"short private routing reason","confidence":0.0,"urgency":"low|normal|high|critical","activationCondition":"semantic activation condition or blank","scope":"current_step|current_task|next_task|persistent_mandate","supersedesDirectiveId":"prior active/pending directive id or blank"}',
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
    selectedThinkingLevel: 'low',
    runtimeSettings: resolved.settings,
  };
  const response = await client.executeMessageLoop(context, prompt, [], undefined, []);
  const decision = extractDecision(response.text);

  let delivery: ProxyManagerChatMessage['delivery'] = 'none';
  const operationThreshold = decision.operation === 'stop_main' || decision.operation === 'interrupt_main' ? 0.82 : 0.6;
  if (decision.operation !== 'none' && decision.instruction && decision.confidence >= operationThreshold) {
    const timing = decision.operation === 'queue_after_current'
      ? 'after_current'
      : decision.operation === 'watch_condition'
        ? 'when_relevant'
        : decision.operation === 'before_completion' ? 'before_completion' : 'now';
    const target = decision.operation === 'brief_proxy'
      ? 'proxy'
      : decision.operation === 'queue_after_current' && decision.target === 'proxy' ? 'both' : decision.target;
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
  };
  store.messages.push(proxyMessage);
  writeStore(store);
  return { message: proxyMessage, history: store.messages.slice(-MAX_MESSAGES), model: { provider: resolved.provider, modelId: resolved.modelId } };
}
