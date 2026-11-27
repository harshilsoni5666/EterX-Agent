import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AntigravityAcpClient, AntigravityRpcError } from '../antigravity/acp';
import { configOptions, sessionModels } from '../antigravity/session-config';
import { cliVersion, providerEnvironment, requireProviderCli, runProviderCli } from './cli';
import { effortOptions, isInlineImage, isInlineText, nativeApproval, readNativeAttachment, sanitizedCounts, trustedLoginUrl } from './shared';
import { NativeProviderAuthError, type NativeAdapter, type NativeProfile, type NativeTurn, type NativeToolEvent } from './types';
import { acpNativeMcp } from './tools';

const CANCELLED = { outcome: { outcome: 'cancelled' } };
const isAuthError = (error: unknown) => error instanceof AntigravityRpcError &&
  (error.code === -32000 || /not authenticated|auth.*requir|sign in|log in/i.test(error.message));

async function openGrok(profile: NativeProfile, signal: AbortSignal, turn?: NativeTurn,
  onUpdate?: (update: any, meta: any) => void) {
  const command = requireProviderCli('grok', profile.binaryPath);
  const args = ['--no-auto-update', '--permission-mode', 'default', '--no-subagents', '--no-plan'];
  if (turn && (!turn.context || turn.onlyEterxTools)) args.push('--tools', '', '--disable-web-search');
  else if (turn?.context?.planMode) args.push('--tools', 'Read,Grep,Glob,LS', '--disable-web-search');
  const client = new AntigravityAcpClient({
    command, args: [...args, 'agent', 'stdio'], cwd: turn?.cwd || profile.directory,
    env: providerEnvironment('grok', profile), signal, name: 'Grok Build', initializeMeta: { clientType: 'extension' },
    cancelMeta: { cancelTrigger: 'ctrl_c' }, onUpdate,
    async onPermission(params) {
      const tool = params?.toolCall;
      if (!turn?.context || (turn.context.planMode && !['read', 'search'].includes(tool?.kind))) return CANCELLED;
      const option = Array.isArray(params?.options) && params.options.find((entry: any) => entry?.kind === 'allow_once');
      if (typeof option?.optionId !== 'string') return CANCELLED;
      const title = typeof tool?.title === 'string' ? tool.title.slice(0, 180) : 'Grok Build action';
      const approved = await nativeApproval(turn, 'grok-build', { title, kind: tool?.kind, input: tool?.rawInput }, title);
      return approved ? { outcome: { outcome: 'selected', optionId: option.optionId } } : CANCELLED;
    },
  });
  try {
    const info = await client.initialize();
    if (!info.authMethods?.some?.((method: any) => method?.id === 'cached_token')) {
      throw new Error('Update Grok Build to a release with support for local subscription sign-in.');
    }
    await client.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } });
    const supportsMcp = info.agentCapabilities?.mcpCapabilities?.http === true;
    if (turn?.onlyEterxTools && turn.mcp && !supportsMcp) throw new Error('Update Grok Build to use it with this custom agent.');
    const session = await client.newSession(undefined, turn?.mcp && supportsMcp ? [acpNativeMcp(turn.mcp)] : []);
    return { client, info, session };
  } catch (error) {
    await client.dispose();
    if (isAuthError(error)) throw new NativeProviderAuthError('Sign in to this Grok Build account again.');
    throw error;
  }
}

function grokModels(info: any, session: any) {
  const models = sessionModels(session);
  const state = session?.models ?? info?._meta?.modelState;
  const catalog = models.length ? models : sessionModels({ models: state });
  return catalog.map(({ id, label }) => {
    const meta = state?.availableModels?.find?.((item: any) => item?.modelId === id)?._meta;
    const values: string[] = Array.isArray(meta?.reasoningEfforts)
      ? meta.reasoningEfforts.map((option: any) => option?.value ?? option?.id).filter((value: any) => typeof value === 'string') : [];
    return { id, label, thinking: effortOptions('grok-build', id, values, meta?.reasoningEffort),
      capabilities: ['image-input:' + String(info?.agentCapabilities?.promptCapabilities?.image === true)] };
  });
}

function grokUsage(raw: any) {
  return sanitizedCounts({
    prompt_tokens: raw?.inputTokens ?? raw?.input_tokens, completion_tokens: raw?.outputTokens ?? raw?.output_tokens,
    cached_tokens: raw?.cachedReadTokens, cache_write_tokens: raw?.cacheCreationTokens, reasoning_tokens: raw?.reasoningTokens,
  });
}

async function inspect(profile: NativeProfile, signal: AbortSignal) {
  const { client, info, session } = await openGrok(profile, signal);
  try { return { models: grokModels(info, session) }; }
  finally { await client.dispose(); }
}

export const grokBuildAdapter: NativeAdapter = {
  version: (configured, signal) => cliVersion('grok', configured, signal),
  async signIn(profile, { signal, authorize }) {
    const { code } = await runProviderCli(requireProviderCli('grok', profile.binaryPath), ['login', '--device-auth'], {
      cwd: profile.directory, signal, env: providerEnvironment('grok', profile),
      onOutput(output) {
        const urls = [...output.matchAll(/https:\/\/[^\s<>"]+/g)].map(match =>
          trustedLoginUrl(match[0].replace(/[),.;]+$/, ''), ['grok.com', 'grok.x.ai', 'auth.x.ai', 'accounts.x.ai', 'x.ai']));
        const url = urls.find(candidate => candidate && /(?:device|oauth|activate|verify|login|code)/i.test(candidate)) ?? urls.find(Boolean);
        const deviceCode = output.match(/\b[A-Z\d]{3,8}-[A-Z\d]{3,8}\b/)?.[0] ??
          output.match(/\b(?:[Uu]ser code|[Dd]evice code|[Cc]ode)\s*[:=]\s*([A-Z\d]{5,12})\b/)?.[1];
        if (url) authorize(url, deviceCode);
      },
    });
    signal.throwIfAborted();
    if (code !== 0) throw new Error('Grok Build sign-in did not complete. Try again.');
    return inspect(profile, signal);
  },
  inspect,
  async signOut(profile, signal) {
    const { code } = await runProviderCli(requireProviderCli('grok', profile.binaryPath), ['logout'], {
      cwd: profile.directory, signal, env: providerEnvironment('grok', profile),
    });
    if (code !== 0) throw new Error('Grok Build could not sign out of this account.');
  },
  isAuthError: error => isAuthError(error) || error instanceof NativeProviderAuthError,
  async run(profile, turn) {
    const promptId = randomUUID();
    let answer = '';
    let usage: ReturnType<typeof grokUsage>;
    let contextSize = 0;
    let settle!: (update: any) => void;
    const complete = new Promise<any>(resolve => { settle = resolve; });
    const toolEvents = new Map<string, NativeToolEvent>();
    const { client, info, session } = await openGrok(profile, turn.signal, turn, (update, meta) => {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        answer += update.content.text;
        turn.onText(update.content.text);
      } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
        turn.onThought?.(update.content.text);
      } else if (update.sessionUpdate === 'usage_update') {
        turn.onContext?.(update.used, update.size);
      } else if (update.sessionUpdate === 'turn_completed') {
        const id = update.prompt_id ?? update.promptId;
        if (id === promptId || id == null) {
          usage = grokUsage(update.usage) ?? usage;
          settle(update);
        }
      } else if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate) && typeof update.toolCallId === 'string') {
        const previous = toolEvents.get(update.toolCallId);
        const event: NativeToolEvent = {
          id: update.toolCallId, label: update.title || previous?.label || 'Grok Build action',
          status: update.status === 'failed' ? 'error' : update.status === 'completed' ? 'completed' : 'running',
          kind: ['edit', 'delete', 'move'].includes(update.kind) ? 'edit' : ['read', 'search'].includes(update.kind) ? 'read' : previous?.kind,
          filename: update.locations?.find?.((entry: any) => typeof entry?.path === 'string')?.path || previous?.filename,
        };
        toolEvents.set(event.id, event);
        turn.onTool?.(event);
      }
      if (contextSize && Number.isSafeInteger(meta?.totalTokens)) turn.onContext?.(meta.totalTokens, contextSize);
    });
    try {
      const modelState = session.models ?? info._meta?.modelState;
      const modelInfo = modelState?.availableModels?.find?.((entry: any) => entry?.modelId === turn.model.id);
      contextSize = modelInfo?._meta?.contextWindow || modelInfo?._meta?.contextWindowTokens || 0;
      if (!grokModels(info, session).some(model => model.id === turn.model.id)) {
        throw new Error('Refresh Grok Build models and select a model available to this account.');
      }
      const effort = turn.thinking && turn.model.thinking?.wireValues?.[turn.thinking];
      const modelConfig = configOptions(session).find(option => option.category === 'model');
      if (modelConfig && !modelState) {
        const response = await client.request('session/set_config_option', {
          sessionId: client.sessionId, configId: modelConfig.id, value: turn.model.id,
        });
        const reasoning = configOptions(response).find(option => option.category === 'thought_level' || option.id === 'thought_level');
        if (reasoning && effort) await client.request('session/set_config_option', {
          sessionId: client.sessionId, configId: reasoning.id, value: effort,
        });
      } else if (effort || modelState?.currentModelId !== turn.model.id) {
        await client.request('session/set_model', { sessionId: client.sessionId, modelId: turn.model.id,
          ...(effort && { _meta: { reasoningEffort: effort } }) });
      }
      const prompt: Record<string, unknown>[] = [{ type: 'text', text: turn.prompt }];
      for (const file of turn.files) {
        const { name, mimeType, bytes } = await readNativeAttachment(file);
        if (isInlineImage(mimeType) && info.agentCapabilities?.promptCapabilities?.image) {
          prompt.push({ type: 'image', mimeType, data: bytes.toString('base64') });
        } else if (isInlineText(mimeType)) {
          prompt.push({ type: 'text', text: 'Attachment ' + name + '\n' + bytes.toString('utf8') });
        } else if (turn.context && file.path) {
          prompt.push({ type: 'text', text: 'Attached file: ' + JSON.stringify(file.path) });
        } else throw new Error('Grok Build cannot open ' + name + ' in this chat.');
      }
      const rpc = client.request('session/prompt', { sessionId: client.sessionId, prompt, _meta: { promptId, requestId: promptId } }, 15 * 60_000);
      let result;
      try {
        result = await Promise.race([rpc, complete]);
      } catch (error) {
        const update = await Promise.race([complete, delay(350, undefined, { signal: turn.signal })]);
        if (!['rate_limit', 'usage_limit'].includes(update?.stopReason ?? update?.stop_reason)) throw error;
        result = update;
      }
      // Older clients can send the reply just before their final update.
      if (!usage) await Promise.race([complete, delay(350, undefined, { signal: turn.signal })]);
      const reason = result?.stopReason ?? result?.stop_reason;
      if (reason === 'cancelled') throw new Error('CANCELLED_BY_USER');
      if (reason === 'rate_limit' || reason === 'usage_limit') {
        turn.onLimit?.({ kind: reason === 'usage_limit' ? 'plan' : 'request' });
        throw new Error('Grok Build reported a usage limit. See Usage → Limits for this account.');
      }
      if (reason === 'error') throw new Error('Grok Build could not complete the turn. Check your Grok usage and try again.');
      return { text: answer, usage: usage ?? grokUsage(result?.usage ?? result?._meta?.usage) };
    } finally {
      await client.dispose();
    }
  },
};
