/**
 * ═══════════════════════════════════════════════════════════════
 * EterX Network Monitor — Request Interception & Traffic Analysis
 * ═══════════════════════════════════════════════════════════════
 * 
 * Features:
 * - Request/response logging
 * - URL pattern blocking
 * - Header injection
 * - Request modification
 * - Download tracking
 * - Performance metrics (timing, sizes)
 * - API response capture
 * - Network idle detection
 */

// ═══════════════════════════════════════
// TYPES
// ═══════════════════════════════════════

export interface NetworkRequest {
  id: string;
  url: string;
  method: string;
  resourceType: string;
  headers: Record<string, string>;
  postData?: string;
  timestamp: number;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseSize?: number;
  duration?: number;
  failed?: boolean;
  failureText?: string;
  redirectedTo?: string;
}

export interface NetworkBlockRule {
  id: string;
  pattern: string;      // glob or regex pattern
  isRegex: boolean;
  resourceTypes?: string[];  // e.g., ['image', 'stylesheet', 'script']
}

export interface NetworkStats {
  totalRequests: number;
  failedRequests: number;
  blockedRequests: number;
  totalBytesReceived: number;
  requestsByType: Record<string, number>;
  averageResponseTime: number;
  slowestRequests: { url: string; duration: number }[];
}

type PageNetworkState = {
  listeners: Array<[string, (...args: any[]) => void]>;
  routes: Map<string, { matcher: string | RegExp; handler: (route: any) => Promise<void>; ruleId: string }>;
  headers: Record<string, string>;
};

// ═══════════════════════════════════════
// NETWORK MONITOR
// ═══════════════════════════════════════

export class NetworkMonitor {
  private requests: Map<string, NetworkRequest> = new Map();
  private blockRules: NetworkBlockRule[] = [];
  private maxEntries: number = 500;
  private blockedCount: number = 0;
  private requestIds: WeakMap<any, string> = new WeakMap();
  
  // Per-page route handlers for cleanup
  private pageStates = new Map<any, PageNetworkState>();

  private getPageState(page: any): PageNetworkState {
    let state = this.pageStates.get(page);
    if (!state) {
      state = { listeners: [], routes: new Map(), headers: {} };
      this.pageStates.set(page, state);
    }
    return state;
  }

  /**
   * Start intercepting network traffic on a page.
   */
  async startIntercepting(page: any, pageId: string = 'main'): Promise<void> {
    const state = this.getPageState(page);
    if (state.listeners.length) return;
    const listen = (event: string, handler: (...args: any[]) => void) => {
      state.listeners.push([event, handler]);
      page.on(event, handler);
    };

    // Listen to all requests
    listen('request', (req: any) => {
      const id = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      this.requestIds.set(req, id);
      this.requests.set(id, {
        id,
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        headers: req.headers(),
        postData: req.postData() || undefined,
        timestamp: Date.now(),
      });

      // Keep size bounded
      if (this.requests.size > this.maxEntries) {
        const oldest = this.requests.keys().next().value;
        if (oldest) this.requests.delete(oldest);
      }
    });

    listen('response', (res: any) => {
      const id = this.requestIds.get(res.request?.());
      const req = id ? this.requests.get(id) : undefined;
      if (req) {
        req.status = res.status();
        req.statusText = res.statusText();
        req.responseHeaders = res.headers();
        req.duration = Date.now() - req.timestamp;
        try {
          const contentLength = res.headers()['content-length'];
          if (contentLength) req.responseSize = parseInt(contentLength);
        } catch {}
      }
    });

    listen('requestfailed', (req: any) => {
      const id = this.requestIds.get(req);
      const record = id ? this.requests.get(id) : undefined;
      if (record) {
        record.failed = true;
        record.failureText = req.failure()?.errorText || 'Unknown';
        record.duration = Date.now() - record.timestamp;
      }
    });

    listen('close', () => { void this.stopIntercepting(page); });
    console.log(`[NetworkMonitor] 📡 Started intercepting network traffic`);
  }

  /**
   * Stop intercepting.
   */
  async stopIntercepting(page: any): Promise<void> {
    const state = this.pageStates.get(page);
    if (!state) return;
    // Detach immediately so stopping and restarting cannot double-log requests.
    for (const [event, handler] of state.listeners) page.removeListener(event, handler);
    state.listeners = [];
    this.pageStates.delete(page);
    const ruleIds = new Set([...state.routes.values()].map(route => route.ruleId));
    this.blockRules = this.blockRules.filter(rule => !ruleIds.has(rule.id));
    for (const { matcher, handler } of state.routes.values()) {
      try { await page.unroute(matcher, handler); } catch {}
    }
    if (Object.keys(state.headers).length && !page.isClosed()) {
      await page.setExtraHTTPHeaders({}).catch(() => {});
    }
    console.log(`[NetworkMonitor] 🔇 Stopped intercepting`);
  }

  /**
   * Block requests matching URL patterns.
   */
  async blockUrls(page: any, patterns: string[], resourceTypes?: string[]): Promise<void> {
    await this.startIntercepting(page);
    const state = this.getPageState(page);
    for (const pattern of patterns) {
      const rule: NetworkBlockRule = {
        id: `block_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        pattern,
        isRegex: pattern.startsWith('/') && pattern.endsWith('/'),
        resourceTypes,
      };
      const matcher = rule.isRegex ? new RegExp(pattern.slice(1, -1)) : pattern;

      // Install route handler
      const handler = async (route: any) => {
        const req = route.request();
        const type = req.resourceType();
        
        if (!resourceTypes || resourceTypes.includes(type)) {
          this.blockedCount++;
          await route.abort('blockedbyclient');
        } else {
          await route.fallback();
        }
      };

      const previous = state.routes.get(pattern);
      if (previous) {
        await page.unroute(previous.matcher, previous.handler);
        this.blockRules = this.blockRules.filter(item => item.id !== previous.ruleId);
        state.routes.delete(pattern);
      }
      await page.route(matcher, handler);
      state.routes.set(pattern, { matcher, handler, ruleId: rule.id });
      this.blockRules.push(rule);
    }

    console.log(`[NetworkMonitor] 🚫 Blocking ${patterns.length} URL patterns`);
  }

  /**
   * Add custom headers to all requests.
   */
  async setCustomHeaders(page: any, headers: Record<string, string>): Promise<void> {
    await this.startIntercepting(page);
    const state = this.getPageState(page);
    const nextHeaders = { ...state.headers, ...headers };
    await page.setExtraHTTPHeaders(nextHeaders);
    state.headers = nextHeaders;
    console.log(`[NetworkMonitor] 📋 Set ${Object.keys(headers).length} custom headers`);
  }

  /**
   * Get captured requests, optionally filtered.
   */
  getRequests(filter?: {
    urlPattern?: string;
    method?: string;
    resourceType?: string;
    statusCode?: number;
    failedOnly?: boolean;
  }): NetworkRequest[] {
    let results = Array.from(this.requests.values());

    if (filter) {
      if (filter.urlPattern) {
        try {
          const regex = new RegExp(filter.urlPattern, 'i');
          results = results.filter(r => regex.test(r.url));
        } catch {
          const needle = filter.urlPattern.toLowerCase();
          results = results.filter(r => r.url.toLowerCase().includes(needle));
        }
      }
      if (filter.method) {
        results = results.filter(r => r.method === filter.method!.toUpperCase());
      }
      if (filter.resourceType) {
        results = results.filter(r => r.resourceType === filter.resourceType);
      }
      if (filter.statusCode) {
        results = results.filter(r => r.status === filter.statusCode);
      }
      if (filter.failedOnly) {
        results = results.filter(r => r.failed);
      }
    }

    return results;
  }

  /**
   * Get API requests (XHR/fetch) — most useful for understanding page behavior.
   */
  getApiRequests(): NetworkRequest[] {
    return this.getRequests({ resourceType: 'fetch' })
      .concat(this.getRequests({ resourceType: 'xhr' }));
  }

  /**
   * Get network statistics.
   */
  getStats(): NetworkStats {
    const all = Array.from(this.requests.values());
    const completed = all.filter(r => r.duration);
    const failed = all.filter(r => r.failed);

    const byType: Record<string, number> = {};
    for (const r of all) {
      byType[r.resourceType] = (byType[r.resourceType] || 0) + 1;
    }

    const totalBytes = all.reduce((sum, r) => sum + (r.responseSize || 0), 0);
    const avgTime = completed.length > 0
      ? completed.reduce((sum, r) => sum + (r.duration || 0), 0) / completed.length
      : 0;

    const slowest = completed
      .sort((a, b) => (b.duration || 0) - (a.duration || 0))
      .slice(0, 5)
      .map(r => ({ url: r.url.substring(0, 100), duration: r.duration || 0 }));

    return {
      totalRequests: all.length,
      failedRequests: failed.length,
      blockedRequests: this.blockedCount,
      totalBytesReceived: totalBytes,
      requestsByType: byType,
      averageResponseTime: Math.round(avgTime),
      slowestRequests: slowest,
    };
  }

  /**
   * Wait for network to be idle (no pending requests for N ms).
   */
  async waitForNetworkIdle(page: any, timeout: number = 5000, idleTime: number = 500): Promise<boolean> {
    try {
      await page.waitForLoadState('networkidle', { timeout });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Wait for a specific request/response to appear.
   */
  async waitForRequest(page: any, urlPattern: string, timeout: number = 10000): Promise<NetworkRequest | null> {
    try {
      const request = await page.waitForRequest(
        (req: any) => req.url().includes(urlPattern),
        { timeout }
      );
      return {
        id: `waited_${Date.now()}`,
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        headers: request.headers(),
        postData: request.postData() || undefined,
        timestamp: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Wait for a specific response.
   */
  async waitForResponse(page: any, urlPattern: string, timeout: number = 10000): Promise<{ status: number; body: string } | null> {
    try {
      const response = await page.waitForResponse(
        (res: any) => res.url().includes(urlPattern),
        { timeout }
      );
      const body = await response.text().catch(() => '');
      return {
        status: response.status(),
        body: body.substring(0, 5000),
      };
    } catch {
      return null;
    }
  }

  /**
   * Clear all captured data.
   */
  clear(): void {
    this.requests.clear();
    this.blockedCount = 0;
  }

  /**
   * Clear block rules.
   */
  async clearBlockRules(page: any): Promise<void> {
    const state = this.pageStates.get(page);
    if (!state) return;
    for (const [pattern, { matcher, handler, ruleId }] of state.routes) {
      try {
        await page.unroute(matcher, handler);
        state.routes.delete(pattern);
        this.blockRules = this.blockRules.filter(rule => rule.id !== ruleId);
      } catch {}
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.pageStates.keys()].map(page => this.stopIntercepting(page)));
    this.clear();
  }
}

// ═══════════════════════════════════════
// GLOBAL SINGLETON
// ═══════════════════════════════════════
const globalForNetwork = globalThis as typeof globalThis & { __eterxNetworkMonitor?: NetworkMonitor };
export const networkMonitor = globalForNetwork.__eterxNetworkMonitor ||= new NetworkMonitor();
