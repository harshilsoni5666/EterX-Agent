---
name: web-artifacts-builder
description: Use for creating self-contained HTML artifacts or small React/Vite artifact projects with polished UI, local assets, and bundle-ready output.
---

# Web Artifacts Builder

Build the actual usable artifact first. Do not create a landing page, placeholder shell, or explanatory wrapper unless the user specifically asks for one.

## Recommended Stack

- Single-file artifacts: plain HTML, CSS, and JavaScript.
- Rich interactive artifacts: React + TypeScript + Vite, then bundle or export to static HTML when needed.
- Styling: existing project tokens first; otherwise concise CSS or Tailwind if already installed.
- Components: use shadcn/ui only when the project already has it or the user asks for that ecosystem.

## Asset Rules

If the artifact needs real imagery, do not hardcode random remote URLs or placeholder services. Use validated local assets, user-provided files, or a proper image search/download workflow, then reference the local path.

## Project Setup

Use the repo's existing app when one exists. For a standalone artifact:

```bash
npm create vite@latest artifact-name -- --template react-ts
cd artifact-name
npm install
npm run dev
```

For a plain single-file artifact, create an `.html` file that can open directly in the browser.

## Build Workflow

1. Define the primary user workflow and make it available on the first screen.
2. Implement complete controls, states, loading/error behavior, and empty states.
3. Use stable responsive dimensions for boards, panels, grids, and controls.
4. Keep text inside containers at mobile and desktop sizes.
5. Use real icons from the existing icon system when available.
6. Run the project checks and build command if a package exists.

## Bundle Options

Use the repository's build command when available:

```bash
npm run build
```

For a self-contained HTML artifact, inline only after the app works. Use a documented project bundler or a small static build pipeline; do not claim a bundle was created unless the file exists and opens.

## Verification

- Open the artifact locally when browser verification is allowed.
- If browser verification is not allowed, run build/lint/test commands and inspect generated files.
- Confirm no broken image paths, random placeholder URLs, clipped text, or console-blocking script errors remain.
