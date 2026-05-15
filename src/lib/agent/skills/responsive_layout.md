---
name: responsive-layout
description: >
  Deep skill for responsive design, mobile-first layouts, fluid grids, CSS Grid,
  Flexbox, container queries, and adaptive UI. Load when user asks for: responsive
  design, mobile-first, breakpoints, grid layout, flex layout, container queries,
  fluid layout, sidebar layout, multi-column, holy grail layout, masonry, sticky
  headers, bottom navigation, or any layout that must adapt across screen sizes.
  Depends on: ui-engine. Works with: typography-system, component-architecture.
  Triggers: "responsive", "mobile", "layout", "grid", "flexbox", "breakpoint",
  "sidebar", "column", "fluid", "adaptive", "container query", "mobile first".
---

# Responsive Layout — Deep UI Skill

Responsive design is not about hiding things on mobile. It's about designing **one coherent experience** that intelligently adapts to any container. The best responsive layouts feel like they were always meant to look this way at any size.

---

## The Layout Philosophy

```
Mobile first → Progressive enhancement
Content first → Layout second
Fluid by default → Breakpoints as exceptions
Intrinsic sizing → Let content drive dimensions
```

---

## Breakpoint System

```css
:root {
  /* Breakpoints */
  --bp-xs:  320px;
  --bp-sm:  480px;
  --bp-md:  768px;
  --bp-lg:  1024px;
  --bp-xl:  1280px;
  --bp-2xl: 1536px;
}

/* Mobile-first (min-width) media queries */
/* Base:   < 480px  (mobile) */
/* sm:     ≥ 480px  (large mobile) */
/* md:     ≥ 768px  (tablet) */
/* lg:     ≥ 1024px (small desktop) */
/* xl:     ≥ 1280px (desktop) */
/* 2xl:    ≥ 1536px (wide desktop) */

/* Usage pattern */
.component {
  /* Base (mobile) */
  font-size: var(--text-base);
  padding: var(--space-4);
  flex-direction: column;
}

@media (min-width: 768px) {
  .component {
    font-size: var(--text-md);
    padding: var(--space-6);
    flex-direction: row;
  }
}

@media (min-width: 1024px) {
  .component {
    padding: var(--space-8);
  }
}
```

---

## The Fluid Container System

```css
.container {
  width: 100%;
  margin-inline: auto;
  padding-inline: var(--space-5);
}

/* Fluid max-widths with padding */
.container-sm  { max-width: calc(640px + 2 * var(--space-5)); }
.container-md  { max-width: calc(768px + 2 * var(--space-5)); }
.container-lg  { max-width: calc(1024px + 2 * var(--space-6)); }
.container-xl  { max-width: calc(1280px + 2 * var(--space-8)); }
.container-2xl { max-width: calc(1536px + 2 * var(--space-8)); }

/* Prose container (optimal reading width) */
.container-prose { max-width: 72ch; }

/* Bleed — full-width within a narrow container */
.bleed {
  margin-inline: calc(-1 * var(--space-5));
  width: calc(100% + 2 * var(--space-5));
}
```

---

## CSS Grid Layouts

### Auto-Fit Grid (Responsive without media queries)
```css
/* Cards that automatically fit: minimum 280px, grow to fill */
.grid-auto-fit {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));
  gap: var(--space-5);
}

/* Fine-tuned auto-fill (maintains minimum columns) */
.grid-auto-fill {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--space-4);
}
```

### Named Template Areas (Semantic Layouts)
```css
/* Classic App Layout */
.app-layout {
  display: grid;
  grid-template-areas:
    "header  header"
    "sidebar content"
    "footer  footer";
  grid-template-columns: 260px 1fr;
  grid-template-rows: auto 1fr auto;
  min-height: 100vh;
  gap: 0;
}

@media (max-width: 768px) {
  .app-layout {
    grid-template-areas:
      "header"
      "content"
      "footer";
    grid-template-columns: 1fr;
  }
  .app-sidebar { display: none; } /* or slide-over panel */
}

.app-header  { grid-area: header; }
.app-sidebar { grid-area: sidebar; }
.app-content { grid-area: content; }
.app-footer  { grid-area: footer; }
```

### Holy Grail Layout
```css
.holy-grail {
  display: grid;
  grid-template-columns: clamp(180px, 20%, 280px) 1fr clamp(180px, 20%, 280px);
  grid-template-rows: auto 1fr auto;
  min-height: 100vh;

  /* On tablet: 2 columns */
  @media (max-width: 960px) {
    grid-template-columns: clamp(180px, 25%, 240px) 1fr;
    /* Right sidebar moves to bottom */
  }

  /* On mobile: single column */
  @media (max-width: 600px) {
    grid-template-columns: 1fr;
  }
}
```

### Magazine Grid
```css
.magazine-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--space-5);
}

/* Featured article spans 8 columns */
.article-featured {
  grid-column: span 8;
}

/* Secondary articles share the remaining 4 */
.article-secondary {
  grid-column: span 4;
}

/* On tablet */
@media (max-width: 768px) {
  .article-featured   { grid-column: span 12; }
  .article-secondary  { grid-column: span 6; }
}

/* On mobile */
@media (max-width: 480px) {
  .article-featured,
  .article-secondary { grid-column: span 12; }
}
```

---

## Flexbox Patterns

### Navigation Bar
```css
.navbar {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-6);
}

.navbar-brand { margin-right: auto; } /* Pushes everything else right */

.navbar-links {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.navbar-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-left: var(--space-4);
}

/* Mobile: collapse to hamburger */
@media (max-width: 768px) {
  .navbar-links,
  .navbar-actions { display: none; }
  .navbar-hamburger { display: flex; }
}
```

### Sidebar + Content
```css
.sidebar-layout {
  display: flex;
  min-height: 100vh;
}

.sidebar {
  width: 260px;
  flex-shrink: 0;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  border-right: 1px solid var(--color-border);
}

.main-content {
  flex: 1;
  min-width: 0; /* Prevents flex blowout */
  padding: var(--space-8);
  overflow: hidden;
}
```

### Card Row with Overflow Scroll (Mobile)
```css
.card-row {
  display: flex;
  gap: var(--space-4);
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;
  padding-bottom: var(--space-3); /* Space for scrollbar */
  scrollbar-width: thin;
}

.card-row-item {
  flex: 0 0 280px; /* Fixed width, no shrinking */
  scroll-snap-align: start;
}

/* On desktop: wrap normally */
@media (min-width: 768px) {
  .card-row {
    flex-wrap: wrap;
    overflow-x: visible;
  }
  .card-row-item {
    flex: 1 1 280px;
  }
}
```

---

## Container Queries (Modern Responsive)

Component-level responsiveness — not viewport-based:

```css
/* Set up a containment context */
.card-container {
  container-type: inline-size;
  container-name: card;
}

/* Component responds to its container's width, not viewport */
@container card (min-width: 400px) {
  .card-inner {
    flex-direction: row;
    align-items: center;
  }
  .card-image {
    width: 40%;
    flex-shrink: 0;
  }
}

@container card (min-width: 600px) {
  .card-inner {
    gap: var(--space-6);
  }
  .card-title {
    font-size: var(--text-xl);
  }
}
```

---

## Fluid Spacing (Responsive without Media Queries)

```css
/* Fluid spacing using clamp */
.section {
  padding-block: clamp(var(--space-8), 8vw, var(--space-10));
  padding-inline: clamp(var(--space-5), 5vw, var(--space-9));
}

.section-gap {
  display: flex;
  flex-direction: column;
  gap: clamp(var(--space-5), 4vw, var(--space-8));
}
```

---

## Bottom Navigation (Mobile)

```css
.bottom-nav {
  display: none;
  position: fixed;
  bottom: 0; left: 0; right: 0;
  background: var(--color-surface-overlay);
  backdrop-filter: blur(16px);
  border-top: 1px solid var(--color-border);
  padding: var(--space-2) var(--space-4);
  padding-bottom: max(var(--space-2), env(safe-area-inset-bottom));
  z-index: var(--z-overlay);

  justify-content: space-around;
  align-items: center;
}

@media (max-width: 768px) {
  .bottom-nav { display: flex; }
  .sidebar    { display: none; }
  /* Add bottom padding to content */
  .main-content { padding-bottom: 80px; }
}

.bottom-nav-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: var(--space-2);
  border-radius: var(--radius-md);
  font-size: 10px;
  font-weight: 500;
  color: var(--color-text-muted);
  transition: color var(--duration-fast) var(--ease-smooth);
  min-width: 56px;
  text-align: center;
}

.bottom-nav-item.active {
  color: var(--color-primary);
}
```

---

## Layout Rules

1. **Mobile first always** — Start with 1 column, add columns as space increases
2. **`min()` for safe sizing** — `minmax(min(280px, 100%), 1fr)` prevents overflow
3. **`min-width: 0` on flex children** — Prevents content from blowing out its container
4. **Avoid fixed heights** — Let content define height; use `min-height` instead
5. **Sticky sidebar requires height** — The sidebar parent needs explicit `height` or `100vh`
6. **Scroll snap for mobile carousels** — `scroll-snap-type: x mandatory` on the row, `scroll-snap-align: start` on items
7. **Safe area insets** — Add `env(safe-area-inset-bottom)` padding for iPhone notch/home indicator
8. **Container queries > media queries** — For reusable components, container queries are always more correct
