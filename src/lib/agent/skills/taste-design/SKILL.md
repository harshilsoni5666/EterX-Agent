---
name: taste-design
description: Create practical, context-sensitive design system guidance for Stitch or frontend work. Use when a project needs a DESIGN.md, visual direction, anti-generic UI guidance, or reusable design language without forcing one aesthetic.
---

# Taste Design

Generate design guidance that fits the product, audience, and use case. This skill should improve judgment, not impose a single premium style.

## Core Principle

There is no universal best aesthetic. A banking dashboard, children's game, scientific tool, luxury campaign, internal CRM, and artist portfolio should not share the same typography, palette, density, motion, or layout rules.

## Analysis

Before writing design guidance, classify:

- Product type: app, dashboard, marketplace, portfolio, game, editorial, campaign, tool, document, or experiment.
- Audience: executives, operators, consumers, students, developers, patients, buyers, fans, etc.
- Use pattern: repeated work, quick scan, deep reading, exploration, conversion, entertainment.
- Brand posture: restrained, playful, technical, premium, warm, bold, institutional, experimental.
- Content density: sparse, balanced, dense.
- Accessibility and device constraints.

## DESIGN.md Structure

Use this flexible structure:

```markdown
# Design System: [Project]

## 1. Product Context
What this interface helps users do, who uses it, and the design priorities.

## 2. Visual Direction
Mood, density, hierarchy, interaction style, and what the design should avoid for this specific product.

## 3. Palette
Color roles with hex values when known: background, surface, primary action, text, border, status, chart colors.

## 4. Typography
Font roles, scale, line length, numeric treatment, and any brand constraints.

## 5. Layout
Grid, spacing, responsive behavior, navigation, information density, and page rhythm.

## 6. Components
Buttons, inputs, cards/tables/lists, navigation, empty states, loading, errors, and data displays.

## 7. Motion
When motion helps, when it should be restrained, and reduced-motion behavior.

## 8. Anti-Patterns For This Project
Only the patterns that would actually hurt this product.
```

## Guidance Rules

- Use exact tokens where available; otherwise describe roles and leave room for implementation.
- Preserve existing brand systems and UI libraries.
- Use cards, centered heroes, serif fonts, monochrome palettes, bright palettes, or heavy motion when they fit the project. Avoid them only when they harm the product.
- Avoid fabricated metrics, generic placeholder names, broken image links, and inaccessible contrast in every context.
- Motion should clarify feedback, hierarchy, or narrative; it is optional for task-heavy products.
- Make mobile and desktop behavior explicit.

## Output

Create or update a `DESIGN.md` only when useful. For a one-off screen, a concise design brief may be better than a full design system.
