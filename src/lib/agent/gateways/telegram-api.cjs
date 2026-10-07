'use strict';

// One transport for setup, polling and media. Electron installs its native
// network stack so the entire connection uses the computer's system proxy.
let request = (...args) => fetch(...args);
function setTelegramTransport(transport) { request = transport; }
const { normalizeTelegramToken, TELEGRAM_CLIENT_VERSION } = require('./telegram-token.cjs');

function safeTelegramError(value, token) {
  let message = String(value || '');
  if (token) message = message.split(token).join('[token]');
  return message.replace(/https:\/\/api\.telegram\.org\/\S+/gi, '[Telegram API request]')
    .replace(/\b\d+:[A-Za-z0-9_-]+/g, '[token]').slice(0, 600);
}

function networkFailure(cause, signal) {
  if (signal?.aborted && signal.reason?.name !== 'TimeoutError') {
    return Object.assign(new Error('Telegram connection stopped.'), { code: 'TELEGRAM_ABORTED', retryable: false });
  }
  const timeout = signal?.aborted || cause?.name === 'TimeoutError';
  // Extract a machine error code only; raw fetch errors can include the token.
  const networkCode = String(cause?.message || '').match(/(?:^|\bnet::)(ERR_[A-Z_]{3,80})\b/)?.[1];
  return Object.assign(new Error(timeout
    ? 'Telegram did not respond in time. Check this computer’s connection and try again.'
    : 'This computer could not reach api.telegram.org. Check its internet or system proxy connection and try again.'),
  { code: timeout ? 'TELEGRAM_TIMEOUT' : 'TELEGRAM_NETWORK', networkCode, retryable: true });
}

async function telegramFetch(url, options = {}) {
  try { return await request(url, { ...options, credentials: 'omit', cache: 'no-store', redirect: 'error' }); }
  catch (cause) { throw networkFailure(cause, options.signal); }
}

async function telegramApi(token, method, body = {}, signal, timeoutMs) {
  const multipart = body instanceof FormData;
  const timeout = AbortSignal.timeout(timeoutMs || (multipart ? 120000 : 40000));
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  // getMe needs no parameters. Keep credential verification a simple,
  // uncached read; all other methods retain their existing POST semantics.
  const identityRequest = method === 'getMe';
  let response;
  let payload;
  try {
    response = await telegramFetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: identityRequest ? 'GET' : 'POST',
      headers: multipart || identityRequest ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: identityRequest ? undefined : multipart ? body : JSON.stringify(body),
      signal: requestSignal,
    });
    try { payload = await response.json(); }
    catch (cause) {
      if (requestSignal.aborted || cause?.name !== 'SyntaxError') throw networkFailure(cause, requestSignal);
      payload = null;
    }
  } catch (error) { error.method = method; throw error; }
  const telegramResponse = payload?.ok === false && Number.isInteger(payload.error_code);
  if (response.ok && payload?.ok === true && payload.result !== undefined) return payload.result;
  const httpStatus = response.status;
  const telegramCode = telegramResponse ? payload.error_code : undefined;
  // An upstream HTTP failure must not be mislabeled as a rejected token, even
  // if a gateway supplies an inconsistent JSON body with a different code.
  const serviceFailure = httpStatus >= 500 || telegramCode >= 500;
  const code = httpStatus >= 500 ? httpStatus : telegramCode || httpStatus;
  const retryAfter = Math.max(0, Number(payload?.parameters?.retry_after || response.headers?.get('retry-after')) || 0);
  const detail = telegramResponse ? safeTelegramError(payload.description, token) : '';
  const codes = `HTTP ${httpStatus}${telegramCode && telegramCode !== httpStatus ? `; Telegram ${telegramCode}` : ''}`;
  const authFailure = telegramResponse && !serviceFailure && [401, 404].includes(code);
  let message;
  if (serviceFailure) message = `Telegram’s API or a network gateway returned ${codes}. This is a service connection failure. Try again shortly.`;
  else if (code === 429) message = `Telegram is rate-limiting this connection (${codes}). Try again${retryAfter ? ` in ${Math.ceil(retryAfter)} seconds` : ' shortly'}.`;
  else if (!telegramResponse) message = `The Telegram request returned ${codes} without a Telegram error response. Check this computer’s network or proxy connection; this response cannot confirm whether the token is valid.`;
  else if (identityRequest && authFailure) message = `Telegram rejected the token sent by EterX (${codes}${detail ? `: ${detail}` : ''}). Copy the token itself from @BotFather → /mybots → your bot → API Token and paste it again. If that current token is still rejected, generate a replacement there.`;
  else message = `Telegram request failed (${codes}): ${detail || 'The request could not be completed.'}`;
  throw Object.assign(new Error(message), {
    code: !telegramResponse && !serviceFailure && code !== 429 ? 'TELEGRAM_RESPONSE' : code,
    httpStatus, telegramCode, method, retryAfter, authFailure,
    retryable: serviceFailure || code === 429,
  });
}

async function verifyTelegramToken(value) {
  const token = normalizeTelegramToken(value);
  if (!token) throw new Error('Paste the API token from @BotFather.');
  let identity;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { identity = await telegramApi(token, 'getMe', {}, undefined, 15000); break; }
    catch (error) {
      // Only repeat this read-only request. Never blindly retry a message or
      // upload that Telegram may already have accepted.
      if (attempt || !error.retryable || error.retryAfter > 2) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.max(500, (error.retryAfter || 0) * 1000)));
    }
  }
  if (!identity?.id || identity.is_bot !== true || !identity.username) {
    throw Object.assign(new Error('Telegram responded, but did not return a bot identity. Try again; this response does not prove the token is invalid.'), { code: 'TELEGRAM_IDENTITY' });
  }
  return { token, identity };
}

module.exports = { normalizeTelegramToken, verifyTelegramToken, telegramApi, telegramFetch, setTelegramTransport, safeTelegramError, TELEGRAM_CLIENT_VERSION };
