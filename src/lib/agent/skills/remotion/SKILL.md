---
name: remotion
description: Use to create, edit, render, or troubleshoot Remotion videos, walkthroughs, screen-recording style product demos, animated explainers, and programmatic React-based video compositions from local assets, screenshots, Stitch exports, or existing Remotion projects.
---

# Remotion Video

Build programmatic videos with Remotion using the assets and tools actually available in the workspace. Do not assume Stitch, a Remotion MCP server, or a pre-existing video project is present.

## Input Discovery

Start by identifying the available source material:

- Existing Remotion project: `remotion.config.*`, `src/Root.*`, `Composition`, or Remotion dependencies in `package.json`.
- Local screenshots, images, videos, audio, HTML exports, or design exports.
- Stitch/project-design data only when a Stitch connector or downloaded export is present.
- User-provided script, storyboard, screen list, dimensions, duration, or target platform.

## Build Workflow

1. Define the video purpose: walkthrough, promo, tutorial, status recap, product demo, or social clip.
2. Choose dimensions, frame rate, duration, and platform constraints.
3. Create or update a manifest for scenes, assets, captions, timing, and transitions when the video has multiple segments.
4. Use existing project conventions if a Remotion app exists.
5. If no project exists, scaffold a minimal Remotion project in an appropriate subdirectory and keep it focused.
6. Implement reusable components for scenes, captions, callouts, progress, and media placement.
7. Preview or render with the available Remotion command and fix timing, clipping, missing assets, and text readability.

## Composition Guidance

- Keep scene timing readable; do not rush dense UI screens.
- Maintain original aspect ratio for screenshots unless the requested platform requires crop/reframe.
- Use motion to clarify attention, not to decorate every frame.
- Use captions or text overlays only when they add context.
- Keep overlays high contrast and away from important UI content.
- For walkthroughs, order screens by the real user journey.
- For product demos, show the actual product state rather than generic filler.

## Common Commands

Use the project’s scripts when present. Common Remotion commands are:

```bash
npm run dev
npx remotion studio
npx remotion render <composition-id> output.mp4
```

Install dependencies only when needed and only into the project that owns the video.

## Quality Gate

Before delivery:

- Confirm all media paths resolve.
- Check the rendered or previewed video is nonblank and correctly framed.
- Verify text is readable at final resolution.
- Check audio, captions, and scene timing if present.
- Report the render command, output path, and any verification not performed.
