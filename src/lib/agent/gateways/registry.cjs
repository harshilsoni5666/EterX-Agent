'use strict';

const { normalizeGatewayPayload } = require('./normalizers.cjs');

/**
 * Runtime adapter registry. Third-party transports only need to provide a
 * stable id and a normalize(payload) function that returns GatewayAgentInput[].
 * Connection ownership can remain in the adapter or feed the daemon webhook.
 */
class GatewayAdapterRegistry {
  constructor() {
    this.adapters = new Map();
    for (const id of ['telegram', 'whatsapp', 'messenger', 'email', 'discord', 'signal', 'generic']) {
      this.register({ id, normalize: (payload) => normalizeGatewayPayload(id, payload) });
    }
  }

  register(adapter) {
    if (!adapter || typeof adapter.id !== 'string' || !adapter.id.trim()) throw new TypeError('Gateway adapter id is required.');
    if (typeof adapter.normalize !== 'function') throw new TypeError(`Gateway adapter ${adapter.id} must implement normalize(payload).`);
    this.adapters.set(adapter.id, Object.freeze({ ...adapter, id: adapter.id.trim() }));
    return () => this.adapters.delete(adapter.id);
  }

  get(id) { return this.adapters.get(id); }
  list() { return [...this.adapters.values()]; }

  normalize(id, payload) {
    const adapter = this.get(id);
    if (!adapter) throw new Error(`No gateway adapter is registered for ${id}.`);
    const events = adapter.normalize(payload);
    if (!Array.isArray(events)) throw new TypeError(`Gateway adapter ${id} returned a non-array payload.`);
    return events;
  }
}

module.exports = { GatewayAdapterRegistry };
