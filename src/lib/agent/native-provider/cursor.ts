import path from 'node:path';
import { existsSync } from 'node:fs';
import type { SDKCustomTool, SDKImage, ModelListItem, TokenUsage, Run } from '@cursor/sdk';
import { isConcreteModelId } from '../model-selector-store';
import type { NativeLimitSignal, NativeProviderModel } from '../../native-provider-contract';
import { effortOptions, isInlineImage, isInlineText, readNativeAttachment, sanitizedCounts, trustedLoginUrl, waitForNative } from './shared';
import { NativeProviderSetupError, type NativeAdapter, type NativeProfile } from './types';

function sdk() {
  const modules = process.env.ETERX_RUNTIME_MODULES;
  if (modules?.includes('.asar' + path.sep)) {
    const native = path.join(modules.replace('.asar' + path.sep, '.asar.unpacked' + path.sep),
      '@cursor', 'sdk-' + process.platform + '-' + process.arch, 'bin');
    const suffix = process.platform === 'win32' ? '.exe' : '';
    if (existsSync(path.join(native, 'rg' + suffix))) process.env.CURSOR_RIPGREP_PATH = path.join(native, 'rg' + suffix);
    if (existsSync(path.join(native, 'cursorsandbox' + suffix))) process.env.CURSOR_SDK_SANDBOX_BINARY = path.join(native, 'cursorsandbox' + suffix);
  }
  return require('@cursor/sdk') as typeof import('@cursor/sdk');
}
const API = 'https://api2.cursor.sh';
const WEBSITE = 'https://cursor.com';
const credentialStore = (profile: NativeProfile) => new (sdk().FileCredentialStore)(path.join(profile.directory, 'authorization.json'));

function cursorModel(model: ModelListItem): NativeProviderModel {
  const effort = model.parameters?.find(parameter => /^(?:reasoning|thinking|effort|reasoning[_-]?effort)$/i.test(parameter.id));
  return {
    id: model.id, label: model.displayName || model.id,
    ...(effort && { effortId: effort.id, thinking: effortOptions('cursor', model.id, effort.values.map(option => option.value)) }),
    capabilities: ['image-input:true'],
  };
}

async function discover(apiKey: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const models = await waitForNative(sdk().Cursor.models.list({ apiKey }), signal);
  signal.throwIfAborted();
  return { models: models.filter(model => isConcreteModelId(model.id)).map(cursorModel) };
}

async function credential(profile: NativeProfile) {
  const saved = await credentialStore(profile).load();
  if (!saved?.apiKey || saved.backendUrl !== API || (saved.apiKeyExpiresAtMs && saved.apiKeyExpiresAtMs <= Date.now())) {
    throw new NativeProviderSetupError('Sign in to Cursor again in Settings → Subscription.');
  }
  return saved;
}

function tokens(usage?: TokenUsage) {
  if (!usage) return undefined;
  return sanitizedCounts({
    prompt_tokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    completion_tokens: usage.outputTokens, cached_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens, reasoning_tokens: usage.reasoningTokens,
  });
}

function isAuthError(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  return error instanceof NativeProviderSetupError || code === 'unauthenticated' || code === 'authentication_error';
}

function cursorLimit(error: unknown): NativeLimitSignal | undefined {
  if (!error || typeof error !== 'object') return;
  const { code, status, retryAfterMs } = error as { code?: string; status?: number; retryAfterMs?: number };
  if (status !== 429 && code !== 'rate_limit_exceeded' && code !== 'resource_exhausted' && code !== 'rate_limited') return;
  return { kind: 'request', retryAt: typeof retryAfterMs === 'number' && retryAfterMs > 0 ? Date.now() + retryAfterMs : undefined };
}

export const cursorAdapter: NativeAdapter = {
  async version() { return '1.5.0'; },
  async signIn(profile, { signal, apiKey, authorize }) {
    const { Cursor } = sdk();
    const result = apiKey ? { apiKey, apiKeyExpiresAtMs: undefined } : await Cursor.auth.login({
      backendUrl: API, websiteUrl: WEBSITE, openBrowser: false, store: null, signal, apiKeyName: 'EterX',
      onLoginUrl(raw) {
        const url = trustedLoginUrl(raw, ['cursor.com', 'www.cursor.com']);
        if (url) authorize(url);
      },
    });
    const inspection = await discover(result.apiKey, signal);
    signal.throwIfAborted();
    await credentialStore(profile).save({
      version: 1, backendUrl: API, apiKey: result.apiKey, createdAtMs: Date.now(),
      ...(result.apiKeyExpiresAtMs !== undefined ? { apiKeyExpiresAtMs: result.apiKeyExpiresAtMs } : {}),
    });
    return inspection;
  },
  async inspect(profile, signal) { return discover((await credential(profile)).apiKey, signal); },
  async signOut(profile) { await sdk().Cursor.auth.logout({ store: credentialStore(profile) }); },
  isAuthError,
  limitFromError: cursorLimit,
  async run(profile, turn) {
    const { Agent, JsonlLocalAgentStore } = sdk();
    const { apiKey } = await credential(profile);
    const images: SDKImage[] = [];
    const texts: string[] = [turn.prompt];
    for (const file of turn.files) {
      const { name, mimeType, bytes } = await readNativeAttachment(file);
      if (isInlineImage(mimeType)) images.push({ data: bytes.toString('base64'), mimeType });
      else if (isInlineText(mimeType)) texts.push('Attachment ' + name + '\n' + bytes.toString('utf8'));
      else if (turn.context && file.path) texts.push('Attached file: ' + JSON.stringify(file.path));
      else throw new Error('Cursor cannot open ' + name + ' in this chat.');
    }
    const effort = turn.thinking && turn.model.thinking?.wireValues?.[turn.thinking];
    const customTools: Record<string, SDKCustomTool> = Object.fromEntries(turn.tools.map(({ name, ...tool }) => [name, tool]));
    const agent = await waitForNative(Agent.create({
      apiKey, mode: 'agent', tools: turn.tools.length ? ['mcp'] : [],
      model: { id: turn.model.id, ...(effort && turn.model.effortId && { params: [{ id: turn.model.effortId, value: effort }] }) },
      local: { cwd: turn.cwd, store: new JsonlLocalAgentStore(path.join(profile.directory, 'sessions')),
        settingSources: [], customTools, enableAgentRetries: false },
    }).then(open => {
      if (turn.signal.aborted) open.close();
      turn.signal.throwIfAborted();
      return open;
    }), turn.signal);
    let run: Run | undefined;
    const abort = () => { void run?.cancel().catch(() => undefined); };
    turn.signal.addEventListener('abort', abort, { once: true });
    try {
      turn.signal.throwIfAborted();
      let answer = '';
      let usage: TokenUsage | undefined;
      let sawTextDelta = false;
      let sawThoughtDelta = false;
      const activeRun = await waitForNative(agent.send({ text: texts.join('\n\n'), images }, {
        onDelta({ update }) {
          if (update.type === 'text-delta') {
            sawTextDelta = true;
            answer += update.text;
            turn.onText(update.text);
          } else if (update.type === 'thinking-delta') {
            sawThoughtDelta = true;
            turn.onThought?.(update.text);
          }
        },
      }).then(started => {
        if (turn.signal.aborted) void started.cancel().catch(() => undefined);
        return started;
      }), turn.signal);
      run = activeRun;
      if (turn.signal.aborted) abort();
      for await (const event of activeRun.stream()) {
        if (event.type === 'assistant' && !sawTextDelta) {
          const delta = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
          answer += delta;
          turn.onText(delta);
        } else if (event.type === 'thinking' && !sawThoughtDelta) turn.onThought?.(event.text);
        else if (event.type === 'usage') usage = event.usage;
        else if (event.type === 'tool_call') turn.onTool?.({
          id: event.call_id, label: event.name, status: event.status,
          kind: /edit/i.test(event.name) ? 'edit' : /(?:read|inspect)/i.test(event.name) ? 'read' : 'command',
        });
      }
      turn.signal.throwIfAborted();
      const result = await activeRun.wait();
      if (result.status !== 'finished') {
        const limit = cursorLimit(result.error);
        if (limit) {
          turn.onLimit?.(limit);
          throw new Error('Cursor limited this request. See Usage → Limits for this account.');
        }
        throw new Error('Cursor ended the turn before completing it.');
      }
      return { text: answer || result.result || '', usage: tokens(result.usage ?? usage) };
    } finally {
      turn.signal.removeEventListener('abort', abort);
      agent.close();
    }
  },
};
