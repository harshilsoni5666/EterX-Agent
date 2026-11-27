import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { AntigravityAllowance, AntigravityRequest, AntigravityState, AntigravityTurnUsage } from '../../antigravity-contract';
import { readModelUsage } from '../../model-usage';
import { initializeCodexBridge } from '../codex-subscription-runtime';
import { AntigravityAcpClient, AntigravityRpcError } from './acp';
import { installAntigravity, supportsAntigravity } from './installation';
import {
  binDir, binary, hasProfileSignIn, nativeProfileArgs, nativeProfileHome, newAntigravityAccount, NO_MEDIA,
  prepareAntigravityProfile, readAntigravityProfiles, setupWorkspace, writeAntigravityProfiles,
  type SavedAccount, type SavedAntigravity,
} from './profiles';
import { modelThinking, selectSessionModel, sessionModels, thinkingOption } from './session-config';

const exec = promisify(execFile);
const CALLBACK = 'https://antigravity.google/oauth-callback';
const CHILD_ENV = /^(?:PATH|PATHEXT|HOME|USER|USERNAME|USERPROFILE|LOGNAME|APPDATA|LOCALAPPDATA|PROGRAMDATA|SYSTEMROOT|WINDIR|COMSPEC|TMP|TEMP|TMPDIR|LANG|LANGUAGE|LC_.+|XDG_.+|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE)$/i;
const MIN_ALLOWANCE_INTERVAL_MS = 15_000;

type Operation = {
  activity: NonNullable<AntigravityState['activity']>;
  accountId: string | null;
  controller: AbortController;
  login?: { child: ChildProcessWithoutNullStreams; state: string; url: string; submitted: boolean };
};
type AccountRuntime = {
  turns: number;
  leases: number;
  lastTurn?: AntigravityTurnUsage;
  allowanceRequest?: { controller: AbortController; settled?: Promise<void> };
  allowanceTimer?: ReturnType<typeof setTimeout>;
  allowanceStartedAt: number;
  allowanceDirty: boolean;
  allowanceError?: string;
};
type Runtime = {
  saved: SavedAntigravity;
  accounts: Map<string, AccountRuntime>;
  operation?: Operation;
  error: string | null;
  epoch: string;
  revision: number;
  usageRevision: number;
  listeners: Set<() => void>;
  scope: AsyncLocalStorage<{ accountId: string | null; model?: string }>;
  writes: Promise<void>;
};
const globals = globalThis as typeof globalThis & { __eterxAntigravityProvider?: Runtime };

function runtime(): Runtime {
  return globals.__eterxAntigravityProvider ??= {
    saved: readAntigravityProfiles(), accounts: new Map(), error: null, epoch: randomUUID(),
    revision: 0, usageRevision: 0, listeners: new Set(), scope: new AsyncLocalStorage(), writes: Promise.resolve(),
  };
}

function accountRuntime(store: Runtime, id: string): AccountRuntime {
  const existing = store.accounts.get(id);
  if (existing) return existing;
  const account = { turns: 0, leases: 0, allowanceStartedAt: 0, allowanceDirty: false };
  store.accounts.set(id, account);
  return account;
}

const activeAccount = ({ saved }: Runtime) => saved.accounts.find(account => account.id === saved.activeAccountId && account.connected);
const revision = (store: Runtime) => `${store.epoch}:${store.revision}`;
const runningTurns = (account: AccountRuntime | undefined) => account ? Math.max(account.turns, account.leases) : 0;
const signingOut = (operation: Operation | undefined, id: string) => operation && (operation.accountId === id || operation.accountId === null) &&
  (operation.activity === 'signing-out' || operation.activity === 'removing');

function publish(store: Runtime) {
  store.revision++;
  for (const listener of store.listeners) listener();
}

function publicState(store: Runtime): AntigravityState {
  const { saved, operation } = store;
  const connected = saved.version ? saved.accounts.filter(account => account.connected) : [];
  const active = connected[0];
  const models = new Map<string, AntigravityState['models'][number]>();
  for (const account of connected) {
    for (const model of account.models) if (!models.has(model.id)) models.set(model.id, { ...model, capabilities: account.capabilities });
  }
  return {
    revision: revision(store), usageRevision: `${store.epoch}:${store.usageRevision}`,
    supported: supportsAntigravity, version: saved.version, connected: Boolean(active), activeAccountId: active?.id ?? null,
    models: [...models.values()],
    capabilities: active?.capabilities ?? NO_MEDIA,
    activity: operation?.activity ?? null, activityAccountId: operation?.accountId ?? null,
    authorizationUrl: operation?.login && !operation.login.submitted ? operation.login.url : null,
    error: store.error,
    accounts: saved.accounts.map(({ id, label, connected, allowance, allowanceUpdatedAt }) => {
      const live = store.accounts.get(id);
      return {
        id, label, connected, allowance, allowanceUpdatedAt, runningTurns: runningTurns(live),
        lastTurn: live?.lastTurn ?? null, allowanceError: live?.allowanceError ?? null, loadingAllowance: Boolean(live?.allowanceRequest),
      };
    }),
  };
}

function waitForChange(store: Runtime, after: string | undefined, signal: AbortSignal) {
  if (after !== revision(store) || signal.aborted) return;
  return new Promise<void>(resolve => {
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      store.listeners.delete(done);
      resolve();
    }
    const timeout = setTimeout(done, 20_000);
    timeout.unref();
    store.listeners.add(done);
    signal.addEventListener('abort', done, { once: true });
  });
}

function save(store: Runtime, update: (saved: SavedAntigravity) => SavedAntigravity) {
  const write = store.writes.then(async () => {
    const next = update(store.saved);
    if (next === store.saved) return;
    if (next.activeAccountId && !next.accounts.some(account => account.id === next.activeAccountId)) next.activeAccountId = null;
    await writeAntigravityProfiles(next);
    store.saved = next;
    publish(store);
  });
  store.writes = write.catch(() => undefined);
  return write;
}

function saveAccount(store: Runtime, id: string, patch: Partial<SavedAccount>, signal?: AbortSignal) {
  return save(store, saved => {
    if (signal?.aborted || !saved.accounts.some(account => account.id === id)) return saved;
    return { ...saved, activeAccountId: saved.activeAccountId || (patch.connected === true ? id : null),
      accounts: saved.accounts.map(account => account.id === id ? { ...account, ...patch } : account) };
  });
}

function env(id: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => CHILD_ENV.test(key))),
    NODE_ENV: process.env.NODE_ENV,
    GEMINI_HOME: nativeProfileHome(id),
    AGY_ACP_FORCE_FILE_STORAGE: '1',
    AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1',
    AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    // Older CLI releases use SSH detection to select profile-local storage.
    SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0',
  };
}

function requireProfileSignIn(id: string) {
  if (!hasProfileSignIn(id)) throw new AntigravityRpcError(-32000, 'Connect this account with the Antigravity sign-in flow.');
}

const authRequired = (error: unknown) => error instanceof AntigravityRpcError && (
  error.code === -32000 || /no browser is available|authentication required|not authenticated|sign.?in required/i.test(error.message)
);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message
    ? error.message.replace(/https:\/\/accounts\.google\.com\/\S+/gi, '[Google sign-in link]').slice(0, 450)
    : fallback;
}

type SessionOptions = Pick<ConstructorParameters<typeof AntigravityAcpClient>[0], 'cwd' | 'signal' | 'onUpdate' | 'onPermission'> & { mcpServers?: unknown[] };

function createClient(id: string, options: SessionOptions) {
  return new AntigravityAcpClient({ ...options, command: binary(),
    args: ['acp', ...nativeProfileArgs(id), ...(options.mcpServers?.length ? ['--process-per-session'] : [])], env: env(id) });
}

async function authenticate(client: AntigravityAcpClient, id: string) {
  requireProfileSignIn(id);
  const info = await client.initialize();
  await client.request('authenticate', { methodId: 'oauth-personal' });
  return info;
}

async function openClient(client: AntigravityAcpClient, id: string, instruction?: string, mcpServers: unknown[] = []) {
  const info = await authenticate(client, id);
  const extension = info.agentCapabilities?._meta?.antigravity?.systemPrompt;
  const session = await client.newSession(extension?.append === true ? instruction : undefined,
    info.agentCapabilities?.mcpCapabilities?.http === true ? mcpServers : []);
  return { accountId: id, info, session, appended: extension?.append === true };
}

async function probe(store: Runtime, id: string, cancellation: AbortSignal) {
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(120_000)]);
  await prepareAntigravityProfile(id);
  requireProfileSignIn(id);
  const client = createClient(id, { cwd: setupWorkspace(), signal });
  try {
    const info = await authenticate(client, id);
    signal.throwIfAborted();
    if (!store.saved.accounts.find(account => account.id === id)?.connected) await saveAccount(store, id, { connected: true }, signal);
    const session = await client.newSession();
    const models = sessionModels(session);
    if (!models.length) throw new Error('Google did not offer any models for this Antigravity account.');
    if (thinkingOption(session)) {
      // The config describes the active model; each selection supplies its own list.
      for (const model of models) {
        signal.throwIfAborted();
        try {
          const selected = await selectSessionModel(client, session, model.id, false);
          model.thinking = modelThinking(selected, model.id);
        } catch (error) {
          if (!(error instanceof AntigravityRpcError) || authRequired(error)) throw error;
        }
      }
    }
    const media = info.agentCapabilities?.promptCapabilities;
    signal.throwIfAborted();
    await saveAccount(store, id, { connected: true, models, capabilities: {
      image: media?.image === true, audio: media?.audio === true, embeddedContext: media?.embeddedContext === true,
    } }, signal);
  } finally {
    await client.dispose();
  }
}

function authorization(line: string): URL | null {
  const candidate = line.match(/https:\/\/accounts\.google\.com\/[^\s<>]+/)?.[0];
  if (!candidate || candidate.length > 8192) return null;
  const url = URL.parse(candidate);
  if (url?.origin !== 'https://accounts.google.com' || !['/o/oauth2/auth', '/o/oauth2/v2/auth'].includes(url.pathname) ||
      url.username || url.password || url.hash || url.searchParams.get('redirect_uri') !== CALLBACK ||
      url.searchParams.get('response_type') !== 'code' || !url.searchParams.get('state')) return null;
  return url;
}

async function signIn(store: Runtime, id: string, operation: Operation) {
  await prepareAntigravityProfile(id);
  const signal = AbortSignal.any([operation.controller.signal, AbortSignal.timeout(10 * 60_000)]);
  signal.throwIfAborted();
  const child = spawn(binary(), ['acp', ...nativeProfileArgs(id), '--login'], { cwd: setupWorkspace(), env: env(id), signal, windowsHide: true });
  child.stderr.resume();
  child.stdin.on('error', () => undefined);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    if (signal.aborted || operation.login) return;
    const url = authorization(line);
    if (!url) return;
    operation.login = { child, state: url.searchParams.get('state')!, url: url.href, submitted: false };
    publish(store);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => reject(new Error('Could not start Google sign-in.')));
      child.once('close', code => code === 0
        ? resolve() : reject(new Error('Google sign-in did not complete. Start sign-in again.')));
    });
    signal.throwIfAborted();
    if (!hasProfileSignIn(id)) throw new Error('Antigravity did not save an isolated Google sign-in. Try connecting this account again.');
  } finally {
    lines.close();
    operation.login = undefined;
    publish(store);
  }
  await probe(store, id, signal);
}

function submitCode(store: Runtime, raw: unknown) {
  const login = store.operation?.login;
  if (!login || login.submitted || !login.child.stdin.writable) throw new Error('There is no pending Antigravity sign-in.');
  const value = typeof raw === 'string' ? raw.trim() : '';
  const url = value.length <= 8192 && value.startsWith('https://') && !/\s/.test(value) ? URL.parse(value) : null;
  const code = url && `${url.origin}${url.pathname}` === CALLBACK && !url.username && !url.password && !url.hash &&
      url.searchParams.get('state') === login.state ? url.searchParams.get('code') : value;
  if (!code || !/^[\w./~-]{1,2048}$/.test(code)) throw new Error('Paste the code from the Antigravity sign-in page.');
  login.submitted = true;
  login.child.stdin.end(`${code}\n`);
  publish(store);
}

function parseAllowance(stdout: string): AntigravityAllowance[] {
  let payload;
  try { payload = JSON.parse(stdout.trim()); }
  catch { throw new Error('Antigravity did not return plan limits for this account.'); }
  const groups = [payload?.command?.data, payload?.data, payload].find(item => Array.isArray(item?.groups))?.groups;
  if (!Array.isArray(groups)) throw new Error('Antigravity did not return plan limits for this account.');
  const windows: AntigravityAllowance[] = [];
  for (const group of groups) {
    const name = String(group?.title || group?.label || group?.name || group?.display_name || group?.displayName || group?.group || 'Models').slice(0, 120);
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const window = String(bucket?.window || bucket?.name || '').slice(0, 80);
      if (!window) continue;
      const fraction = bucket?.remaining_fraction ?? bucket?.remainingFraction;
      const remaining = typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction : null;
      const reset = Date.parse(bucket?.reset_time || bucket?.resetTime || '');
      windows.push({ group: name, window, remaining, resetAt: Number.isFinite(reset) ? reset : null });
    }
  }
  if (!windows.length) throw new Error('Antigravity did not return plan limits for this account.');
  return windows.slice(0, 40);
}

async function refreshAllowance(id: string, signal: AbortSignal) {
  requireProfileSignIn(id);
  await prepareAntigravityProfile(id);
  signal.throwIfAborted();
  const command = exec(binary(), [...nativeProfileArgs(id), '--output-format', 'json', '--print', '/usage'], {
    cwd: setupWorkspace(), env: env(id), timeout: 90_000, signal, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  });
  const closed = new Promise<void>(resolve => command.child.once('close', () => resolve()));
  let stdout: string;
  try {
    ({ stdout } = await command);
  } catch {
    throw new Error('Antigravity could not refresh plan limits.');
  } finally {
    await closed;
  }
  return parseAllowance(stdout);
}

function stopAllowance(live: AccountRuntime) {
  clearTimeout(live.allowanceTimer);
  live.allowanceTimer = undefined;
  live.allowanceDirty = false;
  live.allowanceRequest?.controller.abort();
  live.allowanceError = undefined;
  return live.allowanceRequest?.settled;
}

async function markDisconnected(store: Runtime, id: string) {
  const live = accountRuntime(store, id);
  stopAllowance(live);
  live.lastTurn = undefined;
  await save(store, saved => {
    const accounts = saved.accounts.map(account => account.id !== id ? account : {
      ...account, connected: false, models: [], capabilities: NO_MEDIA, allowance: [], allowanceUpdatedAt: null,
    });
    return { ...saved, accounts, activeAccountId: saved.activeAccountId === id
      ? accounts.find(account => account.connected)?.id ?? null : saved.activeAccountId };
  });
}

function queueAllowance(store: Runtime, id: string, force = false) {
  const connected = () => store.saved.accounts.some(account => account.id === id && account.connected);
  if (!store.saved.version || !connected() || signingOut(store.operation, id)) return;
  const live = accountRuntime(store, id);
  if (live.allowanceRequest) {
    if (!force) live.allowanceDirty = true;
    return;
  }
  if (live.allowanceTimer && !force) return;
  clearTimeout(live.allowanceTimer);
  live.allowanceTimer = undefined;
  const start = () => {
    live.allowanceTimer = undefined;
    if (!connected() || signingOut(store.operation, id) || live.allowanceRequest) return;
    const request: NonNullable<AccountRuntime['allowanceRequest']> = { controller: new AbortController() };
    const { signal } = request.controller;
    live.allowanceRequest = request;
    live.allowanceStartedAt = Date.now();
    live.allowanceError = undefined;
    publish(store);
    request.settled = refreshAllowance(id, signal).then(
      allowance => saveAccount(store, id, { allowance, allowanceUpdatedAt: Date.now() }, signal),
    ).catch(async error => {
      if (signal.aborted) return;
      if (authRequired(error)) {
        await markDisconnected(store, id).catch(() => undefined);
      } else live.allowanceError = errorMessage(error, 'Antigravity plan limits are unavailable.');
    }).finally(() => {
      live.allowanceRequest = undefined;
      publish(store);
      if (live.allowanceDirty) {
        live.allowanceDirty = false;
        queueAllowance(store, id);
      }
    });
  };
  if (force) start();
  else {
    live.allowanceTimer = setTimeout(start, Math.max(900, MIN_ALLOWANCE_INTERVAL_MS - (Date.now() - live.allowanceStartedAt)));
    live.allowanceTimer.unref();
  }
}

async function logout(store: Runtime, id: string, signal: AbortSignal) {
  await stopAllowance(accountRuntime(store, id));
  if (!hasProfileSignIn(id)) return;
  await prepareAntigravityProfile(id);
  const client = createClient(id, { cwd: setupWorkspace(), signal });
  try {
    const info = await client.initialize();
    if (!info.agentCapabilities?.auth?.logout) throw new Error('This Antigravity runtime does not offer native sign-out.');
    await client.request('logout', {});
  } finally {
    await client.dispose();
  }
}

const operationLabels = {
  install: 'installing', 'sign-in': 'signing-in', refresh: 'refreshing', 'sign-out': 'signing-out', switch: 'switching', remove: 'removing',
  'disconnect-all': 'signing-out',
} as const;

export async function antigravityAction(request: AntigravityRequest, requestSignal: AbortSignal): Promise<AntigravityState> {
  const store = runtime();
  const { action, accountId, label, code } = request;
  if (action === 'watch') await waitForChange(store, request.revision, requestSignal);
  if (action === 'state' || action === 'watch') return publicState(store);
  if (action === 'cancel') {
    if (store.operation?.activity === 'signing-in' || store.operation?.activity === 'installing') store.operation.controller.abort();
    return publicState(store);
  }
  if (action === 'submit-code') {
    if (accountId !== store.operation?.accountId) throw new Error('This Antigravity sign-in has ended.');
    submitCode(store, code);
    return publicState(store);
  }
  const accounts = store.saved.accounts;
  const reset = action === 'disconnect-all';
  if (reset && !accounts.some(account => account.connected || hasProfileSignIn(account.id))) return publicState(store);
  if (!supportsAntigravity) throw new Error('Antigravity is unavailable on this desktop platform.');
  if (action === 'install' && store.saved.version) return publicState(store);
  if (action !== 'install' && !store.saved.version) throw new Error('Install Antigravity before continuing.');

  const account = accountId ? accounts.find(item => item.id === accountId) : activeAccount(store);
  if (action === 'usage') {
    if (!account?.connected) throw new Error('Connect this Antigravity account to see its plan limits.');
    queueAllowance(store, account.id, true);
    return publicState(store);
  }
  if (store.operation) throw new Error('Another Antigravity account action is in progress.');
  const signingIn = action === 'sign-in';
  const target = reset || action === 'install' ? undefined : signingIn && !accountId
    ? newAntigravityAccount(randomUUID(), label?.trim() || `Google account ${accounts.length + 1}`)
    : account;
  if (action !== 'install' && !reset && !target) throw new Error('This Antigravity account is unavailable.');
  if (signingIn && target?.connected) return publicState(store);
  if ((action === 'switch' || action === 'refresh') && !target?.connected) throw new Error('Sign in to this Antigravity account first.');
  if (action === 'switch' && target?.id === store.saved.activeAccountId) return publicState(store);
  const affected = reset ? accounts : target ? [target] : [];
  if ((reset || action === 'sign-out' || action === 'remove') && affected.some(item => runningTurns(store.accounts.get(item.id)))) {
    throw new Error('Wait for this account’s Antigravity turns to finish before signing out or removing it.');
  }

  const operation: Operation = { activity: operationLabels[action], accountId: target?.id ?? null, controller: new AbortController() };
  const { signal } = operation.controller;
  store.operation = operation;
  store.error = null;
  publish(store);
  void (async () => {
    try {
      if (action === 'install') {
        const version = await installAntigravity(binDir(), signal);
        await save(store, saved => ({ ...saved, version }));
      } else if (reset) {
        let failure: unknown;
        for (const { id } of accounts) {
          try {
            await logout(store, id, signal);
            await markDisconnected(store, id);
          } catch (error) { failure ??= error; }
        }
        if (failure) throw failure;
      } else if (target) {
        const { id } = target;
        switch (action) {
          case 'sign-in':
            if (!accountId) await save(store, saved => ({ ...saved, accounts: [...saved.accounts, target] }));
            await signIn(store, id, operation);
            await save(store, saved => ({ ...saved, activeAccountId: id }));
            queueAllowance(store, id);
            break;
          case 'switch':
            requireProfileSignIn(id);
            await save(store, saved => ({ ...saved, activeAccountId: id }));
            if (!target.models.length) await probe(store, id, signal);
            queueAllowance(store, id);
            break;
          case 'refresh':
            await probe(store, id, signal);
            queueAllowance(store, id);
            break;
          case 'sign-out':
            await logout(store, id, signal);
            await markDisconnected(store, id);
            break;
          case 'remove':
            await logout(store, id, signal);
            await save(store, saved => ({ ...saved, accounts: saved.accounts.filter(item => item.id !== id) }));
            store.accounts.delete(id);
            break;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      if (target && authRequired(error)) {
        await markDisconnected(store, target.id).catch(() => undefined);
        store.error = 'Reconnect this Antigravity account with Google.';
      } else store.error = errorMessage(error, 'Antigravity could not complete the operation.');
    } finally {
      store.operation = undefined;
      publish(store);
    }
  })();
  return publicState(store);
}

export function recordAntigravityUsage(accountId: string, model: string, usage: unknown, primary = true) {
  const store = runtime();
  const live = accountRuntime(store, accountId);
  if (primary) {
    const metrics = readModelUsage(usage ?? {});
    live.lastTurn = {
      model, completedAt: Date.now(), inputTokens: metrics.inputMeasured ? metrics.promptTokens : null,
      outputTokens: metrics.outputMeasured ? metrics.outputTokens : null,
    };
  }
  store.usageRevision++;
  publish(store);
  queueAllowance(store, accountId);
}

/** Keep the same profile across a turn's compaction, provider calls, and retries. */
export function antigravityOffersModel(model: string) {
  const store = runtime();
  return Boolean(store.saved.version && store.saved.accounts.some(account => account.connected && account.models.some(item => item.id === model)));
}

export function antigravityModelList() {
  return publicState(runtime()).models.map(model => ({ provider: 'antigravity' as const, model: model.id }));
}

export async function runWithAntigravityAccount<T>(run: () => Promise<T>, model?: string): Promise<T> {
  const store = runtime();
  const scope = store.scope.getStore();
  if (scope?.model === model && scope) return run();
  const supportsModel = (account: SavedAccount) => account.connected && (!model || account.models.some(item => item.id === model));
  if (scope && store.saved.accounts.some(account => account.id === scope.accountId && supportsModel(account))) return run();
  const account = store.saved.accounts.find(account => supportsModel(account) && !signingOut(store.operation, account.id));
  if (!account) return store.scope.run({ accountId: null, model }, run);
  const live = accountRuntime(store, account.id);
  live.leases++;
  publish(store);
  try { return await store.scope.run({ accountId: account.id, model }, run); }
  finally {
    live.leases--;
    publish(store);
  }
}

export async function withAntigravitySession<T>(options: SessionOptions & { instruction: string },
  run: (client: AntigravityAcpClient, setup: Awaited<ReturnType<typeof openClient>>) => Promise<T>): Promise<T> {
  const store = runtime();
  if (!initializeCodexBridge()) throw new Error('Connect Antigravity in EterX desktop under Settings → Subscription.');
  const scope = store.scope.getStore();
  const account = scope ? store.saved.accounts.find(candidate => candidate.id === scope.accountId && candidate.connected) : activeAccount(store);
  if (!account || !store.saved.version || signingOut(store.operation, account.id)) {
    throw new Error('Sign in to Antigravity in Settings → Subscription before sending a message.');
  }
  // A running turn keeps the profile it opened, even if new turns use a different account.
  const live = accountRuntime(store, account.id);
  live.turns++;
  publish(store);
  let client: AntigravityAcpClient | undefined;
  try {
    requireProfileSignIn(account.id);
    await prepareAntigravityProfile(account.id);
    client = createClient(account.id, options);
    const setup = await openClient(client, account.id, options.instruction, options.mcpServers);
    return await run(client, setup);
  } catch (error) {
    if (authRequired(error)) {
      await markDisconnected(store, account.id).catch(() => undefined);
      throw new Error('Antigravity needs a fresh Google sign-in. Reconnect in Settings → Subscription.');
    }
    if (!options.signal.aborted) queueAllowance(store, account.id);
    throw error;
  } finally {
    await client?.dispose();
    live.turns--;
    publish(store);
  }
}
