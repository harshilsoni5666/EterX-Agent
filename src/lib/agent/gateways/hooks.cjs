'use strict';

class GatewayHookBus {
  constructor() { this.handlers = new Map(); }
  on(event, handler) {
    if (typeof handler !== 'function') throw new TypeError('Gateway hook must be a function.');
    const handlers = this.handlers.get(event) || new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }
  async emit(event, payload) {
    for (const handler of this.handlers.get(event) || []) {
      try { await handler(payload); } catch (error) { console.warn(`[gateway-hook:${event}]`, error?.message || error); }
    }
  }
}

module.exports = { GatewayHookBus };
