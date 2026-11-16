// Local, script-free, transparent desktop chrome. No app content or credentials
// enter this renderer; the main process owns its lifetime and stop shortcut.
module.exports = function computerUseOverlayHtml(bannerTop) {
  const top = Math.max(10, Math.round(Number(bannerTop) || 14));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <style>
    :root { color-scheme: dark; --banner-top: ${top}px; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; pointer-events: none; }
    body { opacity: 1; transition: opacity 180ms ease-out; user-select: none; -webkit-font-smoothing: antialiased; }
    body.leaving { opacity: 0; }
    .perimeter {
      position: fixed; inset: 0; overflow: hidden; pointer-events: none;
      border: 1px solid rgb(105 158 241 / 56%);
      box-shadow: inset 0 0 5px rgb(88 144 231 / 20%), inset 0 0 15px rgb(70 128 220 / 9%);
      animation: edge-in 280ms ease-out both;
    }
    .edge-glow { position: absolute; display: block; opacity: .65; filter: blur(5px); will-change: transform; }
    .horizontal {
      left: -20%; width: 140%; height: 38px;
      background: radial-gradient(ellipse at 25% 50%, #80b5ff6b, transparent 36%), radial-gradient(ellipse at 78% 50%, #5a9aff4d, transparent 32%);
      animation: drift-x 18s ease-in-out infinite alternate;
    }
    .vertical {
      top: -20%; width: 38px; height: 140%;
      background: radial-gradient(ellipse at 50% 28%, #80b5ff61, transparent 36%), radial-gradient(ellipse at 50% 76%, #5a9aff47, transparent 32%);
      animation: drift-y 22s ease-in-out infinite alternate;
    }
    .top { top: -24px; }
    .bottom { bottom: -24px; animation-delay: -9s; animation-direction: alternate-reverse; }
    .left { left: -24px; animation-delay: -5s; }
    .right { right: -24px; animation-delay: -13s; animation-direction: alternate-reverse; }
    .corners { position: absolute; inset: 0;
      background:
        radial-gradient(circle 44px at 0 0, #8dbaff50, #548ee721 42%, transparent 85%),
        radial-gradient(circle 44px at 100% 0, #8dbaff50, #548ee721 42%, transparent 85%),
        radial-gradient(circle 44px at 100% 100%, #8dbaff50, #548ee721 42%, transparent 85%),
        radial-gradient(circle 44px at 0 100%, #8dbaff50, #548ee721 42%, transparent 85%);
    }
    .banner { position: fixed; top: var(--banner-top); left: 50%; transform: translateX(-50%);
      display: flex; align-items: center; gap: 12px; max-width: calc(100vw - 32px);
      min-height: 36px; padding: 8px 13px; border: 1px solid rgb(255 255 255 / 12%); border-radius: 9px;
      background: rgb(20 23 29 / 97%); color: #edf0f5;
      box-shadow: 0 4px 16px rgb(0 0 0 / 19%), 0 1px 3px rgb(0 0 0 / 12%);
      font: 400 12px/18px -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', sans-serif;
      animation: banner-in 220ms ease-out both;
    }
    .identity, .shortcut { display: inline-flex; align-items: center; white-space: nowrap; }
    .identity { gap: 8px; min-width: 0; }
    .status-dot { flex: none; width: 4px; height: 4px; border-radius: 50%; background: #8ab4f8; }
    .brand { font-weight: 600; letter-spacing: -.15px; }
    .activity { color: #c0c7d2; }
    .divider { flex: none; width: 1px; height: 14px; background: rgb(255 255 255 / 12%); }
    .shortcut { gap: 6px; color: #aeb7c5; font-size: 11px; }
    kbd { display: inline-flex; align-items: center; justify-content: center; height: 20px; min-width: 29px;
      margin: -1px 0; padding: 0 5px; border: 1px solid rgb(255 255 255 / 17%); border-radius: 4px;
      background: rgb(255 255 255 / 5%); color: #e2e7ef;
      font: 500 10px/1 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
    }
    @keyframes edge-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes banner-in { from { opacity: 0; transform: translate(-50%, -3px); } to { opacity: 1; transform: translate(-50%, 0); } }
    @keyframes drift-x { from { transform: translate3d(-6%, 0, 0); } to { transform: translate3d(6%, 0, 0); } }
    @keyframes drift-y { from { transform: translate3d(0, -5%, 0); } to { transform: translate3d(0, 5%, 0); } }
    @media (max-width: 380px) { .banner { gap: 8px; padding: 7px 10px; font-size: 11px; } .identity { gap: 6px; } .shortcut { gap: 4px; font-size: 10px; } }
    @media (max-width: 300px) { .banner { flex-wrap: wrap; justify-content: center; } .divider { display: none; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition-duration: 100ms !important; will-change: auto; } }
    @media (prefers-contrast: more) { .banner { background: #14171d; border-color: #aeb7c5; } .activity, .shortcut { color: #edf0f5; } }
  </style></head><body>
    <div class="perimeter" aria-hidden="true">
      <i class="edge-glow horizontal top"></i><i class="edge-glow horizontal bottom"></i>
      <i class="edge-glow vertical left"></i><i class="edge-glow vertical right"></i><i class="corners"></i>
    </div>
    <div class="banner" role="status" aria-label="EterX computer use is active. Press Escape to stop.">
      <span class="identity"><span class="status-dot" aria-hidden="true"></span><span class="brand">EterX</span><span class="activity">Computer use</span></span>
      <span class="divider" aria-hidden="true"></span><span class="shortcut">Press <kbd>Esc</kbd> to stop</span>
    </div>
  </body></html>`;
};
