---
name: design-md
description: Analyze Stitch screens or frontend artifacts and synthesize a practical DESIGN.md with visual direction, tokens, component guidance, and responsive rules.
---

# DESIGN.md Skill

Create design documentation that helps future screens stay coherent. Do not force one format or aesthetic when a shorter design brief is enough.

## Inputs

Use whatever is available:

- Existing Stitch project/screen metadata.
- Generated HTML/CSS.
- Screenshots.
- Existing app CSS, Tailwind config, tokens, components, or brand docs.
- User-provided visual references.

If Stitch tools are unavailable, work from local files or ask for the missing export.

## Analysis

Extract:

- Product context and audience.
- Visual atmosphere and density.
- Palette roles with exact values when available.
- Typography roles and scale.
- Layout rhythm, spacing, grid behavior, and responsive rules.
- Component patterns: buttons, inputs, navigation, cards/tables/lists, empty/loading/error states.
- Motion and interaction guidance.
- Project-specific anti-patterns.

## Output

Use this structure unless the project needs something smaller:

```markdown
# Design System: [Project]

## Product Context

## Visual Direction

## Palette

## Typography

## Layout And Responsiveness

## Components

## Motion And Interaction

## Accessibility

## Avoid For This Project
```

## Quality Bar

- Use exact tokens where known and descriptive roles where not.
- Explain why choices fit the product.
- Preserve existing brand systems and project conventions.
- Avoid broad bans. Only forbid patterns that would hurt this specific product.
