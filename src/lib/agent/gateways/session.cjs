'use strict';

const crypto = require('crypto');

function safeSegment(value, fallback = 'unknown') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const clean = raw.replace(/[:\s]+/g, '_').replace(/[^a-zA-Z0-9_.@+-]/g, '').slice(0, 120);
  return clean === raw ? clean : `${clean || fallback}_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

/** Deterministic Hermes/OpenClaw-style routing key for one agent conversation lane. */
function buildGatewaySessionKey(event, options = {}) {
  const platform = safeSegment(event.platform);
  const externalConversation = safeSegment(String(event.conversationId || '').replace(new RegExp(`^${platform}:`), ''));
  const actor = safeSegment(event.actor?.id || externalConversation);
  const thread = event.threadId && platform !== 'email' ? `:thread:${safeSegment(event.threadId)}` : '';
  const isGroup = Boolean(event.metadata?.guildId || event.metadata?.groupId || ['group', 'supergroup', 'channel'].includes(event.metadata?.chatType));
  // Telegram and WhatsApp private chat IDs already identify the person. Other
  // adapters can have several independent conversations with the same actor.
  if (!isGroup) return ['telegram', 'whatsapp', 'messenger'].includes(platform)
    ? `agent:main:${platform}:dm:${actor}${thread}`
    : `agent:main:${platform}:dm:${externalConversation}:user:${actor}${thread}`;
  return (options.groupSessionsPerUser === false
    ? `agent:main:${platform}:group:${externalConversation}`
    : `agent:main:${platform}:group:${externalConversation}:user:${actor}`) + thread;
}

class GatewaySessionLanes {
  constructor() { this.lanes = new Map(); }

  enqueue(sessionKey, work) {
    const previous = this.lanes.get(sessionKey) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.lanes.set(sessionKey, next);
    void next.finally(() => { if (this.lanes.get(sessionKey) === next) this.lanes.delete(sessionKey); }).catch(() => {});
    return next;
  }

  get activeCount() { return this.lanes.size; }
}

module.exports = { buildGatewaySessionKey, GatewaySessionLanes };
