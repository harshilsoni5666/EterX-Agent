(function () {
  if (window.__eterxExtensionOverlayReady) return;
  window.__eterxExtensionOverlayReady = true;

  const STYLE_ID = 'eterx-extension-overlay-style';
  const state = {
    frame: null,
    pill: null,
    bubble: null,
    cursor: null,
    actionTimer: null,
    idleTimer: null,
    refTimer: null,
    bubbleFrame: null,
    activeSession: false,
    promptActive: false,
    promptMode: 'done_cancel',
    cursorTarget: { x: -100, y: -100 },
    cursorCurrent: { x: -100, y: -100 },
    cursorLoop: null,
    savedHtmlCursor: null,
    last: { x: -100, y: -100 },
    lastTitle: 'EterX is using Chrome',
    lastDetail: '',
    lastBubble: 'Using Chrome'
  };

  function ensureRoot() {
    const root = document.documentElement || document.body;
    if (!root) return false;

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        @property --eterx-frame-angle {
          syntax: '<angle>';
          initial-value: 0deg;
          inherits: false;
        }
        #eterx-ext-frame {
          position: fixed;
          inset: 0;
          z-index: 2147483638;
          pointer-events: none;
          --eterx-x: 50vw;
          --eterx-y: 44vh;
          --eterx-accent-rgb: 56, 189, 248;
          --eterx-accent-2-rgb: 96, 165, 250;
          --eterx-accent-3-rgb: 167, 139, 250;
          border: 0;
          border-radius: 0;
          background: transparent;
          box-shadow: inset 0 0 0 1px rgba(224, 242, 254, 0.28);
          opacity: 0;
          transition: opacity 220ms ease;
        }
        #eterx-ext-frame.active { opacity: 1; }
        #eterx-ext-frame.active::before {
          content: "";
          position: absolute;
          inset: 0;
          padding: 3px;
          border-radius: 0;
          background: conic-gradient(
            from var(--eterx-frame-angle),
            transparent 0deg,
            transparent 54deg,
            rgba(var(--eterx-accent-2-rgb), 0.08) 84deg,
            rgb(var(--eterx-accent-rgb)) 124deg,
            #dbeafe 176deg,
            rgb(var(--eterx-accent-2-rgb)) 232deg,
            transparent 300deg,
            transparent 360deg
          );
          -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          mask-composite: exclude;
          animation: eterx-frame-spin 2.4s linear infinite;
        }
        #eterx-ext-frame.active::after {
          content: "";
          position: absolute;
          inset: 0;
          box-shadow:
            inset 0 0 0 1px rgba(var(--eterx-accent-rgb), 0.24),
            inset 0 0 32px rgba(var(--eterx-accent-rgb), 0.06);
        }
        #eterx-ext-pill {
          position: fixed;
          left: 50%;
          bottom: 18px;
          z-index: 2147483647;
          transform: translateX(-50%) translateY(10px) scale(0.98);
          display: flex;
          align-items: center;
          gap: 9px;
          max-width: min(560px, calc(100vw - 28px));
          min-height: 36px;
          padding: 5px 5px 5px 11px;
          border-radius: 8px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          background:
            linear-gradient(180deg, rgba(12, 12, 12, 0.96), rgba(3, 3, 3, 0.94)),
            linear-gradient(90deg, rgba(var(--eterx-accent-rgb), 0.06), rgba(var(--eterx-accent-3-rgb), 0.05));
          color: #fff;
          box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(255, 255, 255, 0.04), 0 0 32px rgba(var(--eterx-accent-rgb), 0.18);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          pointer-events: auto;
          overflow: hidden;
          opacity: 0;
          transition: opacity 180ms ease, transform 180ms cubic-bezier(.2,.8,.2,1);
          font: 720 12px/1.1 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        #eterx-ext-bubble {
          position: fixed;
          left: -999px;
          top: -999px;
          z-index: 2147483646;
          max-width: min(340px, calc(100vw - 32px));
          padding: 10px 14px;
          border-radius: 16px;
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(0, 0, 0, 0.92);
          color: #fff;
          box-shadow: 0 14px 34px rgba(0, 0, 0, 0.36), 0 0 0 1px rgba(255, 255, 255, 0.04);
          pointer-events: none;
          opacity: 0;
          transform: scale(0.98);
          transition:
            opacity 150ms ease,
            transform 150ms cubic-bezier(.2,.8,.2,1),
            left 105ms cubic-bezier(.2,.8,.2,1),
            top 105ms cubic-bezier(.2,.8,.2,1);
          will-change: left, top, opacity, transform;
          font: 760 13px/1.2 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        #eterx-ext-bubble::before {
          content: "";
          position: absolute;
          left: -4px;
          top: 14px;
          width: 10px;
          height: 10px;
          border-radius: 2px;
          background: rgba(0, 0, 0, 0.92);
          transform: rotate(45deg);
          box-shadow: -1px 1px 0 rgba(255, 255, 255, 0.05);
        }
        #eterx-ext-bubble.flip-x::before {
          left: auto;
          right: -4px;
          box-shadow: 1px -1px 0 rgba(255, 255, 255, 0.05);
        }
        #eterx-ext-bubble.flip-y::before {
          top: auto;
          bottom: -4px;
        }
        #eterx-ext-bubble.active {
          opacity: 1;
          transform: scale(1);
        }
        #eterx-ext-pill::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background: linear-gradient(90deg, transparent, rgba(var(--eterx-accent-rgb), 0.13), transparent);
          transform: translateX(-100%);
          animation: eterx-ext-pill-sheen 2.8s ease-in-out infinite;
          pointer-events: none;
        }
        #eterx-ext-pill.active {
          opacity: 1;
          transform: translateX(-50%) translateY(0) scale(1);
        }
        #eterx-ext-pill.prompt {
          width: min(560px, calc(100vw - 28px));
          min-height: 42px;
          flex-wrap: wrap;
          align-items: stretch;
          padding: 9px;
          border-color: rgba(var(--eterx-accent-rgb), 0.34);
          box-shadow: 0 20px 52px rgba(0, 0, 0, 0.46), 0 0 0 1px rgba(255, 255, 255, 0.05), 0 0 42px rgba(var(--eterx-accent-rgb), 0.22);
        }
        #eterx-ext-pill.prompt .eterx-ext-pill-text {
          max-width: none;
          flex: 1 1 280px;
        }
        .eterx-ext-pause {
          position: relative;
          z-index: 1;
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #22c55e;
          box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.14);
          animation: eterx-ext-live-dot 1.4s ease-in-out infinite;
          opacity: .95;
          flex: 0 0 auto;
        }
        .eterx-ext-pill-text {
          position: relative;
          z-index: 1;
          min-width: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          gap: 2px;
          flex: 1 1 auto;
          max-width: 340px;
        }
        .eterx-ext-pill-title,
        .eterx-ext-pill-detail {
          min-width: 0;
          white-space: nowrap;
          text-overflow: ellipsis;
          overflow: hidden;
        }
        .eterx-ext-pill-title {
          font-weight: 760;
        }
        .eterx-ext-pill-detail {
          color: rgba(255, 255, 255, 0.74);
          font-size: 11px;
          font-weight: 620;
        }
        .eterx-ext-pill-actions {
          position: relative;
          z-index: 1;
          display: flex;
          align-items: center;
          gap: 5px;
          margin-left: 4px;
        }
        .eterx-ext-pill-button {
          height: 26px;
          padding: 0 9px;
          border: 0;
          border-radius: 7px;
          background: rgba(255, 255, 255, 0.12);
          color: rgba(255, 255, 255, 0.94);
          cursor: pointer;
          font: 760 11px/1 ui-sans-serif, system-ui, sans-serif;
        }
        .eterx-ext-pill-button:hover {
          background: rgba(255, 255, 255, 0.18);
        }
        .eterx-ext-pill-button.stop {
          background: rgba(239, 68, 68, 0.95);
          color: #fff;
        }
        .eterx-ext-pill-button.stop:hover {
          background: rgba(220, 38, 38, 0.98);
        }
        #eterx-ext-pill.prompt .eterx-ext-pill-button[data-eterx-control="take"] {
          background: rgba(255, 255, 255, 0.92);
          color: #0a0a0a;
        }
        #eterx-ext-pill.prompt .eterx-ext-pill-button[data-eterx-control="take"]:hover {
          background: #fff;
        }
        .eterx-ext-prompt-area {
          position: relative;
          z-index: 1;
          flex: 1 0 100%;
          display: flex;
          align-items: center;
          gap: 7px;
          margin-top: 2px;
          min-width: 0;
        }
        .eterx-ext-prompt-area.options {
          flex-wrap: wrap;
        }
        .eterx-ext-option {
          min-width: 0;
          max-width: 180px;
          height: 30px;
          padding: 0 11px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.10);
          color: rgba(255, 255, 255, 0.94);
          cursor: pointer;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font: 760 11px/1 ui-sans-serif, system-ui, sans-serif;
        }
        .eterx-ext-option:hover {
          border-color: rgba(var(--eterx-accent-rgb), 0.42);
          background: rgba(var(--eterx-accent-rgb), 0.16);
        }
        .eterx-ext-answer {
          flex: 1 1 auto;
          min-width: 130px;
          height: 32px;
          padding: 0 11px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          border-radius: 8px;
          outline: 0;
          background: rgba(255, 255, 255, 0.09);
          color: #fff;
          font: 650 12px/1 ui-sans-serif, system-ui, sans-serif;
        }
        .eterx-ext-answer:focus {
          border-color: rgba(var(--eterx-accent-rgb), 0.52);
          box-shadow: 0 0 0 2px rgba(var(--eterx-accent-rgb), 0.14);
        }
        #eterx-ext-cursor {
          position: fixed;
          left: 0;
          top: 0;
          width: 18px;
          height: 22px;
          z-index: 2147483647;
          pointer-events: none;
          opacity: 0;
          transform: translate(-100px, -100px);
          transition: opacity 120ms ease, filter 130ms ease;
          will-change: transform, opacity;
          filter: drop-shadow(0 8px 12px rgba(0, 0, 0, 0.42));
        }
        #eterx-ext-cursor.active {
          opacity: 1;
        }
        #eterx-ext-cursor svg {
          display: block;
          width: 18px;
          height: 22px;
          transform-origin: 4px 4px;
          transition: transform 90ms ease;
        }
        #eterx-ext-cursor.down {
          filter: drop-shadow(0 0 14px rgba(56, 189, 248, 0.70));
        }
        #eterx-ext-cursor.down svg {
          transform: scale(0.92);
        }
        .eterx-ext-click {
          position: fixed;
          z-index: 2147483646;
          width: 18px;
          height: 18px;
          border: 3px solid rgba(103, 232, 249, 0.90);
          border-radius: 999px;
          background: rgba(45, 212, 191, 0.12);
          pointer-events: none;
          transform: translate(-50%, -50%);
          animation: eterx-ext-click 620ms ease-out forwards;
        }
        .eterx-ext-focus {
          position: fixed;
          z-index: 2147483644;
          pointer-events: none;
          border-radius: 10px;
          border: 2px solid rgba(103, 232, 249, 0.72);
          box-shadow: 0 0 0 3px rgba(103, 232, 249, 0.16), 0 0 28px rgba(45, 212, 191, 0.22);
          animation: eterx-ext-fade 820ms ease-out forwards;
        }
        .eterx-ext-key {
          position: fixed;
          left: 50%;
          top: 22px;
          z-index: 2147483647;
          transform: translateX(-50%);
          padding: 8px 12px;
          border-radius: 14px;
          border: 1px solid rgba(103, 232, 249, 0.34);
          background: rgba(250, 250, 248, 0.88);
          color: #243334;
          box-shadow: 0 14px 36px rgba(15, 23, 42, 0.18), 0 0 26px rgba(45, 212, 191, 0.18);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          pointer-events: none;
          font: 750 12px/1 ui-sans-serif, system-ui, sans-serif;
          animation: eterx-ext-key 780ms ease-out forwards;
        }
        .eterx-ext-scroll {
          position: fixed;
          left: 50%;
          top: 50%;
          z-index: 2147483647;
          width: 56px;
          height: 56px;
          margin-left: -28px;
          margin-top: -28px;
          display: grid;
          place-items: center;
          border-radius: 999px;
          border: 2px solid rgba(103, 232, 249, 0.70);
          background: rgba(240, 253, 250, 0.74);
          color: #123245;
          box-shadow: 0 14px 36px rgba(15, 23, 42, 0.18), 0 0 26px rgba(45, 212, 191, 0.18);
          pointer-events: none;
          font: 850 22px/1 ui-sans-serif, system-ui, sans-serif;
          animation: eterx-ext-scroll 820ms ease-out forwards;
        }
        .eterx-ext-drag-line {
          position: fixed;
          height: 3px;
          transform-origin: left center;
          border-radius: 999px;
          background: linear-gradient(90deg, #38bdf8, rgba(37, 99, 235, 0.25));
          box-shadow: 0 0 20px rgba(14, 165, 233, 0.42);
          pointer-events: none;
          z-index: 2147483645;
          animation: eterx-ext-fade 900ms ease-out forwards;
        }
        .eterx-ext-ref-layer {
          position: fixed;
          inset: 0;
          z-index: 2147483644;
          pointer-events: none;
        }
        .eterx-ext-ref-box {
          position: fixed;
          border: 2px solid rgba(56, 189, 248, 0.72);
          border-radius: 8px;
          background: rgba(14, 165, 233, 0.035);
          box-shadow: 0 0 0 1px rgba(2, 132, 199, 0.16), 0 0 22px rgba(14, 165, 233, 0.16);
          animation: eterx-ext-ref-in 160ms ease-out both;
        }
        .eterx-ext-ref-badge {
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
          color: #fff;
          box-shadow: 0 8px 18px rgba(2, 132, 199, 0.32);
          font: 800 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        .eterx-ext-ref-kind {
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
        @keyframes eterx-ext-click {
          0% { opacity: .95; width: 18px; height: 18px; }
          100% { opacity: 0; width: 78px; height: 78px; }
        }
        @keyframes eterx-ext-fade {
          0%, 70% { opacity: 1; }
          100% { opacity: 0; }
        }
        @keyframes eterx-ext-key {
          0% { opacity: 0; transform: translateX(-50%) translateY(-8px) scale(.96); }
          16%, 74% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
          100% { opacity: 0; transform: translateX(-50%) translateY(-4px) scale(.98); }
        }
        @keyframes eterx-ext-scroll {
          0% { opacity: 0; transform: translateY(8px) scale(.9); }
          18% { opacity: 1; transform: translateY(0) scale(1); }
          100% { opacity: 0; transform: translateY(-22px) scale(1.08); }
        }
        @keyframes eterx-ext-ref-in {
          0% { opacity: 0; transform: scale(.985); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes eterx-frame-spin {
          to { --eterx-frame-angle: 360deg; }
        }
        @keyframes eterx-ext-pill-sheen {
          0%, 38% { transform: translateX(-110%); opacity: 0; }
          48% { opacity: 1; }
          78%, 100% { transform: translateX(110%); opacity: 0; }
        }
        @keyframes eterx-ext-live-dot {
          0%, 100% { transform: scale(1); box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.12); }
          50% { transform: scale(1.15); box-shadow: 0 0 0 6px rgba(34, 197, 94, 0.05); }
        }
      `;
      root.appendChild(style);
    }

    if (!state.frame || !state.frame.isConnected) {
      state.frame = document.createElement('div');
      state.frame.id = 'eterx-ext-frame';
      root.appendChild(state.frame);
    }
    if (!state.pill || !state.pill.isConnected) {
      state.pill = document.createElement('div');
      state.pill.id = 'eterx-ext-pill';
      state.pill.innerHTML = '<span class="eterx-ext-pause"></span><span class="eterx-ext-pill-text"><span class="eterx-ext-pill-title">EterX is using Chrome</span><span class="eterx-ext-pill-detail"></span></span><span class="eterx-ext-pill-actions"><button class="eterx-ext-pill-button" data-eterx-control="take" type="button">Take control</button><button class="eterx-ext-pill-button stop" data-eterx-control="stop" type="button">Stop</button></span>';
      state.pill.addEventListener('click', (event) => {
        const button = event.target && event.target.closest && event.target.closest('[data-eterx-control]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const control = button.getAttribute('data-eterx-control');
        if (state.promptActive) {
          if (control === 'stop') {
            if (state.promptMode === 'yes_no') {
              emitPromptResponse({ choice: 'no', value: false });
            } else {
              emitPromptResponse({ choice: 'cancel', cancelled: true });
            }
            return;
          }

          if (state.promptMode === 'yes_no') {
            emitPromptResponse({ choice: 'yes', value: true });
            return;
          }

          if (state.promptMode === 'short_answer') {
            const answer = state.pill.querySelector('.eterx-ext-answer');
            const value = answer ? String(answer.value || '').trim() : '';
            emitPromptResponse({ choice: 'answer', answer: value, value });
            return;
          }

          emitPromptResponse({ choice: 'done' });
          return;
        }
        if (control === 'stop') {
          window.__eterxBrowserStopRequested = true;
          document.dispatchEvent(new CustomEvent('eterx-control-stop-requested'));
        } else {
          document.dispatchEvent(new CustomEvent('eterx-control-takeover'));
        }
        deactivate();
      });
      root.appendChild(state.pill);
    }
    if (!state.bubble || !state.bubble.isConnected) {
      state.bubble = document.createElement('div');
      state.bubble.id = 'eterx-ext-bubble';
      state.bubble.textContent = 'Using Chrome';
      root.appendChild(state.bubble);
    }
    if (!state.cursor || !state.cursor.isConnected) {
      state.cursor = document.createElement('div');
      state.cursor.id = 'eterx-ext-cursor';
      state.cursor.innerHTML = '<svg width="18" height="22" viewBox="0 0 18 22" fill="none" aria-hidden="true"><path d="M2 1l14 7-5.5 2L8 17 2 1z" fill="#000000" stroke="#ffffff" stroke-width="1" stroke-linejoin="round"/></svg>';
      root.appendChild(state.cursor);
    }
    return true;
  }

  function setStatus(title, detail, bubble) {
    state.lastTitle = String(title || state.lastTitle || 'EterX is using Chrome').slice(0, 80);
    state.lastDetail = String(detail || '').slice(0, 140);
    state.lastBubble = normalizeBubbleLabel(bubble || state.lastBubble || title || detail || 'Using Chrome');
    if (!ensureRoot()) return;
    const titleNode = state.pill.querySelector('.eterx-ext-pill-title');
    const detailNode = state.pill.querySelector('.eterx-ext-pill-detail');
    if (titleNode) titleNode.textContent = state.lastTitle;
    if (state.bubble) state.bubble.textContent = state.lastBubble;
    if (detailNode) {
      detailNode.textContent = state.lastDetail;
      detailNode.style.display = state.lastDetail ? 'block' : 'none';
    }
  }

  function setButtonLabels(primary, secondary) {
    if (!state.pill) return;
    const primaryButton = state.pill.querySelector('[data-eterx-control="take"]');
    const secondaryButton = state.pill.querySelector('[data-eterx-control="stop"]');
    if (primaryButton) primaryButton.textContent = primary || 'Take control';
    if (secondaryButton) secondaryButton.textContent = secondary || 'Stop';
  }

  function setButtonVisibility(primaryVisible, secondaryVisible) {
    if (!state.pill) return;
    const primaryButton = state.pill.querySelector('[data-eterx-control="take"]');
    const secondaryButton = state.pill.querySelector('[data-eterx-control="stop"]');
    if (primaryButton) primaryButton.style.display = primaryVisible === false ? 'none' : '';
    if (secondaryButton) secondaryButton.style.display = secondaryVisible === false ? 'none' : '';
  }

  function clearPromptArea() {
    if (!state.pill) return;
    const area = state.pill.querySelector('.eterx-ext-prompt-area');
    if (area) area.remove();
  }

  function getPromptArea(className) {
    if (!state.pill) return null;
    clearPromptArea();
    const area = document.createElement('div');
    area.className = `eterx-ext-prompt-area${className ? ` ${className}` : ''}`;
    state.pill.appendChild(area);
    return area;
  }

  function emitPromptResponse(detail) {
    const response = Object.assign({ at: Date.now() }, detail || {});
    document.dispatchEvent(new CustomEvent('eterx-control-user-response', { detail: response }));
    endPromptMode(response.choice || 'done');
  }

  function showUserPrompt(detail) {
    state.promptActive = true;
    const options = Array.isArray(detail && detail.options)
      ? detail.options.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
      : [];
    const requestedMode = String((detail && (detail.mode || detail.responseMode)) || '').toLowerCase();
    const mode = requestedMode || (options.length ? 'multiple_choice' : 'done_cancel');
    state.promptMode = ['multiple_choice', 'short_answer', 'yes_no', 'done_cancel'].includes(mode) ? mode : 'done_cancel';
    const title = detail && detail.title ? detail.title : (detail && detail.question ? detail.question : 'Please complete this');
    const body = detail && detail.message ? detail.message : (detail && detail.question ? detail.question : 'Finish the step in Chrome, then choose Done.');
    const bubble = detail && (detail.bubble || detail.label) ? (detail.bubble || detail.label) : 'Waiting for you';
    let doneLabel = detail && detail.doneLabel ? detail.doneLabel : 'Done';
    let cancelLabel = detail && detail.cancelLabel ? detail.cancelLabel : 'Cancel';

    clearPromptArea();
    setButtonVisibility(true, true);
    if (state.promptMode === 'yes_no') {
      doneLabel = detail && detail.yesLabel ? detail.yesLabel : 'Yes';
      cancelLabel = detail && detail.noLabel ? detail.noLabel : 'No';
    } else if (state.promptMode === 'short_answer') {
      doneLabel = detail && detail.submitLabel ? detail.submitLabel : 'Submit';
      const area = getPromptArea('answer');
      if (area) {
        const input = document.createElement('input');
        input.className = 'eterx-ext-answer';
        input.type = 'text';
        input.placeholder = detail && detail.placeholder ? String(detail.placeholder).slice(0, 70) : 'Type a short answer';
        input.value = detail && detail.defaultAnswer ? String(detail.defaultAnswer).slice(0, 240) : '';
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            emitPromptResponse({ choice: 'answer', answer: input.value.trim(), value: input.value.trim() });
          } else if (event.key === 'Escape') {
            event.preventDefault();
            emitPromptResponse({ choice: 'cancel', cancelled: true });
          }
        });
        area.appendChild(input);
        setTimeout(() => input.focus({ preventScroll: true }), 30);
      }
    } else if (state.promptMode === 'multiple_choice' && options.length) {
      setButtonVisibility(false, true);
      const area = getPromptArea('options');
      if (area) {
        options.forEach((option, index) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'eterx-ext-option';
          button.textContent = option;
          button.title = option;
          button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            emitPromptResponse({ choice: 'option', option, value: option, index });
          });
          area.appendChild(button);
        });
      }
    }

    setStatus(title, body, bubble);
    setButtonLabels(doneLabel, cancelLabel);
    if (state.pill) state.pill.classList.add('prompt');
    activate(0, true);
  }

  function endPromptMode(choice) {
    state.promptActive = false;
    state.promptMode = 'done_cancel';
    clearPromptArea();
    if (state.pill) state.pill.classList.remove('prompt');
    setButtonVisibility(true, true);
    setButtonLabels('Take control', 'Stop');
    setStatus(choice === 'cancel' ? 'User cancelled' : 'Continuing', '', choice === 'cancel' ? 'Cancelled' : 'Continuing');
    if (choice === 'cancel') {
      deactivate();
      return;
    }
    setNativeCursorHidden(state.activeSession);
  }

  function colorToRgb(value) {
    const text = String(value || '').trim();
    const hex = text.match(/^#?([0-9a-f]{6})$/i);
    if (hex) {
      const raw = hex[1];
      return [
        parseInt(raw.slice(0, 2), 16),
        parseInt(raw.slice(2, 4), 16),
        parseInt(raw.slice(4, 6), 16),
      ].join(', ');
    }
    const rgb = text.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
    if (rgb) {
      return [rgb[1], rgb[2], rgb[3]]
        .map((part) => Math.max(0, Math.min(255, Number(part) || 0)))
        .join(', ');
    }
    return '';
  }

  function applyTheme(theme) {
    if (!theme || !ensureRoot() || !state.frame) return;
    const accent = colorToRgb(theme.accent || theme.primary);
    const secondary = colorToRgb(theme.secondary || theme.accent2);
    const tertiary = colorToRgb(theme.tertiary || theme.accent3);
    if (accent) state.frame.style.setProperty('--eterx-accent-rgb', accent);
    if (secondary) state.frame.style.setProperty('--eterx-accent-2-rgb', secondary);
    if (tertiary) state.frame.style.setProperty('--eterx-accent-3-rgb', tertiary);
  }

  function activate(ttl, persistent) {
    if (!ensureRoot()) return;
    if (persistent) state.activeSession = true;
    setNativeCursorHidden(state.activeSession && !state.promptActive);
    setStatus(state.lastTitle, state.lastDetail, state.lastBubble);
    state.frame.classList.add('active');
    state.pill.classList.add('active');
    if (state.cursor && hasCursorPosition()) {
      state.cursor.classList.add('active');
      startCursorLoop();
    }
    if (state.bubble) {
      updateBubblePosition(state.last.x, state.last.y);
      if (hasCursorPosition()) state.bubble.classList.add('active');
    }
    clearTimeout(state.actionTimer);
    if (state.activeSession) return;
    state.actionTimer = setTimeout(() => {
      state.frame.classList.remove('active');
      state.pill.classList.remove('active');
      if (state.bubble) state.bubble.classList.remove('active');
      if (state.cursor) state.cursor.classList.remove('active');
      setNativeCursorHidden(false);
    }, ttl || 2200);
  }

  function deactivate(delay = 180) {
    state.activeSession = false;
    clearTimeout(state.actionTimer);
    state.actionTimer = setTimeout(() => {
      if (!state.activeSession && state.frame && state.pill) {
          state.frame.classList.remove('active');
          state.pill.classList.remove('active');
          if (state.bubble) state.bubble.classList.remove('active');
          if (state.cursor) state.cursor.classList.remove('active');
          setNativeCursorHidden(false);
      }
    }, Math.max(0, Number(delay) || 180));
  }

  function setNativeCursorHidden(hidden) {
    const root = document.documentElement;
    if (!root) return;
    if (hidden) {
      if (state.savedHtmlCursor === null) state.savedHtmlCursor = root.style.cursor || '';
      root.style.cursor = 'none';
      return;
    }
    if (state.savedHtmlCursor !== null) {
      root.style.cursor = state.savedHtmlCursor;
      state.savedHtmlCursor = null;
    }
  }

  function pulseClick(x, y) {
    if (!ensureRoot()) return;
    const ring = document.createElement('div');
    ring.className = 'eterx-ext-click';
    ring.style.left = x + 'px';
    ring.style.top = y + 'px';
    document.documentElement.appendChild(ring);
    setTimeout(() => ring.remove(), 760);
  }

  function updateBubblePosition(x, y) {
    if (!state.bubble || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return;
    const cursorX = Number(x);
    const cursorY = Number(y);
    const width = state.bubble.offsetWidth || 230;
    const height = state.bubble.offsetHeight || 38;
    const margin = 14;
    const gap = 22;
    const flipX = cursorX + width + gap + margin > window.innerWidth;
    const flipY = cursorY + height + gap + 74 > window.innerHeight;
    const rawLeft = flipX ? cursorX - width - gap : cursorX + gap;
    const rawTop = flipY ? cursorY - height - gap : cursorY + 12;
    const left = Math.max(margin, Math.min(rawLeft, window.innerWidth - width - margin));
    const top = Math.max(margin, Math.min(rawTop, window.innerHeight - height - 64));

    if (state.bubbleFrame) cancelAnimationFrame(state.bubbleFrame);
    state.bubbleFrame = requestAnimationFrame(() => {
      state.bubble.classList.toggle('flip-x', flipX);
      state.bubble.classList.toggle('flip-y', flipY);
      state.bubble.style.left = left + 'px';
      state.bubble.style.top = top + 'px';
    });
  }

  function normalizeBubbleLabel(value) {
    const raw = String(value || 'Using Chrome').trim();
    const marker = raw.match(
      /\[\s*bubble\s*:\s*([^\]]+)\]|\{\{\s*bubble\s*:\s*([^}]+)\}\}|::bubble\{\s*([^}]+?)\s*\}|<bubble>\s*([^<]+?)\s*<\/bubble>/i
    );
    const source = String((marker && (marker[1] || marker[2] || marker[3] || marker[4])) || raw || 'Using Chrome')
      .replace(/^EterX is\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    return source ? source.slice(0, 56) : 'Using Chrome';
  }

  function hasCursorPosition() {
    return Number.isFinite(Number(state.last.x)) && Number.isFinite(Number(state.last.y)) && Number(state.last.x) >= 0 && Number(state.last.y) >= 0;
  }

  function startCursorLoop() {
    if (!state.cursor || state.cursorLoop) return;
    const tick = () => {
      const targetX = Number(state.cursorTarget.x);
      const targetY = Number(state.cursorTarget.y);
      if (Number.isFinite(targetX) && Number.isFinite(targetY)) {
        state.cursorCurrent.x += (targetX - state.cursorCurrent.x) * 0.18;
        state.cursorCurrent.y += (targetY - state.cursorCurrent.y) * 0.18;
        state.cursor.style.transform = `translate(${state.cursorCurrent.x - 2}px, ${state.cursorCurrent.y - 2}px)`;
        if (state.bubble && state.bubble.classList.contains('active')) {
          updateBubblePosition(state.cursorCurrent.x, state.cursorCurrent.y);
        }
      }
      const distance = Math.hypot(targetX - state.cursorCurrent.x, targetY - state.cursorCurrent.y);
      if (state.activeSession || (state.cursor && state.cursor.classList.contains('active')) || distance > 0.5) {
        state.cursorLoop = requestAnimationFrame(tick);
      } else {
        state.cursorLoop = null;
      }
    };
    state.cursorLoop = requestAnimationFrame(tick);
  }

  function pulseFocus(rect) {
    // Keep target focus quiet. Ref boxes made the browser feel cluttered.
    if (!ensureRoot() || !rect) return;
  }

  function pulseKey(label) {
    if (!ensureRoot()) return;
    const node = document.createElement('div');
    node.className = 'eterx-ext-key';
    node.textContent = String(label || 'Typing').slice(0, 32);
    document.documentElement.appendChild(node);
    setTimeout(() => node.remove(), 900);
  }

  function pulseScroll(dir) {
    if (!ensureRoot()) return;
    const node = document.createElement('div');
    node.className = 'eterx-ext-scroll';
    const d = String(dir || 'down').toLowerCase();
    node.textContent = d === 'up' ? '^' : d === 'left' ? '<' : d === 'right' ? '>' : 'v';
    document.documentElement.appendChild(node);
    setTimeout(() => node.remove(), 920);
  }

  function pulseDragLine(from, to) {
    if (!ensureRoot() || !from || !to) return;
    const dx = Number(to.x || 0) - Number(from.x || 0);
    const dy = Number(to.y || 0) - Number(from.y || 0);
    const length = Math.max(1, Math.hypot(dx, dy));
    const line = document.createElement('div');
    line.className = 'eterx-ext-drag-line';
    line.style.left = Number(from.x || 0) + 'px';
    line.style.top = Number(from.y || 0) + 'px';
    line.style.width = length + 'px';
    line.style.transform = 'rotate(' + Math.atan2(dy, dx) + 'rad)';
    document.documentElement.appendChild(line);
    setTimeout(() => line.remove(), 1000);
  }

  function showRefs(refs, ttl) {
    if (!ensureRoot()) return;
    document.querySelectorAll('.eterx-ext-ref-layer').forEach((node) => node.remove());
    setStatus('Reading page', ((refs && refs.length) || 0) + ' controls indexed', 'Reading page');
    activate(Math.min(ttl || 1800, 5200));
    clearTimeout(state.refTimer);
  }

  document.addEventListener('eterx-control-action', (e) => {
    const d = e.detail || {};
    applyTheme(d.theme);
    setStatus(d.title || 'EterX is using Chrome', d.detail || '', d.bubble || d.label);
    activate(d.ttl || 2200);
  });
  document.addEventListener('eterx-control-start', (e) => {
    const d = e.detail || {};
    window.__eterxBrowserStopRequested = false;
    applyTheme(d.theme);
    setStatus(d.title || 'EterX is using Chrome', d.detail || '', d.bubble || d.label);
    activate(0, true);
  });
  document.addEventListener('eterx-control-theme', (e) => {
    applyTheme(e.detail || {});
  });
  document.addEventListener('eterx-control-user-prompt', (e) => {
    showUserPrompt(e.detail || {});
  });
  document.addEventListener('eterx-control-end', (e) => {
    const delay = e.detail && Number(e.detail.delayMs);
    deactivate(Number.isFinite(delay) ? delay : 180);
  });
  document.addEventListener('eterx-control-refs', (e) => {
    const d = e.detail || {};
    showRefs(d.refs || [], d.ttl || 1800);
  });
  document.addEventListener('eterx-control-cursor', (e) => {
    if (!ensureRoot()) return;
    const d = e.detail || {};
    const firstPosition = !hasCursorPosition();
    state.cursorTarget = { x: Number(d.x) || 0, y: Number(d.y) || 0 };
    if (firstPosition) state.cursorCurrent = { ...state.cursorTarget };
    state.last = { ...state.cursorTarget };
    state.cursor.classList.add('active');
    startCursorLoop();
    if (state.frame) {
      state.frame.style.setProperty('--eterx-x', `${Number(d.x) || 0}px`);
      state.frame.style.setProperty('--eterx-y', `${Number(d.y) || 0}px`);
    }
    updateBubblePosition(state.cursorCurrent.x, state.cursorCurrent.y);
    activate(1800);
  });
  document.addEventListener('eterx-control-mouse', (e) => {
    if (!ensureRoot()) return;
    state.cursor.classList.toggle('down', !!(e.detail && e.detail.down));
    activate(1800);
  });
  document.addEventListener('eterx-control-ring', (e) => {
    const d = e.detail || {};
    pulseClick(d.x, d.y);
    activate(1800);
  });
  document.addEventListener('eterx-control-focus', (e) => {
    pulseFocus(e.detail && e.detail.rect);
    activate(1800);
  });
  document.addEventListener('eterx-control-key', (e) => {
    pulseKey(e.detail && e.detail.label);
    activate(1800);
  });
  document.addEventListener('eterx-control-scroll', (e) => {
    pulseScroll(e.detail && e.detail.direction);
    activate(1800);
  });
  document.addEventListener('eterx-control-drag-line', (e) => {
    const d = e.detail || {};
    pulseDragLine(d.from, d.to);
    activate(1800);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureRoot, { once: true });
  } else {
    ensureRoot();
  }
})();
