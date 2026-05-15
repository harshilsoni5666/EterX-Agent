---
name: component-architecture
description: >
  Deep skill for design systems, component architecture, reusable UI patterns,
  variant systems, and scalable frontend structure. Load when user asks for: design
  system, component library, reusable components, variant patterns, compound components,
  atomic design, UI kit, button system, form system, card system, navigation patterns,
  data display components, or building scalable and consistent UI at scale.
  Depends on: ui-engine. Works with: typography-system, color-systems, dark-mode-theming.
  Triggers: "component", "design system", "UI kit", "reusable", "variant", "pattern",
  "atomic design", "button component", "form component", "card component", "scalable UI".
---

# Component Architecture — Deep UI Skill

A component is not just styled HTML. A well-architected component is a **contract** — it has a clear API (props/attributes), predictable variants, defined states, and is isolated from its context. Build components like you build functions: single responsibility, composable, and testable.

---

## The Component Design Checklist

Before building any component, answer all of these:

```
□ What is the ONE job of this component?
□ What variants does it have? (size, color, shape, intent)
□ What states does it have? (default, hover, focus, active, disabled, loading, error)
□ What content does it accept? (slots, children, props)
□ How does it behave responsively?
□ What are its accessibility requirements? (role, aria-*, keyboard nav)
□ Does it need animation? Which states trigger it?
```

---

## The Button System (Complete)

The most important component in any design system. Build it right once.

```css
/* ─── Base Button ─── */
.btn {
  /* Layout */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  white-space: nowrap;

  /* Typography */
  font-family: var(--font-body);
  font-weight: 600;
  letter-spacing: 0.01em;
  text-decoration: none;

  /* Shape */
  border: 1.5px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  user-select: none;

  /* Animation */
  transition:
    background-color var(--duration-fast) var(--ease-smooth),
    border-color var(--duration-fast) var(--ease-smooth),
    color var(--duration-fast) var(--ease-smooth),
    box-shadow var(--duration-fast) var(--ease-smooth),
    transform var(--duration-fast) var(--ease-spring),
    opacity var(--duration-fast) var(--ease-smooth);

  /* Prevent text selection */
  -webkit-user-select: none;
}

.btn:active:not(:disabled) {
  transform: scale(0.97) translateY(1px);
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  pointer-events: none;
}

/* ─── Size Variants ─── */
.btn-xs  { padding: var(--space-1) var(--space-3); font-size: var(--text-xs); border-radius: var(--radius-sm); }
.btn-sm  { padding: var(--space-2) var(--space-4); font-size: var(--text-sm); }
.btn-md  { padding: var(--space-3) var(--space-5); font-size: var(--text-base); }
.btn-lg  { padding: var(--space-4) var(--space-6); font-size: var(--text-md); border-radius: var(--radius-lg); }
.btn-xl  { padding: var(--space-5) var(--space-8); font-size: var(--text-lg); border-radius: var(--radius-xl); }

/* ─── Intent/Color Variants ─── */
/* Primary */
.btn-primary {
  background: var(--color-primary);
  color: white;
  box-shadow: 0 1px 2px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.1);
}
.btn-primary:hover:not(:disabled) {
  background: var(--color-primary-hover);
  box-shadow: var(--shadow-md);
}

/* Secondary */
.btn-secondary {
  background: var(--color-bg-subtle);
  color: var(--color-text-primary);
  border-color: var(--color-border-strong);
}
.btn-secondary:hover:not(:disabled) {
  background: var(--color-bg-muted);
  border-color: var(--color-border-strong);
}

/* Ghost */
.btn-ghost {
  background: transparent;
  color: var(--color-text-secondary);
}
.btn-ghost:hover:not(:disabled) {
  background: var(--color-bg-subtle);
  color: var(--color-text-primary);
}

/* Destructive */
.btn-danger {
  background: var(--color-error);
  color: white;
}
.btn-danger:hover:not(:disabled) {
  background: #dc2626;
  box-shadow: 0 0 0 3px var(--color-error-bg);
}

/* Outline */
.btn-outline {
  background: transparent;
  color: var(--color-primary);
  border-color: var(--color-primary);
}
.btn-outline:hover:not(:disabled) {
  background: var(--color-primary-bg);
}

/* Shape variants */
.btn-icon  { padding: var(--space-3); aspect-ratio: 1; }
.btn-pill  { border-radius: var(--radius-full); }
.btn-block { width: 100%; }

/* Focus visible */
.btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
```

---

## The Card System

```css
/* ─── Base Card ─── */
.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  overflow: hidden;
}

/* Padding variants */
.card-body     { padding: var(--space-6); }
.card-body-sm  { padding: var(--space-4); }
.card-body-lg  { padding: var(--space-8); }

/* Visual variants */
.card-flat {
  box-shadow: none;
  border: 1px solid var(--color-border);
}

.card-raised {
  box-shadow: var(--shadow-md);
  border: none;
}

.card-outlined {
  background: transparent;
  border: 2px solid var(--color-border-strong);
  box-shadow: none;
}

.card-ghost {
  background: transparent;
  border: none;
  box-shadow: none;
}

/* Interactive card */
.card-interactive {
  cursor: pointer;
  transition:
    transform var(--duration-normal) var(--ease-spring),
    box-shadow var(--duration-normal) var(--ease-smooth),
    border-color var(--duration-fast) var(--ease-smooth);
}

.card-interactive:hover {
  transform: translateY(-3px);
  box-shadow: var(--shadow-lg);
  border-color: var(--color-border-focus);
}

/* Card sub-elements */
.card-header {
  padding: var(--space-4) var(--space-6);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-footer {
  padding: var(--space-4) var(--space-6);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-subtle);
}

.card-image {
  width: 100%;
  aspect-ratio: 16/9;
  object-fit: cover;
  display: block;
}
```

---

## The Badge/Tag System

```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-3);
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.03em;
  white-space: nowrap;
  line-height: 1.6;
}

/* Semantic variants */
.badge-default  { background: var(--color-bg-muted); color: var(--color-text-secondary); }
.badge-primary  { background: var(--color-primary-bg); color: var(--color-primary); }
.badge-success  { background: var(--color-success-bg); color: var(--color-success); }
.badge-warning  { background: var(--color-warning-bg); color: var(--color-warning); }
.badge-error    { background: var(--color-error-bg); color: var(--color-error); }
.badge-info     { background: rgba(6,182,212,0.1); color: var(--color-info); }

/* Solid variants */
.badge-solid-primary { background: var(--color-primary); color: white; }
.badge-solid-success { background: var(--color-success); color: white; }

/* Pulse dot (for live/status indicators) */
.badge-live::before {
  content: '';
  width: 6px; height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse-dot 2s ease infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.5; transform: scale(0.8); }
}
```

---

## The Input System

```css
/* ─── Base Input ─── */
.input-wrapper {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.input-label {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--color-text-secondary);
}

.input-label.required::after {
  content: ' *';
  color: var(--color-error);
}

.input {
  width: 100%;
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-base);
  font-family: var(--font-body);
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1.5px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  outline: none;
  transition:
    border-color var(--duration-fast) var(--ease-smooth),
    box-shadow var(--duration-fast) var(--ease-smooth);
}

.input::placeholder { color: var(--color-text-muted); }

.input:hover:not(:disabled) {
  border-color: var(--color-text-secondary);
}

.input:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-bg);
}

.input:disabled {
  background: var(--color-bg-muted);
  color: var(--color-text-disabled);
  cursor: not-allowed;
}

/* States */
.input.error  { border-color: var(--color-error); }
.input.error:focus { box-shadow: 0 0 0 3px var(--color-error-bg); }
.input.success { border-color: var(--color-success); }
.input.success:focus { box-shadow: 0 0 0 3px var(--color-success-bg); }

/* Input with icon */
.input-group {
  position: relative;
}
.input-icon-left  { position: absolute; left: var(--space-4); top: 50%; transform: translateY(-50%); color: var(--color-text-muted); pointer-events: none; }
.input-icon-right { position: absolute; right: var(--space-4); top: 50%; transform: translateY(-50%); color: var(--color-text-muted); pointer-events: none; }
.input-group .input.has-left-icon  { padding-left: var(--space-9); }
.input-group .input.has-right-icon { padding-right: var(--space-9); }

/* Help text and errors */
.input-help  { font-size: var(--text-sm); color: var(--color-text-muted); }
.input-error { font-size: var(--text-sm); color: var(--color-error); }
```

---

## Component Composition Principles

1. **Single Responsibility** — One component does one thing. `<Card>` doesn't know about pagination.
2. **Open/Closed** — Components accept children/slots instead of baking in content
3. **Composition over inheritance** — `<Card><CardHeader/><CardBody/></Card>` beats a monolith
4. **Prop-driven state, not class hacking** — `variant="primary"` not `className="btn-primary"`
5. **Semantic HTML first** — `<button>` for buttons, `<a>` for navigation, `<input>` for inputs
6. **Never hardcode values** — All sizing, color, and spacing must reference tokens
7. **Document states visually** — Every component should have a story for each state
