---
name: hover-effects
description: >
  Deep skill for ALL hover, cursor, and pointer interaction effects. Load this skill
  when the user asks for: hover effects, cursor effects, mouse tracking, magnetic buttons,
  spotlight effects, link underline animations, card lift effects, image reveals on hover,
  follower cursors, pointer-based interactions, or any effect triggered by mouse position.
  Depends on: ui-engine (load first). Works with: micro-interactions, motion-animations.
  Triggers: "hover effect", "cursor effect", "mouse effect", "on hover", "hover animation",
  "magnetic button", "tilt effect", "custom cursor", "link animation", "card hover".
---

# Hover Effects — Deep UI Skill

Hover states are the **first conversation** between your UI and the user. A bad hover is invisible. A great hover creates anticipation, communicates affordance, and makes clicking feel rewarding before it happens.

---

## The 5 Axes of Hover Design

Every hover effect operates on one or more of these axes:

| Axis | What changes | CSS Properties |
|------|-------------|----------------|
| **Spatial** | Position, scale, rotation | `transform: translate/scale/rotate` |
| **Chromatic** | Color, opacity, gradient | `color`, `background`, `opacity`, `filter` |
| **Luminous** | Shadow, glow, light | `box-shadow`, `drop-shadow`, `text-shadow` |
| **Textural** | Border, outline, texture | `border`, `outline`, `background-image` |
| **Dimensional** | 3D, perspective, depth | `perspective`, `rotateX/Y`, `translateZ` |

Always combine at least **2 axes** for a satisfying hover. Single-axis hovers feel flat.

---

## Pattern Library

### 1. Magnetic Button
The button is pulled toward the cursor like a magnet. Requires JS for cursor tracking.

```css
.magnetic-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4) var(--space-6);
  border-radius: var(--radius-full);
  background: var(--color-primary);
  color: white;
  font-weight: 600;
  cursor: pointer;
  transition: box-shadow var(--duration-fast) var(--ease-smooth);
  will-change: transform;
}

.magnetic-btn:hover {
  box-shadow: var(--shadow-4);
}
```

```javascript
document.querySelectorAll('.magnetic-btn').forEach(btn => {
  btn.addEventListener('mousemove', e => {
    const rect = btn.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;
    const strength = 0.35; // 0 = no movement, 1 = full cursor tracking
    btn.style.transform = `translate(${x * strength}px, ${y * strength}px)`;
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.transform = 'translate(0, 0)';
    btn.style.transition = `transform 500ms var(--ease-spring)`;
  });
  btn.addEventListener('mouseenter', () => {
    btn.style.transition = `transform 100ms linear`;
  });
});
```

---

### 2. Spotlight / Radial Reveal Hover
A spotlight follows the cursor within a card, revealing content underneath.

```css
.spotlight-card {
  position: relative;
  overflow: hidden;
  background: var(--color-surface);
  border-radius: var(--radius-xl);
  border: 1px solid rgba(255,255,255,0.08);
  padding: var(--space-6);
}

.spotlight-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(
    600px circle at var(--mouse-x, 50%) var(--mouse-y, 50%),
    rgba(255, 255, 255, 0.08),
    transparent 40%
  );
  opacity: 0;
  transition: opacity var(--duration-normal) var(--ease-smooth);
  pointer-events: none;
}

.spotlight-card:hover::before {
  opacity: 1;
}
```

```javascript
document.querySelectorAll('.spotlight-card').forEach(card => {
  card.addEventListener('mousemove', e => {
    const rect = card.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    card.style.setProperty('--mouse-x', `${x}%`);
    card.style.setProperty('--mouse-y', `${y}%`);
  });
});
```

---

### 3. Link Underline Animations — 6 Variants

```css
/* Base setup for all variants */
.link { position: relative; text-decoration: none; display: inline-block; }

/* Variant A: Slide from left */
.link-slide::after {
  content: '';
  position: absolute;
  bottom: -2px; left: 0;
  width: 0; height: 2px;
  background: currentColor;
  transition: width var(--duration-normal) var(--ease-snappy);
}
.link-slide:hover::after { width: 100%; }

/* Variant B: Center expand */
.link-center::after {
  content: '';
  position: absolute;
  bottom: -2px; left: 50%;
  transform: translateX(-50%);
  width: 0; height: 2px;
  background: currentColor;
  transition: width var(--duration-normal) var(--ease-spring);
}
.link-center:hover::after { width: 100%; }

/* Variant C: Double line reveal */
.link-double::before,
.link-double::after {
  content: '';
  position: absolute;
  height: 1px;
  background: currentColor;
  transition: width var(--duration-slow) var(--ease-snappy);
  width: 0;
}
.link-double::before { top: 0; left: 0; }
.link-double::after  { bottom: 0; right: 0; }
.link-double:hover::before,
.link-double:hover::after { width: 100%; }

/* Variant D: Strikethrough reveal */
.link-strike::after {
  content: '';
  position: absolute;
  top: 50%; left: 0;
  height: 1px;
  background: currentColor;
  width: 0;
  transition: width var(--duration-fast) var(--ease-smooth);
}
.link-strike:hover::after { width: 100%; }

/* Variant E: Highlight fill (background sweep) */
.link-fill {
  background-image: linear-gradient(currentColor, currentColor);
  background-position: 0 100%;
  background-repeat: no-repeat;
  background-size: 0% 2px;
  transition: background-size var(--duration-normal) var(--ease-smooth);
  padding-bottom: 2px;
}
.link-fill:hover { background-size: 100% 2px; }

/* Variant F: Neon glow pulse */
.link-glow {
  transition: text-shadow var(--duration-normal) var(--ease-smooth),
              color var(--duration-normal) var(--ease-smooth);
}
.link-glow:hover {
  color: var(--color-accent);
  text-shadow: 0 0 8px var(--color-accent), 0 0 20px var(--color-accent-50);
}
```

---

### 4. Card Lift with Shadow Depth

```css
.card-lift {
  background: var(--color-surface);
  border-radius: var(--radius-xl);
  padding: var(--space-6);
  border: 1px solid var(--color-border);
  transition:
    transform var(--duration-normal) var(--ease-spring),
    box-shadow var(--duration-normal) var(--ease-smooth),
    border-color var(--duration-fast) var(--ease-smooth);
  will-change: transform, box-shadow;
}

.card-lift:hover {
  transform: translateY(-6px) scale(1.01);
  box-shadow: var(--shadow-4),
              0 0 0 1px var(--color-primary-20);
  border-color: var(--color-primary-40);
}
```

---

### 5. Image Reveal / Clip-Path Hover

```css
.image-reveal {
  position: relative;
  overflow: hidden;
  border-radius: var(--radius-lg);
  cursor: pointer;
}

.image-reveal img {
  width: 100%;
  display: block;
  transition: transform var(--duration-slow) var(--ease-smooth);
  will-change: transform;
}

.image-reveal:hover img {
  transform: scale(1.08);
}

.image-reveal-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to top,
    rgba(0,0,0,0.8) 0%,
    transparent 60%
  );
  opacity: 0;
  transform: translateY(10px);
  transition:
    opacity var(--duration-normal) var(--ease-smooth),
    transform var(--duration-normal) var(--ease-smooth);
}

.image-reveal:hover .image-reveal-overlay {
  opacity: 1;
  transform: translateY(0);
}
```

---

### 6. Custom Cursor

```css
.cursor-dot {
  position: fixed;
  width: 8px; height: 8px;
  background: var(--color-primary);
  border-radius: 50%;
  pointer-events: none;
  z-index: var(--z-toast);
  transition: transform var(--duration-fast) var(--ease-spring),
              opacity var(--duration-fast) var(--ease-smooth);
  transform: translate(-50%, -50%);
}

.cursor-ring {
  position: fixed;
  width: 36px; height: 36px;
  border: 2px solid var(--color-primary);
  border-radius: 50%;
  pointer-events: none;
  z-index: calc(var(--z-toast) - 1);
  transition: transform var(--duration-normal) var(--ease-smooth),
              width var(--duration-fast) var(--ease-spring),
              height var(--duration-fast) var(--ease-spring),
              opacity var(--duration-fast) var(--ease-smooth);
  transform: translate(-50%, -50%);
}

/* Expand ring on hover of interactive elements */
a:hover ~ .cursor-ring,
button:hover ~ .cursor-ring {
  width: 56px;
  height: 56px;
  opacity: 0.6;
}
```

```javascript
const dot = document.querySelector('.cursor-dot');
const ring = document.querySelector('.cursor-ring');
let ringX = 0, ringY = 0;
let dotX = 0, dotY = 0;

document.addEventListener('mousemove', e => {
  dotX = e.clientX; dotY = e.clientY;
});

function animateCursor() {
  // Dot snaps instantly
  dot.style.left = dotX + 'px';
  dot.style.top = dotY + 'px';

  // Ring lerps (smooth follow)
  ringX += (dotX - ringX) * 0.12;
  ringY += (dotY - ringY) * 0.12;
  ring.style.left = ringX + 'px';
  ring.style.top = ringY + 'px';

  requestAnimationFrame(animateCursor);
}
animateCursor();
```

---

### 7. Tilt / Perspective Hover

```css
.tilt-card {
  transform-style: preserve-3d;
  perspective: 1000px;
  transition: transform var(--duration-fast) linear;
  will-change: transform;
}

.tilt-card-inner {
  transform-style: preserve-3d;
  transition: transform var(--duration-fast) linear;
}

.tilt-card-shine {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(135deg, rgba(255,255,255,0.15) 0%, transparent 60%);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-smooth);
  pointer-events: none;
}

.tilt-card:hover .tilt-card-shine { opacity: 1; }
```

```javascript
document.querySelectorAll('.tilt-card').forEach(card => {
  const MAX_TILT = 12; // degrees

  card.addEventListener('mousemove', e => {
    const rect = card.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const rotateX = (y - 0.5) * -MAX_TILT * 2;
    const rotateY = (x - 0.5) * MAX_TILT * 2;
    card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
  });

  card.addEventListener('mouseleave', () => {
    card.style.transition = `transform 500ms var(--ease-spring)`;
    card.style.transform = `perspective(1000px) rotateX(0deg) rotateY(0deg)`;
    setTimeout(() => card.style.transition = '', 500);
  });
});
```

---

## Performance Rules

1. **Only animate `transform` and `opacity`** — these are GPU composited
2. Use `will-change: transform` on elements that will animate (sparingly)
3. Use `pointer-events: none` on overlay/overlay elements
4. Debounce `mousemove` handlers if heavy computation is involved
5. Always reset on `mouseleave` with a spring return
6. Add `@media (prefers-reduced-motion: reduce)` override

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }
}
```
