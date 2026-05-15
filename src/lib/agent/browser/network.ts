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

// ═══════════════════════════════════════
// NETWORK MONITOR
// ═══════════════════════════════════════

export class NetworkMonitor {
  private requests: Map<string, NetworkRequest> = new Map();
  private blockRules: NetworkBlockRule[] = [];
  private customHeaders: Record<string, string> = {};
  private isIntercepting: boolean = false;
  private maxEntries: number = 500;
  private blockedCount: number = 0;
  private interceptedPages: WeakSet<any> = new WeakSet();
  
  // Per-page route handlers for cleanup
  private routeHandlers: Map<string, any> = new Map();

  /**
   * Start intercepting network traffic on a page.
   */
  async startIntercepting(page: any, pageId: string = 'main'): Promise<void> {
    if (this.interceptedPages.has(page)) return;
    this.interceptedPages.add(page);

    // Listen to all requests
    page.on('request', (req: any) => {
      const id = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
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

    page.on('response', (res: any) => {
      const url = res.url();
      // Find the matching request
      for (const [id, req] of this.requests) {
        if (req.url === url && !req.status) {
          req.status = res.status();
          req.statusText = res.statusText();
          req.responseHeaders = res.headers();
          req.duration = Date.now() - req.timestamp;
          try {
            const contentLength = res.headers()['content-length'];
            if (contentLength) req.responseSize = parseInt(contentLength);
          } catch {}
          break;
        }
      }
    });

    page.on('requestfailed', (req: any) => {
      const url = req.url();
      for (const [id, r] of this.requests) {
        if (r.url === url && !r.status) {
          r.failed = true;
          r.failureText = req.failure()?.errorText || 'Unknown';
          r.duration = Date.now() - r.timestamp;
          break;
        }
      }
    });

    this.isIntercepting = true;
    console.log(`[NetworkMonitor] 📡 Started intercepting network traffic`);
  }

  /**
   * Stop intercepting.
   */
  async stopIntercepting(page: any): Promise<void> {
    // Remove route handlers
    for (const [pattern, handler] of this.routeHandlers) {
      try {
        await page.unroute(pattern, handler);
      } catch {}
    }
    this.routeHandlers.clear();
    this.interceptedPages.delete(page);
    this.isIntercepting = false;
    console.log(`[NetworkMonitor] 🔇 Stopped intercepting`);
  }

  /**
   * Block requests matching URL patterns.
   */
  async blockUrls(page: any, patterns: string[], resourceTypes?: string[]): Promise<void> {
    for (const pattern of patterns) {
      const rule: NetworkBlockRule = {
        id: `block_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        pattern,
        isRegex: pattern.startsWith('/') && pattern.endsWith('/'),
        resourceTypes,
      };
      this.blockRules.push(rule);

      // Install route handler
      const handler = async (route: any) => {
        const req = route.request();
        const type = req.resourceType();
        
        if (!resourceTypes || resourceTypes.includes(type)) {
          this.blockedCount++;
          await route.abort('blockedbyclient');
        } else {
          await route.continue();
        }
      };

      await page.route(pattern, handler);
      this.routeHandlers.set(pattern, handler);
    }

    console.log(`[NetworkMonitor] 🚫 Blocking ${patterns.length} URL patterns`);
  }

  /**
   * Add custom headers to all requests.
   */
  async setCustomHeaders(page: any, headers: Record<string, string>): Promise<void> {
    this.customHeaders = { ...this.customHeaders, ...headers };
    await page.setExtraHTTPHeaders(this.customHeaders);
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
        const regex = new RegExp(filter.urlPattern, 'i');
        results = results.filter(r => regex.test(r.url));
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
    for (const [pattern, handler] of this.routeHandlers) {
      try {
        await page.unroute(pattern, handler);
      } catch {}
    }
    this.routeHandlers.clear();
    this.blockRules = [];
    this.blockedCount = 0;
  }
}

// ═══════════════════════════════════════
// GLOBAL SINGLETON
// ═══════════════════════════════════════
export const networkMonitor = new NetworkMonitor();
