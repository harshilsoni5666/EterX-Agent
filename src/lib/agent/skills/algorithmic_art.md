---
name: algorithmic-art
description: Create original generative or algorithmic art with code, including p5.js, Canvas, SVG, WebGL/Three.js, shaders, particle systems, flow fields, simulations, procedural patterns, and interactive controls. Use when the user asks for code-made art, generative visuals, creative coding, visual experiments, or interactive art artifacts.
license: Complete terms in LICENSE.txt
---

# Algorithmic Art

This skill guides creative coding. It should expand the design space, not force a house template, fixed branding, or one visual language.

## Core Principles

- Start from the user's subject, mood, medium, and constraints.
- Choose the rendering approach that fits the idea: p5.js, raw Canvas, SVG, CSS, WebGL, shaders, or a small React/Vite artifact.
- Make the output real and inspectable: a runnable `.html`, project file, or source module, not just a description.
- Preserve creative freedom. Examples are references, not required layouts.
- Use seeded randomness when reproducibility matters; skip it when live improvisation matters more.
- Keep controls only when they help exploration. Do not add sliders, seed panels, sidebars, or download buttons by default.

## Workflow

1. Interpret the brief: subject, atmosphere, palette, motion level, interaction level, and target format.
2. Pick the algorithmic language:
   - Flow fields, particles, reaction-diffusion, cellular automata, L-systems, Voronoi, signed-distance fields, shaders, geometry, typographic systems, audio reactivity, or data-driven visuals.
3. Decide the artifact shape:
   - Single self-contained HTML for quick delivery.
   - Project-integrated component when working inside an app.
   - Separate `.js`/`.ts` modules when maintainability matters.
4. Implement the piece with clear names and bounded performance.
5. Verify the artifact runs and the canvas/SVG is nonblank. If browser checks are unavailable, inspect the generated file and run available build/static checks.

## Creative Direction

The art should feel intentional:

- Use rhythm, density, hierarchy, contrast, and negative space.
- Tune parameters until the result has composition, not just noise.
- Match style to the prompt: scientific, playful, meditative, brutalist, luxurious, educational, surreal, nostalgic, or utilitarian.
- Prefer originality over copying a known artist's exact style.
- Avoid generic "AI art UI" shells unless the user asked for an explorer interface.

## Interaction Options

Add these only when useful:

- Seed controls for reproducible series.
- Palette controls for exploration.
- Sliders for visible physical parameters.
- Play/pause/reset for simulations.
- Export PNG/SVG/WebM when the user needs downloadable output.
- Gallery mode for comparing variants.

## Technical Standards

- Keep animation on `requestAnimationFrame` or the framework's native loop.
- Bound particle counts and canvas resolution for responsive performance.
- Respect `prefers-reduced-motion` when the page contains large or persistent motion.
- Avoid external dependencies unless they clearly improve the result.
- If using CDNs, pick stable public URLs and keep the artifact usable when possible.

## Output

Deliver the format that matches the request:

- Quick standalone visual: one `.html` file with inline CSS/JS.
- App integration: components/modules that match the project stack.
- Study or concept: a short design note plus runnable code.

Mention what was created, how to run it, and any verification performed.
