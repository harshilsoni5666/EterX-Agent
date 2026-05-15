---
name: motion-animations
description: >
  Deep skill for ALL motion, animation, and transition effects in UI. Load this when
  the user asks for: page transitions, scroll animations, entrance animations, parallax,
  staggered reveals, keyframe animations, GSAP effects, scroll-triggered animation,
  loading animations, skeleton screens, number counters, text reveals, or any time-based
  visual effect. Depends on: ui-engine. Works with: hover-effects, micro-interactions.
  Triggers: "animation", "transition", "scroll effect", "page transition", "parallax",
  "stagger", "reveal", "entrance", "exit", "loading animation", "animate on scroll".
---

# Motion & Animations — Deep UI Skill

Motion is the **nervous system** of your interface. It tells the user where they came from, where they're going, and what just happened. Bad motion is distracting. No motion is dead. Great motion is invisible — it just feels right.

---

## The Motion Hierarchy

Apply motion in this priority order:

1. **Entrance/Exit** — Elements entering or leaving the screen
2. **State Transitions** — Changes between UI states (tab switch, modal open)
3. **Scroll Effects** — Parallax, reveal, progress indicators
4. **Ambient Motion** — Subtle loops that keep the page alive (not annoying)
5. **Celebration** — Confetti, success states, delight moments

---

## Easing Reference

```css
:root {
  /* Spring — overshoots, feels physical and alive */
  --ease-spring:   cubic-bezier(0.34, 1.56, 0.64, 1);
  /* Smooth — material motion, professional */
  --ease-smooth:   cubic-bezier(0.4, 0, 0.2, 1);
  /* Snappy — fast out, confident */
  --ease-snappy:   cubic-bezier(0.2, 0, 0, 1);
  /* Bounce — playful, cartoonish */
  --ease-bounce:   cubic-bezier(0.68, -0.55, 0.265, 1.55);
  /* Elastic — extreme spring, use sparingly */
  --ease-elastic:  cubic-bezier(0.175, 0.885, 0.32, 1.275);
  /* Decelerate — enters fast, slows to stop */
  --ease-decel:    cubic-bezier(0, 0, 0.2, 1);
  /* Accelerate — starts slow, exits fast */
  --ease-accel:    cubic-bezier(0.4, 0, 1, 1);
}
```

---

## Pattern Library

### 1. Staggered Entrance (CSS)

```css
.stagger-parent .stagger-child {
  opacity: 0;
  transform: translateY(20px);
  animation: fadeSlideUp var(--duration-normal) var(--ease-spring) forwards;
}

.stagger-parent .stagger-child:nth-child(1) { animation-delay: 0ms; }
.stagger-parent .stagger-child:nth-child(2) { animation-delay: 80ms; }
.stagger-parent .stagger-child:nth-child(3) { animation-delay: 160ms; }
.stagger-parent .stagger-child:nth-child(4) { animation-delay: 240ms; }
.stagger-parent .stagger-child:nth-child(5) { animation-delay: 320ms; }

@keyframes fadeSlideUp {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

```javascript
// Dynamic stagger via JS (for variable-length lists)
document.querySelectorAll('.stagger-child').forEach((el, i) => {
  el.style.animationDelay = `${i * 80}ms`;
});
```

---

### 2. Scroll-Triggered Reveal (Intersection Observer)

```javascript
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('revealed');
      revealObserver.unobserve(entry.target); // Fire once
    }
  });
}, {
  threshold: 0.15,
  rootMargin: '0px 0px -50px 0px'
});

document.querySelectorAll('[data-reveal]').forEach(el => {
  revealObserver.observe(el);
});
```

```css
[data-reveal] {
  opacity: 0;
  transition:
    opacity var(--duration-slow) var(--ease-smooth),
    transform var(--duration-slow) var(--ease-spring);
}

[data-reveal="up"]    { transform: translateY(40px); }
[data-reveal="down"]  { transform: translateY(-40px); }
[data-reveal="left"]  { transform: translateX(-40px); }
[data-reveal="right"] { transform: translateX(40px); }
[data-reveal="scale"] { transform: scale(0.92); }
[data-reveal="fade"]  { /* opacity only */ }

[data-reveal].revealed {
  opacity: 1;
  transform: none;
}
```

---

### 3. Parallax Scroll

```javascript
// Lightweight, no library parallax
class Parallax {
  constructor(selector, speed = 0.3) {
    this.elements = document.querySelectorAll(selector);
    this.speed = speed;
    this.ticking = false;
    this.bind();
  }

  bind() {
    window.addEventListener('scroll', () => {
      if (!this.ticking) {
        requestAnimationFrame(() => {
          this.update();
          this.ticking = false;
        });
        this.ticking = true;
      }
    });
  }

  update() {
    const scrollY = window.scrollY;
    this.elements.forEach(el => {
      const rect = el.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      const viewportCenter = window.innerHeight / 2;
      const offset = (centerY - viewportCenter) * this.speed;
      el.style.transform = `translateY(${offset}px)`;
    });
  }
}

new Parallax('[data-parallax]', 0.2);
new Parallax('[data-parallax-fast]', 0.5);
new Parallax('[data-parallax-slow]', 0.1);
```

---

### 4. Text Reveal Animations — 3 Variants

```css
/* Variant A: Word-by-word slide up */
.text-reveal-word span {
  display: inline-block;
  opacity: 0;
  transform: translateY(1em);
  animation: wordReveal 0.6s var(--ease-spring) forwards;
}

@keyframes wordReveal {
  to { opacity: 1; transform: translateY(0); }
}

/* Variant B: Character scramble (JS required) */
/* Variant C: Clip-path wipe */
.text-reveal-clip {
  clip-path: inset(0 100% 0 0);
  animation: clipReveal 0.8s var(--ease-snappy) forwards;
}

@keyframes clipReveal {
  to { clip-path: inset(0 0% 0 0); }
}

/* Variant D: Gradient mask sweep */
.text-reveal-gradient {
  background: linear-gradient(90deg, var(--color-text) 0%, transparent 100%);
  background-size: 200% 100%;
  background-position: 100% 0;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: gradientSweep 1s var(--ease-smooth) forwards;
}

@keyframes gradientSweep {
  to { background-position: 0% 0; }
}
```

```javascript
// Character scramble text reveal
function scrambleText(el, finalText, duration = 1200) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
  let iteration = 0;
  const interval = setInterval(() => {
    el.textContent = finalText
      .split('')
      .map((char, i) => {
        if (i < iteration) return char;
        if (char === ' ') return ' ';
        return chars[Math.floor(Math.random() * chars.length)];
      })
      .join('');

    if (iteration >= finalText.length) clearInterval(interval);
    iteration += 1 / 3;
  }, duration / (finalText.length * 3));
}
```

---

### 5. Number Counter Animation

```javascript
function animateCounter(el, start = 0, end, duration = 2000, formatter = n => n) {
  const startTime = performance.now();
  const easeOut = t => 1 - Math.pow(1 - t, 4); // Quartic ease-out

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const easedProgress = easeOut(progress);
    const current = Math.round(start + (end - start) * easedProgress);
    el.textContent = formatter(current);
    if (progress < 1) requestAnimationFrame(update);
  }

  requestAnimationFrame(update);
}

// Usage:
// animateCounter(el, 0, 1247, 2000, n => n.toLocaleString() + '+')
// animateCounter(el, 0, 98.6, 1500, n => n.toFixed(1) + '%')
```

---

### 6. Page Transition (SPA-style)

```css
.page {
  animation: pageEnter var(--duration-normal) var(--ease-smooth) both;
}

@keyframes pageEnter {
  from {
    opacity: 0;
    transform: translateY(16px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.page-exit {
  animation: pageExit var(--duration-fast) var(--ease-accel) both;
}

@keyframes pageExit {
  to {
    opacity: 0;
    transform: translateY(-16px);
  }
}
```

---

### 7. Skeleton Screen Loader

```css
.skeleton {
  background: linear-gradient(
    90deg,
    var(--color-skeleton-base) 25%,
    var(--color-skeleton-shine) 50%,
    var(--color-skeleton-base) 75%
  );
  background-size: 200% 100%;
  animation: skeleton-wave 1.5s var(--ease-smooth) infinite;
  border-radius: var(--radius-md);
}

:root {
  --color-skeleton-base:  rgba(0, 0, 0, 0.08);
  --color-skeleton-shine: rgba(0, 0, 0, 0.04);
}

[data-theme="dark"] {
  --color-skeleton-base:  rgba(255, 255, 255, 0.08);
  --color-skeleton-shine: rgba(255, 255, 255, 0.14);
}

@keyframes skeleton-wave {
  from { background-position: 200% 0; }
  to   { background-position: -200% 0; }
}

/* Usage: */
.skeleton-text    { height: 1em; margin-bottom: 0.5em; }
.skeleton-heading { height: 2em; width: 60%; margin-bottom: 1em; }
.skeleton-avatar  { width: 48px; height: 48px; border-radius: 50%; }
.skeleton-card    { height: 200px; width: 100%; }
```

---

### 8. Progress Scroll Indicator

```css
.scroll-progress {
  position: fixed;
  top: 0; left: 0;
  height: 3px;
  background: var(--color-primary);
  width: 0%;
  z-index: var(--z-overlay);
  transition: width 50ms linear;
  transform-origin: left;
}
```

```javascript
const progress = document.querySelector('.scroll-progress');

window.addEventListener('scroll', () => {
  const scrollTop = window.scrollY;
  const docHeight = document.documentElement.scrollHeight - window.innerHeight;
  const pct = (scrollTop / docHeight) * 100;
  progress.style.width = pct + '%';
}, { passive: true });
```

---

## Golden Rules of Motion

1. **Enter slow, exit fast** — Elements should decelerate on entrance (welcoming), accelerate on exit (not blocking)
2. **Small = fast, Large = slow** — Tiny elements (16px) transition in ~150ms, full-page in ~400ms
3. **Stagger hierarchy follows visual hierarchy** — Primary elements first, supporting last
4. **Never animate layout properties** — `width`, `height`, `top`, `left` cause reflow. Use `transform` always.
5. **Chain, don't overlap** — Sequential animations feel intentional; overlapping feels chaotic
6. **One hero animation per page** — The most important moment should own the stage
