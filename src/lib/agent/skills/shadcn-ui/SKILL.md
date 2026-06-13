---
name: shadcn-ui
description: Use for integrating, customizing, reviewing, or troubleshooting shadcn/ui components, registries, blocks, Tailwind styling, Radix/Base UI primitives, component ownership, accessibility, and app-specific component composition.
---

# shadcn/ui

Work with shadcn/ui as source code owned by the project, not as a black-box component library. Inspect the current project before choosing commands or component paths.

## Discovery

Check for:

- `components.json`
- Tailwind config and global CSS
- `components/ui/` or the configured UI component alias
- `lib/utils` or equivalent `cn()` helper
- Existing component wrappers, form patterns, theme tokens, and import aliases
- Package manager and scripts

## Installation And Updates

Use the project’s package manager and existing shadcn configuration. Common commands:

```bash
npx shadcn@latest init
npx shadcn@latest add button dialog form table
```

Before adding a component:

1. Confirm the project already uses shadcn/ui or the user wants it added.
2. Check whether the component already exists locally.
3. Install only the needed component or block.
4. Review generated files before editing wrappers or app code.

## Customization

- Keep generated primitives in the configured UI component directory.
- Put product-specific composed components outside the generated UI directory.
- Preserve accessibility behavior from the underlying primitive.
- Use the existing token system and Tailwind conventions.
- Avoid one-off class sprawl when a variant, wrapper, or token is more maintainable.
- Do not overwrite customized local components without reading them first.

## Review Checklist

| Area | Check |
|---|---|
| Imports | Aliases match `components.json` and `tsconfig` |
| Styling | Tailwind config, CSS variables, dark mode, and theme tokens are wired |
| Accessibility | Keyboard behavior, ARIA, focus management, labels, and contrast survive customization |
| Ownership | Project-specific logic lives in app components, not copied primitive internals |
| Dependencies | Added packages are necessary and compatible with the current stack |
| Validation | Typecheck, lint, tests, and visual/manual checks as available |

## Troubleshooting

- Import failures usually come from alias mismatch, missing `cn()`, or generated files in the wrong directory.
- Missing styles usually come from Tailwind content globs, missing global CSS import, or CSS variable mismatch.
- Hydration issues usually come from client/server component boundaries in React frameworks.
- Broken overlays/popovers usually come from portal containers, z-index context, focus traps, or nested interactive elements.

Use official shadcn/ui documentation or installed registry metadata when the requested component behavior depends on the current version.
