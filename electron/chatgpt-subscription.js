const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createChatGptCallbackPage } = require('./chatgpt-subscription-page');

// Sign in with ChatGPT for open-source local applications. The OAuth grant and
// model catalog follow the same direct token sharing flow used by T3 Code.
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const USAGE_URL = 'https://chatgpt.com/settings/usage';
const CALLBACK_PATH = '/auth/callback';
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const MAX_BRIDGE_BODY = 100 * 1024 * 1024;
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
  if (!body || typeof body.access_token !== 'string' || !body.access_token
    || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'
    || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || typeof body.scope !== 'string') {
    throw subscriptionError('ChatGPT returned an invalid session. Try signing in again.');
  }
  const refresh = body.earliest_refresh_at;
  const earliest = typeof refresh === 'number' ? (refresh < 1e12 ? refresh * 1000 : refresh)
    : typeof refresh === 'string' ? Date.parse(refresh) : NaN;
  if (current?.refreshToken && (typeof body.refresh_token !== 'string' || !body.refresh_token)) {
    throw subscriptionError('ChatGPT did not return a renewed connection. Try signing in again.');
  }
  return {
    id: current?.id || crypto.randomUUID(),
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    idToken: typeof body.id_token === 'string' ? body.id_token : current?.idToken || null,
    scopes: body.scope.split(/\s+/).filter(Boolean),
    expiresAt: Date.now() + body.expires_in * 1000,
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
  directory, safeStorage, canEncrypt, openBrowser, onChange, fetchRemote = fetch, log = () => {}, callbackAssets,
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
  let disconnectRequest;
  let models = [];
  let signInError = '';
  let catalogError = '';
  let revokedWarning = '';
  let refreshFailureUntil = 0;
  let accountAbort = new AbortController();

  function state() {
    const tokens = record?.tokens;
    const connected = Boolean(tokens?.scopes.includes(PLAN_SCOPE));
    return {
      available: available && bridgeReady,
      status: activeFlow ? 'authorizing' : connected ? 'connected' : tokens ? 'consent-required' : 'disconnected',
      canCancel: Boolean(activeFlow && !activeFlow.committing),
      disconnecting: Boolean(disconnectRequest),
      email: record?.registration?.email || null,
      hasRegistration: Boolean(record?.registration || isIssuedClientId(record?.pendingClientId)),
      models: connected ? models : [],
      refreshing: Boolean(catalogRequest),
      error: signInError || catalogError || revokedWarning || null,
    };
  }

  const publish = () => onChange(state());

  function serialize(operation) {
    const result = mutation.then(operation, operation);
    mutation = result.catch(() => {});
    return result;
  }

  function load() {
    loadPromise ??= (async () => {
      available = await canEncrypt();
      if (!available) return;
      try {
        const encrypted = await fs.readFile(store);
        const { result } = await safeStorage.decryptStringAsync(encrypted);
        const saved = JSON.parse(result);
        if (typeof saved?.hostId !== 'string') throw new Error('Invalid host');
        record = saved;
      } catch (error) {
        if (error?.code !== 'ENOENT') signInError = 'The saved ChatGPT connection could not be read. Sign in again.';
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

  function changeAccount() {
    accountAbort.abort();
    accountAbort = new AbortController();
    models = [];
    catalogRequest = undefined;
    catalogError = '';
    refreshFailureUntil = 0;
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
        // The registration can succeed even when its one-time code cannot be used.
        // Keep the issued ID separate from a verified account and its credentials.
        await save({ ...record, pendingClientId: clientId });
      });
      flow.clientId = clientId;
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
    if (flow.registration?.subject && flow.registration.subject !== identity.subject) {
      throw subscriptionError('ChatGPT returned a different account. Choose “Use another account” to connect it.');
    }
    await serialize(async () => {
      signal.throwIfAborted();
      flow.committing = true;
      clearTimeout(flow.timer);
      publish();
      await save({ ...record, pendingClientId: null, registration: identity, tokens });
      changeAccount();
      signInError = '';
    });
    signal.throwIfAborted();
    return tokens.scopes.includes(PLAN_SCOPE);
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
        ...(flow.registration?.email ? { login_hint: flow.registration.email } : {}),
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

  async function completeSignIn(flow, useDifferentAccount) {
    const { signal } = flow.abort;
    try {
      await serialize(async () => {
        signal.throwIfAborted();
        if (!record) await save({ hostId: `urn:uuid:${crypto.randomUUID()}`, registration: null, tokens: null });
        if (!useDifferentAccount) {
          const pendingClientId = isIssuedClientId(record.pendingClientId) ? record.pendingClientId : null;
          flow.registration = record.registration;
          flow.clientId = flow.registration?.clientId || pendingClientId;
          flow.idTokenHint = record.tokens?.idToken;
          flow.needsConsent = Boolean(record.tokens && !record.tokens.scopes.includes(PLAN_SCOPE));
        }
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
        if (record?.tokens?.scopes.includes(PLAN_SCOPE)) void refreshModels();
      }
    }
  }

  async function signIn(useDifferentAccount) {
    await load();
    if (!available || !bridgeReady || activeFlow || disconnectRequest
      || (useDifferentAccount && record?.tokens?.scopes.includes(PLAN_SCOPE))) return state();
    signInError = '';
    revokedWarning = '';
    const flow = { abort: new AbortController() };
    activeFlow = flow;
    startSignInTimer(flow);
    publish();
    void completeSignIn(flow, useDifferentAccount);
    return state();
  }

  function requireTokens(expectedConnection) {
    return serialize(async () => {
      const current = record?.tokens;
      if (disconnectRequest) throw subscriptionError('The ChatGPT connection is being disconnected.', 'chatgpt_connection_changed', 409);
      if (expectedConnection && current?.id !== expectedConnection) {
        throw subscriptionError('The ChatGPT connection changed. Start a new request.', 'chatgpt_connection_changed', 409);
      }
      if (!current?.scopes.includes(PLAN_SCOPE)) {
        throw subscriptionError('Connect ChatGPT plan usage in Settings → Subscription.', 'chatgpt_sign_in_required', 401);
      }
      const now = Date.now();
      if (current.expiresAt - now > 60_000) return current;
      if (current.earliestRefreshAt > now || refreshFailureUntil > now) {
        if (current.expiresAt > now) return current;
        throw subscriptionError('ChatGPT could not renew the connection yet. Try again shortly.', 'chatgpt_refresh_unavailable');
      }
      if (current.refreshToken) {
        let result;
        try {
          const settings = await discover();
          result = await fetchJson(settings.token_endpoint, oauthForm({
            grant_type: 'refresh_token', client_id: record.registration.clientId,
            refresh_token: current.refreshToken, resource: RESOURCE,
          }));
        } catch { /* Temporary failures leave the current session intact. */ }
        if (result?.response.ok) {
          const renewed = normalizeTokens(result.body, current);
          await save({ ...record, tokens: renewed });
          if (renewed.scopes.includes(PLAN_SCOPE)) return renewed;
          changeAccount();
          publish();
          throw subscriptionError('Enable ChatGPT plan usage in Settings → Subscription.', 'chatgpt_sign_in_required', 401);
        }
        const code = oauthErrorCode(result?.body);
        if (!UNUSABLE_REFRESH_CODES.has(code) && code !== 'invalid_client') {
          refreshFailureUntil = Date.now() + 15_000;
          if (current.expiresAt > Date.now()) return current;
          throw subscriptionError('Could not renew the ChatGPT connection. Try again shortly.', 'chatgpt_refresh_unavailable');
        }
      }
      await save({ ...record, tokens: null });
      changeAccount();
      signInError = 'The ChatGPT connection expired. Sign in again.';
      publish();
      throw subscriptionError(signInError, 'chatgpt_sign_in_required', 401);
    });
  }

  function refreshModels() {
    if (catalogRequest) return catalogRequest;
    if (!record?.tokens?.scopes.includes(PLAN_SCOPE)) return Promise.resolve(state());
    const connection = record.tokens.id;
    const signal = accountAbort.signal;
    catalogError = '';
    const refresh = (async () => {
      try {
        const tokens = await requireTokens(connection);
        const { response, body } = await fetchJson(`${RESOURCE}/models`, {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        }, signal);
        if (!response.ok) {
          if (body?.error?.code === 'subscription_sharing_user_not_eligible') {
            throw subscriptionError('ChatGPT plan usage is unavailable for this account or workspace.');
          }
          throw subscriptionError(`Could not load the ChatGPT model catalog (HTTP ${response.status}).`);
        }
        if (record?.tokens?.id === connection && !signal.aborted) models = normalizeCatalog(body);
      } catch (error) {
        if (record?.tokens?.id === connection && !signal.aborted) {
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

  async function disconnectAccount() {
    finishFlow();
    let credentials;
    try {
      await serialize(async () => {
        if (!record?.tokens) return;
        credentials = { clientId: record.registration.clientId, token: record.tokens.refreshToken || record.tokens.accessToken,
          hint: record.tokens.refreshToken ? 'refresh_token' : 'access_token' };
        await save({ ...record, tokens: null });
        changeAccount();
      });
      signInError = '';
      revokedWarning = '';
      publish();
      if (credentials) {
        const endpoints = await discover();
        if (!endpoints.revocation_endpoint) throw new Error();
        const response = await fetchRemote(endpoints.revocation_endpoint, {
          ...oauthForm({ client_id: credentials.clientId, token: credentials.token, token_type_hint: credentials.hint }),
          redirect: 'error', signal: AbortSignal.timeout(10_000),
        });
        await response.body?.cancel().catch(() => {});
        if (!response.ok) throw new Error();
      }
    } catch (error) {
      if (record?.tokens && error?.status) signInError = error.message;
      else if (!record?.tokens) revokedWarning = 'Disconnected in EterX. You can remove the connection in ChatGPT settings.';
    }
    publish();
    return state();
  }

  function disconnect() {
    if (disconnectRequest) return disconnectRequest;
    disconnectRequest = disconnectAccount().finally(() => {
      disconnectRequest = undefined;
      publish();
    });
    publish();
    return disconnectRequest;
  }

  async function proxyResponse(request, response) {
    const abort = new AbortController();
    response.once('close', () => abort.abort());
    try {
      const content = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BRIDGE_BODY) throw subscriptionError('The ChatGPT request is too large.', 'chatgpt_request_too_large', 413);
        content.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(content).toString('utf8'));
      if (!body.model || body.store !== false || body.stream !== true || !Array.isArray(body.input)) {
        throw subscriptionError('Invalid ChatGPT Responses request.', 'chatgpt_invalid_request', 400);
      }
      const tokens = await requireTokens(request.headers['x-eterx-codex-connection']);
      const signal = AbortSignal.any([abort.signal, accountAbort.signal]);
      if (record?.tokens?.id !== tokens.id) throw subscriptionError('The ChatGPT connection changed.', 'chatgpt_connection_changed', 409);
      const upstream = await fetchRemote(`${RESOURCE}/responses`, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const headers = { 'Cache-Control': 'no-store', 'x-eterx-codex-connection': tokens.id };
      for (const name of ['content-type', 'retry-after', 'retry-after-ms', 'x-request-id']) {
        const value = upstream.headers.get(name);
        if (value) headers[name] = value;
      }
      response.writeHead(upstream.status, headers);
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response, { signal });
      else response.end();
    } catch (error) {
      sendBridgeError(response, error);
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
      if (request.method !== 'POST' || request.url !== '/v1/responses'
        || !equalSecret(request.headers['x-eterx-codex-bridge'], key)) {
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
    finishFlow();
    accountAbort.abort();
    bridgeReady = false;
    bridge?.close();
    bridge?.closeAllConnections();
  }

  return {
    start, stop, state, signIn, refreshModels, disconnect,
    cancelSignIn: () => { if (!activeFlow?.committing) finishFlow(); return state(); },
    openUsage: () => openBrowser(USAGE_URL),
  };
}

module.exports = { createChatGptSubscription, createCodexBridgeEnvironment, disposeCodexBridgeEnvironment };
