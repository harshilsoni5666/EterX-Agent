---
name: image-generation
description: Use when the user asks for a new raster image, an edit to an existing image, visual variants, a transparent-background asset, or another bitmap deliverable. Do not use for vector/code-native artwork or ordinary interface implementation.
category: design
icon: Image
---

# Image Generation

Create or edit bitmap assets with a clear purpose, a controlled visual direction, and a verifiable output path.

## Decision boundary

- Use this skill for photographs, illustrations, textures, sprites, mockups, icons, and transparent cutouts.
- Use vector or code-native methods when the deliverable must remain an SVG, logo system, CSS effect, canvas scene, or editable design component.
- Inspect every supplied reference before editing it. If a required reference is missing, stop and request it.

## Workflow

1. Identify the subject, intended use, dimensions, aspect ratio, style, and output format.
2. Write a concrete prompt describing subject, composition, lighting, palette, materials, camera/viewpoint, and exclusions.
3. Generate the smallest useful set of variants.
4. Inspect the result for composition, anatomy or geometry errors, unwanted text, clipping, and background artifacts.
5. For transparency, use a clean alpha workflow and verify that the background is actually removed rather than merely painted over.
6. Copy the chosen asset into the project when it is project-bound; do not leave the only copy in a temporary location.

## Quality gate

- The output exists at the requested path and opens as the requested image type.
- Dimensions, color mode, alpha behavior, and file size are appropriate.
- No unintended logos, signatures, watermarks, readable placeholder text, or reference-image artifacts remain.
- The final response names only the delivered asset and any meaningful limitation.
