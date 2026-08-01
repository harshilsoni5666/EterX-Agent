'use strict';

function safeSegment(value, fallback = 'unknown') {
  const clean = String(value || '').trim().replace(/[:\s]+/g, '_').replace(/[^a-zA-Z0-9_.@+-]/g, '').slice(0, 160);
  return clean || fallback;
}

/** Deterministic Hermes/OpenClaw-style routing key for one agent conversation lane. */
function buildGatewaySessionKey(event, options = {}) {
  const platform = safeSegment(event.platform);
  const externalConversation = safeSegment(String(event.conversationId || '').replace(new RegExp(`^${platform}:`), ''));
  const actor = safeSegment(event.actor?.id);
  const isGroup = Boolean(event.metadata?.guildId || event.metadata?.chatType === 'group' || event.metadata?.chatType === 'supergroup');
  if (!isGroup) return `agent:main:${platform}:dm:${actor || externalConversation}`;
  return options.groupSessionsPerUser === false
    ? `agent:main:${platform}:group:${externalConversation}`
    : `agent:main:${platform}:group:${externalConversation}:user:${actor}`;
}

class GatewaySessionLanes {
  constructor() { this.lanes = new Map(); }

  enqueue(sessionKey, work) {
    const previous = this.lanes.get(sessionKey) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.lanes.set(sessionKey, next);
    void next.finally(() => { if (this.lanes.get(sessionKey) === next) this.lanes.delete(sessionKey); });
    return next;
  }

  get activeCount() { return this.lanes.size; }
}

module.exports = { buildGatewaySessionKey, GatewaySessionLanes };
