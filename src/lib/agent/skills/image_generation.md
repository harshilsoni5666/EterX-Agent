---
name: image-generation
description: "Use this skill for raster image generation or image editing requests: photos, illustrations, product mockups, UI mockups, transparent cutouts, sprites, covers, ad creatives, infographics, or project visual assets. Do not use for charts/data visualization, repo-native SVG/icon systems, simple CSS/canvas shapes, or deterministic diagrams better built as code."
---

# Image Generation And Editing

Use this skill when the requested deliverable is a bitmap image asset or an edit to a bitmap image.

## Routing

- Use `chart_generator` for real data charts. Do not use AI image generation for charts that need accurate values.
- Use code-native SVG, HTML/CSS, canvas, or existing icon components when the output should be deterministic, editable, or consistent with an existing design system.
- Use `image_generator` for creative raster outputs: photos, illustrations, product shots, UI mockups, visual concepts, covers, backgrounds, sprites, and bitmap infographics.
- If the image is for a DOCX/PDF/PPTX/report about real facts, prefer real source images/logos/screenshots/charts over generated images unless the user explicitly asks for generated art.

## Intent Decision

- Generate: user wants a new image, visual concept, mockup, background, illustration, icon exploration, or product/lifestyle shot.
- Edit: user wants to modify an existing image while preserving some parts of it.
- Reference-guided generation: user supplies images only for style, composition, mood, or subject guidance.
- Batch: user asks for many assets or variants; create one clear prompt per distinct asset rather than treating variants of one prompt as different assets.

## Prompt Contract

Write a production prompt with only useful detail:

```text
Use case: <photo | illustration | product-mockup | ui-mockup | infographic | sprite | cover | ad>
Asset type: <where it will be used>
Primary request: <user request>
Input images: <role for each image, if any>
Subject: <main subject>
Scene/backdrop: <environment>
Style/medium: <visual treatment>
Composition/framing: <crop, angle, negative space, subject placement>
Lighting/mood: <lighting and emotional tone>
Color/materials: <palette and surface details>
Text, verbatim: "<exact text>" if any
Constraints: <must keep, must avoid>
```

- Preserve the user's exact text when image text is requested.
- For edits, repeat invariants: what must remain unchanged, what changes, and what must not drift.
- If the user prompt is generic, add only practical details that improve the result. Do not invent extra characters, brands, logos, slogans, or story elements.
- If the prompt is already specific, normalize it instead of expanding it.

## Output Discipline

- Save project-bound final assets inside the workspace or requested path. Do not leave referenced assets only in temp/private generation folders.
- Do not overwrite existing assets unless the user explicitly asked for replacement. Use versioned filenames such as `hero-v2.png`.
- Inspect the output before using it: subject accuracy, style fit, composition, text readability, watermarking, unwanted artifacts, crop, resolution, and fit for the consuming artifact.
- If generation fails, do not create a fake placeholder and claim success. Return the failure and a retry path.
- If a code-native SVG/HTML placeholder would be acceptable, use it only after the user asked for that format or explicitly accepts the fallback.

## Transparent Or Cutout Assets

- For simple opaque subjects, generate on a flat chroma-key background, remove the key locally when tooling exists, and validate alpha.
- Validate transparent corners, plausible subject coverage, and no obvious key-color fringe.
- For complex transparency such as hair, smoke, glass, liquids, translucent materials, reflections, or soft shadows, ask before using a different provider/path that supports true transparency.

## Final QA

Before reporting completion:

1. Verify the image file exists and has non-trivial size.
2. Verify the file is in the requested/project location when it will be consumed by code or an Office artifact.
3. Verify it is a real raster asset when the request was raster output.
4. Verify no watermark, broken text, wrong subject, or obvious artifact remains.
5. Report the final saved path and the prompt used, unless the user asked for only the asset.
