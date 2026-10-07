'use strict';

// This parser is shared by the paste handler and Electron. It has no network
// or Node dependencies: parse clipboard text before a single-line input can
// discard newlines and join BotFather's explanatory text onto the credential.
const TOKEN = /^\d{1,20}:[A-Za-z0-9_-]{20,128}$/;
const TELEGRAM_CLIENT_VERSION = '2026-10-07.1';
function tokenError(message) {
  return Object.assign(new Error(message), { code: 'TELEGRAM_TOKEN_FORMAT' });
}

function normalizeTelegramToken(value) {
  const pasted = String(value || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
  if (!pasted) return '';
  const unwrapped = pasted.replace(/^[`'"<]+|[`'">]+$/g, '').trim().replace(/^bot(?=\d+:)/i, '');
  if (TOKEN.test(unwrapped)) return unwrapped;

  // Keep whitespace boundaries. Collapsing a whole message can produce a
  // syntactically valid but different secret (for example TOKEN + "Keep").
  const matches = [...pasted.matchAll(/(?:^|[^A-Za-z0-9_:-])(?:bot)?(\d{1,20}:[A-Za-z0-9_-]{20,128})(?![A-Za-z0-9_-])/g)];
  const candidates = [...new Set(matches.map(match => match[1]))];
  if (candidates.length > 1) throw tokenError('More than one bot token was pasted. Copy only the token for this bot from @BotFather.');
  if (candidates.length === 1) {
    for (const match of matches) {
      const after = pasted.slice(match.index + match[0].length);
      if (/^[ \t]*\r?\n[ \t]*[A-Za-z0-9_-]+[ \t]*(?:\r?\n|$)/.test(after)) {
        throw tokenError('The pasted token may be split across lines. Use Copy on the token itself in @BotFather so EterX receives the complete token.');
      }
    }
    return candidates[0];
  }
  throw tokenError('Paste the complete API token from @BotFather, including the number, colon and letters after it. A bot username or Telegram login code is not a bot token.');
}

module.exports = { normalizeTelegramToken, TELEGRAM_CLIENT_VERSION };
