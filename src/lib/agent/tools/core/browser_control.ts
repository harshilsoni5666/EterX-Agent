import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';
import { browserEngine } from '../../browser/engine';
import { domSnapshot } from '../../browser/snapshot';
import { browserSessionManager } from '../../browser/session';
import { networkMonitor } from '../../browser/network';

// ═══════════════════════════════════════
// PATHS & CONSTANTS
// ═══════════════════════════════════════

const SCREENSHOTS_DIR = path.resolve(process.cwd(), '.workspaces', 'temp', 'screenshots');
const BROWSER_LOG = path.resolve(process.cwd(), '.workspaces', 'temp', 'browser_actions.log');
const PDF_DIR = path.resolve(process.cwd(), '.workspaces', 'temp', 'pdfs');
const BROWSER_VISUAL_BOOTSTRAP = `
(() => {
  try {
    globalThis.__name = globalThis.__name || function(fn) { return fn; };
    var root = document.documentElement || document.body;
    if (!root) return false;
    var version = '2026-05-12.2';
    if (window.__eterxExtensionOverlayReady) {
      window.__eterxVisualFeedbackReady = version + ':extension';
      return true;
    }
    var styleId = 'eterx-browser-control-style';
    if (window.__eterxVisualFeedbackReady !== version || !document.getElementById(styleId)) {
      window.__eterxVisualFeedbackReady = version;
      var oldStyle = document.getElementById(styleId);
      if (oldStyle) oldStyle.remove();
      var style = document.createElement('style');
      style.id = styleId;
      style.textContent = [
        '@property --eterx-frame-angle{syntax:"<angle>";initial-value:0deg;inherits:false}',
        '#eterx-control-frame{position:fixed;inset:0;pointer-events:none;z-index:2147483642;border:0;border-radius:0;background:transparent;box-shadow:inset 0 0 0 1px rgba(224,242,254,.28);opacity:0;transition:opacity 180ms ease}',
        '#eterx-control-frame.eterx-active{opacity:1}',
        '#eterx-control-frame.eterx-active:before{content:"";position:absolute;inset:0;padding:3px;border-radius:0;background:conic-gradient(from var(--eterx-frame-angle),transparent 0deg,transparent 54deg,rgba(96,165,250,.08) 84deg,#38bdf8 124deg,#dbeafe 176deg,#60a5fa 232deg,transparent 300deg,transparent 360deg);-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);mask-composite:exclude;animation:eterx-frame-spin 2.4s linear infinite}',
        '#eterx-control-frame.eterx-active:after{content:"";position:absolute;inset:0;box-shadow:inset 0 0 0 1px rgba(56,189,248,.24),inset 0 0 32px rgba(56,189,248,.06)}',
        '#eterx-control-hud{position:fixed;left:50%;bottom:18px;max-width:min(560px,calc(100vw - 28px));min-height:36px;transform:translateX(-50%) translateY(10px) scale(.98);display:flex;align-items:center;gap:9px;padding:5px 5px 5px 11px;border:1px solid rgba(255,255,255,.18);border-radius:8px;background:linear-gradient(180deg,rgba(12,12,12,.96),rgba(3,3,3,.94));color:#fff;box-shadow:0 18px 44px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.04),0 0 32px rgba(37,99,235,.18);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);pointer-events:auto;overflow:hidden;z-index:2147483647;opacity:0;transition:opacity 180ms ease,transform 180ms cubic-bezier(.2,.8,.2,1);font:720 12px/1.1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
        '#eterx-control-hud:before{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(90deg,transparent,rgba(56,189,248,.13),transparent);transform:translateX(-100%);animation:eterx-control-pill-sheen 2.8s ease-in-out infinite;pointer-events:none}',
        '#eterx-control-hud.eterx-active{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}',
        '.eterx-hud-dot{position:relative;z-index:1;width:8px;height:8px;border-radius:999px;background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.14);opacity:.95;flex:0 0 auto;animation:eterx-control-live-dot 1.4s ease-in-out infinite}',
        '.eterx-hud-body{position:relative;z-index:1;min-width:0;display:flex;flex-direction:column;gap:2px;flex:1 1 auto;max-width:340px}.eterx-hud-title,.eterx-hud-detail{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.eterx-hud-title{font-weight:760}.eterx-hud-detail{color:rgba(255,255,255,.74);font-size:11px;font-weight:620}.eterx-hud-actions{position:relative;z-index:1;display:flex;align-items:center;gap:5px;margin-left:4px}.eterx-hud-button{height:26px;padding:0 9px;border:0;border-radius:7px;background:rgba(255,255,255,.12);color:rgba(255,255,255,.94);cursor:pointer;font:760 11px/1 ui-sans-serif,system-ui,sans-serif}.eterx-hud-button:hover{background:rgba(255,255,255,.18)}.eterx-hud-button.stop{background:rgba(239,68,68,.95);color:#fff}.eterx-hud-button.stop:hover{background:rgba(220,38,38,.98)}',
        '#eterx-control-cursor{position:fixed;left:0;top:0;width:18px;height:22px;pointer-events:none;z-index:2147483647;opacity:0;transform:translate(-100px,-100px);transition:opacity 120ms ease,filter 130ms ease;will-change:transform,opacity;filter:drop-shadow(0 8px 12px rgba(0,0,0,.42))}',
        '#eterx-control-cursor.eterx-active{opacity:1}',
        '#eterx-control-cursor svg{display:block;width:18px;height:22px;transform-origin:4px 4px;transition:transform 90ms ease}',
        '#eterx-control-cursor.eterx-down{filter:drop-shadow(0 0 14px rgba(56,189,248,.70))}#eterx-control-cursor.eterx-down svg{transform:scale(.92)}',
        '.eterx-control-ring{position:fixed;width:18px;height:18px;border:3px solid rgba(103,232,249,.90);border-radius:999px;background:rgba(45,212,191,.12);pointer-events:none;z-index:2147483646;transform:translate(-50%,-50%);animation:eterx-control-pop 620ms ease-out forwards}',
        '.eterx-control-highlight{position:fixed;border:2px solid rgba(103,232,249,.72);border-radius:10px;box-shadow:0 0 0 3px rgba(103,232,249,.16),0 0 28px rgba(45,212,191,.22);pointer-events:none;z-index:2147483645;animation:eterx-control-fade 880ms ease-out forwards}',
        '.eterx-control-key,.eterx-control-scroll{position:fixed;pointer-events:none;z-index:2147483647;border:1px solid rgba(103,232,249,.34);background:rgba(250,250,248,.88);color:#243334;box-shadow:0 14px 36px rgba(15,23,42,.18),0 0 26px rgba(45,212,191,.18);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);font:750 12px/1 ui-sans-serif,system-ui,sans-serif}',
        '.eterx-control-key{left:50%;top:22px;transform:translateX(-50%);padding:8px 12px;border-radius:14px;animation:eterx-control-key 780ms ease-out forwards}',
        '.eterx-control-scroll{left:50%;top:50%;width:56px;height:56px;margin-left:-28px;margin-top:-28px;display:grid;place-items:center;border-radius:999px;font-size:22px;font-weight:850;animation:eterx-control-scroll 820ms ease-out forwards}',
        '.eterx-control-drag-line{position:fixed;height:3px;transform-origin:left center;border-radius:999px;background:linear-gradient(90deg,#38bdf8,rgba(37,99,235,.25));box-shadow:0 0 20px rgba(14,165,233,.42);pointer-events:none;z-index:2147483644;animation:eterx-control-fade 900ms ease-out forwards}',
        '.eterx-ref-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483643}.eterx-ref-box{position:fixed;border:2px solid rgba(56,189,248,.72);border-radius:8px;background:rgba(14,165,233,.035);box-shadow:0 0 0 1px rgba(2,132,199,.16),0 0 22px rgba(14,165,233,.16);animation:eterx-ref-in 160ms ease-out both}.eterx-ref-badge{position:absolute;left:-2px;top:-18px;min-width:22px;height:18px;padding:0 6px;display:flex;align-items:center;justify-content:center;border-radius:7px 7px 7px 0;background:#0284c7;color:#fff;box-shadow:0 8px 18px rgba(2,132,199,.32);font:800 10px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.eterx-ref-kind{position:absolute;right:-2px;bottom:-16px;max-width:110px;padding:3px 6px;border-radius:7px 0 7px 7px;background:rgba(2,6,23,.82);color:rgba(224,242,254,.86);border:1px solid rgba(56,189,248,.22);font:700 9px/1 ui-sans-serif,system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '@keyframes eterx-control-pop{0%{opacity:.95;width:18px;height:18px}100%{opacity:0;width:78px;height:78px}}@keyframes eterx-control-fade{0%,70%{opacity:1}100%{opacity:0}}@keyframes eterx-control-key{0%{opacity:0;transform:translateX(-50%) translateY(-8px) scale(.96)}16%,74%{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}100%{opacity:0;transform:translateX(-50%) translateY(-4px) scale(.98)}}@keyframes eterx-control-scroll{0%{opacity:0;transform:translateY(8px) scale(.9)}18%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0;transform:translateY(-22px) scale(1.08)}}@keyframes eterx-ref-in{0%{opacity:0;transform:scale(.985)}100%{opacity:1;transform:scale(1)}}@keyframes eterx-frame-spin{to{--eterx-frame-angle:360deg}}@keyframes eterx-control-pill-sheen{0%,38%{transform:translateX(-110%);opacity:0}48%{opacity:1}78%,100%{transform:translateX(110%);opacity:0}}@keyframes eterx-control-live-dot{0%,100%{transform:scale(1);box-shadow:0 0 0 4px rgba(34,197,94,.12)}50%{transform:scale(1.15);box-shadow:0 0 0 6px rgba(34,197,94,.05)}}'
      ].join('');
      root.appendChild(style);
    }
    function ensure(id, className, html) {
      var node = document.getElementById(id);
      if (!node) {
        node = document.createElement('div');
        node.id = id;
        if (className) node.className = className;
        if (html) node.innerHTML = html;
        root.appendChild(node);
      }
      return node;
    }
    var frame = ensure('eterx-control-frame', '', '');
    var hud = ensure('eterx-control-hud', '', '<span class="eterx-hud-dot"></span><span class="eterx-hud-body"><span class="eterx-hud-title">EterX is using Chrome</span><span class="eterx-hud-detail"></span></span><span class="eterx-hud-actions"><button class="eterx-hud-button" data-eterx-control="take" type="button">Take control</button><button class="eterx-hud-button stop" data-eterx-control="stop" type="button">Stop</button></span>');
    var cursor = ensure('eterx-control-cursor', '', '');
    if (!cursor.__eterxSvg) {
      cursor.__eterxSvg = true;
      cursor.innerHTML = '<svg width="18" height="22" viewBox="0 0 18 22" fill="none" aria-hidden="true"><path d="M2 1l14 7-5.5 2L8 17 2 1z" fill="#000000" stroke="#ffffff" stroke-width="1" stroke-linejoin="round"/></svg>';
    }
    if (!hud.__eterxButtonsBound) {
      hud.__eterxButtonsBound = true;
      hud.addEventListener('click', function(event) {
        var target = event.target && event.target.closest && event.target.closest('[data-eterx-control]');
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        if (target.getAttribute('data-eterx-control') === 'stop') {
          window.__eterxBrowserStopRequested = true;
          document.dispatchEvent(new CustomEvent('eterx-control-stop-requested'));
        } else {
          document.dispatchEvent(new CustomEvent('eterx-control-takeover'));
        }
        window.__eterxEndActivity();
      });
    }
    function setStatus(title, detail) {
      var titleEl = hud.querySelector('.eterx-hud-title');
      var detailEl = hud.querySelector('.eterx-hud-detail');
      if (titleEl) titleEl.textContent = String(title || 'EterX is using Chrome').slice(0, 90);
      if (detailEl) {
        detailEl.textContent = String(detail || '').slice(0, 160);
        detailEl.style.display = detail ? 'block' : 'none';
      }
    }
    function activate(ttl, persistent) {
      if (persistent) window.__eterxActivityActive = true;
      hud.classList.add('eterx-active');
      frame.classList.add('eterx-active');
      clearTimeout(window.__eterxHudTimer);
      if (window.__eterxActivityActive) return;
      window.__eterxHudTimer = setTimeout(function() {
        hud.classList.remove('eterx-active');
        frame.classList.remove('eterx-active');
        cursor.classList.remove('eterx-active');
      }, ttl || 2200);
    }
    window.__eterxStartActivity = function(title, detail) {
      window.__eterxBrowserStopRequested = false;
      setStatus(title, detail);
      activate(0, true);
    };
    window.__eterxEndActivity = function(delayMs) {
      window.__eterxActivityActive = false;
      clearTimeout(window.__eterxHudTimer);
      window.__eterxHudTimer = setTimeout(function() {
        if (!window.__eterxActivityActive) {
          hud.classList.remove('eterx-active');
          frame.classList.remove('eterx-active');
          cursor.classList.remove('eterx-active');
        }
      }, Math.max(0, Number(delayMs) || 180));
    };
    window.__eterxShowAction = function(title, detail, ttl) { setStatus(title, detail); activate(ttl || 2200); };
    window.__eterxCursorTarget = window.__eterxCursorTarget || { x: -100, y: -100 };
    window.__eterxCursorCurrent = window.__eterxCursorCurrent || { x: -100, y: -100 };
    function eterxCursorTick() {
      var target = window.__eterxCursorTarget;
      var current = window.__eterxCursorCurrent;
      current.x += (target.x - current.x) * 0.18;
      current.y += (target.y - current.y) * 0.18;
      cursor.style.transform = 'translate(' + (current.x - 2) + 'px,' + (current.y - 2) + 'px)';
      var distance = Math.hypot(target.x - current.x, target.y - current.y);
      if (cursor.classList.contains('eterx-active') || distance > .5) window.__eterxCursorRaf = requestAnimationFrame(eterxCursorTick);
      else window.__eterxCursorRaf = null;
    }
    window.__eterxMoveCursor = function(x, y) {
      window.__eterxCursorTarget = { x: Number(x) || 0, y: Number(y) || 0 };
      if (!cursor.classList.contains('eterx-active')) window.__eterxCursorCurrent = { x: window.__eterxCursorTarget.x, y: window.__eterxCursorTarget.y };
      cursor.classList.add('eterx-active');
      if (!window.__eterxCursorRaf) window.__eterxCursorRaf = requestAnimationFrame(eterxCursorTick);
      activate(1800);
    };
    window.__eterxSetMouseDown = function(down) { cursor.classList.toggle('eterx-down', !!down); activate(1800); };
    window.__eterxClickRing = function(x, y) {
      var ring = document.createElement('div');
      ring.className = 'eterx-control-ring';
      ring.style.left = x + 'px';
      ring.style.top = y + 'px';
      root.appendChild(ring);
      setTimeout(function() { ring.remove(); }, 760);
      activate(1800);
    };
    window.__eterxHighlightRect = function(rect) { activate(900); };
    window.__eterxKeyPulse = function(label) {
      var key = document.createElement('div');
      key.className = 'eterx-control-key';
      key.textContent = String(label || 'Typing').slice(0, 32);
      root.appendChild(key);
      setTimeout(function() { key.remove(); }, 900);
      activate(1800);
    };
    window.__eterxScrollPulse = function(dir) {
      var node = document.createElement('div');
      node.className = 'eterx-control-scroll';
      var d = String(dir || 'down').toLowerCase();
      node.textContent = d === 'up' ? '^' : d === 'left' ? '<' : d === 'right' ? '>' : 'v';
      root.appendChild(node);
      setTimeout(function() { node.remove(); }, 920);
      activate(1800);
    };
    window.__eterxDragLine = function(from, to) {
      var dx = to.x - from.x;
      var dy = to.y - from.y;
      var length = Math.max(1, Math.hypot(dx, dy));
      var line = document.createElement('div');
      line.className = 'eterx-control-drag-line';
      line.style.left = from.x + 'px';
      line.style.top = from.y + 'px';
      line.style.width = length + 'px';
      line.style.transform = 'rotate(' + Math.atan2(dy, dx) + 'rad)';
      root.appendChild(line);
      setTimeout(function() { line.remove(); }, 1000);
    };
    window.__eterxShowRefs = function(refs, ttl) {
      document.querySelectorAll('.eterx-ref-layer').forEach(function(node) { node.remove(); });
      setStatus('Reading page', ((refs && refs.length) || 0) + ' controls indexed');
      activate(Math.min(ttl || 1800, 5200));
      clearTimeout(window.__eterxRefTimer);
    };
    if (window.__eterxVisualEventBridge !== version) {
      window.__eterxVisualEventBridge = version;
      document.addEventListener('eterx-control-start', function(event) { var d = event.detail || {}; window.__eterxStartActivity(d.title || 'EterX is using Chrome', d.detail || ''); });
      document.addEventListener('eterx-control-end', function(event) { var d = event.detail || {}; window.__eterxEndActivity(d.delayMs); });
      document.addEventListener('eterx-control-action', function(event) { var d = event.detail || {}; window.__eterxShowAction(d.title, d.detail, d.ttl); });
      document.addEventListener('eterx-control-refs', function(event) { var d = event.detail || {}; window.__eterxShowRefs(d.refs || [], d.ttl || 1800); });
      document.addEventListener('eterx-control-cursor', function(event) { var d = event.detail || {}; window.__eterxMoveCursor(d.x, d.y); });
      document.addEventListener('eterx-control-mouse', function(event) { var d = event.detail || {}; window.__eterxSetMouseDown(!!d.down); });
      document.addEventListener('eterx-control-ring', function(event) { var d = event.detail || {}; window.__eterxClickRing(d.x, d.y); });
      document.addEventListener('eterx-control-focus', function(event) { var d = event.detail || {}; window.__eterxHighlightRect(d.rect); });
      document.addEventListener('eterx-control-key', function(event) { var d = event.detail || {}; window.__eterxKeyPulse(d.label); });
      document.addEventListener('eterx-control-scroll', function(event) { var d = event.detail || {}; window.__eterxScrollPulse(d.direction); });
      document.addEventListener('eterx-control-drag-line', function(event) { var d = event.detail || {}; window.__eterxDragLine(d.from, d.to); });
    }
    return true;
  } catch (err) {
    return false;
  }
})()
`;

// ═══════════════════════════════════════
// SEQUENTIAL EXECUTION LOCK (CRITICAL)
// ═══════════════════════════════════════
// Gemini can fire multiple browser_control calls in parallel (e.g. launch + goto).
// But browser actions MUST be sequential — you can't goto before launch finishes.
// This mutex ensures all calls queue up and execute one after another.

let _browserLock: Promise<void> = Promise.resolve();
let _lastBrowserCursor: { x: number; y: number } | null = null;
const _visualHookedPages = new WeakSet<any>();
let _browserVisualSessionActive = false;
let _browserVisualSessionPage: any = null;
let _browserVisualIdleTimer: ReturnType<typeof setTimeout> | null = null;
const BROWSER_VISUAL_IDLE_MS = 30000;

async function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  const acquired = new Promise<void>(resolve => { release = resolve; });
  const previousLock = _browserLock;
  _browserLock = acquired;
  
  // Wait for previous operation to finish
  await previousLock;
  
  try {
    return await fn();
  } finally {
    release!();
  }
}

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════

async function logAction(action: string, details: any): Promise<void> {
  try {
    await fs.ensureDir(path.dirname(BROWSER_LOG));
    const entry = `[${new Date().toISOString()}] ${action}: ${JSON.stringify(details)}\n`;
    await fs.appendFile(BROWSER_LOG, entry);
  } catch {}
}

async function takeScreenshot(page: any, label: string, fullPage: boolean = false): Promise<string> {
  try {
    await fs.ensureDir(SCREENSHOTS_DIR);
    const filePath = path.join(SCREENSHOTS_DIR, `browser_${label}_${Date.now()}.png`);
    await page.screenshot({ path: filePath, fullPage });
    return filePath;
  } catch { return ''; }
}

function fail(action: string, msg: string, recovery?: string, nextAction?: string) {
  return {
    success: false,
    action,
    result: msg,
    ...(recovery ? { recovery } : {}),
    ...(nextAction ? { nextAction } : {}),
  };
}

async function failWithPageState(page: any, action: string, msg: string, recovery: string, nextAction: string, input: any, startedAt: number) {
  domSnapshot.invalidate();
  let snapshotText: string | undefined;
  let currentUrl: string | undefined;
  let pageTitle: string | undefined;

  try {
    const snap = await withTimeout(
      domSnapshot.capture(page, {
        mode: input?.snapshotMode || 'interactive',
        maxElements: maxSnapshotElements(input || {}, 120),
        textMaxLength: 80,
      }),
      900,
      'failure recovery snapshot'
    );
    snapshotText = snap.snapshotText;
    currentUrl = snap.pageUrl;
    pageTitle = snap.pageTitle;
    if (input?.visualFeedback !== false) void showRefOverlay(page, snap.refs, 2600);
  } catch {
    try {
      currentUrl = page?.url?.();
      pageTitle = await page?.title?.().catch(() => '');
    } catch {}
  }

  return {
    success: false,
    action,
    result: msg,
    recovery,
    nextAction,
    snapshotText,
    currentUrl,
    pageTitle,
    elapsedMs: Date.now() - startedAt,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Smart element resolver — finds an element by ref, selector, or text.
 * Priority: ref > selector > text > coordinates
 * If ref is used, it tries data-ref first, then falls back to CSS path.
 */
async function resolveElement(page: any, input: any): Promise<any> {
  const resolveSelectorTarget = async (selector: string, index?: number) => {
    try {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (!count) return null;
      if (index != null) return locator.nth(index);

      const limit = Math.min(count, 12);
      for (let i = 0; i < limit; i++) {
        const candidate = locator.nth(i);
        const box = await candidate.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) return candidate;
      }
      return locator.first();
    } catch {
      return null;
    }
  };
  // 1. By ref number (most reliable — from snapshot)
  if (input.ref != null) {
    const elemInfo = domSnapshot.getRef(input.ref);
    if (elemInfo) {
      // Try data-ref selector first
      let el = await resolveSelectorTarget(elemInfo.selector);
      if (el) return el;
      
      // Fallback to CSS path
      if (elemInfo.cssPath) {
        el = await resolveSelectorTarget(elemInfo.cssPath);
        if (el) return el;
      }
    }
    // Last resort — try data-ref directly
    const el = await resolveSelectorTarget(`[data-ref="${input.ref}"]`);
    if (el) return el;
    
    throw new Error(`Element ref [${input.ref}] not found. Take a new snapshot.`);
  }
  
  // 2. By CSS selector
  if (input.selector) {
    const el = await resolveSelectorTarget(input.selector, input.index);
    if (el) return el;
    throw new Error(`Selector not found: ${input.selector}`);
  }
  
  // 3. By visible text
  if (input.text) {
    const text = String(input.text);
    const name = new RegExp(escapeRegExp(text), 'i');
    const tryLocator = async (locator: any) => {
      try {
        const count = await locator.count().catch(() => 0);
        if (!count) return null;
        const limit = Math.min(count, 12);
        for (let i = 0; i < limit; i++) {
          const candidate = locator.nth(i);
          const box = await candidate.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) return candidate;
        }
        return locator.first();
      } catch {}
      return null;
    };

    // Prefer actionable controls. Generic text often resolves to a label/span,
    // which looks correct in a snapshot but does not actually perform the action.
    const rolePriority = ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem', 'option'];
    for (const role of rolePriority) {
      const locator = await tryLocator(page.getByRole(role, { name }));
      if (locator) return locator;
    }

    for (const locatorFactory of [
      () => page.getByLabel(name),
      () => page.getByPlaceholder(name),
      () => page.getByTitle(name),
      () => page.getByTestId(text),
      () => page.locator('button, a, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]').filter({ hasText: name }),
      () => page.getByText(name),
    ]) {
      const locator = await tryLocator(locatorFactory());
      if (locator) return locator;
    }
    
    throw new Error(`Text not found: "${input.text}"`);
  }
  
  return null; // No targeting provided
}

/**
 * Smart wait after interaction — waits for page to settle. Optimized for speed.
 */
async function smartWait(page: any, action: string): Promise<void> {
  const heavyActions = ['click', 'press', 'submit'];
  const waitTime = heavyActions.includes(action) ? 300 : 100;
  
  try {
    await page.waitForLoadState('networkidle', { timeout: waitTime });
  } catch {
    // If network didn't idle in time, just continue — don't block
  }
}

async function installVisualFeedbackScript(page: any): Promise<boolean> {
  try {
    await withTimeout(
      page.evaluate('var __name = globalThis.__name = globalThis.__name || ((fn, name) => fn)').catch(() => {}),
      700,
      'visual shim'
    ).catch(() => {});
    const installed = await withTimeout(page.evaluate(BROWSER_VISUAL_BOOTSTRAP), 1000, 'visual bootstrap');
    return installed !== false;
  } catch {
    return false;
  }
}

async function installVisualFeedback(page: any): Promise<void> {
  if (await installVisualFeedbackScript(page)) return;
  try {
    await withTimeout(page.evaluate('var __name = globalThis.__name = globalThis.__name || ((fn, name) => fn)').catch(() => {}), 700, 'visual shim').catch(() => {});
    await withTimeout(page.evaluate(() => {
      const w = window as any;
      const version = '2026-05-12.2';
      if (w.__eterxExtensionOverlayReady) {
        document.getElementById('eterx-browser-control-style')?.remove();
        document.getElementById('eterx-control-frame')?.remove();
        document.getElementById('eterx-control-hud')?.remove();
        document.getElementById('eterx-control-cursor')?.remove();
        w.__eterxVisualFeedbackReady = `${version}:extension`;
        return;
      }
      if (w.__eterxVisualFeedbackReady === version) return;
      w.__eterxVisualFeedbackReady = version;

      document.getElementById('eterx-browser-control-style')?.remove();
      document.getElementById('eterx-control-frame')?.remove();
      document.getElementById('eterx-control-hud')?.remove();
      document.getElementById('eterx-control-cursor')?.remove();

      const style = document.createElement('style');
      style.id = 'eterx-browser-control-style';
      style.textContent = `
        @property --eterx-frame-angle {
          syntax: '<angle>';
          initial-value: 0deg;
          inherits: false;
        }
        #eterx-control-frame {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 2147483642;
          border: 0;
          border-radius: 0;
          background: transparent;
          box-shadow: inset 0 0 0 1px rgba(224, 242, 254, 0.28);
          opacity: 0;
          transition: opacity 220ms ease;
        }
        #eterx-control-frame.eterx-active {
          opacity: 1;
        }
        #eterx-control-frame.eterx-active::before {
          content: "";
          position: absolute;
          inset: 0;
          padding: 3px;
          border-radius: 0;
          background: conic-gradient(
            from var(--eterx-frame-angle),
            transparent 0deg,
            transparent 54deg,
            rgba(96, 165, 250, 0.08) 84deg,
            #38bdf8 124deg,
            #dbeafe 176deg,
            #60a5fa 232deg,
            transparent 300deg,
            transparent 360deg
          );
          -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          mask-composite: exclude;
          animation: eterx-frame-spin 2.4s linear infinite;
        }
        #eterx-control-frame.eterx-active::after {
          content: "";
          position: absolute;
          inset: 0;
          box-shadow:
            inset 0 0 0 1px rgba(56, 189, 248, 0.24),
            inset 0 0 32px rgba(56, 189, 248, 0.06);
        }
        #eterx-control-hud {
          position: fixed;
          left: 50%;
          bottom: 26px;
          max-width: min(430px, calc(100vw - 48px));
          transform: translateX(-50%) translateY(8px) scale(0.98);
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 11px 16px;
          border: 1px solid rgba(255, 255, 255, 0.20);
          border-radius: 13px;
          background: rgba(47, 47, 47, 0.74);
          color: #fff;
          box-shadow: 0 18px 42px rgba(0, 0, 0, 0.24), 0 0 30px rgba(20, 184, 166, 0.14);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          pointer-events: none;
          z-index: 2147483647;
          opacity: 0;
          transition: opacity 180ms ease, transform 180ms cubic-bezier(.2,.8,.2,1);
          font: 750 14px/1.15 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        #eterx-control-hud.eterx-active {
          opacity: 1;
          transform: translateX(-50%) translateY(0) scale(1);
        }
        .eterx-hud-dot {
          width: 13px;
          height: 14px;
          border-radius: 2px;
          background: linear-gradient(90deg, #fff 0 34%, transparent 34% 66%, #fff 66%);
          opacity: .95;
          flex: 0 0 auto;
        }
        .eterx-hud-body {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 1px;
        }
        .eterx-hud-title {
          color: #fff;
          font-weight: 700;
          letter-spacing: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .eterx-hud-detail {
          display: none;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .eterx-control-cursor {
          position: fixed;
          left: 0;
          top: 0;
          width: 18px;
          height: 22px;
          pointer-events: none;
          z-index: 2147483647;
          opacity: 0;
          transform: translate(-100px, -100px);
          transition: opacity 120ms ease, filter 130ms ease;
          will-change: transform, opacity;
          filter: drop-shadow(0 8px 12px rgba(0, 0, 0, 0.42));
        }
        .eterx-control-cursor.eterx-active {
          opacity: 1;
        }
        .eterx-control-cursor svg {
          display: block;
          width: 18px;
          height: 22px;
          transform-origin: 4px 4px;
          transition: transform 90ms ease;
        }
        .eterx-control-cursor.eterx-down {
          filter: drop-shadow(0 0 14px rgba(56, 189, 248, 0.70));
        }
        .eterx-control-cursor.eterx-down svg {
          transform: scale(0.92);
        }
        .eterx-control-ring {
          position: fixed;
          width: 12px;
          height: 12px;
          border: 3px solid #2563eb;
          border-radius: 999px;
          background: rgba(37, 99, 235, 0.12);
          pointer-events: none;
          z-index: 2147483646;
          transform: translate(-50%, -50%);
          animation: eterx-control-pop 520ms ease-out forwards;
        }
        .eterx-control-highlight {
          position: fixed;
          border: 3px solid #2563eb;
          border-radius: 8px;
          background: rgba(37, 99, 235, 0.08);
          box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.16);
          pointer-events: none;
          z-index: 2147483645;
          animation: eterx-control-fade 900ms ease-out forwards;
        }
        .eterx-control-key {
          position: fixed;
          left: 50%;
          top: 22px;
          transform: translateX(-50%);
          padding: 7px 11px;
          border: 1px solid rgba(56, 189, 248, 0.35);
          border-radius: 10px;
          background: rgba(2, 6, 23, 0.76);
          color: #e0f2fe;
          box-shadow: 0 12px 34px rgba(2, 6, 23, 0.28), 0 0 22px rgba(14, 165, 233, 0.14);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          pointer-events: none;
          z-index: 2147483647;
          font: 700 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          animation: eterx-control-key 720ms ease-out forwards;
        }
        .eterx-control-scroll {
          position: fixed;
          left: 50%;
          top: 50%;
          width: 54px;
          height: 54px;
          margin-left: -27px;
          margin-top: -27px;
          border-radius: 50%;
          border: 2px solid rgba(56, 189, 248, 0.7);
          background: rgba(14, 165, 233, 0.12);
          color: #e0f2fe;
          display: grid;
          place-items: center;
          pointer-events: none;
          z-index: 2147483646;
          font: 800 22px/1 ui-sans-serif, system-ui, sans-serif;
          animation: eterx-control-scroll 760ms ease-out forwards;
        }
        .eterx-control-drag-line {
          position: fixed;
          height: 3px;
          transform-origin: left center;
          border-radius: 999px;
          background: linear-gradient(90deg, #38bdf8, rgba(37, 99, 235, 0.25));
          box-shadow: 0 0 20px rgba(14, 165, 233, 0.42);
          pointer-events: none;
          z-index: 2147483644;
          animation: eterx-control-fade 900ms ease-out forwards;
        }
        .eterx-ref-layer {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 2147483643;
        }
        .eterx-ref-box {
          position: fixed;
          border: 2px solid rgba(56, 189, 248, 0.72);
          border-radius: 8px;
          background: rgba(14, 165, 233, 0.035);
          box-shadow: 0 0 0 1px rgba(2, 132, 199, 0.16), 0 0 22px rgba(14, 165, 233, 0.16);
          animation: eterx-ref-in 180ms ease-out both;
        }
        .eterx-ref-badge {
          position: absolute;
          left: -2px;
          top: -18px;
          min-width: 22px;
          height: 18px;
          padding: 0 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 7px 7px 7px 0;
          background: #0284c7;
          color: white;
          box-shadow: 0 8px 18px rgba(2, 132, 199, 0.32);
          font: 800 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        .eterx-ref-kind {
          position: absolute;
          right: -2px;
          bottom: -16px;
          max-width: 110px;
          padding: 3px 6px;
          border-radius: 7px 0 7px 7px;
          background: rgba(2, 6, 23, 0.82);
          color: rgba(224, 242, 254, 0.86);
          border: 1px solid rgba(56, 189, 248, 0.22);
          font: 700 9px/1 ui-sans-serif, system-ui, sans-serif;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        @keyframes eterx-control-pulse {
          0% { box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.55); }
          100% { box-shadow: 0 0 0 12px rgba(56, 189, 248, 0); }
        }
        @keyframes eterx-control-pop {
          0% { opacity: 0.95; width: 12px; height: 12px; }
          100% { opacity: 0; width: 64px; height: 64px; }
        }
        @keyframes eterx-control-fade {
          0% { opacity: 1; }
          70% { opacity: 1; }
          100% { opacity: 0; }
        }
        @keyframes eterx-control-key {
          0% { opacity: 0; transform: translateX(-50%) translateY(-8px) scale(0.96); }
          18% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
          76% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
          100% { opacity: 0; transform: translateX(-50%) translateY(-4px) scale(0.98); }
        }
        @keyframes eterx-control-scroll {
          0% { opacity: 0; transform: translateY(8px) scale(0.9); }
          18% { opacity: 1; transform: translateY(0) scale(1); }
          100% { opacity: 0; transform: translateY(-20px) scale(1.08); }
        }
        @keyframes eterx-ref-in {
          0% { opacity: 0; transform: scale(0.985); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes eterx-frame-spin {
          to { --eterx-frame-angle: 360deg; }
        }
      `;
      document.documentElement.appendChild(style);

      const frame = document.createElement('div');
      frame.id = 'eterx-control-frame';
      document.documentElement.appendChild(frame);

      const hud = document.createElement('div');
      hud.id = 'eterx-control-hud';
      hud.innerHTML = '<span class="eterx-hud-dot"></span><span class="eterx-hud-body"><span class="eterx-hud-title">Pause EterX Assistant</span><span class="eterx-hud-detail">Chrome control active</span></span>';
      document.documentElement.appendChild(hud);

      w.__eterxControlCursor = document.createElement('div');
      w.__eterxControlCursor.id = 'eterx-control-cursor';
      w.__eterxControlCursor.className = 'eterx-control-cursor';
      w.__eterxControlCursor.innerHTML = '<svg width="18" height="22" viewBox="0 0 18 22" fill="none" aria-hidden="true"><path d="M2 1l14 7-5.5 2L8 17 2 1z" fill="#000000" stroke="#ffffff" stroke-width="1" stroke-linejoin="round"/></svg>';
      document.documentElement.appendChild(w.__eterxControlCursor);

      w.__eterxMoveCursor = (x: number, y: number) => {
        w.__eterxCursorTarget = { x: Number(x) || 0, y: Number(y) || 0 };
        if (!w.__eterxControlCursor.classList.contains('eterx-active')) {
          w.__eterxCursorCurrent = { ...w.__eterxCursorTarget };
        }
        w.__eterxControlCursor.classList.add('eterx-active');
        if (!w.__eterxCursorRaf) {
          const tick = () => {
            const target = w.__eterxCursorTarget || { x: -100, y: -100 };
            const current = w.__eterxCursorCurrent || { x: target.x, y: target.y };
            current.x += (target.x - current.x) * 0.18;
            current.y += (target.y - current.y) * 0.18;
            w.__eterxCursorCurrent = current;
            w.__eterxControlCursor.style.transform = `translate(${current.x - 2}px, ${current.y - 2}px)`;
            const distance = Math.hypot(target.x - current.x, target.y - current.y);
            if (w.__eterxControlCursor.classList.contains('eterx-active') || distance > 0.5) {
              w.__eterxCursorRaf = requestAnimationFrame(tick);
            } else {
              w.__eterxCursorRaf = null;
            }
          };
          w.__eterxCursorRaf = requestAnimationFrame(tick);
        }
      };
      w.__eterxSetMouseDown = (isDown: boolean) => {
        w.__eterxControlCursor.classList.toggle('eterx-down', !!isDown);
      };
      w.__eterxShowAction = (title: string, detail?: string) => {
        const safeTitle = String(title || 'Pause EterX Assistant').slice(0, 90);
        const safeDetail = String(detail || 'Chrome control active').slice(0, 180);
        const titleEl = hud.querySelector('.eterx-hud-title');
        const detailEl = hud.querySelector('.eterx-hud-detail');
        if (titleEl) titleEl.textContent = safeTitle;
        if (detailEl) detailEl.textContent = safeDetail;
        hud.classList.add('eterx-active');
        frame.classList.add('eterx-active');
        clearTimeout(w.__eterxHudTimer);
        if (w.__eterxActivityActive) return;
        w.__eterxHudTimer = setTimeout(() => {
          hud.classList.remove('eterx-active');
          frame.classList.remove('eterx-active');
          w.__eterxControlCursor.classList.remove('eterx-active');
        }, 2200);
      };
      w.__eterxStartActivity = (title: string, detail?: string) => {
        w.__eterxActivityActive = true;
        w.__eterxShowAction?.(title || 'EterX is using Chrome', detail || 'Chrome control active');
      };
      w.__eterxEndActivity = (delayMs = 180) => {
        w.__eterxActivityActive = false;
        clearTimeout(w.__eterxHudTimer);
        w.__eterxHudTimer = setTimeout(() => {
          if (!w.__eterxActivityActive) {
            hud.classList.remove('eterx-active');
            frame.classList.remove('eterx-active');
            w.__eterxControlCursor.classList.remove('eterx-active');
          }
        }, Math.max(0, Number(delayMs) || 180));
      };
      w.__eterxClickRing = (x: number, y: number) => {
        const ring = document.createElement('div');
        ring.className = 'eterx-control-ring';
        ring.style.left = `${x}px`;
        ring.style.top = `${y}px`;
        document.documentElement.appendChild(ring);
        setTimeout(() => ring.remove(), 700);
      };
      w.__eterxHighlightRect = (rect: { x: number; y: number; width: number; height: number }) => {
        const box = document.createElement('div');
        box.className = 'eterx-control-highlight';
        box.style.left = `${Math.max(0, rect.x - 4)}px`;
        box.style.top = `${Math.max(0, rect.y - 4)}px`;
        box.style.width = `${Math.max(8, rect.width + 8)}px`;
        box.style.height = `${Math.max(8, rect.height + 8)}px`;
        document.documentElement.appendChild(box);
        setTimeout(() => box.remove(), 1000);
      };
      w.__eterxKeyPulse = (label: string) => {
        const key = document.createElement('div');
        key.className = 'eterx-control-key';
        key.textContent = String(label || 'Key').slice(0, 32);
        document.documentElement.appendChild(key);
        setTimeout(() => key.remove(), 820);
      };
      w.__eterxScrollPulse = (direction: string) => {
        const pulse = document.createElement('div');
        pulse.className = 'eterx-control-scroll';
        const dir = String(direction || 'down').toLowerCase();
        pulse.textContent = dir === 'up' ? '↑' : dir === 'left' ? '←' : dir === 'right' ? '→' : '↓';
        document.documentElement.appendChild(pulse);
        setTimeout(() => pulse.remove(), 850);
      };
      w.__eterxDragLine = (from: { x: number; y: number }, to: { x: number; y: number }) => {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.max(1, Math.hypot(dx, dy));
        const line = document.createElement('div');
        line.className = 'eterx-control-drag-line';
        line.style.left = `${from.x}px`;
        line.style.top = `${from.y}px`;
        line.style.width = `${length}px`;
        line.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
        document.documentElement.appendChild(line);
        setTimeout(() => line.remove(), 1000);
      };
      w.__eterxShowRefs = (refs: Array<{ ref: number; x: number; y: number; w: number; h: number; kind: string }>, ttl = 4500) => {
        document.querySelectorAll('.eterx-ref-layer').forEach((node) => node.remove());
        w.__eterxShowAction?.('Reading page', 'Chrome control active');
        clearTimeout(w.__eterxRefTimer);
        w.__eterxRefTimer = setTimeout(() => {
          if (!w.__eterxActivityActive) {
            hud.classList.remove('eterx-active');
            frame.classList.remove('eterx-active');
          }
        }, ttl);
      };

      if (w.__eterxVisualEventBridge !== version) {
        w.__eterxVisualEventBridge = version;
        document.addEventListener('eterx-control-start', (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          w.__eterxStartActivity?.(detail.title, detail.detail);
        });
        document.addEventListener('eterx-control-end', (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          w.__eterxEndActivity?.(detail.delayMs);
        });
        document.addEventListener('eterx-control-action', (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          w.__eterxShowAction?.(detail.title, detail.detail);
        });
        document.addEventListener('eterx-control-refs', (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          w.__eterxShowRefs?.(detail.refs || [], Math.min(detail.ttl || 1800, 2400));
        });
        document.addEventListener('eterx-control-cursor', (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          w.__eterxMoveCursor?.(detail.x, detail.y);
          w.__eterxShowAction?.('Moving cursor', 'Chrome control active');
        });
        document.addEventListener('eterx-control-mouse', (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          w.__eterxSetMouseDown?.(!!detail.down);
          w.__eterxShowAction?.('Mouse action', 'Chrome control active');
        });
        document.addEventListener('eterx-control-ring', (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          w.__eterxClickRing?.(detail.x, detail.y);
          w.__eterxShowAction?.('Clicking', 'Chrome control active');
        });
        document.addEventListener('eterx-control-focus', (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          w.__eterxHighlightRect?.(detail.rect);
          w.__eterxShowAction?.('Focusing', 'Chrome control active');
        });
        document.addEventListener('eterx-control-key', (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          w.__eterxKeyPulse?.(detail.label);
          w.__eterxShowAction?.('Typing', 'Chrome control active');
        });
        document.addEventListener('eterx-control-scroll', (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          w.__eterxScrollPulse?.(detail.direction);
          w.__eterxShowAction?.('Scrolling', 'Chrome control active');
        });
        document.addEventListener('eterx-control-drag-line', (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          w.__eterxDragLine?.(detail.from, detail.to);
          w.__eterxShowAction?.('Dragging', 'Chrome control active');
        });
      }
    }), 1200, 'visual feedback');
  } catch {}
}

function ensureVisualHooks(page: any): void {
  try {
    if (!page || _visualHookedPages.has(page)) return;
    _visualHookedPages.add(page);
    const reinstall = async () => {
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});
        await installVisualFeedback(page);
      } catch {}
    };
    page.on('domcontentloaded', reinstall);
    page.on('load', reinstall);
    page.on('framenavigated', (frame: any) => {
      try {
        if (frame === page.mainFrame()) reinstall();
      } catch {}
    });
    void reinstall();
  } catch {}
}

function visualDetail(input: any, action: string): string {
  if (action === 'ask_user_browser') return String(input.promptMessage || input.question || input.text || 'Waiting for your response').substring(0, 90);
  if (action === 'start_browser_session') return 'Browser session started';
  if (action === 'end_browser_session') return 'Browser session complete';
  if (input.ref != null) return `ref [${input.ref}]`;
  if (input.selector) return input.selector;
  if (input.url) return input.url;
  if (input.key) return input.key;
  if (input.text && ['type', 'fill'].includes(action)) return `${String(input.text).length} characters`;
  if (input.text) return String(input.text).substring(0, 90);
  if (input.x != null && input.y != null) return `${input.x}, ${input.y}`;
  return 'Chrome';
}

function visualTitle(action: string): string {
  const titleMap: Record<string, string> = {
    launch: 'Opening Chrome',
    connect: 'Connecting to Chrome',
    start_browser_session: 'Starting browser session',
    end_browser_session: 'Ending browser session',
    goto: 'Navigating',
    back: 'Going back',
    forward: 'Going forward',
    reload: 'Reloading page',
    observe: 'Observing page',
    snapshot: 'Reading page',
    show_refs: 'Showing clickable refs',
    screenshot: 'Capturing screenshot',
    click: 'Clicking',
    dblclick: 'Double clicking',
    type: 'Typing',
    fill: 'Filling field',
    clear: 'Clearing field',
    select: 'Selecting option',
    check: 'Checking option',
    uncheck: 'Unchecking option',
    hover: 'Hovering',
    focus: 'Focusing field',
    press: 'Pressing key',
    mouse_move: 'Moving cursor',
    mouse_down: 'Holding mouse',
    mouse_up: 'Releasing mouse',
    drag_drop: 'Dragging item',
    scroll: 'Scrolling',
    scroll_to: 'Scrolling to target',
    new_tab: 'Opening tab',
    switch_or_open_tab: 'Opening tab',
    switch_tab: 'Switching tab',
    close_tab: 'Closing tab',
    wait: 'Waiting',
    wait_for: 'Waiting for page',
    ask_user_browser: 'Waiting for user',
    upload: 'Uploading file',
    pdf: 'Saving PDF',
  };
  return titleMap[action] || `Chrome ${action.replace(/_/g, ' ')}`;
}

function maxSnapshotElements(input: any, fallback: number): number {
  const requested = Number(input.maxElements || fallback);
  if (!Number.isFinite(requested)) return fallback;
  return Math.max(30, Math.min(Math.round(requested), 500));
}

function actionTimeout(input: any, fallback: number, cap: number): number {
  const requested = Number(input?.timeout || fallback);
  if (!Number.isFinite(requested)) return fallback;
  return Math.max(500, Math.min(Math.round(requested), cap));
}

function normalizeBrowserUrl(value: string): string {
  let url = String(value || '').trim();
  if (!url) return url;
  if (!url.startsWith('http') && !url.startsWith('file:') && !url.startsWith('data:')) {
    url = url.includes('.') ? `https://${url}` : `https://www.google.com/search?q=${encodeURIComponent(url)}`;
  }
  return url;
}

function visualBubbleLabel(action: string, input: any): string {
  const fromInput = normalizeBubbleLabel(input?.visualLabel || input?.bubbleLabel || input?.bubble || input?.label);
  if (fromInput) return fromInput;

  const labels: Record<string, string> = {
    launch: 'Opening Chrome',
    connect: 'Connecting Chrome',
    start_browser_session: 'Starting browser',
    end_browser_session: 'Finished browser',
    goto: 'Opening site',
    back: 'Going back',
    forward: 'Going forward',
    reload: 'Reloading page',
    observe: 'Reading page',
    snapshot: 'Reading page',
    read_page: 'Reading page',
    show_refs: 'Finding controls',
    get_text: 'Reading text',
    get_html: 'Reading HTML',
    click: 'Clicking item',
    dblclick: 'Double clicking',
    type: 'Typing text',
    fill: 'Filling field',
    clear: 'Clearing field',
    select: 'Selecting option',
    check: 'Checking box',
    uncheck: 'Unchecking box',
    hover: 'Hovering item',
    focus: 'Focusing field',
    press: 'Pressing key',
    mouse_move: 'Moving cursor',
    mouse_down: 'Holding mouse',
    mouse_up: 'Releasing mouse',
    drag_drop: 'Dragging item',
    scroll: 'Scrolling page',
    scroll_to: 'Scrolling target',
    new_tab: 'Opening tab',
    switch_or_open_tab: 'Opening tab',
    switch_tab: 'Switching tab',
    close_tab: 'Closing tab',
    list_tabs: 'Checking tabs',
    wait: 'Waiting page',
    wait_for: 'Waiting page',
    evaluate: 'Running script',
    upload: 'Uploading file',
    pdf: 'Saving PDF',
    get_console: 'Reading console',
    clear_console: 'Clearing console',
    monitor_network: 'Watching network',
    get_requests: 'Reading requests',
    network_stats: 'Checking network',
    ask_user_browser: 'Waiting for user',
  };
  return labels[action] || normalizeBubbleLabel(action.replace(/_/g, ' ')) || 'Using Chrome';
}

function normalizeBubbleLabel(value: any): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const marker = raw.match(
    /\[\s*bubble\s*:\s*([^\]]+)\]|\{\{\s*bubble\s*:\s*([^}]+)\}\}|::bubble\{\s*([^}]+?)\s*\}|<bubble>\s*([^<]+?)\s*<\/bubble>/i
  );
  const source = String((marker && (marker[1] || marker[2] || marker[3] || marker[4])) || raw)
    .replace(/^EterX is\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return source.slice(0, 56);
}

async function showBrowserAction(page: any, action: string, input: any): Promise<void> {
  try {
    await installVisualFeedback(page);
    const payload = JSON.stringify({
      title: visualTitle(action),
      detail: visualDetail(input, action),
      bubble: visualBubbleLabel(action, input),
      theme: input.visualPalette,
    });
    await withTimeout(page.evaluate(`(() => {
      const payload = ${payload};
      document.dispatchEvent(new CustomEvent('eterx-control-start', { detail: payload }));
      document.dispatchEvent(new CustomEvent('eterx-control-action', { detail: payload }));
    })()`), 450, 'visual action');
    _browserVisualSessionActive = true;
    _browserVisualSessionPage = page;
    if (_browserVisualIdleTimer) {
      clearTimeout(_browserVisualIdleTimer);
      _browserVisualIdleTimer = null;
    }
  } catch {}
}

function scheduleBrowserActivityIdleEnd(page: any): void {
  if (!page || !_browserVisualSessionActive) return;
  if (_browserVisualIdleTimer) clearTimeout(_browserVisualIdleTimer);
  _browserVisualSessionPage = page;
  _browserVisualIdleTimer = setTimeout(() => {
    const target = _browserVisualSessionPage;
    _browserVisualIdleTimer = null;
    if (target && _browserVisualSessionActive) {
      void endBrowserActivity(target, 0);
    }
  }, BROWSER_VISUAL_IDLE_MS);
}

async function endBrowserActivity(page: any, delayMs = 0): Promise<void> {
  if (_browserVisualIdleTimer) {
    clearTimeout(_browserVisualIdleTimer);
    _browserVisualIdleTimer = null;
  }
  _browserVisualSessionActive = false;
  _browserVisualSessionPage = null;
  try {
    await withTimeout(page.evaluate(`(() => {
      document.dispatchEvent(new CustomEvent('eterx-control-end', { detail: { at: Date.now(), delayMs: ${Math.max(0, Math.round(delayMs))} } }));
    })()`), 350, 'visual end');
  } catch {}
}

async function askUserInBrowser(page: any, input: any): Promise<any> {
  await installVisualFeedback(page);
  const rawOptions = Array.isArray(input.options) ? input.options : (Array.isArray(input.choices) ? input.choices : []);
  const options = rawOptions
    .map((item: any) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const mode = input.responseMode || (options.length ? 'multiple_choice' : 'done_cancel');
  const question = input.question || input.promptMessage || input.text || 'Please confirm before I continue.';
  const payload = {
    title: input.promptTitle || input.title || (mode === 'short_answer' ? 'Need your answer' : 'Need your confirmation'),
    message: input.promptMessage || question,
    question,
    mode,
    options,
    doneLabel: input.doneLabel,
    cancelLabel: input.cancelLabel,
    yesLabel: input.yesLabel,
    noLabel: input.noLabel,
    submitLabel: input.submitLabel,
    placeholder: input.placeholder,
    defaultAnswer: input.defaultAnswer,
    bubble: visualBubbleLabel('ask_user_browser', input),
    theme: input.visualPalette,
  };
  const timeout = actionTimeout(input, 300000, 1800000);

  return withTimeout(page.evaluate(({ payload, timeout }: { payload: any; timeout: number }) => {
    return new Promise((resolve) => {
      let finished = false;
      let timer: any = null;
      let fallback: HTMLElement | null = null;

      const finish = (detail: any) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        document.removeEventListener('eterx-control-user-response', onResponse as EventListener);
        if (fallback) fallback.remove();
        resolve(detail || {});
      };

      const onResponse = (event: any) => finish(event.detail || {});

      const button = (label: string, onClick: () => void, primary = false) => {
        const node = document.createElement('button');
        node.type = 'button';
        node.textContent = label;
        node.style.cssText = [
          'height:30px',
          'padding:0 12px',
          'border:0',
          'border-radius:8px',
          'cursor:pointer',
          'white-space:nowrap',
          'font:760 12px/1 ui-sans-serif,system-ui,sans-serif',
          primary ? 'background:#fff;color:#080808' : 'background:rgba(255,255,255,.12);color:#fff',
        ].join(';');
        node.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick();
        });
        return node;
      };

      const showFallback = () => {
        if ((window as any).__eterxExtensionOverlayReady) return;
        const root = document.documentElement || document.body;
        if (!root) return;
        document.getElementById('eterx-browser-question-fallback')?.remove();
        fallback = document.createElement('div');
        fallback.id = 'eterx-browser-question-fallback';
        fallback.style.cssText = [
          'position:fixed',
          'left:50%',
          'bottom:18px',
          'z-index:2147483647',
          'transform:translateX(-50%)',
          'width:min(560px,calc(100vw - 28px))',
          'box-sizing:border-box',
          'display:flex',
          'flex-wrap:wrap',
          'align-items:center',
          'gap:9px',
          'padding:10px',
          'border:1px solid rgba(255,255,255,.18)',
          'border-radius:8px',
          'background:linear-gradient(180deg,rgba(12,12,12,.97),rgba(3,3,3,.95))',
          'color:#fff',
          'box-shadow:0 20px 52px rgba(0,0,0,.46),0 0 42px rgba(56,189,248,.20)',
          'font:720 12px/1.15 ui-sans-serif,system-ui,sans-serif',
        ].join(';');

        const dot = document.createElement('span');
        dot.style.cssText = 'width:8px;height:8px;border-radius:999px;background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.14);flex:0 0 auto';
        const text = document.createElement('span');
        text.style.cssText = 'min-width:0;flex:1 1 260px;display:flex;flex-direction:column;gap:3px';
        const title = document.createElement('span');
        title.textContent = String(payload.title || 'Need your confirmation').slice(0, 80);
        title.style.cssText = 'font-weight:760;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        const message = document.createElement('span');
        message.textContent = String(payload.message || payload.question || '').slice(0, 180);
        message.style.cssText = 'color:rgba(255,255,255,.72);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        text.append(title, message);
        fallback.append(dot, text);

        const actions = document.createElement('span');
        actions.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';
        const mode = String(payload.mode || 'done_cancel').toLowerCase();
        const choices = Array.isArray(payload.options) ? payload.options : [];

        if (mode === 'multiple_choice' && choices.length) {
          choices.slice(0, 8).forEach((choice: string, index: number) => {
            actions.appendChild(button(String(choice).slice(0, 60), () => finish({ choice: 'option', option: choice, value: choice, index, at: Date.now() })));
          });
          actions.appendChild(button(String(payload.cancelLabel || 'Cancel'), () => finish({ choice: 'cancel', cancelled: true, at: Date.now() })));
        } else if (mode === 'short_answer') {
          const input = document.createElement('input');
          input.type = 'text';
          input.placeholder = String(payload.placeholder || 'Type a short answer').slice(0, 70);
          input.value = payload.defaultAnswer ? String(payload.defaultAnswer).slice(0, 240) : '';
          input.style.cssText = 'height:30px;min-width:150px;flex:1 1 180px;padding:0 10px;border:1px solid rgba(255,255,255,.16);border-radius:8px;outline:0;background:rgba(255,255,255,.09);color:#fff;font:650 12px/1 ui-sans-serif,system-ui,sans-serif';
          input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') finish({ choice: 'answer', answer: input.value.trim(), value: input.value.trim(), at: Date.now() });
            if (event.key === 'Escape') finish({ choice: 'cancel', cancelled: true, at: Date.now() });
          });
          fallback.appendChild(input);
          actions.appendChild(button(String(payload.submitLabel || 'Submit'), () => finish({ choice: 'answer', answer: input.value.trim(), value: input.value.trim(), at: Date.now() }), true));
          actions.appendChild(button(String(payload.cancelLabel || 'Cancel'), () => finish({ choice: 'cancel', cancelled: true, at: Date.now() })));
          setTimeout(() => input.focus({ preventScroll: true }), 30);
        } else if (mode === 'yes_no') {
          actions.appendChild(button(String(payload.yesLabel || 'Yes'), () => finish({ choice: 'yes', value: true, at: Date.now() }), true));
          actions.appendChild(button(String(payload.noLabel || 'No'), () => finish({ choice: 'no', value: false, at: Date.now() })));
        } else {
          actions.appendChild(button(String(payload.doneLabel || 'Done'), () => finish({ choice: 'done', at: Date.now() }), true));
          actions.appendChild(button(String(payload.cancelLabel || 'Cancel'), () => finish({ choice: 'cancel', cancelled: true, at: Date.now() })));
        }

        fallback.appendChild(actions);
        root.appendChild(fallback);
      };

      document.addEventListener('eterx-control-user-response', onResponse as EventListener);
      document.dispatchEvent(new CustomEvent('eterx-control-user-prompt', { detail: payload }));
      showFallback();
      timer = setTimeout(() => finish({ choice: 'timeout', cancelled: true, timedOut: true, at: Date.now() }), timeout);
    });
  }, { payload, timeout }), timeout + 1000, 'browser user prompt');
}

async function showCursor(page: any, x: number, y: number): Promise<void> {
  try {
    const payload = JSON.stringify({ x, y });
    await withTimeout(page.evaluate(`(() => {
      document.dispatchEvent(new CustomEvent('eterx-control-cursor', { detail: ${payload} }));
    })()`), 700, 'visual cursor');
  } catch {}
}

async function showClickRing(page: any, x: number, y: number): Promise<void> {
  try {
    const payload = JSON.stringify({ x, y });
    await withTimeout(page.evaluate(`(() => {
      document.dispatchEvent(new CustomEvent('eterx-control-ring', { detail: ${payload} }));
    })()`), 700, 'visual click');
  } catch {}
}

async function showMouseDown(page: any, down: boolean): Promise<void> {
  try {
    const payload = JSON.stringify({ down });
    await withTimeout(page.evaluate(`(() => {
      document.dispatchEvent(new CustomEvent('eterx-control-mouse', { detail: ${payload} }));
    })()`), 700, 'visual mouse');
  } catch {}
}

async function showKeyPulse(page: any, label: string): Promise<void> {
  try {
    const payload = JSON.stringify({ label });
    await withTimeout(page.evaluate(`(() => {
      document.dispatchEvent(new CustomEvent('eterx-control-key', { detail: ${payload} }));
    })()`), 700, 'visual key');
  } catch {}
}

async function showScrollPulse(page: any, direction: string): Promise<void> {
  try {
    const payload = JSON.stringify({ direction });
    await withTimeout(page.evaluate(`(() => {
      document.dispatchEvent(new CustomEvent('eterx-control-scroll', { detail: ${payload} }));
    })()`), 700, 'visual scroll');
  } catch {}
}

async function showDragLine(page: any, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  try {
    const payload = JSON.stringify({ from, to });
    await withTimeout(page.evaluate(`(() => {
      const payload = ${payload};
      document.dispatchEvent(new CustomEvent('eterx-control-drag-line', { detail: payload }));
      globalThis.__eterxDragLine?.(payload.from, payload.to);
    })()`), 700, 'visual drag');
  } catch {}
}

async function showRefOverlay(page: any, refs: Map<number, any>, ttl = 4500): Promise<void> {
  try {
    const refPayload = Array.from(refs.values())
      .filter((item: any) => item?.isVisible !== false && item?.bbox && item.bbox.w > 0 && item.bbox.h > 0)
      .slice(0, 80)
      .map((item: any) => ({
        ref: item.ref,
        x: item.bbox.x,
        y: item.bbox.y,
        w: item.bbox.w,
        h: item.bbox.h,
        kind: item.role || item.tag || item.type || 'target',
      }));
    const payload = JSON.stringify({ refs: refPayload, ttl });
    await withTimeout(page.evaluate(`(() => {
      document.dispatchEvent(new CustomEvent('eterx-control-refs', { detail: ${payload} }));
    })()`), 700, 'visual refs');
  } catch {}
}

async function readPageSemantics(page: any, maxChars = 30000): Promise<any> {
  await page.evaluate('var __name = globalThis.__name = globalThis.__name || ((fn, name) => fn)').catch(() => {});
  return page.evaluate((limit: number) => {
    const clean = (value: string | null | undefined, max = 400) =>
      String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const visible = (el: Element) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0;
    };
    const pick = (selector: string, max: number, mapper: (el: Element) => any) =>
      Array.from(document.querySelectorAll(selector)).filter(visible).slice(0, max).map(mapper).filter(Boolean);

    const title = document.title || '';
    const url = location.href;
    const description = clean(
      document.querySelector('meta[name="description"]')?.getAttribute('content') ||
      document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
      ''
    );
    const headings = pick('h1,h2,h3,[role="heading"]', 80, (el) => ({
      level: Number((el as HTMLElement).tagName?.replace(/\D/g, '')) || Number(el.getAttribute('aria-level')) || 2,
      text: clean(el.textContent, 220),
    }));
    const forms = pick('form', 25, (form) => ({
      label: clean(form.getAttribute('aria-label') || form.getAttribute('name') || form.textContent, 220),
      action: clean((form as HTMLFormElement).action, 220),
      fields: Array.from(form.querySelectorAll('input,textarea,select')).slice(0, 30).map((field: any) => ({
        type: clean(field.type || field.tagName?.toLowerCase(), 40),
        name: clean(field.name || field.id || field.getAttribute('aria-label') || field.placeholder, 120),
        value: clean(field.value, 120),
      })),
    }));
    const actions = pick('button,a,input,textarea,select,[role="button"],[role="link"],[role="tab"],[tabindex],[contenteditable="true"]', 160, (el) => {
      const rect = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      const text = clean((el as HTMLInputElement).value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent, 180);
      if (!text && !['input', 'textarea', 'select'].includes(tag)) return null;
      return {
        tag,
        role: clean(el.getAttribute('role') || '', 40),
        text,
        href: clean((el as HTMLAnchorElement).href || '', 220),
        viewport: rect.top >= 0 && rect.left >= 0 && rect.top < innerHeight && rect.left < innerWidth,
      };
    });

    const main = document.querySelector('main, article, [role="main"]') || document.body;
    const clone = main.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script,style,noscript,svg,canvas,iframe,nav,header,footer').forEach(node => node.remove());
    const paragraphs = Array.from(clone.querySelectorAll('p,li,td,th,blockquote,section,div'))
      .map(el => clean(el.textContent, 800))
      .filter(text => text.length >= 35);
    const seen = new Set<string>();
    const uniqueParagraphs: string[] = [];
    for (const text of paragraphs) {
      const key = text.toLowerCase().slice(0, 140);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueParagraphs.push(text);
      if (uniqueParagraphs.join('\n').length > limit) break;
    }

    return {
      title: clean(title, 220),
      url,
      description,
      headings,
      forms,
      actions,
      text: uniqueParagraphs.join('\n\n').slice(0, limit),
      stats: {
        headings: headings.length,
        actions: actions.length,
        forms: forms.length,
        textChars: uniqueParagraphs.join('\n\n').length,
        scrollY: window.scrollY,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        totalHeight: document.documentElement.scrollHeight,
      },
    };
  }, Math.max(4000, Math.min(maxChars, 120000)));
}

async function highlightElement(page: any, element: any): Promise<void> {
  try {
    const box = await element.boundingBox();
    if (!box) return;
    const payload = JSON.stringify({ rect: { x: box.x, y: box.y, width: box.width, height: box.height } });
    await withTimeout(page.evaluate(`(() => {
      document.dispatchEvent(new CustomEvent('eterx-control-focus', { detail: ${payload} }));
    })()`), 700, 'visual focus');
  } catch {}
}

async function humanMove(page: any, x: number, y: number): Promise<void> {
  const start = _lastBrowserCursor || { x, y };
  const distance = Math.hypot(x - start.x, y - start.y);
  const steps = Math.max(4, Math.min(18, Math.ceil(distance / 90)));
  try {
    for (let i = 1; i <= steps; i++) {
      const ratio = i / steps;
      const eased = ratio < 0.5 ? 2 * ratio * ratio : 1 - Math.pow(-2 * ratio + 2, 2) / 2;
      const cx = Math.round(start.x + (x - start.x) * eased);
      const cy = Math.round(start.y + (y - start.y) * eased);
      await page.mouse.move(cx, cy);
      void showCursor(page, cx, cy);
      if (ratio < 1) await page.waitForTimeout(12);
    }
    _lastBrowserCursor = { x, y };
  } catch {
    await page.mouse.move(x, y);
    _lastBrowserCursor = { x, y };
  }
}

async function elementCenter(element: any): Promise<{ x: number; y: number } | null> {
  try {
    const box = await element.boundingBox();
    if (!box) return null;
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  } catch {
    return null;
  }
}

async function clickElementHuman(page: any, element: any, button: 'left' | 'right' | 'middle' = 'left', clickCount = 1): Promise<boolean> {
  try { await element.scrollIntoViewIfNeeded({ timeout: 700 }); } catch {}
  void highlightElement(page, element);
  const center = await elementCenter(element);
  if (!center) return false;
  await humanMove(page, center.x, center.y);
  void showClickRing(page, center.x, center.y);
  try {
    await page.mouse.click(center.x, center.y, { button, clickCount, delay: 35 });
    return true;
  } catch {}
  try {
    await element.click({ timeout: 450, force: true });
    return true;
  } catch {}
  try {
    await element.evaluate(`(node, count) => {
      node.focus && node.focus();
      for (let i = 0; i < Math.max(1, count); i++) {
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        if (node.click) node.click();
      }
    }`, clickCount);
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════
// TOOL DEFINITION — REBUILT FROM SCRATCH
// ═══════════════════════════════════════

export const browserControlTool: ToolDefinition = {
  name: 'browser_control',
  description: `🌐 NEXT-GEN BROWSER CONTROL — Full Chrome Automation via CDP + Playwright + Snapshot/Ref System.

ARCHITECTURE: Three-layer system
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Layer 1: You (the AI) — read snapshots, decide actions
Layer 2: This tool — resolves refs, executes actions, returns results
Layer 3: CDP + Playwright — drives actual browser

🧠 THE SNAPSHOT/REF SYSTEM (KEY INNOVATION):
Instead of guessing CSS selectors, do this:
1. snapshot → See ALL interactive elements with numeric refs
2. click(ref: 14) → Click element [14] from the snapshot
3. type(ref: 8, text: "hello") → Type into element [8]

This is 10x more reliable than selectors. ALWAYS snapshot first.

WORKFLOW for ANY web task:
1. launch → Start browser (or connect to existing Chrome)
2. goto → Navigate to URL
3. snapshot → SEE the page with element refs
4. click/type/select → Interact using refs
5. snapshot → Verify result

STATE RULE:
When you use browser_control, make it the only tool call in that model turn. Wait for the browser result before choosing the next browser or non-browser action.

BROWSER UI SESSION:
- Use start_browser_session when beginning a multi-step visible browser workflow.
- Run normal browser actions in between; the animated frame, cursor, pill, and bubble stay alive across those actions.
- Use end_browser_session when the browser workflow is finished so the UI disappears cleanly.
- If end_browser_session is missed, the UI auto-closes after a short idle window with no browser actions.

USER CHECKPOINTS:
- Use action="ask_user_browser" when the browser needs human confirmation, a login/captcha/manual step, validation before purchase/submit/delete, or a choice the page cannot decide safely.
- Do not use it for routine browsing, reversible navigation, reading page state, normal form filling, or choices you can infer from the user's request.
- Avoid repeated prompts. If the user already answered a checkpoint, continue autonomously until there is a materially new blocker or high-impact decision.
- responseMode supports "done_cancel", "yes_no", "multiple_choice", and "short_answer".
- For multiple_choice, pass options/choices. For short_answer, pass placeholder/defaultAnswer when useful.
- The tool pauses, shows the prompt inside Chrome, waits for the response, then returns choice/value/cancelled/timedOut.
- Prefer ask_user_browser over chat ask_user whenever the user's attention should stay in the browser context.

CONNECTION MODES:
- managed: Launch new Chrome (clean, isolated)
- cdp: Connect to user's Chrome (keeps sessions/logins)
- remote: Connect to cloud browser via WebSocket

SESSION PERSISTENCE:
- Use profile="myprofile" to save cookies/sessions across restarts
- Once you login, the session persists forever
- List profiles with: profiles action

ELEMENT TARGETING (priority order):
1. ref: number — From snapshot [BEST, most reliable]
2. selector: CSS — "#id", ".class", "button[type=submit]"
3. text: string — Visible text on the page
4. x,y: coordinates — Screen position [last resort]

USE THIS WHEN THE USER ASKS TO:
- Browse/open any website
- Fill forms, click buttons, interact with web apps
- Login to services, manage accounts
- Search the web visually
- Extract/read webpage content
- Download files, generate PDFs
- Monitor network traffic
- Ask the user to confirm/choose/type while Chrome remains active
- Automate repetitive web tasks`,

  category: 'core',
  
  inputSchema: z.object({
    action: z.enum([
      // ── Connection & Lifecycle ──
      'launch', 'connect', 'disconnect', 'start_browser_session', 'end_browser_session',
      
      // ── Navigation ──
      'goto', 'back', 'forward', 'reload',
      
      // ── Snapshot & Reading (CORE) ──
      'observe', 'snapshot', 'read_page', 'show_refs', 'get_text', 'get_html', 'get_url', 'get_title',
      
      // ── Interaction by ref/selector/text ──
      'click', 'dblclick', 'type', 'fill', 'clear', 'select', 'check', 'uncheck',
      'hover', 'focus', 'press', 'mouse_move', 'mouse_down', 'mouse_up', 'drag_drop',
      
      // ── Scroll ──
      'scroll', 'scroll_to',
      
      // ── Tab Management ──
      'new_tab', 'switch_or_open_tab', 'switch_tab', 'close_tab', 'list_tabs',
      
      // ── Wait & User Checkpoints ──
      'wait', 'wait_for', 'ask_user_browser',
      
      // ── Frames ──
      'switch_frame', 'switch_main',
      
      // ── JavaScript ──
      'evaluate',
      
      // ── Files & PDF ──
      'upload', 'pdf', 'get_downloads',
      
      // ── Cookies & Storage ──
      'get_cookies', 'set_cookie', 'clear_cookies', 'get_storage', 'set_storage',
      
      // ── Network ──
      'monitor_network', 'block_urls', 'get_requests', 'network_stats',
      
      // ── Session & Profile ──
      'profiles', 'save_session', 'restore_session', 'export_cookies', 'import_cookies',
      
      // ── Page Settings ──
      'set_viewport', 'emulate_device', 'set_geolocation',
      
      // ── Console ──
      'get_console', 'clear_console',
      
      // ── Dialog ──
      'set_dialog_action',
    ]).describe('Browser action to perform. Start with "launch" then "goto" then "snapshot".'),

    // ── Connection ──
    mode: z.enum(['managed', 'cdp', 'remote']).optional().describe('Connection mode. managed=new Chrome, cdp=existing Chrome, remote=cloud'),
    profile: z.string().optional().describe('Named profile for session persistence (cookies survive restarts)'),
    headless: z.boolean().optional().describe('Run headless (no visible window). Default: false'),
    cdpEndpoint: z.string().optional().describe('CDP endpoint for cdp mode: http://127.0.0.1:9222'),
    wsEndpoint: z.string().optional().describe('WebSocket endpoint for remote mode'),

    // ── Navigation ──
    url: z.string().optional().describe('URL to navigate to'),

    // ── Element Targeting (by priority) ──
    ref: z.number().optional().describe('Element ref number from snapshot [BEST method]'),
    selector: z.string().optional().describe('CSS selector: #id, .class, button[type="submit"]'),
    text: z.string().optional().describe('Text to type, or visible text to find element by'),
    index: z.number().optional().describe('Index if multiple matches (0-based)'),

    // ── Browser User Prompt ──
    question: z.string().optional().describe('Question to ask the user in Chrome for ask_user_browser'),
    promptTitle: z.string().optional().describe('Short title for the Chrome prompt'),
    promptMessage: z.string().optional().describe('Prompt body shown in Chrome'),
    responseMode: z.enum(['done_cancel', 'yes_no', 'multiple_choice', 'short_answer']).optional().describe('User response mode for ask_user_browser'),
    options: z.array(z.string()).optional().describe('Choices for multiple_choice prompts'),
    choices: z.array(z.string()).optional().describe('Alias for options in multiple_choice prompts'),
    doneLabel: z.string().optional().describe('Label for the done/primary prompt button'),
    cancelLabel: z.string().optional().describe('Label for the cancel/secondary prompt button'),
    yesLabel: z.string().optional().describe('Label for yes prompt button'),
    noLabel: z.string().optional().describe('Label for no prompt button'),
    submitLabel: z.string().optional().describe('Label for short-answer submit button'),
    placeholder: z.string().optional().describe('Placeholder for short-answer prompt input'),
    defaultAnswer: z.string().optional().describe('Prefilled value for short-answer prompt input'),
    
    // ── Coordinates (fallback) ──
    x: z.number().optional().describe('X coordinate'),
    y: z.number().optional().describe('Y coordinate'),
    button: z.enum(['left', 'right', 'middle']).optional().default('left').describe('Mouse button for physical mouse actions'),
    
    // ── Drag target ──
    targetRef: z.number().optional().describe('Target ref for drag_drop'),
    targetSelector: z.string().optional().describe('Target selector for drag_drop'),

    // ── Keyboard ──
    key: z.string().optional().describe('Key to press: Enter, Tab, Escape, ArrowDown, Control+A, etc.'),

    // ── Select/Check ──
    value: z.string().optional().describe('Option value for select, or attribute name for get_attribute'),

    // ── Scroll ──
    direction: z.enum(['up', 'down', 'left', 'right']).optional().default('down'),
    amount: z.number().optional().describe('Scroll pixels (default 500) or wait ms'),

    // ── JavaScript ──
    script: z.string().optional().describe('JavaScript code to evaluate in page context'),

    // ── Tabs ──
    tabId: z.string().optional().describe('Tab ID for tab operations'),
    tabMatch: z.enum(['exact', 'origin', 'host']).optional().default('exact').describe('How switch_or_open_tab matches an existing tab before opening a new one'),
    reuseTab: z.boolean().optional().default(true).describe('Reuse matching or blank tabs for navigation/new_tab when possible'),

    // ── Files ──
    filePath: z.string().optional().describe('File path for upload or PDF save'),

    // ── Cookies ──
    cookieName: z.string().optional().describe('Cookie name'),
    cookieValue: z.string().optional().describe('Cookie value'),
    cookieDomain: z.string().optional().describe('Cookie domain'),

    // ── Storage ──
    storageKey: z.string().optional().describe('localStorage/sessionStorage key'),
    storageValue: z.string().optional().describe('Storage value to set'),
    storageType: z.enum(['local', 'session']).optional().default('local'),

    // ── Network ──
    urlPatterns: z.array(z.string()).optional().describe('URL patterns to block'),
    urlFilter: z.string().optional().describe('Filter requests by URL pattern'),
    headers: z.string().optional().describe('Optional JSON object string of custom headers to inject'),

    // ── Viewport/Device ──
    width: z.number().optional().describe('Viewport width'),
    height: z.number().optional().describe('Viewport height'),
    device: z.string().optional().describe('Device name: "iPhone 15", "Pixel 7", "iPad Pro"'),

    // ── Geolocation ──
    latitude: z.number().optional().describe('Latitude for geolocation spoof'),
    longitude: z.number().optional().describe('Longitude for geolocation spoof'),

    // ── Frames ──
    frameSelector: z.string().optional().describe('Iframe selector or name'),

    // ── Snapshot Options ──
    snapshotMode: z.enum(['full', 'interactive', 'forms', 'landmarks']).optional().default('full'),
    maxTextChars: z.number().optional().describe('Maximum text characters for read_page. Default 30000.'),
    maxElements: z.number().optional().describe('Maximum refs to collect for snapshot/read_page. Default is optimized for speed.'),
    autoSnapshot: z.boolean().optional().default(false).describe('Optional compatibility mode: automatically capture DOM after launch/goto/new_tab. Default false for speed.'),

    // ── Screenshot Options ──
    fullPage: z.boolean().optional().default(false),
    visualFeedback: z.boolean().optional().default(true).describe('Show live blue cursor, click rings, and focus borders during browser actions'),
    visualLabel: z.string().optional().describe('Optional generated cursor bubble label for the current action, e.g. "Checking cart items" or "Comparing delivery options"'),
    bubbleLabel: z.string().optional().describe('Cursor bubble label from API/marker protocol. Supports [bubble: ...], {{bubble: ...}}, ::bubble{...}, or <bubble>...</bubble>.'),
    visualPalette: z.object({
      accent: z.string().optional().describe('Primary overlay color, e.g. #38bdf8'),
      secondary: z.string().optional().describe('Secondary overlay color, e.g. #60a5fa'),
      tertiary: z.string().optional().describe('Tertiary overlay color, e.g. #a78bfa'),
    }).optional().describe('Optional generated palette for the browser-control overlay'),

    // ── Wait options ──
    timeout: z.number().optional().describe('Timeout in ms (default varies by action)'),
    waitFor: z.enum(['element', 'navigation', 'network', 'load']).optional().describe('What to wait for'),

    // ── Dialog ──
    dialogAction: z.enum(['accept', 'dismiss']).optional().describe('How to handle dialogs'),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    action: z.string(),
    result: z.any(),
    screenshotPath: z.string().optional(),
    snapshotText: z.string().optional(),
    currentUrl: z.string().optional(),
    pageTitle: z.string().optional(),
    recovery: z.string().optional(),
    nextAction: z.string().optional(),
    elapsedMs: z.number().optional(),
  }),

  execute: async (input: any) => {
    // SEQUENTIAL EXECUTION: All browser actions are queued and run one after another.
    // This prevents race conditions (e.g. goto running before launch finishes).
    return withBrowserLock(async () => {
    const { action } = input;
    const startedAt = Date.now();
    let activityPage: any = null;

    console.log(`[BrowserControl] 🌐 ${action} | ref:${input.ref || '-'} url:"${(input.url || '').substring(0, 60)}" sel:"${input.selector || ''}" text:"${(input.text || '').substring(0, 40)}"`);
    void logAction(action, { url: input.url, ref: input.ref, selector: input.selector, text: input.text }); // fire-and-forget, no await for speed

    try {
      let result: any = {};
      let page: any;
      let screenshotPath: string | undefined;
      let snapshotText: string | undefined;

      // ═══════════════════════════════════════
      // CONNECTION & LIFECYCLE
      // ═══════════════════════════════════════

      if (action === 'launch' || action === 'connect') {
        page = await browserEngine.launch({
          mode: input.mode || (action === 'connect' ? 'cdp' : 'managed'),
          headless: input.headless ?? false,
          profile: input.profile,
          cdpEndpoint: input.cdpEndpoint,
          wsEndpoint: input.wsEndpoint,
          viewport: input.width && input.height ? { width: input.width, height: input.height } : null,
        });

        // Restore session if profile specified
        if (input.profile) {
          await browserSessionManager.touchProfile(input.profile);
        }

        // Navigate if URL provided
        if (input.url) {
          const url = normalizeBrowserUrl(input.url);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: actionTimeout(input, 15000, 30000) });
        }

        // Auto-start network monitoring (non-fatal)
        try { await networkMonitor.startIntercepting(page); } catch {}
        if (input.visualFeedback !== false) {
          ensureVisualHooks(page);
          activityPage = page;
          await showBrowserAction(page, action, input);
        }

        // Auto-snapshot after launch (NON-FATAL — navigation must always succeed)
        let snapElementCount = 0; if (input.autoSnapshot === true)
        try {
          const snap = await domSnapshot.capture(page, { maxElements: maxSnapshotElements(input, 120) });
          snapshotText = snap.snapshotText;
          snapElementCount = snap.elementCount;
          if (input.visualFeedback !== false) void showRefOverlay(page, snap.refs, 4200);
        } catch (snapErr: any) {
          console.warn(`[BrowserControl] ⚠️ Auto-snapshot failed (non-fatal): ${snapErr.message?.substring(0, 100)}`);
          snapshotText = `Page loaded: ${page.url()} — Snapshot failed, use action "snapshot" to retry.`;
        }

        result = {
          connected: true,
          mode: browserEngine.mode,
          profile: input.profile || 'ephemeral',
          url: page.url(),
          title: await page.title().catch(() => ''),
          note: 'Use snapshot/read_page when page context is needed.',
        };

        console.log(`[BrowserControl] done ${action} in ${Date.now() - startedAt}ms`);
        return {
          success: true,
          action,
          result,
          snapshotText,
          currentUrl: page.url(),
          pageTitle: await page.title().catch(() => ''),
          elapsedMs: Date.now() - startedAt,
        };
      }

      if (action === 'disconnect') {
        if (_browserVisualSessionPage) {
          await endBrowserActivity(_browserVisualSessionPage, 0).catch(() => {});
        }
        await browserEngine.disconnect();
        return { success: true, action, result: 'Browser disconnected. All sessions closed.', elapsedMs: Date.now() - startedAt };
      }

      // For all other actions, the browser must be connected
      if (!browserEngine.connected) {
        return fail(action, 'Browser not connected. Use action "launch" first.');
      }

      page = await browserEngine.getActivePage();
      if (input.visualFeedback !== false) {
        ensureVisualHooks(page);
        activityPage = page;
        await showBrowserAction(page, action, input);
      }

      switch (action) {
        case 'start_browser_session': {
          result = {
            started: true,
            idleTimeoutMs: BROWSER_VISUAL_IDLE_MS,
            note: 'Browser UI session started. The visual frame stays active across browser actions until end_browser_session or idle timeout.',
          };
          break;
        }

        case 'end_browser_session': {
          await endBrowserActivity(page, 0);
          activityPage = null;
          result = { ended: true, note: 'Browser UI session ended.' };
          break;
        }

        // ═══════════════════════════════════════
        // NAVIGATION
        // ═══════════════════════════════════════

        case 'goto': {
          if (!input.url) return fail(action, 'url required');
          const url = normalizeBrowserUrl(input.url);
          
          // Invalidate old snapshot
          domSnapshot.invalidate();

          if (input.reuseTab !== false) {
            const reused = await browserEngine.switchOrOpenPage(url, {
              match: input.tabMatch || 'exact',
              navigateIfBlank: true,
              openIfMissing: false,
            });
            page = reused.page;
            activityPage = page;
            if (reused.reused && reused.reason !== 'blank') {
              result = {
                navigated: url,
                title: await page.title().catch(() => ''),
                reusedTab: true,
                tabId: reused.id,
                note: 'Switched to an already-open matching tab.',
              };
              break;
            }
            if (reused.reason === 'active') {
              await page.goto(url, { 
                waitUntil: 'domcontentloaded', 
                timeout: actionTimeout(input, 15000, 30000)
              });
            }
            if (input.visualFeedback !== false) {
              ensureVisualHooks(page);
              await showBrowserAction(page, action, input);
            }
          } else {
            await page.goto(url, { 
              waitUntil: 'domcontentloaded', 
              timeout: actionTimeout(input, 15000, 30000)
            });
          }
          result = { navigated: url, title: await page.title().catch(() => ''), note: 'Use snapshot/read_page when page context is needed.' };
          
          // Auto-snapshot after navigation (NON-FATAL — navigation must always succeed)
          if (input.autoSnapshot === true) try {
            const snap = await domSnapshot.capture(page, { mode: input.snapshotMode || 'full', maxElements: maxSnapshotElements(input, 120) });
            snapshotText = snap.snapshotText;
            result = { navigated: url, title: snap.pageTitle, elements: snap.elementCount };
            if (input.visualFeedback !== false) void showRefOverlay(page, snap.refs, 4200);
          } catch (snapErr: any) {
            console.warn(`[BrowserControl] ⚠️ Auto-snapshot failed after goto (non-fatal): ${snapErr.message?.substring(0, 100)}`);
            snapshotText = `Navigated to: ${url} — Snapshot failed, use action "snapshot" to retry.`;
            result = { navigated: url, title: await page.title().catch(() => ''), snapshotNote: 'Auto-snapshot failed. Call snapshot action separately.' };
          }
          break;
        }

        case 'back': {
          domSnapshot.invalidate();
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: actionTimeout(input, 8000, 15000) });
          result = { navigated: 'back', url: page.url() };
          break;
        }

        case 'forward': {
          domSnapshot.invalidate();
          await page.goForward({ waitUntil: 'domcontentloaded', timeout: actionTimeout(input, 8000, 15000) });
          result = { navigated: 'forward', url: page.url() };
          break;
        }

        case 'reload': {
          domSnapshot.invalidate();
          await page.reload({ waitUntil: 'domcontentloaded', timeout: actionTimeout(input, 8000, 15000) });
          result = { reloaded: true, url: page.url() };
          break;
        }

        // ═══════════════════════════════════════
        // SNAPSHOT & READING (THE CORE)
        // ═══════════════════════════════════════

        case 'observe': {
          const snap = await domSnapshot.capture(page, {
            mode: input.snapshotMode || 'full',
            maxElements: maxSnapshotElements(input, 160),
          });
          if (input.visualFeedback !== false) void showRefOverlay(page, snap.refs, 5200);
          const tabs = await browserEngine.getPageListDetailed();
          const consoleLogs = browserEngine.getConsoleLogs().slice(-10).map(l => ({
            type: l.type,
            text: l.text.substring(0, 180),
            time: new Date(l.timestamp).toISOString(),
          }));
          const requests = networkMonitor.getApiRequests().slice(-10).map(r => ({
            method: r.method,
            url: r.url.substring(0, 120),
            status: r.status || 'pending',
            type: r.resourceType,
          }));
          return {
            success: true,
            action,
            result: {
              elements: snap.elementCount,
              forms: snap.forms.length,
              viewport: snap.viewport,
              scrollPosition: snap.scrollPosition,
              totalHeight: snap.totalHeight,
              activeTabId: browserEngine.activeTabId,
              tabs,
              consoleLogs,
              recentApiRequests: requests,
            },
            snapshotText: snap.snapshotText,
            currentUrl: snap.pageUrl,
            pageTitle: snap.pageTitle,
          };
        }

        case 'snapshot': {
          const snap = await domSnapshot.capture(page, {
            mode: input.snapshotMode || 'full',
            maxElements: maxSnapshotElements(input, 160),
          });
          if (input.visualFeedback !== false) void showRefOverlay(page, snap.refs, 5200);
          return {
            success: true,
            action,
            result: {
              elements: snap.elementCount,
              forms: snap.forms.length,
              viewport: snap.viewport,
              scrollPosition: snap.scrollPosition,
              totalHeight: snap.totalHeight,
            },
            snapshotText: snap.snapshotText,
            currentUrl: snap.pageUrl,
            pageTitle: snap.pageTitle,
          };
        }

        case 'read_page': {
          const [snapOutcome, readableOutcome] = await Promise.allSettled([
            domSnapshot.capture(page, { mode: input.snapshotMode || 'full', maxElements: maxSnapshotElements(input, 220), textMaxLength: 90 }),
            readPageSemantics(page, input.maxTextChars || 30000),
          ]);
          if (snapOutcome.status === 'rejected') {
            return await failWithPageState(page, action, 'Could not read page refs.', 'Refresh browser state, then retry read_page or snapshot.', 'snapshot', input, startedAt);
          }

          const snap = snapOutcome.value;
          const readable = readableOutcome.status === 'fulfilled'
            ? readableOutcome.value
            : {
              title: snap.pageTitle,
              url: snap.pageUrl,
              description: '',
              stats: {
                headings: 0,
                actions: snap.elementCount,
                forms: snap.forms.length,
                textChars: 0,
                scrollY: snap.scrollPosition.y,
                viewport: snap.viewport,
                totalHeight: snap.totalHeight,
              },
              headings: [],
              forms: snap.forms,
              actions: [],
              text: await page.locator('body').innerText({ timeout: 1000 }).catch(() => ''),
            };
          if (typeof readable.text === 'string') {
            readable.text = readable.text.slice(0, Math.max(4000, Math.min(input.maxTextChars || 30000, 120000)));
          }
          snapshotText = snap.snapshotText;
          if (input.visualFeedback !== false) void showRefOverlay(page, snap.refs, 1800);
          const actionPreview = readable.actions
            .slice(0, 35)
            .map((a: any, i: number) => `${i + 1}. ${a.tag}${a.role ? `/${a.role}` : ''}: ${a.text}${a.href ? ` -> ${a.href}` : ''}`)
            .join('\n');
          const headingPreview = readable.headings
            .slice(0, 40)
            .map((h: any) => `${'  '.repeat(Math.max(0, Math.min(2, h.level - 1)))}- ${h.text}`)
            .join('\n');
          return {
            success: true,
            action,
            result: {
              title: readable.title,
              url: readable.url,
              description: readable.description,
              stats: readable.stats,
              headings: readable.headings.slice(0, 60),
              forms: readable.forms.slice(0, 20),
              actionPreview,
              text: readable.text,
            },
            snapshotText: [
              `Page: ${readable.title || snap.pageTitle || 'Untitled'}`,
              `URL: ${readable.url || snap.pageUrl}`,
              readable.description ? `Description: ${readable.description}` : '',
              headingPreview ? `\nHeadings:\n${headingPreview}` : '',
              actionPreview ? `\nActions:\n${actionPreview}` : '',
              readable.text ? `\nReadable text:\n${readable.text}` : '',
              `\nRefs:\n${snap.snapshotText}`,
            ].filter(Boolean).join('\n'),
            currentUrl: readable.url || snap.pageUrl,
            pageTitle: readable.title || snap.pageTitle,
          };
        }

        case 'show_refs': {
          const snap = await domSnapshot.capture(page, {
            mode: input.snapshotMode || 'interactive',
            maxElements: maxSnapshotElements(input, 180),
          });
          if (input.visualFeedback !== false) {
            await showBrowserAction(page, action, { ...input, text: `${snap.elementCount} elements` });
            void showRefOverlay(page, snap.refs, input.timeout || 9000);
          }
          return {
            success: true,
            action,
            result: {
              shown: snap.elementCount,
              durationMs: input.timeout || 9000,
              url: snap.pageUrl,
            },
            snapshotText: snap.snapshotText,
            currentUrl: snap.pageUrl,
            pageTitle: snap.pageTitle,
          };
        }

        case 'screenshot': {
          if (input.allowScreenshot !== true) {
            return fail(action, 'Screenshot capture is disabled by default. Use snapshot/show_refs/get_text for browser state.');
          }
          screenshotPath = await takeScreenshot(page, 'view', input.fullPage ?? false);
          return {
            success: !!screenshotPath,
            action,
            result: screenshotPath 
              ? `Screenshot saved: ${screenshotPath}` 
              : 'Screenshot failed',
            screenshotPath,
            currentUrl: page.url(),
            pageTitle: await page.title().catch(() => ''),
          };
        }

        case 'get_text': {
          let text: string;
          if (input.ref != null || input.selector) {
            const el = await resolveElement(page, input);
            text = el ? (await el.textContent()) || '' : 'Element not found';
          } else {
            text = await page.locator('body').innerText({ timeout: 2000 })
              .catch(() => page.evaluate('document.body ? document.body.innerText.substring(0, 10000) : ""'));
          }
          result = { text: text.substring(0, 8000) };
          break;
        }

        case 'get_html': {
          let html: string;
          if (input.ref != null || input.selector) {
            const el = await resolveElement(page, input);
            html = el ? (await el.innerHTML()) : 'Element not found';
          } else {
            html = await page.content();
          }
          result = { html: html.substring(0, 10000) };
          break;
        }

        case 'get_url': {
          result = { url: page.url() };
          break;
        }

        case 'get_title': {
          result = { title: await page.title(), url: page.url() };
          break;
        }

        // ═══════════════════════════════════════
        // INTERACTION
        // ═══════════════════════════════════════

        case 'click': {
          if (input.x != null && input.y != null && input.ref == null && !input.selector && !input.text) {
            // Click by coordinates
            await humanMove(page, input.x, input.y);
            void showClickRing(page, input.x, input.y);
            await page.mouse.click(input.x, input.y, { button: input.button || 'left', delay: 55 });
            result = { clicked: { x: input.x, y: input.y } };
          } else {
            const el = await resolveElement(page, input);
            if (!el) return fail(action, 'No element target. Provide ref, selector, text, or x/y.');
            
            const humanClicked = await clickElementHuman(page, el, input.button || 'left');
            if (!humanClicked) {
              return await failWithPageState(
                page,
                action,
                `Target ${input.ref != null ? `ref [${input.ref}]` : input.selector || input.text || 'element'} is not currently clickable or visible.`,
                'Take a fresh snapshot/read_page and choose a visible actionable ref.',
                'snapshot',
                input,
                startedAt
              );
            }
            
            const refInfo = input.ref != null ? `ref [${input.ref}]` : (input.selector || input.text || 'element');
            result = { clicked: refInfo };
          }
          
          await smartWait(page, action);
          domSnapshot.invalidate(); // Page may have changed
          break;
        }

        case 'dblclick': {
          const el = await resolveElement(page, input);
          if (!el) return fail(action, 'No element target.');
          const humanClicked = await clickElementHuman(page, el, input.button || 'left', 2);
          if (!humanClicked) {
            return await failWithPageState(page, action, 'Target is not currently double-clickable or visible.', 'Take a fresh snapshot and choose a visible ref.', 'snapshot', input, startedAt);
          }
          result = { dblclicked: input.ref ? `ref [${input.ref}]` : input.selector || input.text };
          await smartWait(page, action);
          break;
        }

        case 'type': {
          if (!input.text) return fail(action, 'text required');
          
          if (input.ref != null || input.selector) {
            const el = await resolveElement(page, input);
            if (!el) return fail(action, 'Element not found');
            try { await el.scrollIntoViewIfNeeded({ timeout: 700 }); } catch {}
            const humanClicked = await clickElementHuman(page, el);
            if (!humanClicked) {
              return await failWithPageState(page, action, 'Target field is not currently visible/clickable for typing.', 'Take a fresh snapshot and choose a visible input/contenteditable ref.', 'snapshot', input, startedAt);
            }
            await page.waitForTimeout(50); // Brief settle for contenteditable
            if (input.visualFeedback !== false) void showKeyPulse(page, `typing ${input.text.length}`);
            await page.keyboard.type(input.text, { delay: 8 }); // Fast typing
          } else {
            // Type into currently focused element
            if (input.visualFeedback !== false) void showKeyPulse(page, `typing ${input.text.length}`);
            await page.keyboard.type(input.text, { delay: 8 });
          }
          
          result = { typed: input.text.substring(0, 60), into: input.ref ? `ref [${input.ref}]` : (input.selector || 'focused') };
          break;
        }

        case 'fill': {
          if (!input.text && input.text !== '') return fail(action, 'text required');
          const el = await resolveElement(page, input);
          if (!el) return fail(action, 'Element not found');
          try { await el.scrollIntoViewIfNeeded({ timeout: 700 }); } catch {}
          void highlightElement(page, el);
          
          // Try native fill first (works on <input> and <textarea>)
          try {
            if (input.visualFeedback !== false) void showKeyPulse(page, `fill ${input.text.length}`);
            await el.fill(input.text, { timeout: 900 });
            result = { filled: input.text.substring(0, 60), into: input.ref ? `ref [${input.ref}]` : input.selector };
          } catch {
            // Native fill failed — element is likely contenteditable (Google Forms, Docs, etc.)
            // Fallback: click → select all → delete → type
            console.log(`[BrowserControl] fill fallback: contenteditable mode (click+selectAll+type)`);
            const humanClicked = await clickElementHuman(page, el);
            if (!humanClicked) {
              return await failWithPageState(page, action, 'Target field is not currently visible/clickable for filling.', 'Take a fresh snapshot and choose a visible input/contenteditable ref.', 'snapshot', input, startedAt);
            }
            await page.waitForTimeout(50);
            await page.keyboard.press('Control+A'); // Select all existing text
            await page.keyboard.press('Delete');      // Clear it
            if (input.text) {
              if (input.visualFeedback !== false) void showKeyPulse(page, `typing ${input.text.length}`);
              await page.keyboard.type(input.text, { delay: 8 }); // Type new text
            }
            result = { filled: input.text.substring(0, 60), into: input.ref ? `ref [${input.ref}]` : input.selector, method: 'contenteditable' };
          }
          break;
        }

        case 'clear': {
          const el = await resolveElement(page, input);
          if (!el) return fail(action, 'Element not found');
          
          try {
            await el.fill('', { timeout: 900 });
          } catch {
            // Contenteditable fallback
            const humanClicked = await clickElementHuman(page, el);
            if (!humanClicked) {
              return await failWithPageState(page, action, 'Target field is not currently visible/clickable for clearing.', 'Take a fresh snapshot and choose a visible input/contenteditable ref.', 'snapshot', input, startedAt);
            }
            await page.waitForTimeout(50);
            await page.keyboard.press('Control+A');
            await page.keyboard.press('Delete');
          }
          result = { cleared: input.ref ? `ref [${input.ref}]` : input.selector };
          break;
        }

        case 'select': {
          const el = await resolveElement(page, input);
          if (!el) return fail(action, 'Element not found');
          const val = input.value || input.text || '';
          try {
            await el.selectOption(val, { timeout: 1000 });
          } catch {
            return await failWithPageState(page, action, 'Target select is not currently usable.', 'Take a fresh snapshot and choose a visible select/combobox ref.', 'snapshot', input, startedAt);
          }
          result = { selected: val, in: input.ref ? `ref [${input.ref}]` : input.selector };
          break;
        }

        case 'check': {
          const el = await resolveElement(page, input);
          if (!el) return fail(action, 'Element not found');
          try {
            await el.check({ timeout: 1000 });
          } catch {
            return await failWithPageState(page, action, 'Target checkbox/radio is not currently checkable.', 'Take a fresh snapshot and choose a visible checkbox/radio ref.', 'snapshot', input, startedAt);
          }
          result = { checked: input.ref ? `ref [${input.ref}]` : input.selector };
          break;
        }

        case 'uncheck': {
          const el = await resolveElement(page, input);
          if (!el) return fail(action, 'Element not found');
          try {
            await el.uncheck({ timeout: 1000 });
          } catch {
            return await failWithPageState(page, action, 'Target checkbox/radio is not currently uncheckable.', 'Take a fresh snapshot and choose a visible checkbox/radio ref.', 'snapshot', input, startedAt);
          }
          result = { unchecked: input.ref ? `ref [${input.ref}]` : input.selector };
          break;
        }

        case 'hover': {
          if (input.x != null && input.y != null && input.ref == null && !input.selector) {
            await humanMove(page, input.x, input.y);
            result = { hovered: { x: input.x, y: input.y } };
          } else {
            const el = await resolveElement(page, input);
            if (!el) return fail(action, 'Element not found');
            const center = await elementCenter(el);
            void highlightElement(page, el);
            if (center) await humanMove(page, center.x, center.y);
            else {
              try {
                await el.hover({ timeout: 900 });
              } catch {
                return await failWithPageState(page, action, 'Target is not currently hoverable or visible.', 'Take a fresh snapshot and choose a visible ref.', 'snapshot', input, startedAt);
              }
            }
            result = { hovered: input.ref ? `ref [${input.ref}]` : input.selector };
          }
          break;
        }

        case 'focus': {
          const el = await resolveElement(page, input);
          if (!el) return fail(action, 'Element not found');
          void highlightElement(page, el);
          try {
            await el.focus({ timeout: 900 });
          } catch {
            return await failWithPageState(page, action, 'Target is not currently focusable or visible.', 'Take a fresh snapshot and choose a visible input/contenteditable ref.', 'snapshot', input, startedAt);
          }
          result = { focused: input.ref ? `ref [${input.ref}]` : input.selector };
          break;
        }

        case 'mouse_move': {
          if (input.x == null || input.y == null) return fail(action, 'x and y required');
          await humanMove(page, input.x, input.y);
          result = { moved: { x: input.x, y: input.y } };
          break;
        }

        case 'mouse_down': {
          if (input.x != null && input.y != null) await humanMove(page, input.x, input.y);
          if (input.visualFeedback !== false) void showMouseDown(page, true);
          await page.mouse.down({ button: input.button || 'left' });
          result = {
            mouse: 'down',
            button: input.button || 'left',
            at: input.x != null && input.y != null ? { x: input.x, y: input.y } : 'current',
          };
          break;
        }

        case 'mouse_up': {
          if (input.x != null && input.y != null) await humanMove(page, input.x, input.y);
          await page.mouse.up({ button: input.button || 'left' });
          if (input.visualFeedback !== false) void showMouseDown(page, false);
          if (input.x != null && input.y != null) void showClickRing(page, input.x, input.y);
          result = {
            mouse: 'up',
            button: input.button || 'left',
            at: input.x != null && input.y != null ? { x: input.x, y: input.y } : 'current',
          };
          break;
        }

        case 'press': {
          const key = input.key || input.text || 'Enter';
          if (input.visualFeedback !== false) void showKeyPulse(page, key);
          
          if (input.ref != null || input.selector) {
            const el = await resolveElement(page, input);
            if (el) {
              try {
                await el.press(key, { timeout: 900 });
              } catch {
                return await failWithPageState(page, action, 'Target is not currently usable for key press.', 'Take a fresh snapshot and choose a visible ref, or press the key on the page without a target.', 'snapshot', input, startedAt);
              }
              result = { pressed: key, on: input.ref ? `ref [${input.ref}]` : input.selector };
              break;
            }
          }
          
          await page.keyboard.press(key);
          result = { pressed: key, on: 'page' };
          await smartWait(page, action);
          break;
        }

        case 'drag_drop': {
          const source = await resolveElement(page, input);
          if (!source) return fail(action, 'Source element not found');
          
          let target: any;
          if (input.targetRef != null) {
            const targetInfo = domSnapshot.getRef(input.targetRef);
            if (targetInfo) target = await page.$(targetInfo.selector);
          } else if (input.targetSelector) {
            target = await page.$(input.targetSelector);
          }
          
          if (!target) return fail(action, 'Target element not found');
          
          // Get bounding boxes
          const srcBox = await source.boundingBox();
          const tgtBox = await target.boundingBox();
          
          if (!srcBox || !tgtBox) return fail(action, 'Cannot determine element positions');
          
          const from = { x: Math.round(srcBox.x + srcBox.width / 2), y: Math.round(srcBox.y + srcBox.height / 2) };
          const to = { x: Math.round(tgtBox.x + tgtBox.width / 2), y: Math.round(tgtBox.y + tgtBox.height / 2) };

          await humanMove(page, from.x, from.y);
          if (input.visualFeedback !== false) void showMouseDown(page, true);
          await page.mouse.down();
          if (input.visualFeedback !== false) void showDragLine(page, from, to);
          await page.mouse.move(to.x, to.y, { steps: 12 });
          await page.mouse.up();
          if (input.visualFeedback !== false) void showMouseDown(page, false);
          
          result = { dragged: `from ref [${input.ref}] to ref [${input.targetRef}]` };
          break;
        }

        // ═══════════════════════════════════════
        // SCROLL
        // ═══════════════════════════════════════

        case 'scroll': {
          const dir = input.direction || 'down';
          const amt = input.amount || 500;
          const deltaX = dir === 'left' ? -amt : dir === 'right' ? amt : 0;
          const deltaY = dir === 'up' ? -amt : dir === 'down' ? amt : 0;
          
          await page.mouse.wheel(deltaX, deltaY);
          if (input.visualFeedback !== false) void showScrollPulse(page, dir);
          await page.waitForTimeout(120);
          
          const scrollPos = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
          domSnapshot.invalidate(); // Visible elements changed
          result = { scrolled: dir, amount: amt, position: scrollPos };
          break;
        }

        case 'scroll_to': {
          if (input.ref != null || input.selector) {
            const el = await resolveElement(page, input);
            if (el) {
              await el.scrollIntoViewIfNeeded({ timeout: 700 }).catch(() => {});
              if (input.visualFeedback !== false) {
                void highlightElement(page, el);
                void showScrollPulse(page, 'down');
              }
              result = { scrolledTo: input.ref ? `ref [${input.ref}]` : input.selector };
              domSnapshot.invalidate();
              break;
            }
          }
          
          // Scroll to position
          if (input.y != null) {
            await page.evaluate((y: number) => window.scrollTo(0, y), input.y);
            if (input.visualFeedback !== false) void showScrollPulse(page, 'down');
            result = { scrolledTo: { y: input.y } };
            domSnapshot.invalidate();
            break;
          }
          
          return fail(action, 'Provide ref, selector, or y position');
        }

        // ═══════════════════════════════════════
        // TAB MANAGEMENT
        // ═══════════════════════════════════════

        case 'new_tab':
        case 'switch_or_open_tab': {
          const url = input.url ? normalizeBrowserUrl(input.url) : undefined;
          const tab = url && input.reuseTab !== false
            ? await browserEngine.switchOrOpenPage(url, {
              match: input.tabMatch || 'exact',
              navigateIfBlank: true,
              openIfMissing: true,
            })
            : await browserEngine.newPage(url);
          const { page: newPage, id } = tab;
          page = newPage;
          if (input.visualFeedback !== false) {
            ensureVisualHooks(page);
            activityPage = page;
            await showBrowserAction(page, action, input);
          }
          
          // Auto-snapshot new tab
          if (input.autoSnapshot === true && url) {
            const snap = await domSnapshot.capture(page, { maxElements: maxSnapshotElements(input, 120) });
            snapshotText = snap.snapshotText;
            if (input.visualFeedback !== false) void showRefOverlay(page, snap.refs, 4200);
          }
          
          result = {
            opened: !('reused' in tab) || !tab.reused,
            reused: 'reused' in tab ? tab.reused : false,
            reason: 'reason' in tab ? tab.reason : 'new',
            tabId: id,
            url: page.url(),
          };
          break;
        }

        case 'switch_tab': {
          if (!input.tabId) return fail(action, 'tabId required');
          page = await browserEngine.switchPage(input.tabId);
          if (input.visualFeedback !== false) {
            ensureVisualHooks(page);
            activityPage = page;
            await showBrowserAction(page, action, input);
          }
          result = { switched: input.tabId, url: page.url() };
          domSnapshot.invalidate();
          break;
        }

        case 'close_tab': {
          if (!input.tabId) return fail(action, 'tabId required');
          await browserEngine.closePage(input.tabId);
          result = { closed: input.tabId };
          break;
        }

        case 'list_tabs': {
          const tabs = await browserEngine.getPageListDetailed();
          const consoleIssues = browserEngine.getConsoleLogs()
            .filter((entry: any) => entry.type === 'error' || entry.type === 'warn')
            .slice(-8)
            .map((entry: any) => ({
              type: entry.type,
              text: entry.text.substring(0, 180),
              time: new Date(entry.timestamp).toISOString(),
            }));
          result = {
            tabs,
            count: tabs.length,
            activeTabId: browserEngine.activeTabId,
            mode: browserEngine.mode,
            consoleIssues,
            networkStats: networkMonitor.getStats(),
          };
          break;
        }

        case 'ask_user_browser': {
          const response = await askUserInBrowser(page, input);
          result = {
            prompt: input.question || input.promptMessage || input.text || '',
            response,
            choice: response?.choice,
            value: response?.value ?? response?.answer ?? response?.option,
            cancelled: !!response?.cancelled || response?.choice === 'cancel',
            timedOut: !!response?.timedOut || response?.choice === 'timeout',
          };
          break;
        }

        // ═══════════════════════════════════════
        // WAIT
        // ═══════════════════════════════════════

        case 'wait': {
          if (input.waitFor) {
            const timeout = actionTimeout(input, 5000, 15000);
            switch (input.waitFor) {
              case 'element': {
                if (!input.selector && input.ref == null) return fail(action, 'selector or ref required for wait_for element');
                const sel = input.selector || (input.ref != null ? `[data-ref="${input.ref}"]` : '');
                try {
                  await page.waitForSelector(sel, { timeout, state: 'visible' });
                  result = { found: true, selector: sel };
                } catch {
                  result = { found: false, selector: sel, message: 'Timeout' };
                }
                break;
              }
              case 'navigation': {
                try {
                  await page.waitForNavigation({ timeout, waitUntil: 'domcontentloaded' });
                  result = { navigated: true, url: page.url() };
                } catch {
                  result = { navigated: false, url: page.url(), message: 'Timeout' };
                }
                break;
              }
              case 'network': {
                const idle = await networkMonitor.waitForNetworkIdle(page, timeout);
                result = { networkIdle: idle };
                break;
              }
              case 'load': {
                try {
                  await page.waitForLoadState('load', { timeout });
                  result = { loaded: true };
                } catch {
                  result = { loaded: false, message: 'Timeout' };
                }
                break;
              }
            }
          } else {
            const ms = Math.min(input.amount || input.timeout || 1000, 30000);
            await page.waitForTimeout(ms);
            result = { waited: `${ms}ms` };
          }
          break;
        }

        case 'wait_for': {
          const timeout = input.timeout || 5000;
          if (input.selector || input.ref != null) {
            const sel = input.selector || `[data-ref="${input.ref}"]`;
            try {
              await page.waitForSelector(sel, { timeout, state: 'visible' });
              result = { found: true, selector: sel };
            } catch {
              result = { found: false, selector: sel, message: 'Timeout' };
            }
          } else if (input.url) {
            try {
              await page.waitForURL(input.url, { timeout });
              result = { matched: true, url: page.url() };
            } catch {
              result = { matched: false, message: 'Timeout' };
            }
          } else {
            return fail(action, 'selector, ref, or url required');
          }
          break;
        }

        // ═══════════════════════════════════════
        // FRAMES
        // ═══════════════════════════════════════

        case 'switch_frame': {
          if (!input.frameSelector) return fail(action, 'frameSelector required');
          
          const frameEl = await page.$(input.frameSelector);
          if (!frameEl) return fail(action, `Frame not found: ${input.frameSelector}`);
          
          const frame = await frameEl.contentFrame();
          if (!frame) return fail(action, 'Cannot access frame content');
          
          // Store the frame as the "active page" for this tab
          // Note: frame has same API as page for most operations
          result = { switched: input.frameSelector, url: frame.url() };
          break;
        }

        case 'switch_main': {
          // Switch back to main frame — just use the page directly
          result = { switched: 'main_frame', url: page.url() };
          break;
        }

        // ═══════════════════════════════════════
        // JAVASCRIPT EXECUTION
        // ═══════════════════════════════════════

        case 'evaluate': {
          if (!input.script) return fail(action, 'script required');

          const rawScript = String(input.script);
          await page.evaluate('var __name = globalThis.__name = globalThis.__name || ((fn, name) => fn)').catch(() => {});

          let evalResult: any;
          let evalMode = 'expression';
          const shouldRunAsBody = /\breturn\b/.test(rawScript) || /;\s*$/.test(rawScript) || /\n/.test(rawScript);
          if (shouldRunAsBody) {
            evalMode = 'function_body';
            evalResult = await page.evaluate(`(async () => {\nvar __name = globalThis.__name = globalThis.__name || ((fn, name) => fn);\n${rawScript}\n})()`);
          } else {
            try {
              evalResult = await page.evaluate(rawScript);
            } catch (err: any) {
              const msg = String(err?.message || '');
              const shouldWrap =
                msg.includes('Unexpected token') ||
                msg.includes('Illegal return statement');
              if (!shouldWrap) throw err;

              evalMode = 'function_body';
              evalResult = await page.evaluate(`(async () => {\nvar __name = globalThis.__name = globalThis.__name || ((fn, name) => fn);\n${rawScript}\n})()`);
            }
          }

          const output = typeof evalResult === 'object' 
            ? JSON.stringify(evalResult, null, 2).substring(0, 5000)
            : String(evalResult).substring(0, 5000);
          
          result = { output, mode: evalMode };
          break;
        }

        // ═══════════════════════════════════════
        // FILES & PDF
        // ═══════════════════════════════════════

        case 'upload': {
          if (!input.filePath) return fail(action, 'filePath required');
          
          const el = await resolveElement(page, input);
          if (!el) return fail(action, 'File input element not found. Provide ref or selector.');
          
          try {
            await el.setInputFiles(input.filePath, { timeout: 2000 });
          } catch {
            return await failWithPageState(page, action, 'File input is not currently available for upload.', 'Take a fresh snapshot and choose a visible file input ref, or open the upload dialog first.', 'snapshot', input, startedAt);
          }
          result = { uploaded: input.filePath };
          await smartWait(page, action);
          break;
        }

        case 'pdf': {
          await fs.ensureDir(PDF_DIR);
          const pdfPath = input.filePath || path.join(PDF_DIR, `page_${Date.now()}.pdf`);
          await page.pdf({ 
            path: pdfPath, 
            format: 'A4',
            printBackground: true,
            margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' },
          });
          result = { saved: pdfPath };
          break;
        }

        case 'get_downloads': {
          result = { downloads: browserEngine.getDownloads() };
          break;
        }

        // ═══════════════════════════════════════
        // COOKIES & STORAGE
        // ═══════════════════════════════════════

        case 'get_cookies': {
          const cookies = await browserEngine.browserContext.cookies();
          const filtered = input.cookieDomain
            ? cookies.filter((c: any) => c.domain.includes(input.cookieDomain))
            : cookies;
          result = { cookies: filtered.slice(0, 50), total: filtered.length };
          break;
        }

        case 'set_cookie': {
          if (!input.cookieName || !input.cookieValue) return fail(action, 'cookieName and cookieValue required');
          await browserEngine.browserContext.addCookies([{
            name: input.cookieName,
            value: input.cookieValue,
            domain: input.cookieDomain || new URL(page.url()).hostname,
            path: '/',
          }]);
          result = { set: input.cookieName };
          break;
        }

        case 'clear_cookies': {
          await browserEngine.browserContext.clearCookies();
          result = { cleared: true };
          break;
        }

        case 'get_storage': {
          const storageType = input.storageType || 'local';
          const storageData = await page.evaluate((type: string) => {
            const storage = type === 'session' ? sessionStorage : localStorage;
            const data: Record<string, string> = {};
            for (let i = 0; i < Math.min(storage.length, 100); i++) {
              const key = storage.key(i);
              if (key) data[key] = (storage.getItem(key) || '').substring(0, 200);
            }
            return data;
          }, storageType);
          
          result = { type: storageType, data: storageData, count: Object.keys(storageData).length };
          break;
        }

        case 'set_storage': {
          if (!input.storageKey) return fail(action, 'storageKey required');
          const storageType = input.storageType || 'local';
          await page.evaluate(({ type, key, value }: any) => {
            const storage = type === 'session' ? sessionStorage : localStorage;
            if (value != null) {
              storage.setItem(key, value);
            } else {
              storage.removeItem(key);
            }
          }, { type: storageType, key: input.storageKey, value: input.storageValue });
          
          result = { set: input.storageKey, type: storageType };
          break;
        }

        // ═══════════════════════════════════════
        // NETWORK
        // ═══════════════════════════════════════

        case 'monitor_network': {
          await networkMonitor.startIntercepting(page);
          
          const headers = parseStringRecord(input.headers);
          if (Object.keys(headers).length > 0) {
            await networkMonitor.setCustomHeaders(page, headers);
          }
          
          result = { monitoring: true };
          break;
        }

        case 'block_urls': {
          if (!input.urlPatterns || input.urlPatterns.length === 0) return fail(action, 'urlPatterns required');
          await networkMonitor.blockUrls(page, input.urlPatterns);
          result = { blocked: input.urlPatterns.length, patterns: input.urlPatterns };
          break;
        }

        case 'get_requests': {
          const requests = input.urlFilter
            ? networkMonitor.getRequests({ urlPattern: input.urlFilter })
            : networkMonitor.getApiRequests(); // Default: show API requests
          
          // Compact format for AI
          const compact = requests.slice(-30).map(r => ({
            method: r.method,
            url: r.url.substring(0, 100),
            status: r.status || 'pending',
            type: r.resourceType,
            size: r.responseSize ? `${Math.round(r.responseSize / 1024)}KB` : '-',
            time: r.duration ? `${r.duration}ms` : '-',
          }));
          
          result = { requests: compact, total: requests.length };
          break;
        }

        case 'network_stats': {
          result = networkMonitor.getStats();
          break;
        }

        // ═══════════════════════════════════════
        // SESSION & PROFILES
        // ═══════════════════════════════════════

        case 'profiles': {
          const profiles = await browserSessionManager.listProfiles();
          result = {
            profiles: profiles.map(p => ({
              name: p.name,
              lastUsed: p.lastUsed ? new Date(p.lastUsed).toISOString() : 'never',
              cookies: p.cookies,
              notes: p.notes,
            })),
            count: profiles.length,
          };
          break;
        }

        case 'save_session': {
          const profile = input.profile || 'default';
          await browserSessionManager.saveState(browserEngine.browserContext, page, profile);
          result = { saved: profile };
          break;
        }

        case 'restore_session': {
          const profile = input.profile || 'default';
          const restored = await browserSessionManager.restoreState(browserEngine.browserContext, page, profile);
          result = { restored, profile };
          break;
        }

        case 'export_cookies': {
          const profile = input.profile || 'default';
          const cookies = await browserSessionManager.exportCookies(browserEngine.browserContext, profile);
          result = { exported: cookies.length, profile };
          break;
        }

        case 'import_cookies': {
          const profile = input.profile || 'default';
          const count = await browserSessionManager.importCookies(browserEngine.browserContext, profile);
          result = { imported: count, profile };
          break;
        }

        // ═══════════════════════════════════════
        // PAGE SETTINGS
        // ═══════════════════════════════════════

        case 'set_viewport': {
          if (!input.width || !input.height) return fail(action, 'width and height required');
          await page.setViewportSize({ width: input.width, height: input.height });
          result = { viewport: { width: input.width, height: input.height } };
          domSnapshot.invalidate();
          break;
        }

        case 'emulate_device': {
          const deviceName = input.device || 'iPhone 15';
          // Common device presets
          const devices: Record<string, { width: number; height: number; ua: string; mobile: boolean }> = {
            'iphone 15': { width: 393, height: 852, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', mobile: true },
            'iphone 14': { width: 390, height: 844, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)', mobile: true },
            'pixel 7': { width: 412, height: 915, ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7)', mobile: true },
            'ipad pro': { width: 1024, height: 1366, ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', mobile: true },
            'galaxy s24': { width: 360, height: 780, ua: 'Mozilla/5.0 (Linux; Android 14; SM-S921B)', mobile: true },
            'desktop': { width: 1920, height: 1080, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', mobile: false },
            'laptop': { width: 1366, height: 768, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', mobile: false },
          };
          
          const preset = devices[deviceName.toLowerCase()] || devices['desktop'];
          await page.setViewportSize({ width: preset.width, height: preset.height });
          result = { emulating: deviceName, viewport: { width: preset.width, height: preset.height } };
          domSnapshot.invalidate();
          break;
        }

        case 'set_geolocation': {
          if (input.latitude == null || input.longitude == null) return fail(action, 'latitude and longitude required');
          await browserEngine.browserContext.setGeolocation({ 
            latitude: input.latitude, 
            longitude: input.longitude 
          });
          await browserEngine.browserContext.grantPermissions(['geolocation']);
          result = { geolocation: { latitude: input.latitude, longitude: input.longitude } };
          break;
        }

        // ═══════════════════════════════════════
        // CONSOLE
        // ═══════════════════════════════════════

        case 'get_console': {
          const logs = browserEngine.getConsoleLogs();
          const recent = logs.slice(-30).map(l => ({
            type: l.type,
            text: l.text.substring(0, 200),
            time: new Date(l.timestamp).toISOString(),
          }));
          result = { logs: recent, total: logs.length };
          break;
        }

        case 'clear_console': {
          browserEngine.clearConsoleLogs();
          result = { cleared: true };
          break;
        }

        // ═══════════════════════════════════════
        // DIALOG
        // ═══════════════════════════════════════

        case 'set_dialog_action': {
          const dialogAction = input.dialogAction || 'accept';
          browserEngine.setDialogAction(dialogAction);
          result = { dialogAction };
          break;
        }

        default:
          return fail(action, `Unknown action: ${action}. Check available actions.`);
      }

      console.log(`[BrowserControl] done ${action} in ${Date.now() - startedAt}ms`);
      return {
        success: true,
        action,
        result,
        snapshotText,
        currentUrl: page.url(),
        pageTitle: await page.title().catch(() => ''),
        elapsedMs: Date.now() - startedAt,
      };

    } catch (error: any) {
      console.error(`[BrowserControl] ❌ ${action}:`, error.message?.substring(0, 500));
      
      // Smart error recovery suggestions
      let recovery = '';
      let nextAction = 'retry the same action once';
      const msg = error.message || '';

      if (msg.includes('ref') && msg.includes('not found')) {
        domSnapshot.invalidate();
        recovery = 'The snapshot is stale. Take a fresh snapshot, then use the new ref.';
        nextAction = 'snapshot';
      } else if (msg.includes('not connected')) {
        recovery = 'Browser is not connected.';
        nextAction = 'launch';
      } else if (msg.includes('not found') || msg.includes('strict mode violation')) {
        recovery = 'The target was not found or was ambiguous. Read the page, then target by ref.';
        nextAction = 'snapshot';
      } else if (msg.includes('timeout') || msg.includes('Timeout')) {
        recovery = 'The page or element took too long. Continue with a fresh snapshot before retrying.';
        nextAction = 'snapshot';
      } else if (msg.includes('Execution context') || msg.includes('Target closed') || msg.includes('detached') || msg.includes('navigated')) {
        domSnapshot.invalidate();
        recovery = 'The page changed during the action. Refresh browser state before continuing.';
        nextAction = 'snapshot';
      }

      let currentUrl: string | undefined;
      let pageTitle: string | undefined;
      let activePage: any;
      try {
        if (browserEngine.connected) {
          activePage = await browserEngine.getActivePage();
          currentUrl = activePage.url();
          pageTitle = await activePage.title().catch(() => '');
        }
      } catch {}

      if (activePage && nextAction === 'snapshot') {
        return await failWithPageState(
          activePage,
          action,
          `Failed: ${msg.substring(0, 400)}${recovery ? ` | Recovery: ${recovery}` : ''}`,
          recovery,
          nextAction,
          input,
          startedAt
        );
      }
      
      return {
        success: false,
        action,
        result: `Failed: ${msg.substring(0, 400)}${recovery ? ` | Recovery: ${recovery}` : ''}`,
        recovery,
        nextAction,
        currentUrl,
        pageTitle,
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      if (activityPage && input.visualFeedback !== false) {
        scheduleBrowserActivityIdleEnd(activityPage);
      }
    }
    }); // end withBrowserLock
  }
};

function parseStringRecord(value: Record<string, string> | string | undefined): Record<string, string> {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const normalized: Record<string, string> = {};
    for (const [key, recordValue] of Object.entries(parsed)) {
      normalized[key] = String(recordValue);
    }
    return normalized;
  } catch {
    return {};
  }
}
