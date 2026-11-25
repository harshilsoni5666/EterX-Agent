const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');

const MAX_EVENT_LENGTH = 1024 * 1024;
const MAX_ERROR_LENGTH = 64 * 1024;

function usageFromError(payload) {
  const code = payload?.response?.error?.code
    ?? payload?.error?.code ?? payload?.detail?.code ?? payload?.code
    ?? payload?.error;
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded': return 'plan-limit';
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable': return 'unavailable';
    case 'subscription_sharing_user_not_eligible':
    case 'subscription_sharing_v2_user_not_eligible': return 'ineligible';
    default: return null;
  }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function usageFromEvent(frame) {
  const event = /^event: ?([^\r\n]+)$/m.exec(frame)?.[1];
  if (event === 'response.completed') return 'completed';
  if (event && event !== 'response.failed' && event !== 'error' && event !== 'message') return null;
  if (frame.length > MAX_EVENT_LENGTH) return null;

  const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, '')).join('\n');
  const payload = parseJson(data);
  if (payload?.type === 'response.completed') return 'completed';
  return usageFromError(payload);
}

function observeEvents(report) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let discardFrame = false;
  let reported = false;

  // Observe terminal events without rewriting the stream or retaining model output.
  return new Transform({
    transform(chunk, _encoding, done) {
      if (!reported) {
        buffer += decoder.write(chunk);
        let offset = 0;
        for (const match of buffer.matchAll(/\r?\n\r?\n/g)) {
          const status = discardFrame ? null : usageFromEvent(buffer.slice(offset, match.index));
          offset = match.index + match[0].length;
          discardFrame = false;
          if (status) {
            reported = true;
            report(status);
            break;
          }
        }
        buffer = reported ? '' : buffer.slice(offset);
        if (buffer.length > MAX_EVENT_LENGTH) {
          discardFrame = true;
          buffer = buffer.slice(-3);
        }
      }
      done(null, chunk);
    },
  });
}

function observeError(report, fallback) {
  const chunks = [];
  let length = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      length += chunk.length;
      if (length <= MAX_ERROR_LENGTH) chunks.push(chunk);
      done(null, chunk);
    },
    flush(done) {
      const status = length <= MAX_ERROR_LENGTH
        ? usageFromError(parseJson(Buffer.concat(chunks).toString('utf8'))) ?? fallback
        : fallback;
      if (status) report(status);
      done();
    },
  });
}

function observeChatGptUsage(response, report) {
  const contentType = response.headers.get('content-type')?.split(';')[0].trim();
  if (response.ok && contentType === 'text/event-stream') return observeEvents(report);
  const fallback = response.status === 429 ? 'rate-limited' : null;
  if (!response.ok && response.body && contentType && /(?:\/|\+)json$/i.test(contentType)) {
    return observeError(report, fallback);
  }
  if (fallback) report(fallback);
  return null;
}

module.exports = { observeChatGptUsage };
