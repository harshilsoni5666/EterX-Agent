---
name: stitch-loop
description: Use for iterative Stitch-to-site workflows where generated screens are reviewed, integrated, verified, and optionally queued for another pass. Supports baton files when a project already uses them, but does not require autonomous continuation.
---

# Stitch Loop

This skill supports iterative website building with Stitch. It is a controlled workflow, not a requirement to keep generating pages forever.

## Modes

| Mode | Use When |
|---|---|
| Single iteration | User asks for one screen/page or one integration pass |
| Baton-assisted | `.stitch/next-prompt.md` exists and the user wants to continue that queue |
| Review loop | User wants to compare generated output to screenshots or site behavior |
| Site expansion | User asks to add the next logical page to an existing Stitch-backed site |

## Inputs

Read what exists:

- `.stitch/SITE.md` for site vision, sitemap, and roadmap.
- `.stitch/DESIGN.md` for optional design context.
- `.stitch/metadata.json` for project and screen IDs.
- `.stitch/next-prompt.md` only when baton-assisted mode is intended.
- Existing generated HTML/screenshots in `.stitch/designs/`.

Do not recreate pages already present in the sitemap unless the task is a redesign.

## Generate Or Edit

1. Prepare a prompt from the current task and relevant context.
2. Use the available Stitch namespace if present.
3. Save generated HTML/screenshot when local integration is needed.
4. If local files already exist, reuse them unless the user asks to refresh or the task requires fresh output.

## Integrate

- Move or adapt generated HTML into the site structure only when the project expects static pages.
- Fix relative asset paths.
- Wire navigation deliberately; do not leave `href="#"` for real links.
- Preserve existing headers, footers, routing, and build conventions where possible.

## Verify

Use available checks:

- Compare generated screenshot and local rendered page when browser/devtools are available.
- Check text fit, broken images, missing assets, navigation links, and responsive behavior.
- If browser checks are unavailable, inspect generated HTML and run available build/static checks.

## Optional Baton Update

Update `.stitch/next-prompt.md` only when the user or project workflow expects another iteration. The next prompt should be concrete, scoped, and based on the sitemap or backlog, not invented busywork.

## Output

Report:

- Screen/page generated or edited.
- Files saved/integrated.
- Verification performed.
- Suggested next iteration only when useful.
