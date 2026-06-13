---
name: "senior-frontend"
description: Use for frontend architecture, React/Next.js/Vite implementation, component design, state management, accessibility, performance, responsive layouts, UI polish, and frontend code review.
---

# Senior Frontend Engineer

Use this skill to ship frontends that are usable, maintainable, accessible, and aligned with the existing product design system.

## First Pass

1. Identify framework, routing model, styling system, component library, data-fetching pattern, and test setup.
2. Read nearby components before creating new ones.
3. Reuse existing tokens, layout primitives, icons, forms, and state patterns.
4. Keep state local unless multiple independent areas need it.
5. Verify visually and with project checks when the task changes user-visible behavior.

## Useful Local Commands

Use commands that exist in the repository:

```bash
rg --files
rg -n "use client|createContext|useReducer|zustand|redux|react-query|tanstack|tailwind|className|aria-"
npm run lint
npm test
npm run build
npx playwright test
```

If a command is absent, inspect `package.json` and use the repo's equivalent.

## Component Standards

- Components should have one clear responsibility and stable props.
- Prefer composition over configuration objects with many flags.
- Keep data loading, mutation, and presentation boundaries explicit.
- Use semantic HTML first; add ARIA only when native semantics are insufficient.
- Use accessible names for controls and visible focus states for keyboard users.
- Avoid layout shifts by reserving stable dimensions for images, grids, and controls.
- Do not hardcode remote placeholder images or fake metrics.

## Styling Standards

- Use existing design tokens and variants.
- Keep spacing, typography, and color choices consistent with the product surface.
- Avoid one-off colors unless the design system lacks the required token.
- Make responsive behavior explicit with stable constraints, not viewport-scaled fonts.
- Keep cards for actual grouped objects or tools; do not nest decorative cards.

## Performance

- Keep server/client boundaries deliberate in Next.js.
- Avoid unnecessary client components and large shared bundles.
- Memoize only when measurement or clear render cost justifies it.
- Lazy-load heavy charts, editors, maps, and media.
- Check images for size, format, dimensions, and loading behavior.

## Review Output

For frontend reviews, report:

- User-visible bugs and accessibility issues first.
- State/data-flow risks.
- Responsive or visual breakpoints likely to fail.
- Performance and bundle concerns.
- Missing tests or visual verification.
- Specific changes that fit the existing component model.
