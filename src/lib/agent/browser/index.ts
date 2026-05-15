/**
 * EterX Browser — Next-Gen Browser Control Module
 * 
 * Architecture:
 * ═══════════════════════════════════════
 * Layer 1: AI Agent (Gemini) — interprets requests, reads snapshots
 * Layer 2: Browser Tool — parses AI decisions, orchestrates actions
 * Layer 3: Engine + Snapshot + Session + Network — drives actual browser
 * Layer 4: Playwright + CDP — raw browser automation protocol
 * ═══════════════════════════════════════
 */

export { BrowserEngine, browserEngine } from './engine';
export type { ConnectionMode, LaunchOptions, PageInfo, ConsoleEntry, DownloadInfo } from './engine';

export { DOMSnapshot, domSnapshot } from './snapshot';
export type { ElementRef, FormInfo, SnapshotOptions, SnapshotResult } from './snapshot';

export { BrowserSessionManager, browserSessionManager } from './session';
export type { BrowserProfile, CookieData, SessionState } from './session';

export { NetworkMonitor, networkMonitor } from './network';
export type { NetworkRequest, NetworkBlockRule, NetworkStats } from './network';
