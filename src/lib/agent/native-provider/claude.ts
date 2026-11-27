import type { ModelInfo, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { cliVersion, providerEnvironment, requireProviderCli, runProviderCli } from './cli';
import { effortOptions, isInlineImage, isInlineText, nativeApproval, readNativeAttachment, sanitizedCounts } from './shared';
import { NativeProviderAuthError, type NativeAdapter, type NativeProfile, type NativeTurnResult } from './types';
import type { NativeUsageWindow } from '../../native-provider-contract';

const sdk = () => require('@anthropic-ai/claude-agent-sdk') as typeof import('@anthropic-ai/claude-agent-sdk');
const LABELS: Record<string, string> = {
  five_hour: 'Five hours', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet', seven_day_oauth_apps: 'Weekly connected apps',
  seven_day_overage_included: 'Included overage', overage: 'Extra usage',
};

function cli(profile: NativeProfile, args: string[], signal: AbortSignal) {
  return runProviderCli(requireProviderCli('claude', profile.binaryPath), args, {
    cwd: profile.directory, env: providerEnvironment('claude', profile), signal,
  });
}

function opts(profile: NativeProfile, cwd: string, abortController: AbortController): Options {
  return {
    cwd, abortController, env: providerEnvironment('claude', profile),
    pathToClaudeCodeExecutable: requireProviderCli('claude', profile.binaryPath),
    settingSources: [], strictMcpConfig: true, persistSession: false, permissionMode: 'default',
  };
}

function claudeModel(model: ModelInfo) {
  const id = model.resolvedModel || model.value;
  return { id, label: model.displayName, capabilities: ['image-input:true', 'embedded-context:true'],
    thinking: effortOptions('claude-code', id, model.supportedEffortLevels || []) };
}

function rateWindows(windows: Record<string, any>): NativeUsageWindow[] {
  return Object.entries(windows).flatMap(([key, row]) => {
    if (typeof row?.utilization !== 'number' || !Number.isFinite(row.utilization) || !Object.hasOwn(LABELS, key)) return [];
    const reset = typeof row.resets_at === 'string' ? Date.parse(row.resets_at) : NaN;
    return [{ label: LABELS[key], usedPercent: Math.max(0, Math.min(100, row.utilization)), resetsAt: Number.isFinite(reset) ? reset : null }];
  });
}

async function inspect(profile: NativeProfile, signal: AbortSignal) {
  const status = await cli(profile, ['auth', 'status'], signal);
  signal.throwIfAborted();
  if (status.code !== 0) throw new NativeProviderAuthError('Sign in using Claude Code in Subscription settings.');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  const q = sdk().query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      // Initializing the CLI can discover models without sending a model request.
      await new Promise<void>(resolve => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    })(),
    options: { ...opts(profile, profile.directory, controller), tools: [] },
  });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const models = (await q.supportedModels()).filter(model => model.value !== 'default').map(claudeModel);
    const readLimits = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.({ skipBehaviors: true });
    let limits: NativeUsageWindow[] | undefined;
    if (readLimits) {
      // Plan limits are optional and must not block model discovery on an older CLI.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([readLimits.catch(() => undefined),
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 3500); })]);
        if (result?.rate_limits_available && result.rate_limits) limits = rateWindows(result.rate_limits);
      } finally { clearTimeout(timer); }
    }
    return { models, limits };
  } finally {
    signal.removeEventListener('abort', abort);
    controller.abort();
    q.close();
  }
}

export const claudeCodeAdapter: NativeAdapter = {
  version: (configured, signal) => cliVersion('claude', configured, signal),
  async signIn(profile, { signal }) {
    // Let the installed, unmodified Claude Code CLI handle the browser, callbacks,
    // native credential storage, and any enterprise authentication policy.
    const { code } = await cli(profile, ['auth', 'login'], signal);
    signal.throwIfAborted();
    if (code !== 0) throw new Error('Claude Code sign-in did not complete.');
    return inspect(profile, signal);
  },
  inspect,
  async signOut(profile, signal) {
    const { code } = await cli(profile, ['auth', 'logout'], signal);
    if (code !== 0) throw new Error('Claude Code could not sign out of this account.');
  },
  isAuthError: error => error instanceof NativeProviderAuthError,
  async run(profile, turn) {
    type UserMessage = Extract<SDKUserMessage['message'], { role: 'user' }>;
    const blocks: Exclude<UserMessage['content'], string> = [{ type: 'text', text: turn.prompt }];
    for (const file of turn.files) {
      const { name, mimeType, bytes } = await readNativeAttachment(file);
      if (isInlineImage(mimeType)) {
        blocks.push({ type: 'image', source: { type: 'base64',
          media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: bytes.toString('base64') } });
      } else if (mimeType === 'application/pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: mimeType, data: bytes.toString('base64') }, title: name });
      } else if (isInlineText(mimeType)) {
        blocks.push({ type: 'text', text: 'Attachment ' + name + '\n' + bytes.toString('utf8') });
      } else if (turn.context && file.path) {
        blocks.push({ type: 'text', text: 'Attached file: ' + JSON.stringify(file.path) });
      } else throw new Error('Claude Code cannot open ' + name + ' in this chat.');
    }
    const controller = new AbortController();
    const abort = () => controller.abort(turn.signal.reason);
    const tools = !turn.context || turn.onlyEterxTools ? [] : turn.context.planMode ? ['Read', 'Glob', 'Grep', 'LS']
      : ['Read', 'Glob', 'Grep', 'LS', 'Edit', 'Write', 'MultiEdit', 'Bash'];
    const effort = turn.thinking && turn.model.thinking?.wireValues?.[turn.thinking];
    turn.signal.throwIfAborted();
    const q = sdk().query({
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: blocks } };
      })(),
      options: {
        ...opts(profile, turn.cwd, controller), model: turn.model.id, tools, includePartialMessages: true,
        ...(turn.mcp && { mcpServers: { eterx: { type: 'http' as const, url: turn.mcp.url, headers: { Authorization: turn.mcp.authorization } } } }),
        ...(['low', 'medium', 'high', 'xhigh', 'max'].includes(effort || '') && { effort: effort as Options['effort'] }),
        async canUseTool(name, args, options) {
          // The named MCP endpoint applies EterX permissions before running its tools.
          if (turn.mcp && turn.tools.some(tool => name === 'mcp__eterx__' + tool.name)) return { behavior: 'allow', updatedInput: args };
          if (!tools.includes(name) || options.signal.aborted ||
            !await nativeApproval(turn, 'claude-code', { name, input: args }, name)) {
            return { behavior: 'deny', message: 'EterX did not approve this action.' };
          }
          return { behavior: 'allow', updatedInput: args };
        },
      },
    });
    turn.signal.addEventListener('abort', abort, { once: true });
    if (turn.signal.aborted) abort();
    const limits = new Map<string, NativeUsageWindow>();
    const actions = new Map<string, { label: string; filename?: string }>();
    let answer = '';
    let hasDeltas = false;
    let latestContext = 0;
    let result: NativeTurnResult | undefined;
    try {
      for await (const event of q) {
        if (event.type === 'stream_event' && event.event.type === 'content_block_delta') {
          const delta = event.event.delta;
          if (delta.type === 'text_delta') {
            hasDeltas = true;
            answer += delta.text;
            turn.onText(delta.text);
          } else if (delta.type === 'thinking_delta') turn.onThought?.(delta.thinking);
        } else if (event.type === 'assistant') {
          const usage = event.message.usage;
          latestContext = (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) +
            (usage?.cache_read_input_tokens ?? 0) + (usage?.output_tokens ?? 0);
          for (const block of event.message.content) {
            if (block.type === 'text' && !hasDeltas) {
              answer += block.text;
              turn.onText(block.text);
            } else if (block.type === 'tool_use') {
              const input = block.input as { file_path?: unknown } | null;
              const filename = typeof input?.file_path === 'string' ? input.file_path : undefined;
              actions.set(block.id, { label: block.name, filename });
              turn.onTool?.({ id: block.id, label: block.name, status: 'running', filename,
                kind: /Edit|Write/.test(block.name) ? 'edit' : /Read|Grep|Glob|LS/.test(block.name) ? 'read' : 'command' });
            }
          }
          hasDeltas = false;
        } else if (event.type === 'user' && Array.isArray(event.message.content)) {
          for (const block of event.message.content) {
            if (block.type !== 'tool_result') continue;
            const action = actions.get(block.tool_use_id);
            if (!action) continue;
            turn.onTool?.({ id: block.tool_use_id, ...action, status: block.is_error ? 'error' : 'completed' });
          }
        } else if (event.type === 'rate_limit_event') {
          const rate = event.rate_limit_info;
          const resetAt = typeof rate.resetsAt === 'number' && Number.isFinite(rate.resetsAt) && rate.resetsAt > 0
            ? (rate.resetsAt < 1e12 ? rate.resetsAt * 1000 : rate.resetsAt) : undefined;
          if (rate.status === 'rejected' && rate.rateLimitType && Object.hasOwn(LABELS, rate.rateLimitType)) {
            turn.onLimit?.({ kind: 'plan', retryAt: resetAt });
          }
          if (rate.rateLimitType && Object.hasOwn(LABELS, rate.rateLimitType) && typeof rate.utilization === 'number' && Number.isFinite(rate.utilization)) {
            limits.set(rate.rateLimitType, { label: LABELS[rate.rateLimitType], usedPercent: Math.min(100, Math.max(0, rate.utilization * 100)),
              resetsAt: resetAt ?? null });
          }
        } else if (event.type === 'result') {
          if (event.is_error || event.subtype !== 'success') {
            if ('api_error_status' in event && event.api_error_status === 401) throw new NativeProviderAuthError('Sign in to Claude Code again.');
            throw new Error('Claude Code could not complete the turn. Check the account or its plan limits and try again.');
          }
          const totals = Object.values(event.modelUsage);
          const input = totals.reduce((sum, row) => sum + row.inputTokens + row.cacheReadInputTokens + row.cacheCreationInputTokens, 0);
          const contextWindow = event.modelUsage[turn.model.id]?.contextWindow || totals.at(-1)?.contextWindow;
          if (contextWindow && latestContext) turn.onContext?.(latestContext, contextWindow);
          const usage = totals.length ? sanitizedCounts({
            prompt_tokens: input, completion_tokens: totals.reduce((sum, row) => sum + row.outputTokens, 0),
            cached_tokens: totals.reduce((sum, row) => sum + row.cacheReadInputTokens, 0),
            cache_write_tokens: totals.reduce((sum, row) => sum + row.cacheCreationInputTokens, 0),
            ...(totals.some(row => row.thinkingTokens !== undefined) && { reasoning_tokens: totals.reduce((sum, row) => sum + (row.thinkingTokens || 0), 0) }),
          }) : sanitizedCounts({
            prompt_tokens: event.usage.input_tokens + (event.usage.cache_creation_input_tokens || 0) + (event.usage.cache_read_input_tokens || 0),
            completion_tokens: event.usage.output_tokens,
            cached_tokens: event.usage.cache_read_input_tokens, cache_write_tokens: event.usage.cache_creation_input_tokens,
          });
          result = { text: answer || event.result, usage, limits: limits.size ? [...limits.values()] : undefined };
          break;
        }
      }
      turn.signal.throwIfAborted();
      if (!result) throw new Error('Claude Code stopped before producing a result.');
      return result;
    } finally {
      q.close();
      turn.signal.removeEventListener('abort', abort);
      controller.abort();
    }
  },
};
