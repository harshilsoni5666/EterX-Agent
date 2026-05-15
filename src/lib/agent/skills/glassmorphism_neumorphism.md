---
name: glassmorphism-neumorphism
description: >
  Deep skill for glass UI, frosted blur, translucent panels, soft UI (neumorphism),
  and all depth/material-based design aesthetics. Load when user asks for: glass effect,
  frosted glass, blur background, translucent card, neumorphism, soft UI, acrylic effect,
  macOS-style UI, visionOS style, iOS blur, material design depth, milky/frosted panels.
  Depends on: ui-engine. Works with: dark-mode-theming, color-systems.
  Triggers: "glass", "frosted", "blur effect", "translucent", "neumorphism", "soft UI",
  "acrylic", "depth", "material", "layered UI", "Apple-style", "visionOS".
---

# Glassmorphism & Neumorphism — Deep UI Skill

Two distinct styles. Two completely different philosophies. Both manipulate **perceived depth and material** — but in opposite directions.

- **Glassmorphism**: Light passes *through* surfaces — transparent, luminous, layered
- **Neumorphism**: Light bounces *off* surfaces — extruded, embossed, soft shadows

Never mix them in the same interface without extreme intentionality.

---

## Part 1: Glassmorphism

### The Formula

```css
.glass {
  /* 1. Semi-transparent background */
  background: rgba(255, 255, 255, 0.12);

  /* 2. Backdrop blur — the defining property */
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);

  /* 3. Thin border to catch light */
  border: 1px solid rgba(255, 255, 255, 0.2);

  /* 4. Subtle shadow for depth */
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.12),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);

  /* 5. Rounded corners (glass should never be sharp) */
  border-radius: var(--radius-xl);
}
```

### Dark Glass (for dark backgrounds)
```css
.glass-dark {
  background: rgba(15, 15, 20, 0.5);
  backdrop-filter: blur(24px) saturate(150%);
  -webkit-backdrop-filter: blur(24px) saturate(150%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
  border-radius: var(--radius-xl);
}
```

### Colored Glass (tinted panels)
```css
.glass-blue   { background: rgba(59, 130, 246, 0.15); border-color: rgba(59, 130, 246, 0.3); }
.glass-purple { background: rgba(139, 92, 246, 0.15); border-color: rgba(139, 92, 246, 0.3); }
.glass-green  { background: rgba(16, 185, 129, 0.15); border-color: rgba(16, 185, 129, 0.3); }
.glass-pink   { background: rgba(236, 72, 153, 0.15); border-color: rgba(236, 72, 153, 0.3); }
.glass-amber  { background: rgba(245, 158, 11, 0.15); border-color: rgba(245, 158, 11, 0.3); }
```

### Glass Navbar
```css
.glass-nav {
  position: fixed;
  top: 16px; left: 50%;
  transform: translateX(-50%);
  width: min(90vw, 900px);
  padding: var(--space-3) var(--space-5);
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(30px) saturate(200%);
  -webkit-backdrop-filter: blur(30px) saturate(200%);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: var(--radius-full);
  box-shadow:
    0 4px 24px rgba(0, 0, 0, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.25);
  z-index: var(--z-overlay);
  display: flex;
  align-items: center;
  gap: var(--space-5);
}
```

### Glass Modal
```css
.glass-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: grid;
  place-items: center;
  z-index: var(--z-modal);
}

.glass-modal {
  background: rgba(255, 255, 255, 0.14);
  backdrop-filter: blur(40px) saturate(180%) brightness(110%);
  -webkit-backdrop-filter: blur(40px) saturate(180%) brightness(110%);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: var(--radius-2xl);
  padding: var(--space-8);
  box-shadow:
    0 32px 64px rgba(0, 0, 0, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.3);
  max-width: 560px;
  width: 90%;
}
```

### Glass Background Requirements
Glassmorphism REQUIRES an interesting background to blur. Use these:

```css
/* Gradient mesh background */
.glass-bg-gradient {
  background:
    radial-gradient(ellipse at 20% 50%, rgba(120, 119, 198, 0.4) 0%, transparent 50%),
    radial-gradient(ellipse at 80% 20%, rgba(255, 119, 115, 0.4) 0%, transparent 50%),
    radial-gradient(ellipse at 60% 80%, rgba(100, 200, 255, 0.3) 0%, transparent 50%),
    #0a0a0f;
}

/* Bokeh blobs */
.glass-bg-bokeh::before {
  content: '';
  position: fixed; inset: 0;
  background:
    radial-gradient(circle at 25% 35%, rgba(255, 100, 150, 0.5) 0%, transparent 40%),
    radial-gradient(circle at 75% 65%, rgba(100, 150, 255, 0.5) 0%, transparent 40%),
    radial-gradient(circle at 50% 20%, rgba(150, 255, 200, 0.4) 0%, transparent 35%);
  filter: blur(40px);
  pointer-events: none;
  z-index: -1;
}
```

---

## Part 2: Neumorphism

### The Formula

```css
/* LIGHT NEUMORPHISM */
:root {
  --neu-bg: #e0e5ec;
  --neu-light: #ffffff;
  --neu-dark:  #a3b1c6;
}

.neu-flat {
  background: var(--neu-bg);
  border-radius: var(--radius-xl);
  box-shadow:
    6px 6px 12px var(--neu-dark),
    -6px -6px 12px var(--neu-light);
}

/* Pressed/inset (active state) */
.neu-pressed {
  background: var(--neu-bg);
  border-radius: var(--radius-xl);
  box-shadow:
    inset 6px 6px 12px var(--neu-dark),
    inset -6px -6px 12px var(--neu-light);
}

/* Convex (raised button look) */
.neu-convex {
  background: linear-gradient(145deg, var(--neu-light), var(--neu-bg));
  border-radius: var(--radius-xl);
  box-shadow:
    6px 6px 12px var(--neu-dark),
    -6px -6px 12px var(--neu-light);
}

/* Concave (inset well) */
.neu-concave {
  background: linear-gradient(145deg, var(--neu-bg), var(--neu-light));
  border-radius: var(--radius-xl);
  box-shadow:
    6px 6px 12px var(--neu-dark),
    -6px -6px 12px var(--neu-light);
}
```

### Neumorphic Toggle
```css
.neu-toggle {
  position: relative;
  width: 60px; height: 30px;
  background: var(--neu-bg);
  border-radius: var(--radius-full);
  box-shadow:
    inset 4px 4px 8px var(--neu-dark),
    inset -4px -4px 8px var(--neu-light);
  cursor: pointer;
  transition: all var(--duration-normal) var(--ease-smooth);
}

.neu-toggle-thumb {
  position: absolute;
  top: 4px; left: 4px;
  width: 22px; height: 22px;
  border-radius: 50%;
  background: var(--neu-bg);
  box-shadow:
    3px 3px 6px var(--neu-dark),
    -3px -3px 6px var(--neu-light);
  transition: transform var(--duration-normal) var(--ease-spring);
}

.neu-toggle.active .neu-toggle-thumb {
  transform: translateX(30px);
}
.neu-toggle.active {
  box-shadow:
    inset 4px 4px 8px rgba(0,0,0,0.15),
    inset -4px -4px 8px rgba(255,255,255,0.7);
}
```

### Neumorphic Input
```css
.neu-input {
  background: var(--neu-bg);
  border: none;
  border-radius: var(--radius-lg);
  padding: var(--space-4) var(--space-5);
  box-shadow:
    inset 4px 4px 8px var(--neu-dark),
    inset -4px -4px 8px var(--neu-light);
  outline: none;
  font-size: var(--text-base);
  color: #555;
  width: 100%;
  transition: box-shadow var(--duration-fast) var(--ease-smooth);
}

.neu-input:focus {
  box-shadow:
    inset 6px 6px 12px var(--neu-dark),
    inset -6px -6px 12px var(--neu-light),
    0 0 0 2px var(--color-primary-40);
}
```

---

## Critical Rules

### Glassmorphism Must-Haves
- Background behind glass MUST be colorful/complex (solid colors kill the effect)
- `backdrop-filter` requires vendor prefix `-webkit-backdrop-filter` for Safari
- Blur values: `blur(8px)` = subtle, `blur(20px)` = standard, `blur(40px)` = heavy
- Always add `inset 0 1px 0 rgba(255,255,255,0.X)` — this is the light catching the rim
- Content legibility is paramount — don't blur so much text becomes unreadable

### Neumorphism Must-Haves  
- Background color MUST be neutral (neumorphism dies on vivid colors)
- Shadow spread = ~60% of radius (shadows too large = ugly, too small = invisible)
- Light source is always top-left (dark shadow bottom-right, light shadow top-left)
- NEVER use neumorphism for text — only for UI elements (buttons, cards, inputs)
- Accessibility caution: low contrast is a known accessibility problem with this style; always test
