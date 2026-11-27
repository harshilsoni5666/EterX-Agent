import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { NativeSessionProvider } from '../../native-provider-contract';
import { meterModelResponse } from '../../usage/ledger';
import { assertProviderAvailable, providerAvailabilitySignal } from '../../app-presentation/posthog';
import { runAntigravityTurn } from '../antigravity/turn';
import { runWithAntigravityAccount } from '../antigravity/provider';
import { buildAgentBuilderRuntimePrompt, isAgentBuilderRuntimeContext, isCustomAgentRuntimeContext } from '../builder-agent';
import type { MainAgentThinkingLevel } from '../model-routing';
import { normalizeProviderCacheUsage } from '../provider-prompt-cache';
import { FINAL_ANSWER_POLICY } from '../response-format';
import type { ProjectContext } from '../schemas';
import { getRuntimeScratchRoot, getRuntimeWorkspaceRoot } from '../workspace/path_resolver';
import { recordNativeLimit, recordNativeUsage, runWithNativeAccount, withNativeProfile } from './accounts';
import { acpNativeMcp, nativeAgentTools, openNativeMcp } from './tools';
import type { NativeAttachment } from './types';

type Trace = (event: Record<string, unknown>) => void;
type Turn = Parameters<typeof runAntigravityTurn>[0];

export async function runWithSubscriptionAccount<T>(provider: NativeSessionProvider, model: string | undefined, run: () => Promise<T>): Promise<T> {
  await assertProviderAvailable(provider);
  return provider === 'antigravity' ? runWithAntigravityAccount(run, model) : runWithNativeAccount(provider, model, run);
}

export async function runSubscriptionTurn(provider: NativeSessionProvider, turn: Turn) {
  const context = turn.agent?.context;
  const sourceSignal = AbortSignal.any([...(turn.signal ? [turn.signal] : []), AbortSignal.timeout(15 * 60_000)]);
  const signal = await providerAvailabilitySignal(provider, sourceSignal) ?? sourceSignal;
  const onlyEterxTools = Boolean(context && (isAgentBuilderRuntimeContext(context) || isCustomAgentRuntimeContext(context)));
  const tools = context ? nativeAgentTools(context, signal, provider === 'cursor') : [];
  const mcp = provider === 'cursor' ? undefined : await openNativeMcp(tools, signal);
  try {
    if (provider === 'antigravity') return await runWithAntigravityAccount(() =>
      runAntigravityTurn({ ...turn, signal, mcpServers: mcp ? [acpNativeMcp(mcp)] : [] }), turn.model);
    return await runNativeTurn(provider, turn, signal, onlyEterxTools, tools, mcp);
  } finally {
    mcp?.dispose();
  }
}

async function runNativeTurn(
  provider: Exclude<NativeSessionProvider, 'antigravity'>, turn: Turn, signal: AbortSignal,
  onlyEterxTools: boolean, tools: ReturnType<typeof nativeAgentTools>, mcp: Awaited<ReturnType<typeof openNativeMcp>>,
) {
  const context = turn.agent?.context;
  const cwd = context ? getRuntimeWorkspaceRoot(context)
    : path.join(getRuntimeScratchRoot({ chatId: turn.chatId }), provider);
  await mkdir(cwd, { recursive: true });
  const instruction = !context ? 'Use the conversation and supplied attachments to answer.'
    : context.planMode ? 'Inspect the selected workspace as needed and explain your plan.' : 'Use the selected workspace to complete the request.';
  const prompt = [turn.instruction, instruction,
    turn.history?.length ? 'Earlier messages for context\n' + JSON.stringify(turn.history) : '',
    'Current request\n' + turn.prompt,
  ].filter(Boolean).join('\n\n');
  return withNativeProfile(provider, turn.model, async (adapter, account, models) => {
    const model = models.find(item => item.id === turn.model);
    if (!model) throw new Error('Select a model available to the active provider account.');
    const trace = turn.agent?.trace;
    const started = new Map<string, number>();
    const results = await meterModelResponse(provider, model.id, () => adapter.run(account, {
      model, cwd, signal, context, tools, mcp, onlyEterxTools, files: turn.attachments ?? [], prompt, thinking: turn.thinking,
      onText: text => { if (text) turn.onText?.(text); }, onThought: turn.onThought,
      onLimit: limit => { if (!signal.aborted) recordNativeLimit(provider, account.id, limit); },
      onContext(usedTokens, contextWindow) {
        if (!Number.isSafeInteger(usedTokens) || usedTokens < 0 || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return;
        turn.onContextUsage?.({ type: 'context_usage', provider, model: model.id, usedTokens, contextWindow,
          modelContextWindow: contextWindow, providerCalibrationApplied: true, timestamp: Date.now() });
      },
      onTool: trace && (event => {
        const id = [provider, context?.subAgentTurnId || context?.turnId || context?.projectId, event.id].join(':');
        const prior = started.get(id) || Date.now();
        started.set(id, prior);
        trace({ type: event.kind === 'edit' ? 'file_edit' : event.kind === 'read' ? 'exploration' : 'tool_call', id,
          toolCallId: id, toolName: provider, text: event.label, filename: event.filename, startTime: prior,
          status: event.status === 'error' ? 'failed' : event.status, isStreaming: event.status === 'running',
          ...(event.status !== 'running' && { endTime: Date.now() }), timestamp: Date.now() });
      }),
    }), result => ({ usage: result.usage }), signal);
    const { response, usageId } = results;
    recordNativeUsage(provider, account.id, model.id, response.usage, response.limits, !turn.auxiliary);
    if (!response.text.trim() && !context?.askUserInbox?.hasWork) throw new Error('The provider completed the turn without a text response.');
    return { text: response.text.trim(), usage: response.usage ? { ...response.usage, eterxUsageId: usageId } : undefined };
  });
}

export async function runNativeProviderAgent(
  provider: NativeSessionProvider,
  context: ProjectContext & { abortSignal?: AbortSignal; selectedThinkingLevel?: MainAgentThinkingLevel; _customAgentProfile?: { professionalPrompt?: string } },
  model: string, prompt: string, history: any[], files: NativeAttachment[], onTrace?: Trace,
) {
  const trace: Record<string, unknown>[] = [];
  const emit: Trace = event => { trace.push(event); onTrace?.(event); };
  const baseId = [provider, context.subAgentTurnId || context.turnId || context.projectId, Date.now()].join(':');
  let id = baseId;
  const messages = history.flatMap(message => {
    const text = typeof message?.content === 'string' ? message.content
      : (Array.isArray(message?.parts) ? message.parts : []).map((part: any) => part?.text || '').join('\n');
    return text ? [{ role: message.role === 'user' ? 'user' : 'assistant', text }] : [];
  });
  let thought = '', partial = '';
  let thoughtStart = 0, answerStart = 0, sequence = 0;
  const thoughtEvent = (closed: boolean) => {
    if (!thought) return;
    emit({ type: 'thought_stream', thoughtId: id + ':thought:' + sequence, text: thought, uiOnly: true, isDelta: false,
      streamState: closed ? 'closed' : 'open', isStreaming: !closed, isLiveTyping: !closed,
      startTime: thoughtStart, timestamp: Date.now(), ...(closed && { final: true, endTime: Date.now() }) });
    if (closed) { thought = ''; thoughtStart = 0; sequence++; }
  };
  try {
    const runtime = context as typeof context & { agentId?: string; agentName?: string; disableSubAgents?: boolean; _onTrace?: Trace };
    const builder = isAgentBuilderRuntimeContext(context);
    const delegation = context.allowAgentSpawning && !runtime.disableSubAgents && !context.planMode && !builder
      ? 'Use EterX spawn_sub_agent to delegate independent tasks. Use mode="models" to see provider and model pairs. Leave provider and model empty to inherit, or supply a pair for each worker. Use join when you need the results.'
      : '';
    const agentContext = { ...runtime, _onTrace: runtime._onTrace ?? emit };
    const instruction = [FINAL_ANSWER_POLICY, builder ? buildAgentBuilderRuntimePrompt(runtime.agentId || context.projectId, runtime.agentName)
      : context._customAgentProfile?.professionalPrompt, delegation].filter(Boolean).join('\n\n');
    let request = prompt;
    for (let pass = 0; ; pass++) {
      id = pass ? baseId + ':' + pass : baseId;
      const result = await runSubscriptionTurn(provider, {
        chatId: context.ownerChatId || context.projectId, model, prompt: request, instruction,
        history: messages, attachments: files, thinking: context.selectedThinkingLevel, signal: context.abortSignal,
        agent: { context: agentContext, trace: event => { thoughtEvent(true); emit(event); } }, onContextUsage: emit,
        onText(delta) {
          thoughtEvent(true);
          if (!answerStart) answerStart = Date.now();
          partial += delta;
          emit({ type: 'answer', answerId: id, text: delta, isDelta: true, isStreaming: true, isLiveTyping: true,
            streamState: 'open', startTime: answerStart, timestamp: Date.now() });
        },
        onThought(delta) {
          if (!thoughtStart) thoughtStart = Date.now();
          thought += delta;
          thoughtEvent(false);
        },
      });
      thoughtEvent(true);
      if (result.usage) emit({ type: 'model_usage', usageId: result.usage.eterxUsageId, source: 'provider', provider,
        model, usageScope: 'turn', ...normalizeProviderCacheUsage(provider, result.usage), timestamp: Date.now() });
      if (context.askUserInbox?.hasWork) {
        if (answerStart) emit({ type: 'answer_cancel', answerId: id });
        partial = '';
        answerStart = 0;
        const replies = await context.askUserInbox.waitForReply();
        context.abortSignal?.throwIfAborted();
        if (replies) {
          messages.push({ role: 'user', text: request });
          if (result.text) messages.push({ role: 'assistant', text: result.text });
          request = replies;
          continue;
        }
      }
      emit({ type: 'answer', answerId: id, text: result.text, isDelta: false, isStreaming: false,
        streamState: 'closed', final: true, startTime: answerStart || Date.now(), endTime: Date.now() });
      return { text: result.text, trace };
    }
  } catch (error) {
    thoughtEvent(true);
    if (partial) emit({ type: 'answer', answerId: id, text: partial, isDelta: false, isStreaming: false,
      streamState: 'closed', startTime: answerStart, endTime: Date.now() });
    if (context.abortSignal?.aborted) throw new Error('CANCELLED_BY_USER');
    throw error;
  }
}
