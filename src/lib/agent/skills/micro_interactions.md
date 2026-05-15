---
name: micro-interactions
description: >
  Deep skill for micro-interactions, tactile feedback, and state-change animations.
  Load when user asks for: button click effects, ripple effects, toggle animations,
  checkbox animations, form validation feedback, loading spinners, success animations,
  toast notifications, badge counters, like/heart animations, pull-to-refresh,
  swipe gestures, drag interactions, or any small-scale UI feedback moment.
  Depends on: ui-engine. Works with: motion-animations, hover-effects.
  Triggers: "micro interaction", "click effect", "ripple", "toggle", "checkbox style",
  "form feedback", "success animation", "loading spinner", "toast", "like animation".
---

# Micro-Interactions — Deep UI Skill

Micro-interactions are the **punctuation of your UI**. They don't change meaning — they shape *how* the meaning is received. A button that clicks with conviction. A form that celebrates on success. A toggle that springs into place. These are the details users don't consciously notice — but instantly feel when they're missing.

---

## The 4-Stage Micro-Interaction Model

Every micro-interaction has four stages. Design all four.

```
1. TRIGGER → What starts it? (click, hover, scroll, time, data)
2. RULES   → What happens? (which properties change, how)
3. FEEDBACK → How does the user know? (visual, haptic, audio)
4. LOOPS/MODES → Does it repeat? Can it get stuck?
```

---

## Pattern Library

### 1. Ripple Click Effect

```css
.ripple-btn {
  position: relative;
  overflow: hidden;
  cursor: pointer;
  /* other button styles */
}

.ripple-circle {
  position: absolute;
  border-radius: 50%;
  transform: scale(0);
  animation: ripple-expand 600ms var(--ease-smooth) forwards;
  background: rgba(255, 255, 255, 0.3);
  pointer-events: none;
}

@keyframes ripple-expand {
  to {
    transform: scale(4);
    opacity: 0;
  }
}
```

```javascript
document.querySelectorAll('.ripple-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;

    const circle = document.createElement('span');
    circle.classList.add('ripple-circle');
    circle.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px`;
    btn.appendChild(circle);

    circle.addEventListener('animationend', () => circle.remove());
  });
});
```

---

### 2. Animated Checkbox

```css
.custom-checkbox {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  cursor: pointer;
  user-select: none;
}

.checkbox-box {
  width: 20px; height: 20px;
  border: 2px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  display: grid;
  place-items: center;
  transition:
    background var(--duration-fast) var(--ease-smooth),
    border-color var(--duration-fast) var(--ease-smooth),
    transform var(--duration-fast) var(--ease-spring);
  flex-shrink: 0;
}

.checkbox-box svg {
  width: 12px; height: 12px;
  stroke: white;
  stroke-width: 2.5;
  stroke-dasharray: 20;
  stroke-dashoffset: 20;
  fill: none;
  transition: stroke-dashoffset var(--duration-normal) var(--ease-snappy);
}

input[type="checkbox"]:checked + .checkbox-box {
  background: var(--color-primary);
  border-color: var(--color-primary);
  transform: scale(1.1);
}

input[type="checkbox"]:checked + .checkbox-box svg {
  stroke-dashoffset: 0;
}

input[type="checkbox"] { display: none; }
```

---

### 3. Toggle Switch — Spring Animation

```css
.toggle {
  --toggle-width: 48px;
  --toggle-height: 26px;
  --thumb-size: 20px;
  --thumb-travel: calc(var(--toggle-width) - var(--thumb-size) - 6px);

  position: relative;
  width: var(--toggle-width);
  height: var(--toggle-height);
  border-radius: var(--radius-full);
  background: var(--color-bg-emphasis);
  cursor: pointer;
  transition: background var(--duration-normal) var(--ease-smooth);
  flex-shrink: 0;
}

.toggle.active {
  background: var(--color-primary);
}

.toggle-thumb {
  position: absolute;
  top: 3px; left: 3px;
  width: var(--thumb-size);
  height: var(--thumb-size);
  background: white;
  border-radius: 50%;
  box-shadow: var(--shadow-sm);
  transition: transform var(--duration-normal) var(--ease-spring);
  will-change: transform;
}

.toggle.active .toggle-thumb {
  transform: translateX(var(--thumb-travel));
}

/* Scale squish on press */
.toggle:active .toggle-thumb {
  transform: scaleX(1.2);
}
.toggle.active:active .toggle-thumb {
  transform: translateX(var(--thumb-travel)) scaleX(1.2);
}
```

---

### 4. Button Loading State

```css
.btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-6);
  border-radius: var(--radius-md);
  background: var(--color-primary);
  color: white;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition:
    background var(--duration-fast) var(--ease-smooth),
    transform var(--duration-fast) var(--ease-spring),
    opacity var(--duration-fast) var(--ease-smooth);
}

.btn:active:not(:disabled) {
  transform: scale(0.97);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn.loading {
  color: transparent;
  pointer-events: none;
}

.btn.loading::after {
  content: '';
  position: absolute;
  width: 18px; height: 18px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Success state */
.btn.success {
  background: var(--color-success);
  color: white;
}

.btn.success::after {
  content: '✓';
  position: absolute;
  font-size: 1.1em;
  font-weight: 700;
  animation: popIn var(--duration-normal) var(--ease-spring);
}

@keyframes popIn {
  0%   { transform: scale(0) rotate(-45deg); }
  100% { transform: scale(1) rotate(0deg); }
}
```

---

### 5. Toast Notification System

```css
.toast-container {
  position: fixed;
  bottom: var(--space-6);
  right: var(--space-6);
  display: flex;
  flex-direction: column-reverse;
  gap: var(--space-3);
  z-index: var(--z-toast);
}

.toast {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  background: var(--color-surface-overlay);
  backdrop-filter: blur(16px);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
  min-width: 300px;
  max-width: 400px;

  animation: toastEnter var(--duration-normal) var(--ease-spring) forwards;
}

.toast.dismissing {
  animation: toastExit var(--duration-fast) var(--ease-accel) forwards;
}

@keyframes toastEnter {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes toastExit {
  to {
    opacity: 0;
    transform: translateX(calc(100% + var(--space-6)));
  }
}

.toast-icon  { font-size: 1.2em; flex-shrink: 0; }
.toast-title { font-weight: 600; color: var(--color-text-primary); }
.toast-msg   { font-size: var(--text-sm); color: var(--color-text-secondary); }
```

```javascript
class ToastManager {
  constructor() {
    this.container = this.createContainer();
  }

  createContainer() {
    const c = document.createElement('div');
    c.className = 'toast-container';
    document.body.appendChild(c);
    return c;
  }

  show({ title, message, type = 'info', duration = 4000 }) {
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
      <span class="toast-icon">${icons[type]}</span>
      <div>
        <div class="toast-title">${title}</div>
        ${message ? `<div class="toast-msg">${message}</div>` : ''}
      </div>
    `;

    this.container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('dismissing');
      toast.addEventListener('animationend', () => toast.remove());
    }, duration);
  }
}

const toast = new ToastManager();
// toast.show({ title: 'Saved!', message: 'Your changes were saved.', type: 'success' });
```

---

### 6. Heart / Like Animation

```css
.like-btn {
  position: relative;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px; height: 44px;
  border-radius: 50%;
  transition: background var(--duration-fast) var(--ease-smooth);
}

.like-btn:hover { background: rgba(239, 68, 68, 0.1); }

.like-icon {
  font-size: 1.4rem;
  transition: transform var(--duration-fast) var(--ease-spring);
}

.like-btn.liked .like-icon {
  color: #ef4444;
  animation: heartPop 400ms var(--ease-spring);
}

@keyframes heartPop {
  0%   { transform: scale(1); }
  40%  { transform: scale(1.4); }
  70%  { transform: scale(0.9); }
  100% { transform: scale(1); }
}

/* Particle burst on like */
.like-btn.liked::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(239,68,68,0.4) 0%, transparent 70%);
  animation: likeBurst 400ms var(--ease-smooth) forwards;
}

@keyframes likeBurst {
  0%   { transform: scale(0); opacity: 1; }
  100% { transform: scale(2.5); opacity: 0; }
}
```

---

### 7. Form Validation Feedback

```css
/* Shake on error */
.input-error {
  animation: shake 400ms var(--ease-smooth);
  border-color: var(--color-error) !important;
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  15%       { transform: translateX(-8px); }
  30%       { transform: translateX(6px); }
  45%       { transform: translateX(-5px); }
  60%       { transform: translateX(4px); }
  75%       { transform: translateX(-3px); }
  90%       { transform: translateX(2px); }
}

/* Success glow */
.input-success {
  border-color: var(--color-success) !important;
  box-shadow: 0 0 0 3px var(--color-success-bg);
}

/* Character counter fade */
.char-counter {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  transition: color var(--duration-fast) var(--ease-smooth);
}
.char-counter.warning { color: var(--color-warning); }
.char-counter.danger  { color: var(--color-error); }
```

---

## The Micro-Interaction Checklist

For every interactive element, verify:
- [ ] **Hover state** is visually distinct (not just cursor change)
- [ ] **Active/pressed state** has physical compression feeling (scale down ~2-3%)
- [ ] **Focus state** is clearly visible (critical for keyboard users)
- [ ] **Loading state** prevents double-submission
- [ ] **Success/error** feedback is immediate (<100ms feels instant)
- [ ] **Disabled state** communicates unavailability (not just gray)
- [ ] **Transition** uses spring or snappy easing, never `linear`
