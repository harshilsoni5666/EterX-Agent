const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createChatGptCallbackPage } = require('./chatgpt-subscription-page');
const { observeChatGptUsage } = require('./chatgpt-subscription-usage');

// Sign in with ChatGPT for open-source local applications. The OAuth grant and
// model catalog follow the same direct token sharing flow.
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const CALLBACK_PATH = '/auth/callback';
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const MAX_BRIDGE_BODY = 100 * 1024 * 1024;
const PLAN_LIMIT_CODE = 'subscription_sharing_usage_limit_exceeded';
const DEFAULT_LIMIT_BACKOFF_MS = 60_000;
const HANDOFF_DRAIN_MS = 90_000;
const UNUSABLE_REFRESH_CODES = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused',
]);

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

async function createCodexBridgeEnvironment() {
  const key = randomSecret();
  const address = process.platform === 'win32'
    ? `\\\\.\\pipe\\eterx-codex-${randomSecret()}`
    : path.join(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'eterx-codex-')), 'responses.sock');
  return { ETERX_CODEX_BRIDGE_ADDRESS: address, ETERX_CODEX_BRIDGE_KEY: key };
}

async function disposeCodexBridgeEnvironment(env) {
  if (!env?.ETERX_CODEX_BRIDGE_ADDRESS || process.platform === 'win32') return;
  const address = env.ETERX_CODEX_BRIDGE_ADDRESS;
  await fs.unlink(address).catch(() => {});
  await fs.rmdir(path.dirname(address)).catch(() => {});
}

function subscriptionError(message, code = 'chatgpt_connection_error', status = 503) {
  return Object.assign(new Error(message), { code, status });
}

function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function listen(server, address) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, resolve);
  });
}

function oauthForm(fields) {
  return {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

function oauthErrorCode(body) {
  const code = typeof body?.error === 'string' ? body.error : body?.error?.code ?? body?.detail?.code ?? body?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_-]{0,79}$/i.test(code) ? code : null;
}

function isIssuedClientId(value) {
  return typeof value === 'string' && /^oaiapp_[a-zA-Z0-9_-]{1,193}$/.test(value);
}

function hasPlanAccess(tokens) {
  return Boolean(tokens?.accessToken && tokens.scopes.includes(PLAN_SCOPE));
}

function newProfile(profiles, clientId) {
  const number = profiles.reduce((maximum, profile) => Math.max(maximum, profile.number), 0) + 1;
  return { id: crypto.randomUUID(), number, clientId, subject: null, email: null, tokens: null };
}

function validProfile(profile) {
  return profile && typeof profile.id === 'string' && profile.id.length > 0
    && Number.isSafeInteger(profile.number) && profile.number > 0
    && isIssuedClientId(profile.clientId)
    && (profile.subject === null || typeof profile.subject === 'string' && profile.subject.length > 0)
    && (profile.email === null || typeof profile.email === 'string')
    && (profile.tokens === null || Boolean(profile.subject) && Array.isArray(profile.tokens?.scopes));
}

function readProfiles(saved) {
  if (typeof saved?.hostId !== 'string' || !saved.hostId) throw new Error('Invalid ChatGPT host');
  if (Object.hasOwn(saved, 'profiles')) {
    if (!Array.isArray(saved.profiles) || !saved.profiles.every(validProfile)
      || new Set(saved.profiles.map(profile => profile.id)).size !== saved.profiles.length
      || new Set(saved.profiles.map(profile => profile.number)).size !== saved.profiles.length
      || new Set(saved.profiles.map(profile => profile.clientId)).size !== saved.profiles.length
      || (saved.activeProfileId !== null && !saved.profiles.some(profile => profile.id === saved.activeProfileId && profile.subject))) {
      throw new Error('Invalid saved ChatGPT accounts');
    }
    return saved;
  }

  const profiles = [];
  let activeProfileId = null;
  if (saved.registration) {
    const { clientId, subject, email } = saved.registration;
    const profile = { ...newProfile(profiles, clientId), subject, email: email ?? null, tokens: saved.tokens ?? null };
    if (!validProfile(profile)) throw new Error('Invalid saved ChatGPT connection');
    profiles.push(profile);
    activeProfileId = profile.id;
  }
  if (isIssuedClientId(saved.pendingClientId) && saved.pendingClientId !== saved.registration?.clientId) {
    profiles.push(newProfile(profiles, saved.pendingClientId));
  }
  return { hostId: saved.hostId, activeProfileId, profiles, planWelcome: hasPlanAccess(saved.tokens) ? 'dismissed' : null };
}

function profileStatus(profile) {
  if (!profile?.subject) return profile ? 'pending' : 'disconnected';
  if (!profile.tokens) return 'disconnected';
  if (!hasPlanAccess(profile.tokens)) return 'consent-required';
  return 'connected';
}

function retryAfterTime(headers, now) {
  const milliseconds = Number(headers.get('retry-after-ms'));
  if (Number.isSafeInteger(milliseconds) && milliseconds > 0) return now + milliseconds;
  const retryAfter = headers.get('retry-after');
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    const seconds = Number(retryAfter);
    if (Number.isSafeInteger(seconds * 1000) && seconds > 0) return now + seconds * 1000;
  }
  const date = Date.parse(retryAfter || '');
  return date > now ? date : now + DEFAULT_LIMIT_BACKOFF_MS;
}

function signInExchangeMessage(status, code) {
  switch (code) {
    case 'invalid_grant':
      return 'OpenAI could not use this one-time code. Start a new sign-in in EterX.';
    case 'invalid_client':
    case 'unauthorized_client':
      return 'OpenAI rejected the app registration for this ChatGPT account.';
    case 'access_denied':
      return 'ChatGPT sign-in was declined. Sign in again when you are ready.';
    case 'subscription_sharing_v2_client_not_enabled':
      return 'OpenAI has not enabled ChatGPT plan usage for this app registration.';
    case 'subscription_sharing_user_not_eligible':
    case 'subscription_sharing_v2_user_not_eligible':
      return 'ChatGPT plan usage is unavailable for this account or workspace.';
    case 'unsupported_country_region_territory':
      return 'OpenAI reported that ChatGPT sign-in is unavailable from this network region.';
    default:
      return status >= 500 || status === 429
        ? 'OpenAI’s sign-in service is temporarily unavailable. Try again in a moment.'
        : 'OpenAI could not finish ChatGPT sign-in. Try again in EterX.';
  }
}

function normalizeTokens(body, current) {
  if (typeof body?.scope !== 'string') {
    throw subscriptionError('ChatGPT returned an invalid session. Try signing in again.');
  }
  const scopes = body.scope.split(/\s+/).filter(Boolean);
  const accessToken = typeof body.access_token === 'string' && body.access_token ? body.access_token : null;
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null;
  const needsRefreshToken = Boolean(current?.refreshToken || scopes.includes('offline_access'));
  const expiresAt = typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : NaN;
  if ((!accessToken && (needsRefreshToken || scopes.includes(PLAN_SCOPE)))
    || (accessToken && (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'
      || !Number.isFinite(expiresAt) || body.expires_in <= 0))
    || (needsRefreshToken && !refreshToken)) {
    throw subscriptionError('ChatGPT returned incomplete credentials. Try signing in again.');
  }
  const refresh = body.earliest_refresh_at;
  const earliest = typeof refresh === 'number' ? (refresh < 1e12 ? refresh * 1000 : refresh)
    : typeof refresh === 'string' ? Date.parse(refresh) : NaN;
  return {
    accessToken, refreshToken, scopes,
    // Preserve the ID token verified when this account was connected.
    idToken: current?.idToken ?? (typeof body.id_token === 'string' ? body.id_token : null),
    expiresAt: accessToken ? expiresAt : null,
    earliestRefreshAt: Number.isFinite(earliest) ? earliest : null,
  };
}

function normalizeCatalog(payload) {
  if (!Array.isArray(payload?.models)) {
    throw subscriptionError('ChatGPT returned an unavailable model catalog. Try refreshing it.');
  }
  const models = new Map();
  for (const model of payload.models) {
    if (model?.visibility !== 'list' || typeof model.slug !== 'string' || !model.slug
      || typeof model.display_name !== 'string' || !model.display_name || models.has(model.slug)) continue;
    models.set(model.slug, {
      id: model.slug,
      label: model.display_name,
      defaultEffort: typeof model.default_reasoning_level === 'string' ? model.default_reasoning_level : null,
      efforts: Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.map(level => level?.effort).filter(effort => typeof effort === 'string') : [],
      imageInput: Array.isArray(model.input_modalities) ? model.input_modalities.includes('image') : null,
      fast: (Array.isArray(model.service_tiers) && model.service_tiers.some(tier => {
        const id = typeof tier === 'string' ? tier : tier?.id;
        return id === 'fast' || id === 'priority';
      })) || (Array.isArray(model.additional_speed_tiers) && model.additional_speed_tiers.includes('fast')),
    });
  }
  return [...models.values()];
}

function sendBridgeError(response, error) {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const known = typeof error?.code === 'string' && Number.isInteger(error?.status);
  response.writeHead(known ? error.status : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ error: {
    code: known ? error.code : 'chatgpt_connection_error',
    message: known ? error.message : 'Could not reach ChatGPT. Try again in a moment.',
  } }));
}

function createChatGptSubscription({
  directory, safeStorage, canEncrypt, openBrowser, onChange, fetchRemote = fetch, log = () => {}, callbackAssets, requestHandoff,
}) {
  const store = path.join(directory, 'chatgpt-subscription.enc');
  const callbackPage = createChatGptCallbackPage(callbackAssets);
  let record = null;
  let available = false;
  let bridgeReady = false;
  let metadata;
  let activeFlow;
  let bridge;
  let loadPromise;
  let mutation = Promise.resolve();
  let catalogRequest;
  let profileAction;
  let models = [];
  let catalogReady = false;
  let catalogRevision = 0;
  let signInError = '';
  let catalogError = '';
  const refreshFailureUntil = new Map();
  const observedUsage = new Map();
  const streamingRequests = new Set();
  let bridgeHold;
  let connection = { id: crypto.randomUUID(), controller: new AbortController(), resumable: new Set() };

  const findProfile = id => record?.profiles.find(profile => profile.id === id);
  const activeProfile = () => findProfile(record?.activeProfileId);

  function publicUsage(profile) {
    const usage = profileStatus(profile) === 'connected' ? observedUsage.get(profile.id) : null;
    return usage ? { status: usage.status, observedAt: usage.observedAt, retryAt: usage.pausedUntil || undefined } : null;
  }

  function state() {
    const profile = activeProfile();
    const status = profileStatus(profile);
    return {
      available: available && bridgeReady,
      status,
      accounts: (record?.profiles || []).map(account => ({
        id: account.id,
        label: `Connection ${account.number}`,
        email: account.email,
        status: profileStatus(account),
        usage: publicUsage(account),
      })),
      activeAccountId: profile?.id ?? null,
      authorizing: Boolean(activeFlow),
      authorizingAccountId: activeFlow?.profileId ?? null,
      canCancel: Boolean(activeFlow && !activeFlow.committing),
      accountAction: profileAction?.kind ?? null,
      models: status === 'connected' ? models : [],
      catalogReady,
      catalogRevision,
      refreshing: Boolean(catalogRequest),
      catalogError: catalogError || null,
      usage: publicUsage(profile),
      planWelcomePending: status === 'connected' && record.planWelcome === 'pending',
      error: signInError || null,
    };
  }

  const publish = () => {
    try { onChange(state()); } catch { log('[subscription] Could not publish connection status.'); }
  };

  function serialize(operation) {
    const result = mutation.then(operation, operation);
    mutation = result.catch(() => {});
    return result;
  }

  function load() {
    loadPromise ??= (async () => {
      available = await canEncrypt();
      if (!available) return;
      let encrypted;
      try {
        encrypted = await fs.readFile(store);
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        signInError = 'Could not read the saved ChatGPT accounts from secure storage.';
        available = false;
        return;
      }
      try {
        const { result } = await safeStorage.decryptStringAsync(encrypted);
        const saved = JSON.parse(result);
        record = readProfiles(saved);
        if (!Object.hasOwn(saved, 'profiles')) await save(record);
      } catch {
        signInError = 'Could not load the saved ChatGPT accounts from secure storage.';
        available = false;
      }
    })();
    return loadPromise;
  }

  async function save(next) {
    const temporary = `${store}.${randomSecret()}.tmp`;
    try {
      await fs.mkdir(directory, { recursive: true });
      const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(next));
      await fs.writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, store);
      record = next;
    } catch {
      throw subscriptionError('Could not save the ChatGPT connection in secure storage.');
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  function saveProfile(profile, { activeProfileId = record.activeProfileId, planWelcome = record.planWelcome } = {}) {
    const profiles = record.profiles.some(entry => entry.id === profile.id)
      ? record.profiles.map(entry => entry.id === profile.id ? profile : entry)
      : [...record.profiles, profile];
    return save({ ...record, profiles, activeProfileId, planWelcome });
  }

  function changeAccount({ resume = false, catalog = null } = {}) {
    const resumable = resume ? new Set([...connection.resumable, connection.id]) : new Set();
    connection.controller.abort();
    connection = { id: crypto.randomUUID(), controller: new AbortController(), resumable };
    models = catalog ?? [];
    catalogReady = catalog !== null;
    catalogRevision++;
    catalogRequest = undefined;
    catalogError = '';
  }

  async function fetchJson(url, options, signal) {
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetchRemote(url, {
      ...options,
      redirect: 'error',
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    const body = await response.json().catch(() => null);
    return { response, body };
  }

  async function fetchCatalog(tokens, signal) {
    const { response, body } = await fetchJson(`${RESOURCE}/models`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    }, signal);
    if (!response.ok) {
      const code = oauthErrorCode(body);
      if (code === 'subscription_sharing_user_not_eligible' || code === 'subscription_sharing_v2_user_not_eligible') {
        throw subscriptionError('ChatGPT plan usage is unavailable for this account or workspace.');
      }
      throw subscriptionError(`Could not load the ChatGPT model catalog (HTTP ${response.status}).`);
    }
    return normalizeCatalog(body);
  }

  async function discover(signal) {
    if (metadata) return metadata;
    const { response, body } = await fetchJson(`${ISSUER}/.well-known/openid-configuration`, {}, signal);
    const endpoints = [body?.authorization_endpoint, body?.token_endpoint, body?.jwks_uri,
      ...(body?.revocation_endpoint ? [body.revocation_endpoint] : [])];
    if (!response.ok || body?.issuer !== ISSUER || endpoints.some(endpoint => {
      if (typeof endpoint !== 'string' || !URL.canParse(endpoint)) return true;
      const url = new URL(endpoint);
      return url.origin !== ISSUER || Boolean(url.username || url.password);
    })) throw subscriptionError('Could not verify ChatGPT sign-in configuration. Try again.');
    metadata = body;
    return metadata;
  }

  async function verifyIdentity(idToken, clientId, nonce, endpoints, signal) {
    try {
      const parts = idToken?.split('.') || [];
      if (parts.length !== 3) throw new Error();
      const [header, payload, signature] = parts;
      const protectedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      const { alg, kid } = protectedHeader;
      if (!kid || (alg !== 'RS256' && alg !== 'ES256')) throw new Error();
      const { response, body } = await fetchJson(endpoints.jwks_uri, {}, signal);
      const jwk = response.ok && body?.keys?.find(key => key.kid === kid
        && (!key.use || key.use === 'sig') && (!key.alg || key.alg === alg)
        && key.kty === (alg === 'ES256' ? 'EC' : 'RSA'));
      if (!jwk || (alg === 'ES256' && jwk.crv !== 'P-256')) throw new Error();
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      if (!crypto.verify('sha256', Buffer.from(`${header}.${payload}`),
        alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(signature, 'base64url'))) throw new Error();
      const claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const aud = Array.isArray(claim.aud) ? claim.aud : [claim.aud];
      const now = Date.now() / 1000;
      if (claim.iss !== ISSUER || !aud.includes(clientId) || (aud.length > 1 && claim.azp !== clientId)
        || (claim.azp !== undefined && claim.azp !== clientId) || !Number.isFinite(claim.exp) || claim.exp < now - 5
        || (claim.nbf !== undefined && (!Number.isFinite(claim.nbf) || claim.nbf > now + 5))
        || !equalSecret(claim.nonce, nonce) || typeof claim.sub !== 'string' || !claim.sub) throw new Error();
      return { clientId, subject: claim.sub, email: typeof claim.email === 'string' ? claim.email : null };
    } catch {
      throw subscriptionError('ChatGPT sign-in could not be verified. Start again.');
    }
  }

  function signInFailureMessage(error) {
    return error?.status ? error.message : 'Could not complete ChatGPT sign-in. Try again in EterX.';
  }

  async function exchangeCallback(flow, endpoints, { params, redirectUri, verifier, nonce }) {
    const { signal } = flow.abort;
    signal.throwIfAborted();
    if (params.has('iss') && (params.getAll('iss').length !== 1 || params.get('iss') !== endpoints.issuer)) {
      throw subscriptionError('ChatGPT returned an unexpected sign-in provider. Start again.');
    }
    if (params.has('error')) {
      if (params.get('error') === 'access_denied') {
        throw subscriptionError('ChatGPT sign-in was declined. Sign in again when you are ready.', 'access_denied');
      }
      throw subscriptionError('OpenAI could not authorize ChatGPT sign-in. Start again in EterX.');
    }
    const returnedId = params.get('client_id');
    const clientId = flow.clientId ?? returnedId;
    const code = params.get('code');
    if (!code || params.getAll('code').length !== 1 || !isIssuedClientId(clientId)
      || params.getAll('client_id').length > 1 || (returnedId !== null && returnedId !== clientId)) {
      throw subscriptionError('ChatGPT returned incomplete sign-in details. Start again.');
    }
    if (!flow.clientId) {
      await serialize(async () => {
        signal.throwIfAborted();
        let profile = record.profiles.find(entry => entry.clientId === clientId);
        if (!profile) {
          // Keep an issued registration recoverable even if its code exchange fails.
          profile = newProfile(record.profiles, clientId);
          await saveProfile(profile);
        }
        flow.profileId = profile.id;
        flow.clientId = profile.clientId;
        publish();
      });
    }

    signal.throwIfAborted();
    const { response, body } = await fetchJson(endpoints.token_endpoint, oauthForm({
      grant_type: 'authorization_code', client_id: clientId, code,
      code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE,
    }), signal).catch(() => {
      signal.throwIfAborted();
      log('[subscription] Could not reach the OpenAI token endpoint during sign-in.');
      throw subscriptionError('Could not reach OpenAI to finish ChatGPT sign-in. Try again.');
    });
    if (!response.ok) {
      const failure = oauthErrorCode(body);
      const details = failure ? `HTTP ${response.status}, ${failure}` : `HTTP ${response.status}`;
      const requestId = response.headers.get('x-request-id');
      const reference = /^[a-zA-Z0-9_-]{1,128}$/.test(requestId || '') ? ` Request ID: ${requestId}.` : '';
      log(`[subscription] OpenAI sign-in exchange failed (${details}).${reference}`);
      const message = signInExchangeMessage(response.status, failure);
      throw subscriptionError(`${message} (${details})`, failure || 'chatgpt_token_exchange_failed', response.status);
    }

    const tokens = normalizeTokens(body);
    const identity = await verifyIdentity(tokens.idToken, clientId, nonce, endpoints, signal);
    const sharePlan = hasPlanAccess(tokens);
    await serialize(async () => {
      signal.throwIfAborted();
      const profile = findProfile(flow.profileId);
      if (!profile || profile.clientId !== clientId || (profile.subject && profile.subject !== identity.subject)) {
        throw subscriptionError('ChatGPT returned a different account. Use “Add account” to connect it.');
      }

      const previous = activeProfile();
      // Adding or reconnecting a different profile must not switch running work.
      const activate = !previous || previous.id === profile.id;
      flow.committing = true;
      clearTimeout(flow.timer);
      publish();
      const updatedProfile = { ...profile, ...identity, tokens };
      await saveProfile(updatedProfile, {
        activeProfileId: activate ? profile.id : record.activeProfileId,
        planWelcome: sharePlan && !record.planWelcome ? 'pending' : record.planWelcome,
      });
      refreshFailureUntil.delete(profile.id);
      if (activate && (previous?.id !== profile.id || hasPlanAccess(previous?.tokens) !== sharePlan)) changeAccount();
      signInError = '';
    });
    signal.throwIfAborted();
    return sharePlan;
  }

  async function authorize(flow, endpoints, allowRetry) {
    const { signal } = flow.abort;
    signal.throwIfAborted();
    const expectedState = randomSecret();
    const nonce = randomSecret();
    const verifier = crypto.randomBytes(64).toString('base64url');
    const callback = Promise.withResolvers();
    const abortCallback = () => callback.reject(signal.reason);
    let redirect;
    let browserResponse;
    let received = false;
    const listener = http.createServer({ headersTimeout: 10_000, requestTimeout: 15_000 }, (request, response) => {
      const url = redirect && URL.parse(request.url || '/', redirect);
      if (!url || request.method !== 'GET' || request.headers.host !== redirect.host
        || url.origin !== redirect.origin || url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end();
      } else if (url.searchParams.getAll('state').length !== 1 || !equalSecret(url.searchParams.get('state'), expectedState)) {
        callbackPage(response, {
          status: 400,
          heading: 'This tab belongs to another sign-in',
          detail: 'Continue in the browser tab opened by EterX.',
        });
      } else if (received || signal.aborted) {
        callbackPage(response, {
          status: 410,
          heading: 'This sign-in is no longer active',
          detail: 'Return to EterX to see your connection status.',
        });
      } else {
        received = true;
        callback.resolve({ params: url.searchParams, response });
      }
    });

    try {
      await listen(listener, { port: 0, host: '127.0.0.1' }).catch(() => {
        throw subscriptionError('Could not start the local ChatGPT sign-in callback. Try again.');
      });
      signal.throwIfAborted();
      redirect = new URL(`http://127.0.0.1:${listener.address().port}${CALLBACK_PATH}`);
      const url = new URL(endpoints.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: flow.clientId || 'dynamic_agent_client',
        ...(flow.clientId ? {} : { agent_name_hint: 'EterX' }),
        ...(flow.email ? { login_hint: flow.email } : {}),
        ...(flow.idTokenHint ? { id_token_hint: flow.idTokenHint } : {}),
        ...(flow.needsConsent ? { prompt: 'consent' } : {}),
        ext_agent_host_id: record.hostId, response_type: 'code', redirect_uri: redirect.href,
        scope: SCOPES, resource: RESOURCE, state: expectedState, nonce,
        code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      }).toString();

      listener.once('error', () => callback.reject(subscriptionError('The local ChatGPT sign-in callback stopped. Try again.')));
      signal.addEventListener('abort', abortCallback, { once: true });
      void Promise.resolve().then(() => {
        signal.throwIfAborted();
        return openBrowser(url.toString());
      }).catch(() => callback.reject(subscriptionError('Could not open ChatGPT sign-in. Try again.')));
      const { params, response } = await callback.promise;
      browserResponse = response;
      const connected = await exchangeCallback(flow, endpoints, { params, redirectUri: redirect.href, verifier, nonce });
      callbackPage(browserResponse, connected
        ? { heading: 'Successfully connected to EterX', connected: true }
        : { heading: 'Enable ChatGPT plan usage', detail: 'Return to Settings → Subscription in EterX to use your ChatGPT plan.' });
      return true;
    } catch (error) {
      if (allowRetry && !signal.aborted && error?.code === 'invalid_grant') {
        callbackPage(browserResponse, {
          heading: 'Continue signing in',
          detail: 'Use the new ChatGPT tab to finish connecting to EterX.',
        });
        return false;
      }
      if (signal.aborted) {
        callbackPage(browserResponse, {
          heading: 'ChatGPT sign-in ended',
          detail: signInFailureMessage(signal.reason),
        });
      } else if (error?.code === 'access_denied') {
        callbackPage(browserResponse, {
          heading: 'ChatGPT access wasn’t approved',
          detail: 'Return to EterX to start a new sign-in whenever you’re ready.',
        });
      } else {
        callbackPage(browserResponse, {
          heading: 'Couldn’t connect to ChatGPT',
          detail: 'Return to Settings → Subscription in EterX for details and to try again.',
        });
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', abortCallback);
      listener.close();
    }
  }

  function finishFlow() {
    const flow = activeFlow;
    if (!flow) return;
    activeFlow = undefined;
    clearTimeout(flow.timer);
    flow.abort.abort(subscriptionError(signInError || 'ChatGPT sign-in was cancelled.'));
    publish();
  }

  function startSignInTimer(flow) {
    clearTimeout(flow.timer);
    flow.timer = setTimeout(() => {
      signInError = 'ChatGPT sign-in timed out. Start again.';
      finishFlow();
    }, SIGN_IN_TIMEOUT_MS);
  }

  async function completeSignIn(flow) {
    const { signal } = flow.abort;
    try {
      await serialize(async () => {
        signal.throwIfAborted();
        if (!record) {
          await save({ hostId: `urn:uuid:${crypto.randomUUID()}`, activeProfileId: null, profiles: [], planWelcome: null });
        }
        if (flow.profileId === null) return;
        const profile = findProfile(flow.profileId);
        if (!profile) throw subscriptionError('This ChatGPT account is no longer saved in EterX.');
        flow.clientId = profile.clientId;
        flow.email = profile.email;
        flow.idTokenHint = profile.tokens?.idToken;
        flow.needsConsent = profileStatus(profile) === 'consent-required';
      });
      signal.throwIfAborted();
      const endpoints = await discover(signal);
      if (!(await authorize(flow, endpoints, true))) {
        // OpenAI issued this client ID in the first callback. Use it with fresh PKCE and state.
        signal.throwIfAborted();
        startSignInTimer(flow);
        await authorize(flow, endpoints, false);
      }
    } catch (error) {
      if (activeFlow === flow) signInError = signInFailureMessage(error);
    } finally {
      if (activeFlow === flow) {
        finishFlow();
        if (!catalogReady) void refreshModels();
      }
    }
  }

  async function signIn(profileId = null) {
    await load();
    if (!available || !bridgeReady || activeFlow || profileAction) return state();
    if (profileId !== null && !findProfile(profileId)) {
      signInError = 'This ChatGPT account is no longer saved in EterX.';
      publish();
      return state();
    }
    signInError = '';
    const flow = { abort: new AbortController(), profileId };
    activeFlow = flow;
    startSignInTimer(flow);
    publish();
    void completeSignIn(flow);
    return state();
  }

  async function requireProfileTokens(profile) {
    const current = profile?.tokens;
    if (!hasPlanAccess(current)) {
      throw subscriptionError('Connect ChatGPT plan usage in Settings → Subscription.', 'chatgpt_sign_in_required', 401);
    }
    const now = Date.now();
    if (current.expiresAt - now > 60_000 || (!current.refreshToken && current.expiresAt > now)) return current;
    if (current.earliestRefreshAt > now || refreshFailureUntil.get(profile.id) > now) {
      if (current.expiresAt > now) return current;
      throw subscriptionError('ChatGPT could not renew the connection yet. Try again shortly.', 'chatgpt_refresh_unavailable');
    }
    if (current.refreshToken) {
      let result;
      try {
        const settings = await discover();
        result = await fetchJson(settings.token_endpoint, oauthForm({
          grant_type: 'refresh_token', client_id: profile.clientId,
          refresh_token: current.refreshToken, resource: RESOURCE,
        }));
      } catch { /* Temporary failures leave the saved account intact. */ }
      if (result?.response.ok) {
        const renewed = normalizeTokens(result.body, current);
        await saveProfile({ ...profile, tokens: renewed });
        if (hasPlanAccess(renewed)) return renewed;
        if (profile.id === record.activeProfileId) changeAccount();
        publish();
        throw subscriptionError('Enable ChatGPT plan usage in Settings → Subscription.', 'chatgpt_sign_in_required', 401);
      }
      const code = oauthErrorCode(result?.body);
      if (!UNUSABLE_REFRESH_CODES.has(code) && code !== 'invalid_client') {
        refreshFailureUntil.set(profile.id, Date.now() + 15_000);
        if (current.expiresAt > Date.now()) return current;
        throw subscriptionError('Could not renew the ChatGPT connection. Try again shortly.', 'chatgpt_refresh_unavailable');
      }
    }
    await saveProfile({ ...profile, tokens: null });
    const message = 'The ChatGPT connection expired. Reconnect this account in Settings → Subscription.';
    if (profile.id === record.activeProfileId) {
      changeAccount();
      signInError = message;
    }
    publish();
    throw subscriptionError(message, 'chatgpt_sign_in_required', 401);
  }

  function isDisconnecting(profileId) {
    return profileAction?.kind === 'disconnecting'
      && (profileAction.profileId === null || profileAction.profileId === profileId);
  }

  function requireTokens(expectedConnection, forInference = false) {
    return serialize(async () => {
      const profile = activeProfile();
      const lease = connection;
      const validConnection = expectedConnection === lease.id || (forInference && lease.resumable.has(expectedConnection));
      if (!validConnection || lease.controller.signal.aborted || isDisconnecting(profile?.id)) {
        throw subscriptionError('The ChatGPT connection changed. Start a new request.', 'chatgpt_connection_changed', 409);
      }
      const usage = observedUsage.get(profile?.id);
      if (forInference && usage?.pausedUntil > Date.now()) {
        throw subscriptionError('ChatGPT limited this account’s requests. Review usage in ChatGPT settings.', usage.pauseCode, 429);
      }
      const tokens = await requireProfileTokens(profile);
      return { tokens, lease, profileId: profile.id };
    });
  }

  function refreshModels() {
    if (catalogRequest) return catalogRequest;
    const profile = activeProfile();
    if (!bridgeReady || !hasPlanAccess(profile?.tokens) || isDisconnecting(profile.id)) return Promise.resolve(state());
    const lease = connection;
    const { signal } = lease.controller;
    catalogError = '';
    const refresh = (async () => {
      try {
        const { tokens } = await requireTokens(lease.id);
        const catalog = await fetchCatalog(tokens, signal);
        if (!signal.aborted) {
          models = catalog;
          catalogReady = true;
          catalogRevision++;
        }
      } catch (error) {
        if (!signal.aborted && !isDisconnecting(profile.id)) {
          catalogError = error?.status ? error.message : 'Could not reach the ChatGPT model catalog. Try again.';
        }
      } finally {
        if (catalogRequest === refresh) {
          catalogRequest = undefined;
          publish();
        }
      }
      return state();
    })();
    catalogRequest = refresh;
    publish();
    return refresh;
  }

  function savedProfile(profileId) {
    const profile = findProfile(profileId);
    if (!profile) throw subscriptionError('This ChatGPT account is no longer saved in EterX.');
    return profile;
  }

  function runProfileAction(kind, profileId, run, { cancelSignIn = false } = {}) {
    if (!available || !bridgeReady || profileAction || (activeFlow && !cancelSignIn)) return Promise.resolve(state());
    signInError = '';
    const action = { kind, profileId };
    profileAction = action;
    action.promise = Promise.resolve().then(run).catch(error => {
      signInError = error?.status ? error.message : 'Could not update the ChatGPT connection. Try again.';
    }).finally(() => {
      profileAction = undefined;
      if (!catalogReady) void refreshModels();
      publish();
    }).then(state);
    if (cancelSignIn) finishFlow();
    publish();
    return action.promise;
  }

  async function switchAccount(profileId, mode) {
    let activeWork = 0;
    const next = await runProfileAction('switching', profileId, async () => {
      const profile = savedProfile(profileId);
      if (record.activeProfileId === profile.id) return;

      const id = crypto.randomUUID();
      const hold = Promise.withResolvers();
      bridgeHold = hold;
      const inFlight = [...streamingRequests];
      try {
        const handoff = await requestHandoff('begin', id, mode);
        if (mode === 'idle' && (handoff.activeWork > 0 || inFlight.length > 0)) {
          activeWork = Math.max(handoff.activeWork || 0, inFlight.length);
          return;
        }
        if (handoff.held !== true) throw subscriptionError('Could not pause work for the account change.');

        const tokens = await serialize(() => requireProfileTokens(savedProfile(profileId)));
        const catalog = await fetchCatalog(tokens);
        if (mode === 'stop') await requestHandoff('stop', id);

        let timer;
        try {
          await Promise.race([
            Promise.all(inFlight.map(entry => entry.finished)),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(subscriptionError(
                'Codex is still finishing a request. Wait for it to finish or choose Stop all and switch.',
              )), HANDOFF_DRAIN_MS);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }

        if (mode === 'resume') {
          if (observedUsage.get(profileId)?.pausedUntil > Date.now()) {
            throw subscriptionError('The selected account is temporarily rate limited. Choose it after the limit clears.');
          }
          const availableModels = new Set(catalog.map(model => model.id));
          const requiredModels = [...new Set([...handoff.models, ...inFlight.map(entry => entry.model)].filter(Boolean))];
          const unavailableModel = requiredModels.find(model => !availableModels.has(model));
          if (unavailableModel) {
            throw subscriptionError(`The selected account cannot resume work using ${unavailableModel}. Choose an account with access or stop the runs first.`);
          }
        }
        await serialize(async () => {
          if (!bridgeReady || !hasPlanAccess(savedProfile(profileId).tokens)) {
            throw subscriptionError('The selected ChatGPT account could not be activated.');
          }
          await save({ ...record, activeProfileId: profileId });
          changeAccount({ resume: mode === 'resume', catalog });
        });
      } finally {
        bridgeHold = undefined;
        hold.resolve();
        try {
          await requestHandoff('release', id);
        } catch {
          await requestHandoff('release', id).catch(() => log('[subscription] The work pause will release automatically.'));
        }
      }
    });
    return { state: next, activeWork };
  }

  function removeAccount(profileId) {
    return runProfileAction('removing', profileId, () => serialize(async () => {
      const profile = savedProfile(profileId);
      if (profile.tokens) throw subscriptionError('Sign out of this ChatGPT account before removing it.');
      const selected = profile.id === record.activeProfileId;
      await save({
        ...record,
        activeProfileId: selected ? null : record.activeProfileId,
        profiles: record.profiles.filter(entry => entry.id !== profileId),
      });
      refreshFailureUntil.delete(profileId);
      observedUsage.delete(profileId);
      if (selected) changeAccount();
    }));
  }

  async function revokeSession(profile, endpoint) {
    const { refreshToken, accessToken } = profile.tokens;
    if (!refreshToken && !accessToken) return true;
    if (!endpoint) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetchRemote(endpoint, {
          ...oauthForm({
            client_id: profile.clientId, token: refreshToken || accessToken,
            token_type_hint: refreshToken ? 'refresh_token' : 'access_token',
          }),
          redirect: 'error', signal: AbortSignal.timeout(10_000),
        });
        await response.body?.cancel().catch(() => {});
        if (response.ok) return true;
        if (response.status < 500) return false;
      } catch { /* Retry an unreachable provider once before clearing credentials. */ }
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 300));
    }
    return false;
  }

  function disconnectProfiles(profileId, clearAll) {
    return runProfileAction('disconnecting', profileId, async () => {
      const targets = await serialize(() => {
        const accounts = clearAll ? record?.profiles ?? [] : [savedProfile(profileId)];
        return accounts.filter(profile => profile.tokens);
      });
      if (!targets.length) return;
      const ids = new Set(targets.map(profile => profile.id));
      if (ids.has(record.activeProfileId)) {
        changeAccount();
        publish();
      }
      const endpoints = await discover().catch(() => null);
      const revoked = await Promise.all(targets.map(profile => revokeSession(profile, endpoints?.revocation_endpoint)));

      await serialize(async () => {
        const next = { ...record, profiles: record.profiles.map(profile => ids.has(profile.id) ? { ...profile, tokens: null } : profile) };
        try {
          await save(next);
        } catch {
          record = next;
          throw subscriptionError('Signed out for this session. EterX could not update secure storage.');
        }
        for (const id of ids) refreshFailureUntil.delete(id);
      });
      if (revoked.some(ok => !ok)) {
        signInError = 'Signed out in EterX. OpenAI didn’t confirm revocation. You can remove the connection in ChatGPT settings.';
      }
    }, { cancelSignIn: clearAll });
  }

  async function disconnectAll() {
    while (profileAction) await profileAction.promise;
    return disconnectProfiles(null, true);
  }

  async function dismissPlanWelcome() {
    await serialize(async () => {
      if (record?.planWelcome !== 'pending') return;
      const next = { ...record, planWelcome: 'dismissed' };
      try {
        await save(next);
      } catch {
        record = next;
        signInError = 'Could not save the ChatGPT welcome preference.';
      }
      publish();
    });
    return state();
  }

  function recordUsage(profileId, lease, status, upstream) {
    if (!bridgeReady || lease !== connection || lease.controller.signal.aborted || isDisconnecting(profileId)) return;
    const now = Date.now();
    const previous = observedUsage.get(profileId);
    const limited = status === 'plan-limit' || status === 'rate-limited';
    // A concurrent success cannot clear an already reported limit.
    if (status === 'completed' && previous?.pausedUntil > now) return;
    const pausedUntil = limited
      ? Math.max(previous?.pausedUntil || 0, retryAfterTime(upstream.headers, now))
      : previous?.pausedUntil || 0;
    let pauseCode = previous?.pauseCode;
    if (status === 'plan-limit') pauseCode = PLAN_LIMIT_CODE;
    else if (status === 'rate-limited' && !(previous?.pausedUntil > now)) pauseCode = 'rate_limit_exceeded';
    observedUsage.set(profileId, { status, observedAt: now, pausedUntil, pauseCode });
    publish();
  }

  async function proxyResponse(request, response) {
    const abort = new AbortController();
    response.once('close', () => abort.abort());
    const completion = Promise.withResolvers();
    const entry = { finished: completion.promise, model: null };
    try {
      while (bridgeHold) {
        const hold = bridgeHold;
        await new Promise((resolve, reject) => {
          abort.signal.throwIfAborted();
          const stopWaiting = () => reject(abort.signal.reason);
          abort.signal.addEventListener('abort', stopWaiting, { once: true });
          void hold.promise.then(() => {
            abort.signal.removeEventListener('abort', stopWaiting);
            resolve();
          });
        });
      }
      if (!bridgeReady) throw subscriptionError('The ChatGPT connection is closing.');
      streamingRequests.add(entry);
      const expectedConnection = request.headers['x-eterx-codex-connection'] ?? connection.id;
      const content = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BRIDGE_BODY) throw subscriptionError('The ChatGPT request is too large.', 'chatgpt_request_too_large', 413);
        content.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(content).toString('utf8'));
      if (typeof body.model !== 'string' || !body.model || body.store !== false || body.stream !== true || !Array.isArray(body.input)) {
        throw subscriptionError('Invalid ChatGPT Responses request.', 'chatgpt_invalid_request', 400);
      }
      entry.model = body.model;
      const { tokens, lease, profileId } = await requireTokens(expectedConnection, true);
      if (lease !== connection || isDisconnecting(profileId)) {
        throw subscriptionError('The ChatGPT connection changed.', 'chatgpt_connection_changed', 409);
      }
      if (body.service_tier !== undefined) {
        // Fast is authorized for a specific saved account. Work resumed on a
        // different account uses its normal speed until the user opts in there.
        if (request.headers['x-eterx-codex-fast-profile'] !== profileId) {
          delete body.service_tier;
        } else if (body.service_tier !== 'priority' || !models.some(model => model.id === body.model && model.fast)) {
          throw subscriptionError('Fast is unavailable for this ChatGPT model. Turn it off or refresh the account’s models.', 'chatgpt_fast_unavailable', 400);
        }
      }
      const signal = AbortSignal.any([abort.signal, lease.controller.signal]);
      const upstream = await fetchRemote(`${RESOURCE}/responses`, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const headers = { 'Cache-Control': 'no-store', 'x-eterx-codex-connection': lease.id };
      for (const name of ['content-type', 'retry-after', 'retry-after-ms', 'x-request-id']) {
        const value = upstream.headers.get(name);
        if (value) headers[name] = value;
      }
      const observer = observeChatGptUsage(upstream, status => recordUsage(profileId, lease, status, upstream));
      response.writeHead(upstream.status, headers);
      if (!upstream.body) {
        response.end();
      } else {
        const stream = Readable.fromWeb(upstream.body);
        if (observer) await pipeline(stream, observer, response, { signal });
        else await pipeline(stream, response, { signal });
      }
    } catch (error) {
      sendBridgeError(response, error);
    } finally {
      streamingRequests.delete(entry);
      completion.resolve();
    }
  }

  async function start(env) {
    if (bridgeReady) return;
    const address = env.ETERX_CODEX_BRIDGE_ADDRESS;
    const key = env.ETERX_CODEX_BRIDGE_KEY;
    if (!address || !key) return;
    await load();
    if (!available) return;
    // The dev launcher owns this private directory for all shell restarts.
    if (process.platform !== 'win32') await fs.unlink(address).catch(error => {
      if (error?.code !== 'ENOENT') throw error;
    });
    bridge = http.createServer((request, response) => {
      if (!equalSecret(request.headers['x-eterx-codex-bridge'], key)) {
        response.writeHead(404).end();
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(JSON.stringify(state().models.map(model => model.id)));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end();
        return;
      }
      void proxyResponse(request, response);
    });
    await listen(bridge, address);
    bridgeReady = true;
    publish();
    void refreshModels();
  }

  function stop() {
    bridgeReady = false;
    bridgeHold?.resolve();
    bridgeHold = undefined;
    finishFlow();
    connection.controller.abort();
    bridge?.close();
    bridge?.closeAllConnections();
  }

  return {
    start, stop, state, signIn, refreshModels, switchAccount, removeAccount, disconnectAll, dismissPlanWelcome,
    disconnect: profileId => disconnectProfiles(profileId, false),
    cancelSignIn: () => { if (!activeFlow?.committing) finishFlow(); return state(); },
  };
}

module.exports = { createChatGptSubscription, createCodexBridgeEnvironment, disposeCodexBridgeEnvironment };
