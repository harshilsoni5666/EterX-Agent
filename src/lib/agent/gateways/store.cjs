'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class GatewayStore {
  constructor(root) {
    this.root = root;
    this.eventsPath = path.join(root, 'events.jsonl');
    this.conversationsPath = path.join(root, 'conversations.json');
    this.acknowledgedPath = path.join(root, 'acknowledged.json');
    this.identitiesPath = path.join(root, 'identities.json');
    this.deliveriesPath = path.join(root, 'deliveries.json');
    this.seen = new Set();
    this.eventIndex = new Map();
    this.acknowledged = new Set();
    this.conversations = new Map();
    this.identities = new Map();
    this.deliveries = new Map();
    this.eventCount = 0;
    this.load();
  }

  load() {
    fs.mkdirSync(this.root, { recursive: true });
    try {
      const rows = fs.readFileSync(this.eventsPath, 'utf8').trim().split(/\r?\n/).slice(-10000);
      for (const row of rows) {
        if (!row) continue;
        let event;
        try { event = JSON.parse(row); } catch { continue; }
        if (event.dedupeKey) this.seen.add(event.dedupeKey);
        if (event.id) this.eventIndex.set(event.id, event);
        this.eventCount = Math.max(this.eventCount + 1, Number(event.cursor || 0));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[gateway-store] Could not load events:', error.message);
    }
    try {
      const rows = JSON.parse(fs.readFileSync(this.conversationsPath, 'utf8'));
      for (const item of Array.isArray(rows) ? rows : []) this.conversations.set(item.id, item);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[gateway-store] Could not load conversations:', error.message);
    }
    try {
      const ids = JSON.parse(fs.readFileSync(this.acknowledgedPath, 'utf8'));
      for (const id of Array.isArray(ids) ? ids.slice(-10000) : []) this.acknowledged.add(String(id));
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[gateway-store] Could not load acknowledgements:', error.message);
    }
    for (const [target, collection] of [[this.identitiesPath, this.identities], [this.deliveriesPath, this.deliveries]]) {
      try {
        const rows = JSON.parse(fs.readFileSync(target, 'utf8'));
        for (const item of Array.isArray(rows) ? rows : []) if (item?.id) {
          if (collection === this.deliveries && item.status === 'sending') { item.status = 'retrying'; item.nextAttemptAt = Date.now(); }
          collection.set(String(item.id), item);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`[gateway-store] Could not load ${path.basename(target)}:`, error.message);
      }
    }
  }

  append(event) {
    if (!event?.dedupeKey || this.seen.has(event.dedupeKey)) return { accepted: false, duplicate: true };
    this.seen.add(event.dedupeKey);
    this.eventCount += 1;
    event.cursor = this.eventCount;
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.eventIndex.set(event.id, event);
    const current = this.conversations.get(event.conversationId);
    const conversation = {
      id: event.conversationId,
      platform: event.platform,
      externalId: event.externalConversationId || event.conversationId,
      title: event.direction === 'outbound' ? current?.title || event.conversationId : event.actor?.displayName || event.actor?.username || event.conversationId,
      lastMessageAt: event.receivedAt,
      lastMessagePreview: String(event.text || (event.attachments?.length ? '[Attachment]' : '')).slice(0, 180),
      unreadCount: (current?.unreadCount || 0) + (event.direction === 'outbound' ? 0 : 1),
      messageCount: (current?.messageCount || 0) + 1,
    };
    this.conversations.set(conversation.id, conversation);
    this.flushConversations();
    return { accepted: true, duplicate: false, conversation };
  }

  flushConversations() {
    const temp = `${this.conversationsPath}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(this.listConversations(), null, 2), { encoding: 'utf8', mode: 0o600 });
    this.backupBeforeReplace(this.conversationsPath);
    fs.renameSync(temp, this.conversationsPath);
  }

  listConversations() {
    return [...this.conversations.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  listEvents(limit = 100) {
    try {
      return fs.readFileSync(this.eventsPath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-Math.max(1, Math.min(500, limit)))
        .reverse()
        .flatMap((row) => {
          try { return [JSON.parse(row)]; } catch { return []; }
        });
    } catch { return []; }
  }

  listMessages(conversationId, limit = 100) {
    const target = String(conversationId || '');
    return this.listEvents(Math.max(500, limit * 10))
      .filter((event) => event.conversationId === target)
      .slice(0, Math.max(1, Math.min(500, limit)))
      .reverse();
  }

  pollEvents(afterCursor = 0, limit = 100) {
    const cursor = Math.max(0, Number(afterCursor) || 0);
    const events = this.listEvents(500).reverse().filter((event) => Number(event.cursor || 0) > cursor).slice(0, Math.max(1, Math.min(500, limit)));
    return { events, cursor: events.length ? Number(events[events.length - 1].cursor || cursor) : cursor };
  }

  listPending(limit = 100, accepts = () => true) {
    return [...this.eventIndex.values()]
      .filter((event) => event.direction !== 'outbound' && !this.acknowledged.has(event.id) && accepts(event))
      .sort((left, right) => Number(Boolean(right.botId)) - Number(Boolean(left.botId)) || left.receivedAt - right.receivedAt)
      .slice(0, Math.max(1, Math.min(500, limit)));
  }

  acknowledge(eventId) {
    const id = String(eventId || '');
    if (!id) return false;
    this.acknowledged.add(id);
    const values = [...this.acknowledged].slice(-10000);
    const temp = `${this.acknowledgedPath}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(values), { encoding: 'utf8', mode: 0o600 });
    this.backupBeforeReplace(this.acknowledgedPath);
    fs.renameSync(temp, this.acknowledgedPath);
    return true;
  }

  markRead(conversationId) {
    const item = this.conversations.get(conversationId);
    if (!item) return false;
    item.unreadCount = 0;
    this.flushConversations();
    return true;
  }

  authorize(event, policy = 'open', allowlist = []) {
    const actorId = String(event?.actor?.id || '');
    const username = String(event?.actor?.username || '');
    const identityId = `${event.platform}:${actorId}`;
    const allowed = new Set((Array.isArray(allowlist) ? allowlist : []).map((item) => String(item).trim().toLowerCase()).filter(Boolean));
    const normalizedUsername = username.toLowerCase().replace(/^@/, '');
    if (policy === 'open' || allowed.has(actorId.toLowerCase()) || (normalizedUsername && (allowed.has(normalizedUsername) || allowed.has(`@${normalizedUsername}`)))) {
      return { authorized: true, identityId };
    }
    const existing = this.identities.get(identityId);
    if (policy === 'allowlist') return { authorized: false, identityId, reason: 'not-allowlisted' };
    if (existing?.status === 'approved') return { authorized: true, identityId };
    if (existing?.status === 'denied') return { authorized: false, identityId, reason: 'denied' };
    if (existing?.status === 'pending') {
      existing.lastSeenAt = Date.now();
      this.flushCollection(this.identitiesPath, this.identities);
      return { authorized: false, identityId, reason: 'pairing-required', approval: existing };
    }
    const approval = {
      id: identityId,
      platform: event.platform,
      actorId,
      displayName: event.actor?.displayName || username || actorId,
      username: username || undefined,
      status: 'pending',
      code: String(crypto.randomInt(100000, 1000000)),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.identities.set(identityId, approval);
    this.flushCollection(this.identitiesPath, this.identities);
    return { authorized: false, identityId, reason: 'pairing-required', approval };
  }

  listApprovals() {
    return [...this.identities.values()].sort((a, b) => Number(b.lastSeenAt || b.createdAt) - Number(a.lastSeenAt || a.createdAt));
  }

  resolveApproval(identityId, approved) {
    const item = this.identities.get(String(identityId || ''));
    if (!item) return false;
    item.status = approved ? 'approved' : 'denied';
    item.resolvedAt = Date.now();
    delete item.code;
    this.flushCollection(this.identitiesPath, this.identities);
    return true;
  }

  createDelivery(platform, target, text, metadata = {}) {
    if (metadata.deliveryKey) {
      const previous = [...this.deliveries.values()].find(item => item.platform === platform && item.metadata?.deliveryKey === metadata.deliveryKey && JSON.stringify(item.target) === JSON.stringify(target));
      if (previous) return previous;
    }
    const delivery = {
      id: crypto.randomUUID(), platform, target, text, metadata,
      status: 'pending', attempts: 0, createdAt: Date.now(), updatedAt: Date.now(), nextAttemptAt: Date.now(),
    };
    this.deliveries.set(delivery.id, delivery);
    this.flushCollection(this.deliveriesPath, this.deliveries);
    return delivery;
  }

  updateDelivery(deliveryId, patch) {
    const delivery = this.deliveries.get(String(deliveryId || ''));
    if (!delivery) return null;
    Object.assign(delivery, patch, { updatedAt: Date.now() });
    this.flushCollection(this.deliveriesPath, this.deliveries);
    return delivery;
  }

  listPendingDeliveries(limit = 100) {
    const now = Date.now();
    return [...this.deliveries.values()]
      .filter((item) => (item.status === 'pending' || item.status === 'retrying') && Number(item.nextAttemptAt || 0) <= now)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, Math.max(1, Math.min(500, limit)));
  }

  flushCollection(target, collection) {
    const temp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify([...collection.values()].slice(-10000), null, 2), { encoding: 'utf8', mode: 0o600 });
    this.backupBeforeReplace(target);
    fs.renameSync(temp, target);
  }

  backupBeforeReplace(target) {
    if (!fs.existsSync(target)) return;
    try { fs.copyFileSync(target, `${target}.backup`); } catch { }
  }
}

module.exports = { GatewayStore };
