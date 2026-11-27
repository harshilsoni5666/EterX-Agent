import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readModelUsage } from '../../model-usage';
import {
  NATIVE_PROVIDERS, NATIVE_PROVIDER_INFO, type NativeProvider, type NativeProviderModel, type NativeProviderRequest,
  type NativeLimitSignal, type NativeLimitObservation, type NativeProviderSnapshot, type NativeProviderStatus, type NativeUsageWindow,
} from '../../native-provider-contract';
import { initializeCodexBridge } from '../codex-subscription-runtime';
import { isConcreteModelId } from '../model-selector-store';
import { getEterxDataDir } from '../storage-paths';
import { cursorAdapter } from './cursor';
import { grokBuildAdapter } from './grok';
import { claudeCodeAdapter } from './claude';
import { NativeProviderSetupError, type NativeAdapter, type NativeInspection, type NativeProfile } from './types';

type Account = Pick<NativeProfile, 'id' | 'label' | 'method'> & { connected: boolean; models: NativeProviderModel[]; limits?: NativeUsageWindow[]; limitsUpdatedAt?: number };
type Saved = { binaryPath: string; activeAccountId: string | null; accounts: Account[] };
type Action = { activity: NonNullable<NativeProviderStatus['activity']>; accountId?: string; controller: AbortController;
  authorizationUrl?: string; deviceCode?: string };
type LiveAccount = { leases: number; turns: number; lastTurn?: { model: string; input: number | null; output: number | null };
  limits?: NativeUsageWindow[]; limitsUpdatedAt?: number; limit?: NativeLimitObservation };
type Entry = { saved: Saved; version: string | null; live: Map<string, LiveAccount>; action?: Action; error?: string };
type Runtime = {
  epoch: string; revision: number; usageRevision: number;
  entries: Map<NativeProvider, Entry>;
  subscribers: Set<() => void>;
  scope: AsyncLocalStorage<{ provider: NativeProvider; model?: string; id: string | null }>;
};

const adapters: Record<NativeProvider, NativeAdapter> = {
  cursor: cursorAdapter, 'grok-build': grokBuildAdapter, 'claude-code': claudeCodeAdapter,
};
const globalState = globalThis as typeof globalThis & { __eterxNativeProviders?: Runtime };
const state = (): Runtime => globalState.__eterxNativeProviders ??= {
  epoch: randomUUID(), revision: 0, usageRevision: 0, entries: new Map(), subscribers: new Set(), scope: new AsyncLocalStorage(),
};
const directory = (provider: NativeProvider) => path.join(getEterxDataDir(), 'native-providers', provider);
const profileDirectory = (provider: NativeProvider, id: string) => path.join(directory(provider), 'profiles', id);
const info = (provider: NativeProvider) => NATIVE_PROVIDER_INFO[provider];
const revision = (runtime: Runtime) => runtime.epoch + ':' + runtime.revision;
export const isNativeProviderAccountId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);

function read(provider: NativeProvider): Saved {
  const defaults: Saved = { binaryPath: '', activeAccountId: null, accounts: [] };
  try {
    const value: Partial<Saved> = JSON.parse(readFileSync(path.join(directory(provider), 'accounts.json'), 'utf8'));
    const accounts = Array.isArray(value.accounts) ? value.accounts.filter(account =>
      isNativeProviderAccountId(account?.id) && typeof account.label === 'string' && Array.isArray(account.models) &&
      (account.method === 'browser' || (provider === 'cursor' && account.method === 'api-key'))) : [];
    return {
      binaryPath: typeof value.binaryPath === 'string' && path.isAbsolute(value.binaryPath) ? value.binaryPath : '',
      activeAccountId: accounts.find(account => account.id === value.activeAccountId && account.connected)?.id ??
        accounts.find(account => account.connected)?.id ?? null,
      accounts,
    };
  } catch { return defaults; }
}

function entry(runtime: Runtime, provider: NativeProvider) {
  let result = runtime.entries.get(provider);
  if (!result) {
    result = { saved: read(provider), version: provider === 'cursor' ? '1.5.0' : null, live: new Map() };
    runtime.entries.set(provider, result);
  }
  return result;
}

function publish(runtime: Runtime) {
  runtime.revision++;
  for (const subscriber of runtime.subscribers) subscriber();
}

function save(runtime: Runtime, provider: NativeProvider, next: Saved) {
  const dir = directory(provider);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, randomUUID() + '.tmp');
  try {
    writeFileSync(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path.join(dir, 'accounts.json'));
  } finally { try { unlinkSync(temporary); } catch { /* Rename removes the temporary file. */ } }
  entry(runtime, provider).saved = next;
  publish(runtime);
}

function updateAccount(runtime: Runtime, provider: NativeProvider, account: Account, activate = false) {
  const saved = entry(runtime, provider).saved;
  const exists = saved.accounts.some(item => item.id === account.id);
  const accounts = exists ? saved.accounts.map(item => item.id === account.id ? account : item) : [...saved.accounts, account];
  const active = activate ? account.id
    : accounts.find(item => item.connected && item.id === saved.activeAccountId)?.id ?? accounts.find(item => item.connected)?.id ?? null;
  save(runtime, provider, { ...saved, accounts, activeAccountId: active });
}

function live(entry: Entry, id: string) {
  let result = entry.live.get(id);
  if (!result) { result = { leases: 0, turns: 0 }; entry.live.set(id, result); }
  return result;
}
const running = (item?: LiveAccount) => item ? Math.max(item.leases, item.turns) : 0;

function buildSnapshot(runtime: Runtime): NativeProviderSnapshot {
  const providers = {} as NativeProviderSnapshot['providers'];
  for (const provider of NATIVE_PROVIDERS) {
    const { saved, version, live, action, error } = entry(runtime, provider);
    const models = new Map<string, NativeProviderModel>();
    for (const account of saved.accounts) {
      if (!account.connected) continue;
      for (const model of account.models) if (!models.has(model.id)) models.set(model.id, model);
    }
    providers[provider] = {
      version, binaryPath: saved.binaryPath, activity: action?.activity ?? null, error,
      authorizationUrl: action?.authorizationUrl, deviceCode: action?.deviceCode,
      activeAccountId: saved.activeAccountId,
      models: [...models.values()],
      accounts: saved.accounts.map(({ id, label, connected, method, limits, limitsUpdatedAt }) => {
        const current = live.get(id);
        return { id, label, connected, method, runningTurns: running(current), lastTurn: current?.lastTurn, limit: current?.limit,
          limits: current?.limits ?? limits, limitsUpdatedAt: current?.limitsUpdatedAt ?? limitsUpdatedAt };
      }),
    };
  }
  return { revision: revision(runtime), usageRevision: runtime.usageRevision, providers };
}

async function watch(runtime: Runtime, after: string | undefined, signal: AbortSignal) {
  if (after === revision(runtime) && !signal.aborted) await new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      runtime.subscribers.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, 20_000);
    timer.unref();
    signal.addEventListener('abort', finish, { once: true });
    runtime.subscribers.add(finish);
    if (signal.aborted) finish();
  });
  return buildSnapshot(runtime);
}

const asProfile = (provider: NativeProvider, account: Account, binaryPath: string): NativeProfile => ({
  id: account.id, label: account.label, method: account.method, directory: profileDirectory(provider, account.id), binaryPath,
});

function inspectAccount(account: Account, inspection: NativeInspection): Account {
  const models = [...new Map(inspection.models.filter(model => isConcreteModelId(model.id) && model.id.length <= 220)
    .map(model => [model.id, { ...model, label: String(model.label || model.id).slice(0, 160) }])).values()].slice(0, 200);
  return { ...account, connected: true, models, limits: inspection.limits ?? account.limits,
    limitsUpdatedAt: inspection.limits ? Date.now() : account.limitsUpdatedAt };
}

const disconnect = (account: Account): Account => ({ ...account, connected: false, models: [], limits: undefined, limitsUpdatedAt: undefined });
const errorText = (provider: NativeProvider, error: unknown, fallback: string) =>
  error instanceof NativeProviderSetupError ? error.message : info(provider).name + ' ' + fallback;

export async function nativeProviderAction(request: NativeProviderRequest, requestSignal: AbortSignal) {
  const runtime = state();
  if (request.action === 'watch') return watch(runtime, request.revision, requestSignal);
  const provider = request.provider;
  if (!provider) throw new NativeProviderSetupError('Select a provider.');
  const store = entry(runtime, provider);
  const adapter = adapters[provider];
  const { saved } = store;
  const account = saved.accounts.find(item => item.id === (request.accountId || saved.activeAccountId));
  if (request.action === 'cancel') {
    if (store.action?.activity === 'sign-in') store.action.controller.abort();
    return buildSnapshot(runtime);
  }
  if (store.action) throw new NativeProviderSetupError('Wait for the current provider action to finish.');
  if (request.accountId && !account) throw new NativeProviderSetupError('This provider account is unavailable.');
  if (request.action === 'switch') {
    if (!account?.connected) throw new NativeProviderSetupError('Connect this account first.');
    save(runtime, provider, { ...saved, activeAccountId: account.id });
    return buildSnapshot(runtime);
  }
  const requested = request.action;
  const protectedAccounts = requested === 'clear' || requested === 'binary' ? saved.accounts : account ? [account] : [];
  if (['clear', 'binary', 'sign-out'].includes(requested) && protectedAccounts.some(item => running(store.live.get(item.id)))) {
    throw new NativeProviderSetupError('Wait for this provider’s active turns to finish.');
  }
  if (requested === 'sign-out' && !account) throw new NativeProviderSetupError('Select an account to sign out.');
  if (requested === 'sign-in' && request.apiKey && provider !== 'cursor') throw new NativeProviderSetupError('Use this provider’s own sign-in.');
  const target = requested === 'sign-in' ? (request.accountId ? account! : {
    id: randomUUID(), label: request.label?.trim() || info(provider).auth + ' account ' + (saved.accounts.length + 1),
    connected: false, method: request.apiKey ? 'api-key' as const : 'browser' as const, models: [],
  }) : account;
  if (requested === 'sign-in' && target?.connected) throw new NativeProviderSetupError('This account is already connected.');
  const action: Action = { activity: requested === 'binary' ? 'refresh' : requested, accountId: target?.id, controller: new AbortController() };
  const timeout = AbortSignal.timeout(requested === 'sign-in' ? 5 * 60_000 : requested === 'clear' ? 60_000 : 40_000);
  const signal = AbortSignal.any([action.controller.signal, timeout]);
  store.action = action;
  store.error = undefined;
  publish(runtime);
  void (async () => {
    try {
      if (requested === 'binary') {
        const binaryPath = request.binaryPath?.trim() || '';
        if (provider === 'cursor' || (binaryPath && !path.isAbsolute(binaryPath))) {
          throw new NativeProviderSetupError('Enter an absolute path to the installed CLI executable.');
        }
        const version = await adapter.version(binaryPath, signal);
        if (!version && binaryPath) throw new NativeProviderSetupError('This path did not start the provider’s CLI.');
        save(runtime, provider, { ...store.saved, binaryPath });
        store.version = version;
      } else if (requested === 'refresh' || requested === 'sign-in') {
        store.version = await adapter.version(store.saved.binaryPath, signal);
        if (!store.version) {
          if (requested === 'sign-in') throw new NativeProviderSetupError('Install the provider’s CLI before connecting an account.');
          return;
        }
        if (!target) return;
        const profile = asProfile(provider, target, store.saved.binaryPath);
        mkdirSync(profile.directory, { recursive: true, mode: 0o700 });
        if (requested === 'sign-in') {
          if (!request.accountId) updateAccount(runtime, provider, target);
          const inspection = await adapter.signIn(profile, { signal, apiKey: request.apiKey,
            authorize(url, deviceCode) {
              if (signal.aborted || store.action !== action || (action.authorizationUrl === url && action.deviceCode === deviceCode)) return;
              action.authorizationUrl = url;
              action.deviceCode = deviceCode;
              publish(runtime);
            } });
          signal.throwIfAborted();
          updateAccount(runtime, provider, inspectAccount({ ...target, method: request.apiKey ? 'api-key' : 'browser' }, inspection), true);
        } else if (target.connected) {
          const inspection = await adapter.inspect(profile, signal);
          signal.throwIfAborted();
          updateAccount(runtime, provider, inspectAccount(target, inspection));
          const current = live(store, target.id);
          current.limits = undefined;
          current.limitsUpdatedAt = undefined;
        }
      } else {
        const accounts = requested === 'clear' ? store.saved.accounts : target ? [target] : [];
        for (const item of accounts) {
          signal.throwIfAborted();
          await adapter.signOut(asProfile(provider, item, store.saved.binaryPath), signal);
          store.live.delete(item.id);
          updateAccount(runtime, provider, disconnect(item));
        }
        if (requested === 'clear') save(runtime, provider, { ...store.saved, accounts: [], activeAccountId: null });
      }
    } catch (error) {
      if (action.controller.signal.aborted) return;
      if (requested === 'refresh' && target?.connected && adapter.isAuthError?.(error)) {
        updateAccount(runtime, provider, disconnect(target));
      }
      store.error = errorText(provider, error, timeout.aborted ? 'did not respond in time. Try again.' : 'could not complete this action. Try again.');
    } finally {
      store.action = undefined;
      publish(runtime);
    }
  })();
  return buildSnapshot(runtime);
}

/** Keep the selected credential fixed through compaction and generation. */
export function nativeProviderOffersModel(provider: NativeProvider, model: string) {
  return entry(state(), provider).saved.accounts.some(account => account.connected && account.models.some(item => item.id === model));
}

export function nativeProviderModelList() {
  const { providers } = buildSnapshot(state());
  return NATIVE_PROVIDERS.flatMap(provider => providers[provider].models.map(model => ({ provider, model: model.id })));
}

export async function runWithNativeAccount<T>(provider: NativeProvider, model: string | undefined, run: () => Promise<T>): Promise<T> {
  const runtime = state();
  const pinned = runtime.scope.getStore();
  if (pinned?.provider === provider && pinned.model === model) return run();
  const store = entry(runtime, provider);
  const matches = (account: Account) => account.connected && (!model || account.models.some(item => item.id === model));
  const usable = (account: Account) => matches(account) &&
    store.action?.activity !== 'clear' && (store.action?.activity !== 'sign-out' || store.action.accountId !== account.id);
  if (pinned?.provider === provider && store.saved.accounts.some(account => account.id === pinned.id && matches(account))) return run();
  const id = store.saved.accounts.find(usable)?.id;
  if (!id) return runtime.scope.run({ provider, model, id: null }, run);
  const current = live(store, id);
  current.leases++;
  publish(runtime);
  try { return await runtime.scope.run({ provider, model, id }, run); }
  finally { current.leases--; publish(runtime); }
}

export async function withNativeProfile<T>(provider: NativeProvider, model: string,
  run: (adapter: NativeAdapter, profile: NativeProfile, models: NativeProviderModel[]) => Promise<T>): Promise<T> {
  if (!initializeCodexBridge()) throw new NativeProviderSetupError('Open EterX desktop to use ' + info(provider).name + '.');
  return runWithNativeAccount(provider, model, async () => {
    const runtime = state();
    const store = entry(runtime, provider);
    const account = store.saved.accounts.find(item => item.id === runtime.scope.getStore()?.id && item.connected);
    if (!account) throw new NativeProviderSetupError('Connect a ' + info(provider).name + ' account that offers this model in Settings → Subscription.');
    const adapter = adapters[provider];
    const current = live(store, account.id);
    current.turns++;
    publish(runtime);
    try { return await run(adapter, asProfile(provider, account, store.saved.binaryPath), account.models); }
    catch (error) {
      if (adapter.isAuthError?.(error)) {
        updateAccount(runtime, provider, disconnect(account));
        throw new NativeProviderSetupError('Reconnect ' + info(provider).name + ' in Settings → Subscription.');
      }
      const limit = adapter.limitFromError?.(error);
      if (limit) recordNativeLimit(provider, account.id, limit);
      throw error;
    } finally { current.turns--; publish(runtime); }
  });
}

export function recordNativeLimit(provider: NativeProvider, id: string, limit: NativeLimitSignal) {
  const runtime = state();
  const store = entry(runtime, provider);
  if (!store.saved.accounts.some(account => account.id === id && account.connected && account.method === 'browser')) return;
  const current = live(store, id);
  const observedAt = Date.now();
  const retryAt = typeof limit.retryAt === 'number' && Number.isFinite(limit.retryAt) &&
    limit.retryAt > observedAt && limit.retryAt < 8.64e15 ? limit.retryAt : undefined;
  // A burst throttle does not replace a still active plan limit.
  if (limit.kind === 'request' && current.limit?.kind === 'plan' &&
    (current.limit.retryAt ?? current.limit.observedAt + 15 * 60_000) > observedAt) return;
  current.limit = { kind: limit.kind, retryAt, observedAt };
  publish(runtime);
}

export function recordNativeUsage(provider: NativeProvider, id: string, model: string, usage: unknown, limits?: NativeUsageWindow[], primary = true) {
  const runtime = state();
  const account = live(entry(runtime, provider), id);
  if (primary) {
    const measured = readModelUsage(usage ?? {});
    account.lastTurn = { model, input: measured.inputMeasured ? measured.promptTokens : null,
      output: measured.outputMeasured ? measured.outputTokens : null };
  }
  if (limits?.length) {
    account.limits = limits;
    account.limitsUpdatedAt = Date.now();
  }
  runtime.usageRevision++;
  publish(runtime);
}
