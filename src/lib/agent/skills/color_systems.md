---
name: color-systems
description: >
  Deep skill for color theory, palette generation, semantic color systems, gradients,
  and mood-based color design. Load when user asks for: color palette, brand colors,
  gradient, color scheme, complementary colors, color theory, accessible colors,
  WCAG contrast, color tokens, mood board colors, hue selection, tints/shades,
  or any color-related design decisions. Depends on: ui-engine.
  Works with: dark-mode-theming, typography-system.
  Triggers: "color palette", "color scheme", "gradient", "color theory", "brand color",
  "accessible color", "contrast ratio", "tint", "shade", "hue", "saturation".
---

# Color Systems — Deep UI Skill

Color is not decoration. Color is **communication**. Every color choice makes a claim about trust, energy, warmth, authority, playfulness. A bad color system undermines even the best design. A great color system makes average design feel polished.

---

## The Three Layers of Color

Every UI color system operates on three layers:

```
Layer 1: BRAND COLORS     → Who you are (primary, accent, brand)
Layer 2: SEMANTIC COLORS  → What something means (success, error, warning)
Layer 3: NEUTRAL COLORS   → The stage everything lives on (backgrounds, text, borders)
```

Most teams over-invest in Layer 1 and under-invest in Layer 3. Neutrals are 80% of the UI.

---

## Color Token Architecture

```css
:root {
  /* ─── Primary ─── */
  --color-primary-50:  #eff6ff;
  --color-primary-100: #dbeafe;
  --color-primary-200: #bfdbfe;
  --color-primary-300: #93c5fd;
  --color-primary-400: #60a5fa;
  --color-primary-500: #3b82f6;  /* ← base */
  --color-primary-600: #2563eb;
  --color-primary-700: #1d4ed8;
  --color-primary-800: #1e40af;
  --color-primary-900: #1e3a8a;

  /* ─── Accent (Complementary or Analogous) ─── */
  --color-accent-500:  #f97316; /* amber-orange complement to blue */
  --color-accent-600:  #ea580c;

  /* ─── Neutrals (never pure black/white) ─── */
  --color-neutral-0:   #ffffff;
  --color-neutral-50:  #f8fafc;
  --color-neutral-100: #f1f5f9;
  --color-neutral-200: #e2e8f0;
  --color-neutral-300: #cbd5e1;
  --color-neutral-400: #94a3b8;
  --color-neutral-500: #64748b;
  --color-neutral-600: #475569;
  --color-neutral-700: #334155;
  --color-neutral-800: #1e293b;
  --color-neutral-900: #0f172a;
  --color-neutral-950: #020617;

  /* ─── Semantic Colors ─── */
  --color-success: #10b981;
  --color-warning: #f59e0b;
  --color-error:   #ef4444;
  --color-info:    #06b6d4;
}
```

---

## Palette Generation Strategies

### Strategy 1: Hue Rotation (Analogous)
Pairs of hues 30° apart on the wheel. Harmonious, calm.

```css
/* Base: Blue 220° → Analogous: Violet 260° + Teal 180° */
--color-primary: hsl(220, 90%, 55%);
--color-accent:  hsl(260, 85%, 65%);
--color-tone:    hsl(180, 70%, 45%);
```

### Strategy 2: Complementary
Hues 180° apart. High contrast, energetic.

```css
/* Blue + Orange */
--color-primary: hsl(215, 85%, 55%);
--color-accent:  hsl(35, 90%, 55%);
```

### Strategy 3: Split-Complementary
One color + two colors adjacent to its complement. Balanced energy.

```css
/* Blue + Red-Orange + Yellow-Orange */
--color-primary: hsl(215, 85%, 55%);
--color-accent-a: hsl(20, 85%, 55%);
--color-accent-b: hsl(50, 85%, 55%);
```

### Strategy 4: Triadic
Three hues 120° apart. Vibrant and balanced.

```css
--color-a: hsl(0, 80%, 60%);    /* Red */
--color-b: hsl(120, 70%, 45%);  /* Green */
--color-c: hsl(240, 80%, 65%);  /* Blue */
```

---

## Mood-Based Color Profiles

### Professional / Trust (SaaS, Finance, Healthcare)
```css
--color-primary:    #1a56db; /* Deep blue */
--color-accent:     #0e9f6e; /* Muted green */
--color-bg:         #f9fafb;
--color-text:       #111928;
--color-border:     #e5e7eb;
```

### Energy / Action (Fitness, Gaming, Sports)
```css
--color-primary:    #ff3d00; /* Electric red-orange */
--color-accent:     #ffdd00; /* Yellow */
--color-bg:         #0a0a0a;
--color-text:       #ffffff;
--color-border:     rgba(255,255,255,0.1);
```

### Luxury / Premium (Fashion, Jewelry, Fine Dining)
```css
--color-primary:    #b8960c; /* Muted gold */
--color-accent:     #c9a84c; /* Warm gold */
--color-bg:         #0c0c0c;
--color-text:       #f5f0e8; /* Warm white */
--color-border:     rgba(184, 150, 12, 0.2);
```

### Natural / Organic (Health, Wellness, Food)
```css
--color-primary:    #2d6a4f; /* Forest green */
--color-accent:     #d4a373; /* Warm sand */
--color-bg:         #fefae0; /* Cream */
--color-text:       #333d29;
--color-border:     #ccd5ae;
```

### Creative / Playful (Kids, Gaming, Entertainment)
```css
--color-primary:    #7c3aed; /* Vivid purple */
--color-accent:     #f97316; /* Orange */
--color-secondary:  #06b6d4; /* Cyan */
--color-bg:         #0f0f1a;
--color-text:       #f8fafc;
```

### Tech / Cyberpunk (Developer Tools, Hacker Aesthetic)
```css
--color-primary:    #00ff88; /* Electric green */
--color-accent:     #ff007a; /* Neon pink */
--color-bg:         #050510;
--color-text:       #e2e8f0;
--color-glow:       rgba(0, 255, 136, 0.3);
```

---

## Gradient System

### Directional Gradients
```css
/* Linear — most versatile */
.grad-primary    { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
.grad-warm       { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); }
.grad-cool       { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); }
.grad-nature     { background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%); }
.grad-sunset     { background: linear-gradient(135deg, #fa709a 0%, #fee140 100%); }
.grad-midnight   { background: linear-gradient(135deg, #0c3483 0%, #a2b6df 70%, #6b8cce 100%); }
.grad-aurora     { background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%); }
```

### Mesh Gradient (CSS only)
```css
.mesh-gradient {
  background-color: #0f0f1a;
  background-image:
    radial-gradient(ellipse at 20% 50%, rgba(120,40,200,0.5) 0%, transparent 50%),
    radial-gradient(ellipse at 80% 20%, rgba(255,60,100,0.4) 0%, transparent 40%),
    radial-gradient(ellipse at 70% 80%, rgba(40,180,255,0.4) 0%, transparent 40%),
    radial-gradient(ellipse at 40% 90%, rgba(40,230,140,0.3) 0%, transparent 35%);
}
```

### Gradient Text
```css
.gradient-text {
  background: linear-gradient(135deg, #667eea, #764ba2);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* Animated gradient text */
.gradient-text-animated {
  background: linear-gradient(90deg, #667eea, #764ba2, #f5576c, #667eea);
  background-size: 300% 100%;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: gradientShift 4s linear infinite;
}

@keyframes gradientShift {
  0%   { background-position: 0% 50%; }
  100% { background-position: 100% 50%; }
}
```

---

## Accessibility: Contrast Requirements

| Use Case | WCAG AA | WCAG AAA |
|----------|---------|----------|
| Normal text (< 18px) | 4.5:1 | 7:1 |
| Large text (≥ 18px bold or ≥ 24px) | 3:1 | 4.5:1 |
| UI components & graphics | 3:1 | — |
| Decorative elements | No requirement | — |

```javascript
// Quick contrast ratio checker
function getContrastRatio(hex1, hex2) {
  const lum = hex => {
    const rgb = parseInt(hex.slice(1), 16);
    const [r, g, b] = [rgb >> 16, (rgb >> 8) & 255, rgb & 255].map(c => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const l1 = lum(hex1), l2 = lum(hex2);
  const [bright, dark] = l1 > l2 ? [l1, l2] : [l2, l1];
  return ((bright + 0.05) / (dark + 0.05)).toFixed(2);
}
```

---

## Color Rules

1. **60-30-10 rule** — 60% neutral background, 30% secondary, 10% primary/accent
2. **Never use pure black** — Use `#111827` or `#0f172a` for depth without harshness
3. **Never use pure white** — Use `#f8fafc` or `#fafafa` for warmth
4. **Saturate dark backgrounds** — Add hue to dark surfaces: `#0f1117` (blue-tinted) vs `#111111` (dead gray)
5. **Desaturate at extremes** — Very light and very dark shades should be less saturated than mid-tones
6. **One hero color** — Pick one primary and let it breathe; don't fight for attention with multiple equal-weight colors
7. **Neutral does the heavy lifting** — Your UI is mostly neutral; invest as much in your grays as your brand color
