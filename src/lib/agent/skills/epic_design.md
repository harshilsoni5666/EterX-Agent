---
name: epic-design
description: Use for rich, high-impact web experiences when the user wants cinematic, immersive, premium, motion-heavy, product-led, editorial, portfolio, launch, or scroll-storytelling design. Applies depth, motion, media, and interaction selectively based on the domain instead of forcing a fixed template.
license: MIT
metadata:
  version: 2.0.0
  category: design
---

# Epic Design

Use this skill when the task calls for a memorable web experience. It is not a mandate to make every page cinematic, animated, or asset-heavy.

## Design Judgment

Choose the design intensity from the use case:

| Context | Appropriate Direction |
|---|---|
| SaaS, CRM, admin, ops | Quiet, dense, fast, scannable, restrained motion |
| Product launch, campaign, brand | Immersive media, strong hero, choreographed sections |
| Portfolio, editorial, gallery | Expressive typography, image rhythm, narrative pacing |
| Game, music, art, event | More playful, animated, atmospheric |
| Docs, tools, forms | Utility, clarity, accessibility, low distraction |

Do not force parallax, card stacks, full-screen heroes, scroll hijacking, floating products, or cinematic effects where they hurt usability.

## Workflow

1. Read existing product/design context first: app routes, components, CSS/tokens, screenshots, assets, and target audience.
2. Decide the experience type: utilitarian, editorial, cinematic, playful, luxury, technical, or experimental.
3. Pick only the techniques that serve the content.
4. Use real assets when the subject depends on a real product, person, place, chart, or screenshot.
5. Build the actual user-facing page or component, not a marketing explanation of the design.
6. Verify layout, responsive behavior, text fit, images, and motion fallbacks with available non-browser checks unless browser verification is allowed.

## Technique Menu

Use these as options, not requirements:

- Depth: layered media, soft parallax, sticky object, z-index storytelling.
- Motion: entrance choreography, scroll-linked progress, reveal masks, route transitions.
- Interaction: magnetic hover, tilt, drag, scrub controls, pointer-follow effects.
- Typography: editorial scale, kinetic text, image-text composition, variable fonts.
- Media: real product cutouts, screenshots, video loops, canvas/WebGL scenes.
- Structure: asymmetric split, magazine layout, dashboard surface, timeline, comparison, map, gallery.

## Asset Rules

- Use user-provided assets first.
- If real imagery is needed and available tools permit, find/download validated assets and store them locally.
- Do not use random remote placeholder services or unrelated stock imagery.
- Do not remove image backgrounds unless the design role requires a cutout and the user or source asset supports it.
- If assets are missing, create a layout that still works and clearly note the missing asset.

## Motion And Accessibility

- Respect `prefers-reduced-motion`.
- Use motion to clarify focus, hierarchy, continuity, or emotion.
- Animate transform and opacity where possible.
- Avoid scroll hijacking and persistent motion in task-heavy interfaces.
- Keep decorative layers `aria-hidden` and preserve semantic content order.

## Output Standards

- Match the existing stack when working in a repo.
- For standalone work, a self-contained HTML file is acceptable when it truly satisfies the request.
- Keep implementation maintainable: named sections, scoped CSS/classes, and no unexplained generated clutter.
- Report the files changed/created and the checks run.
