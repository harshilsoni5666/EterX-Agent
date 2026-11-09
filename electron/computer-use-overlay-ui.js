// Local, script-free, transparent desktop chrome. No app content or credentials
// enter this renderer; the main process owns its lifetime and stop shortcut.
module.exports = function computerUseOverlayHtml(bannerTop) {
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <style>
    @property --orbit { syntax: '<angle>'; initial-value: 0deg; inherits: false; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; pointer-events: none; }
    body { opacity: 1; transition: opacity 280ms ease; }
    body.leaving { opacity: 0; }
    .edge { position: fixed; inset: 0; border-radius: 15px; opacity: 0; animation: arrive 450ms ease forwards; }
    .edge::before, .edge::after { content: ''; position: absolute; border-radius: inherit; }
    .edge::before {
      inset: 0; padding: 3px;
      background: conic-gradient(from var(--orbit), #579aff80 0%, #a6d9ffdd 9%, #4879ff50 23%, #5d9cff22 33%, #a2e6ffff 45%, #4b86ff80 55%, #b0e7ffff 68%, #496bff44 81%, #579aff80 100%);
      mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      mask-composite: exclude;
      animation: orbit 11s linear infinite;
    }
    .edge::after {
      inset: 2px; border: 1px solid #a9d8ff8c;
      box-shadow: inset 0 0 12px #6eb7ff66, inset 0 0 30px #4388ff30, 0 0 8px #b9e7ff70;
    }
    .clouds { position: fixed; inset: 0; opacity: .8; animation: breathe 5s ease-in-out infinite alternate; }
    .clouds::before, .clouds::after {
      content: ''; position: absolute; inset: -12px;
      background:
        radial-gradient(ellipse 210px 75px at 3% 0%, #76c5ff9c, transparent 75%),
        radial-gradient(ellipse 230px 72px at 75% 100%, #4b90ff99, transparent 80%),
        radial-gradient(ellipse 60px 240px at 100% 30%, #83caff96, transparent 80%),
        radial-gradient(ellipse 65px 220px at 0% 72%, #5c9fff9e, transparent 82%);
      filter: blur(13px);
      animation: drift 8s ease-in-out infinite alternate;
    }
    .clouds::after { transform: rotate(180deg); opacity: .62; animation-delay: -4s; filter: blur(20px); }
    .corners { position: fixed; inset: 0;
      background:
        radial-gradient(circle 72px at 0 0, #c4edff95, #579dff50 35%, transparent 78%),
        radial-gradient(circle 72px at 100% 0, #b8e4ff95, #579dff50 35%, transparent 78%),
        radial-gradient(circle 72px at 100% 100%, #bdeaff95, #579dff50 35%, transparent 78%),
        radial-gradient(circle 72px at 0 100%, #c4edff95, #579dff50 35%, transparent 78%);
      filter: blur(8px); animation: breathe 4s ease-in-out infinite alternate-reverse;
    }
    .banner { position: absolute; top: ${Math.round(bannerTop)}px; left: 50%; transform: translateX(-50%);
      display: flex; align-items: center; gap: 9px; white-space: nowrap;
      max-width: calc(100vw - 40px); padding: 10px 16px; border-radius: 999px;
      border: 1px solid #b6d7ff45; background: linear-gradient(120deg, #10233cf2, #172c4af5);
      box-shadow: 0 5px 24px #06142635, inset 0 1px 0 #ffffff15, 0 0 18px #68b1ff20;
      color: #edf6ff; font: 500 12px/18px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      letter-spacing: .08px; animation: banner-in 400ms cubic-bezier(.2,.8,.2,1) both;
    }
    .dot { width: 6px; height: 6px; border-radius: 100%; background: #a9ddff; box-shadow: 0 0 9px #74bcff; animation: breathe 2s ease-in-out infinite alternate; }
    kbd { font: inherit; font-size: 11px; padding: 1px 6px; border: 1px solid #b5d7ff45; border-radius: 5px; background: #ffffff0a; box-shadow: 0 1px 0 #0006; }
    strong { font-weight: 600; }
    @keyframes orbit { to { --orbit: 360deg; } }
    @keyframes breathe { from { opacity: .48; } to { opacity: .88; } }
    @keyframes drift { from { translate: -10px -6px; } to { translate: 10px 6px; } }
    @keyframes arrive { to { opacity: 1; } }
    @keyframes banner-in { from { opacity: 0; translate: 0 -8px; } to { opacity: 1; translate: 0 0; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition-duration: 100ms !important; } .edge { opacity: 1; } }
  </style></head><body>
    <div class="clouds" aria-hidden="true"></div><div class="corners" aria-hidden="true"></div><div class="edge" aria-hidden="true"></div>
    <div class="banner" role="status"><span class="dot" aria-hidden="true"></span><span>Press <kbd>Escape</kbd> to stop <strong>EterX computer use</strong></span></div>
  </body></html>`;
};
