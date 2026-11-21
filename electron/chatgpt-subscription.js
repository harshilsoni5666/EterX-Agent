const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

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

async function fetchJson(url, options, signal) {
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  const body = await response.json().catch(() => null);
  return { response, body };
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

function createChatGptSubscription({ directory, safeStorage, canEncrypt, openBrowser, onChange }) {
  const store = path.join(directory, 'chatgpt-subscription.enc');
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
      hasRegistration: Boolean(record?.registration),
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

  function callbackPage(response, message) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    }).end(message);
  }

  async function exchangeCallback(flow, params, response, endpoints, redirectUri) {
    try {
      if (params.has('error')) throw subscriptionError('ChatGPT sign-in was declined or cancelled.');
      const returnedId = params.get('client_id');
      const clientId = flow.registration?.clientId || returnedId;
      const code = params.get('code');
      if (!code || !clientId?.startsWith('oaiapp_') || (returnedId && returnedId !== clientId)) {
        throw subscriptionError('ChatGPT returned incomplete sign-in details. Start again.');
      }
      const { response: result, body } = await fetchJson(endpoints.token_endpoint, {
        method: 'POST', body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirectUri,
          code_verifier: flow.verifier, resource: RESOURCE,
        }),
      }, flow.abort.signal);
      if (!result.ok) throw subscriptionError('ChatGPT could not finish sign-in. Start a new sign-in.');
      const tokens = normalizeTokens(body);
      const identity = await verifyIdentity(tokens.idToken, clientId, flow.nonce, endpoints, flow.abort.signal);
      if (flow.registration?.subject && flow.registration.subject !== identity.subject) {
        throw subscriptionError('ChatGPT returned a different account. Choose “Use another account” to connect it.');
      }
      await serialize(async () => {
        if (activeFlow !== flow || flow.abort.signal.aborted) throw subscriptionError('ChatGPT sign-in was cancelled.');
        flow.committing = true;
        clearTimeout(flow.timer);
        publish();
        await save({ ...record, registration: identity, tokens });
        changeAccount();
      });
      callbackPage(response, tokens.scopes.includes(PLAN_SCOPE)
        ? 'ChatGPT is connected. You can close this tab and return to EterX.'
        : 'Sign-in is complete. Return to EterX to enable ChatGPT plan usage.');
    } catch (error) {
      if (activeFlow === flow) signInError = error?.status ? error.message : 'Could not complete ChatGPT sign-in. Try again.';
      callbackPage(response, 'ChatGPT sign-in did not complete. Return to EterX to try again.');
    } finally {
      if (activeFlow === flow) {
        finishFlow();
        if (record?.tokens?.scopes.includes(PLAN_SCOPE)) void refreshModels();
      }
    }
  }

  function finishFlow() {
    const flow = activeFlow;
    if (!flow) return;
    activeFlow = undefined;
    clearTimeout(flow.timer);
    flow.abort.abort();
    flow.listener?.close();
    publish();
  }

  async function signIn(useDifferentAccount) {
    await load();
    if (!available || !bridgeReady || activeFlow || disconnectRequest
      || (useDifferentAccount && record?.tokens?.scopes.includes(PLAN_SCOPE))) return state();
    signInError = '';
    revokedWarning = '';
    const flow = {
      state: randomSecret(), nonce: randomSecret(), verifier: randomSecret(), abort: new AbortController(),
      registration: useDifferentAccount ? null : record?.registration,
      idTokenHint: useDifferentAccount ? null : record?.tokens?.idToken,
      needsConsent: !useDifferentAccount && Boolean(record?.tokens && !record.tokens.scopes.includes(PLAN_SCOPE)),
    };
    activeFlow = flow;
    flow.timer = setTimeout(() => {
      signInError = 'ChatGPT sign-in timed out. Start again.';
      finishFlow();
    }, SIGN_IN_TIMEOUT_MS);
    publish();
    try {
      await serialize(async () => {
        if (!record) await save({ hostId: `urn:uuid:${crypto.randomUUID()}`, registration: null, tokens: null });
      });
      const endpoints = await discover(flow.abort.signal);
      if (activeFlow !== flow) return state();
      let used = false;
      let redirectUri;
      flow.listener = http.createServer((request, response) => {
        const url = URL.parse(request.url || '/', redirectUri);
        if (!redirectUri || !url || request.method !== 'GET' || url.origin !== new URL(redirectUri).origin || url.pathname !== CALLBACK_PATH) {
          response.writeHead(404).end();
        } else if (!equalSecret(url.searchParams.get('state'), flow.state)) {
          response.writeHead(400).end('This response belongs to another sign-in.');
        } else if (used || activeFlow !== flow) {
          response.writeHead(410).end('This sign-in is no longer active.');
        } else {
          used = true;
          void exchangeCallback(flow, url.searchParams, response, endpoints, redirectUri);
        }
      });
      await listen(flow.listener, { port: 0, host: '127.0.0.1' });
      if (activeFlow !== flow) {
        flow.listener.close();
        return state();
      }
      redirectUri = `http://127.0.0.1:${flow.listener.address().port}${CALLBACK_PATH}`;
      const url = new URL(endpoints.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: flow.registration?.clientId || 'dynamic_agent_client',
        ...(flow.registration ? {} : { agent_name_hint: 'EterX' }),
        ...(flow.registration?.email ? { login_hint: flow.registration.email } : {}),
        ...(flow.idTokenHint ? { id_token_hint: flow.idTokenHint } : {}),
        ...(flow.needsConsent ? { prompt: 'consent' } : {}),
        ext_agent_host_id: record.hostId, response_type: 'code', redirect_uri: redirectUri,
        scope: SCOPES, resource: RESOURCE, state: flow.state, nonce: flow.nonce,
        code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(flow.verifier).digest('base64url'),
      }).toString();
      await openBrowser(url.toString());
    } catch (error) {
      if (activeFlow === flow) {
        signInError = error?.status ? error.message : 'Could not open ChatGPT sign-in. Try again.';
        finishFlow();
      }
    }
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
          result = await fetchJson(settings.token_endpoint, {
            method: 'POST', body: new URLSearchParams({
              grant_type: 'refresh_token', client_id: record.registration.clientId,
              refresh_token: current.refreshToken, resource: RESOURCE,
            }),
          });
        } catch { /* Temporary failures leave the current session intact. */ }
        if (result?.response.ok) {
          const renewed = normalizeTokens(result.body, current);
          await save({ ...record, tokens: renewed });
          if (renewed.scopes.includes(PLAN_SCOPE)) return renewed;
          changeAccount();
          publish();
          throw subscriptionError('Enable ChatGPT plan usage in Settings → Subscription.', 'chatgpt_sign_in_required', 401);
        }
        const code = result?.body?.error?.code || result?.body?.error;
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
        const response = await fetch(endpoints.revocation_endpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          body: new URLSearchParams({ client_id: credentials.clientId, token: credentials.token, token_type_hint: credentials.hint }),
        });
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
      const upstream = await fetch(`${RESOURCE}/responses`, {
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
