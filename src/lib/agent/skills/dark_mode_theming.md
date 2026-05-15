---
name: dark-mode-theming
description: >
  Deep skill for dark mode, light mode, adaptive theming, and multi-theme systems.
  Load when user asks for: dark mode, light/dark toggle, theme switching, system theme
  detection, high-contrast mode, adaptive colors, theme variables, color scheme,
  semantic color tokens, or any appearance-mode-related UI. Depends on: ui-engine.
  Works with: color-systems, glassmorphism-neumorphism.
  Triggers: "dark mode", "light mode", "theme", "color scheme", "theme toggle",
  "dark theme", "appearance", "prefers-color-scheme", "theme switcher", "adaptive UI".
---

# Dark Mode & Theming — Deep UI Skill

Dark mode done wrong is just "make everything black." Dark mode done right is a **completely reconsidered visual system** — where shadows become light, where depth inverts, where a new hierarchy emerges from darkness.

---

## The Semantic Token Architecture

Never use raw color values in components. Always reference semantic tokens that change with the theme.

```css
/* ─── Light Theme (default) ─── */
:root,
[data-theme="light"] {

  /* Backgrounds — layered from bottom to top */
  --color-bg-base:      #ffffff;
  --color-bg-subtle:    #f8f9fa;
  --color-bg-muted:     #f1f3f5;
  --color-bg-emphasis:  #e9ecef;

  /* Surface (cards, panels, inputs) */
  --color-surface:      #ffffff;
  --color-surface-raised: #f8f9fa;
  --color-surface-overlay: rgba(255,255,255,0.92);

  /* Borders */
  --color-border:       rgba(0,0,0,0.08);
  --color-border-strong: rgba(0,0,0,0.16);
  --color-border-focus: var(--color-primary);

  /* Text */
  --color-text-primary:   #111827;
  --color-text-secondary: #4b5563;
  --color-text-muted:     #9ca3af;
  --color-text-disabled:  #d1d5db;
  --color-text-inverse:   #ffffff;

  /* Shadows — visible on light bg */
  --shadow-color: rgba(0, 0, 0, 0.1);
  --shadow-sm:  0 1px 3px var(--shadow-color);
  --shadow-md:  0 4px 12px var(--shadow-color);
  --shadow-lg:  0 8px 24px var(--shadow-color);
  --shadow-xl:  0 20px 48px var(--shadow-color);

  /* Skeleton loaders */
  --color-skeleton-base:  rgba(0,0,0,0.06);
  --color-skeleton-shine: rgba(0,0,0,0.03);
}

/* ─── Dark Theme ─── */
[data-theme="dark"] {

  /* Backgrounds */
  --color-bg-base:      #0f1117;
  --color-bg-subtle:    #161b22;
  --color-bg-muted:     #1c2128;
  --color-bg-emphasis:  #24292f;

  /* Surface */
  --color-surface:        #161b22;
  --color-surface-raised: #1c2128;
  --color-surface-overlay: rgba(22,27,34,0.95);

  /* Borders */
  --color-border:        rgba(255,255,255,0.08);
  --color-border-strong: rgba(255,255,255,0.16);
  --color-border-focus:  var(--color-primary-light);

  /* Text — slightly reduced brightness in dark mode (less eye strain) */
  --color-text-primary:   #e6edf3;
  --color-text-secondary: #8b949e;
  --color-text-muted:     #6e7681;
  --color-text-disabled:  #3d444d;
  --color-text-inverse:   #0f1117;

  /* Shadows — in dark mode, use glow instead of drop shadow */
  --shadow-color: rgba(0, 0, 0, 0.4);
  --shadow-sm:  0 1px 3px var(--shadow-color);
  --shadow-md:  0 4px 12px var(--shadow-color);
  --shadow-lg:  0 8px 32px var(--shadow-color);
  --shadow-xl:  0 20px 60px var(--shadow-color);

  /* Skeleton loaders */
  --color-skeleton-base:  rgba(255,255,255,0.06);
  --color-skeleton-shine: rgba(255,255,255,0.10);
}
```

---

## Primary & Accent Colors — Adaptive per Theme

Primaries often need to be **lighter in dark mode** to maintain correct luminance contrast.

```css
:root {
  /* Blue */
  --color-primary:       #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-primary-light: #93c5fd;
  --color-primary-bg:    rgba(37, 99, 235, 0.08);
  --color-primary-text:  #1e40af;

  /* Success */
  --color-success:      #10b981;
  --color-success-bg:   rgba(16, 185, 129, 0.08);
  --color-success-text: #065f46;

  /* Warning */
  --color-warning:      #f59e0b;
  --color-warning-bg:   rgba(245, 158, 11, 0.08);
  --color-warning-text: #92400e;

  /* Error */
  --color-error:       #ef4444;
  --color-error-bg:    rgba(239, 68, 68, 0.08);
  --color-error-text:  #991b1b;
}

[data-theme="dark"] {
  --color-primary:       #3b82f6;   /* Lighter blue for dark bg */
  --color-primary-hover: #60a5fa;
  --color-primary-light: #93c5fd;
  --color-primary-bg:    rgba(59, 130, 246, 0.12);
  --color-primary-text:  #93c5fd;

  --color-success:      #34d399;
  --color-success-bg:   rgba(52, 211, 153, 0.12);
  --color-success-text: #6ee7b7;

  --color-warning:      #fbbf24;
  --color-warning-bg:   rgba(251, 191, 36, 0.12);
  --color-warning-text: #fcd34d;

  --color-error:       #f87171;
  --color-error-bg:    rgba(248, 113, 113, 0.12);
  --color-error-text:  #fca5a5;
}
```

---

## Theme Switcher Implementation

### HTML + JS (no framework)
```html
<button class="theme-toggle" id="themeToggle" aria-label="Toggle theme">
  <svg class="icon-sun" ...>☀️</svg>
  <svg class="icon-moon" ...>🌙</svg>
</button>
```

```javascript
class ThemeManager {
  constructor() {
    this.STORAGE_KEY = 'preferred-theme';
    this.init();
  }

  getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  getSavedTheme() {
    return localStorage.getItem(this.STORAGE_KEY);
  }

  getActiveTheme() {
    return this.getSavedTheme() || this.getSystemTheme();
  }

  applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(this.STORAGE_KEY, theme);

    // Animate the transition
    document.documentElement.style.setProperty('--theme-transition', 'all 300ms ease');
    setTimeout(() => {
      document.documentElement.style.removeProperty('--theme-transition');
    }, 300);
  }

  toggle() {
    const current = this.getActiveTheme();
    this.applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  init() {
    this.applyTheme(this.getActiveTheme());

    // Listen for system changes
    window.matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', e => {
        if (!this.getSavedTheme()) {
          this.applyTheme(e.matches ? 'dark' : 'light');
        }
      });
  }
}

const theme = new ThemeManager();
document.getElementById('themeToggle').addEventListener('click', () => theme.toggle());
```

### React Hook
```typescript
import { useState, useEffect } from 'react';

type Theme = 'light' | 'dark' | 'system';

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    return (localStorage.getItem('theme') as Theme) || 'system';
  });

  const resolvedTheme = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', resolvedTheme);
    localStorage.setItem('theme', theme);
  }, [theme, resolvedTheme]);

  return { theme, resolvedTheme, setTheme };
}
```

---

## Smooth Theme Transition (no flash)

```css
/* Add to :root — applies transition to all color changes */
* {
  transition:
    background-color 200ms ease,
    border-color 200ms ease,
    color 200ms ease,
    box-shadow 200ms ease;
}

/* CRITICAL: Disable transition for transforms/opacity to not break animations */
*[class*="animate"],
*[class*="motion"],
.hover-target {
  transition: none;
}
```

---

## Preventing Flash of Wrong Theme (FOUT)

Place this in `<head>` before any CSS:

```html
<script>
  (function() {
    const saved = localStorage.getItem('theme');
    const system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', saved || system);
  })();
</script>
```

---

## Dark Mode Design Rules

1. **Don't just invert** — Dark mode is not `filter: invert(1)`. Each color must be reconsidered.
2. **Reduce saturation slightly** — Vivid colors on dark backgrounds cause vibration. Desaturate 10-15%.
3. **Shadows don't work on dark** — On dark backgrounds, use glow/inner-glow instead of drop shadows.
4. **Text contrast is different** — Pure white (#fff) on pure black (#000) is too harsh. Use off-white (#e6edf3) and off-black (#0f1117).
5. **Elevation via lightness, not shadow** — Higher surfaces = lighter background color (the opposite of light mode).
6. **Images need treatment** — Add `img { filter: brightness(0.9) contrast(1.05); }` for dark mode images.
7. **Borders become visible** — In dark mode, subtle borders become critical for defining surfaces.
