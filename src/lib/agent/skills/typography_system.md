---
name: typography-system
description: >
  Deep skill for typography, font pairing, type scales, editorial layouts, and all
  text-related design decisions. Load when user asks for: font pairing, typography
  system, type scale, heading styles, body text, editorial layout, magazine-style text,
  pull quotes, drop caps, text hierarchy, Google Fonts, variable fonts, responsive type,
  fluid typography, or any situation where the choice and styling of text is central.
  Depends on: ui-engine. Works with: color-systems, responsive-layout.
  Triggers: "typography", "font", "typeface", "type scale", "heading style", "editorial",
  "text hierarchy", "font pairing", "readable", "legible", "body text", "display font".
---

# Typography System — Deep UI Skill

Typography is not decoration. It IS the design. In most interfaces, 70-90% of what users see is text. Getting typography wrong means getting the entire design wrong, no matter how beautiful your colors or animations are.

---

## The Typography Stack Philosophy

Every project needs exactly **two** typefaces. Rarely three. Never four.

| Role | Purpose | Characteristics |
|------|---------|-----------------|
| **Display / Heading** | Commands attention, defines personality | Distinctive, has strong character |
| **Body / Reading** | Sustains attention, ensures comprehension | Neutral but not boring, highly legible |

The two should create **productive tension** — contrast in weight, structure, or era.

---

## Curated Pairings by Aesthetic

### Modern Minimal
```css
@import url('https://fonts.googleapis.com/css2?family=Cabinet+Grotesk:wght@400;500;700;900&family=Literata:ital,wght@0,400;0,500;1,400&display=swap');

:root {
  --font-display: 'Cabinet Grotesk', sans-serif;
  --font-body:    'Literata', Georgia, serif;
}
```

### High-Tech / SaaS
```css
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=IBM+Plex+Mono:ital,wght@0,400;0,500;1,400&display=swap');

:root {
  --font-display: 'Syne', sans-serif;
  --font-body:    'IBM Plex Mono', monospace;
}
```

### Editorial / Magazine
```css
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,400;1,700&family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,600&display=swap');

:root {
  --font-display: 'Playfair Display', serif;
  --font-body:    'Source Serif 4', serif;
}
```

### Brutalist / Raw
```css
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;900&family=Barlow:wght@400;500&display=swap');

:root {
  --font-display: 'Barlow Condensed', sans-serif;
  --font-body:    'Barlow', sans-serif;
}
```

### Luxury / Fashion
```css
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Jost:wght@300;400;500&display=swap');

:root {
  --font-display: 'Cormorant Garamond', serif;
  --font-body:    'Jost', sans-serif;
}
```

### Retro / Nostalgic
```css
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@400;500&display=swap');

:root {
  --font-display: 'Bebas Neue', sans-serif;
  --font-body:    'DM Sans', sans-serif;
  --font-accent:  'DM Serif Display', serif; /* 3rd font for pull quotes */
}
```

### Warm / Humanist
```css
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,700;1,9..144,300&family=Plus+Jakarta+Sans:wght@400;500;600&display=swap');

:root {
  --font-display: 'Fraunces', serif;
  --font-body:    'Plus Jakarta Sans', sans-serif;
}
```

---

## The Type Scale System

Use a mathematical scale for consistency. Major Third (1.25) is the most versatile.

```css
:root {
  --text-base-size: 1rem; /* 16px */
  --type-scale:     1.25; /* Major Third */

  --text-xs:   calc(var(--text-base-size) / var(--type-scale) / var(--type-scale)); /* ~10px */
  --text-sm:   calc(var(--text-base-size) / var(--type-scale));                     /* ~13px */
  --text-base: var(--text-base-size);                                               /* 16px */
  --text-md:   calc(var(--text-base-size) * var(--type-scale));                     /* 20px */
  --text-lg:   calc(var(--text-base-size) * var(--type-scale) * var(--type-scale)); /* 25px */
  --text-xl:   calc(var(--text-base-size) * pow(var(--type-scale), 3));             /* 31px */
  --text-2xl:  calc(var(--text-base-size) * pow(var(--type-scale), 4));             /* 39px */
  --text-3xl:  calc(var(--text-base-size) * pow(var(--type-scale), 5));             /* 49px */
  --text-4xl:  calc(var(--text-base-size) * pow(var(--type-scale), 6));             /* 61px */

  /* Line heights */
  --leading-tight:   1.2;
  --leading-snug:    1.35;
  --leading-normal:  1.5;
  --leading-relaxed: 1.65;
  --leading-loose:   1.85;

  /* Letter spacing */
  --tracking-tight:   -0.04em;
  --tracking-snug:    -0.02em;
  --tracking-normal:   0em;
  --tracking-wide:     0.04em;
  --tracking-wider:    0.08em;
  --tracking-widest:   0.16em;
}
```

---

## Semantic Type Styles

Apply these consistently across the entire interface:

```css
/* Hero / Display — largest statement */
.type-display {
  font-family: var(--font-display);
  font-size: clamp(var(--text-3xl), 8vw, var(--text-4xl));
  font-weight: 800;
  line-height: var(--leading-tight);
  letter-spacing: var(--tracking-tight);
}

/* H1 — primary page heading */
.type-h1 {
  font-family: var(--font-display);
  font-size: clamp(var(--text-2xl), 5vw, var(--text-3xl));
  font-weight: 700;
  line-height: var(--leading-tight);
  letter-spacing: var(--tracking-snug);
}

/* H2 — section heading */
.type-h2 {
  font-family: var(--font-display);
  font-size: clamp(var(--text-xl), 3.5vw, var(--text-2xl));
  font-weight: 600;
  line-height: var(--leading-snug);
}

/* H3 — subsection */
.type-h3 {
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: 600;
  line-height: var(--leading-snug);
}

/* Body — default reading text */
.type-body {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  line-height: var(--leading-relaxed);
  max-width: 66ch; /* Optimal reading width */
}

/* Label — UI labels, captions */
.type-label {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  font-weight: 500;
  line-height: var(--leading-normal);
  letter-spacing: var(--tracking-wide);
  text-transform: uppercase;
}

/* Mono — code, data, numbers */
.type-mono {
  font-family: 'IBM Plex Mono', 'Fira Code', monospace;
  font-size: 0.9em;
  font-feature-settings: 'calt' 1, 'liga' 1;
}
```

---

## Editorial Techniques

### Drop Cap
```css
.drop-cap::first-letter {
  float: left;
  font-family: var(--font-display);
  font-size: calc(var(--text-base) * 4);
  font-weight: 900;
  line-height: 0.8;
  margin-right: var(--space-2);
  margin-top: var(--space-1);
  color: var(--color-primary);
}
```

### Pull Quote
```css
.pull-quote {
  position: relative;
  padding: var(--space-6) var(--space-7);
  font-family: var(--font-display);
  font-size: var(--text-xl);
  font-style: italic;
  font-weight: 300;
  line-height: var(--leading-snug);
  color: var(--color-text-primary);
  border-left: 4px solid var(--color-primary);
  margin: var(--space-8) 0;
}

.pull-quote::before {
  content: '"';
  position: absolute;
  top: -20px; left: var(--space-5);
  font-size: 5rem;
  color: var(--color-primary);
  opacity: 0.3;
  font-family: Georgia, serif;
  line-height: 1;
}
```

### Text Columns (magazine layout)
```css
.text-columns-2 {
  columns: 2;
  column-gap: var(--space-8);
  column-rule: 1px solid var(--color-border);
}

.text-columns-3 {
  columns: 3;
  column-gap: var(--space-6);
}

/* Prevent orphaned headings */
h2, h3, h4 { break-after: avoid; }
```

---

## Fluid Typography (Responsive)

No breakpoints needed — type scales smoothly with viewport:

```css
/* clamp(MIN, PREFERRED, MAX) */
h1 { font-size: clamp(2rem, 5vw + 1rem, 4rem); }
h2 { font-size: clamp(1.5rem, 3.5vw + 0.5rem, 2.5rem); }
p  { font-size: clamp(1rem, 1vw + 0.75rem, 1.2rem); }
```

---

## Typography Rules (Never Break These)

1. **Body text: 16px minimum** — Never below 14px for sustained reading
2. **Line length: 45–75 characters** — Use `max-width: 66ch` on body text
3. **Line height: 1.4–1.6 for body** — Tight for headings (1.1–1.3), loose for body
4. **Hierarchy: max 4 sizes per page** — More creates confusion, not structure
5. **Weight contrast: at least 200 weight gap** — Thin body + Bold heading, not Regular + Medium
6. **Don't kern with letter-spacing on body** — Only use letter-spacing for uppercase labels
7. **Italic for emphasis, not bold** — Bold is for headings; italic is for stress in body
8. **Font-feature-settings for numbers** — Use tabular figures in data tables: `font-variant-numeric: tabular-nums`
