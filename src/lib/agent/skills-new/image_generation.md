---
name: image-generation
description: Use when the user asks for a new raster image, visual variants, a transparent-background asset, or another bitmap deliverable. This runtime is text-to-image only; do not use it for edits to an existing image. Do not use for vector/code-native artwork or ordinary interface implementation.
category: design
icon: Image
---

# Image Generation

Create new bitmap assets with a clear purpose, a controlled visual direction, and a verifiable output path.

## Decision boundary

- Use this skill for photographs, illustrations, textures, sprites, mockups, icons, and transparent cutouts.
- The built-in image generator currently supports text-to-image only. If the user asks to edit an existing image, explain that limitation and request a fresh generation prompt or use a dedicated image-editing workflow.
- Use vector or code-native methods when the deliverable must remain an SVG, logo system, CSS effect, canvas scene, or editable design component.
- Inspect supplied references for context, but do not claim that the generator edited or preserved a reference image.

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
