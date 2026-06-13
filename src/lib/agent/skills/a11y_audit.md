---
name: "a11y-audit"
description: Use for accessibility audits, WCAG 2.2 A/AA review, fixing a11y violations, checking color contrast, keyboard navigation, ARIA, semantic HTML, screen-reader behavior, and adding accessibility checks to tests or CI.
---

# Accessibility Audit

Audit accessibility with evidence from the codebase, rendered UI when available, configured test tools, and manual reasoning. Automated tools catch many issues but do not prove full WCAG compliance by themselves.

## Workflow

1. Identify the framework, routes/screens, component library, design system, and existing a11y tooling.
2. Scope the audit: whole app, changed files, one workflow, one component, or CI gate.
3. Run configured static checks first: lint, typecheck, component tests, existing a11y tests.
4. When a local app/browser is available, run browser-level checks such as axe and manual keyboard traversal.
5. Fix issues in the project’s existing component and styling patterns.
6. Re-run the checks that found the issue and add regression tests for important flows.

## What To Check

| Area | Checks |
|---|---|
| Semantics | Native elements, headings, landmarks, lists, tables, form structure |
| Names/descriptions | Labels, alt text, button names, dialog names, error text association |
| Keyboard | Tab order, focus traps, escape behavior, skip links, no pointer-only interactions |
| Focus | Visible focus, restored focus after dialogs/routes, no hidden focused elements |
| Contrast | Text, icons, states, charts, disabled/read-only affordances |
| ARIA | Valid roles/states, no redundant ARIA, live regions only where useful |
| Motion | Reduced-motion support and no essential information conveyed only by motion |
| Errors | Inline validation, summaries, `aria-invalid`, `aria-describedby` |
| Responsive | Zoom/reflow to 200-400%, touch target size, no clipped text |

## Useful Tooling

Prefer tools already present in the repository. Common options:

```bash
npx @axe-core/cli http://localhost:3000
npx @axe-core/cli http://localhost:3000 --json
npx eslint . --ext .js,.jsx,.ts,.tsx
npm test -- --runInBand
```

Also look for Playwright accessibility checks, `jest-axe`, `eslint-plugin-jsx-a11y`, Storybook a11y, and design-system test utilities.

## Fixing Guidance

- Prefer native controls over adding ARIA to generic elements.
- Keep visible labels whenever possible; use ARIA labels only when visible text cannot work.
- Make clickable regions reachable and operable by keyboard.
- Keep focus indicators visible and high contrast.
- Use semantic form errors tied to the affected field.
- Avoid relying on color alone; add text, icons, patterns, or state labels.
- Preserve accessibility behavior when wrapping third-party components.

## Report Format

Lead with findings ordered by severity:

```text
[P1] Checkout modal traps keyboard focus behind overlay
Evidence: Tab order reaches background page after opening dialog.
Impact: Keyboard and screen-reader users can lose context and submit unintended actions.
Fix: Use the design-system Dialog primitive or add focus trap, labelled title, escape handling, and focus restoration.
Verification: Add Playwright keyboard test and rerun axe/manual tab pass.
```

Then include checks run, residual risk, and any manual checks still needed.

## Resources

- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [axe-core rules](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md)
- [eslint-plugin-jsx-a11y](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y)
