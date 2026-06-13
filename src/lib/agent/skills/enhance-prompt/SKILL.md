---
name: enhance-prompt
description: Transform vague UI ideas into clear Stitch or design-generation prompts that preserve the user's intent, include useful design context, and avoid forcing a fixed layout or aesthetic.
---

# Enhance Prompt

Improve rough UI prompts so a design generator has enough context to produce the right screen. Do not over-design a simple request or force every prompt into a hero/card/footer template.

## Enhancement Pipeline

1. Identify the product type, platform, audience, and primary user task.
2. Preserve the user's requested mood and constraints.
3. Add only useful design details: structure, content priority, interaction states, density, visual language, and responsive needs.
4. Include existing `DESIGN.md` context when it exists and is relevant.
5. Keep targeted edits narrow. Do not bundle unrelated redesigns into an edit prompt.

## What To Add

| Missing Input | Add |
|---|---|
| Platform | Web, mobile, desktop, tablet, responsive, or infer from context |
| Page/screen type | Dashboard, form, settings, onboarding, landing, tool, gallery, etc. |
| Primary task | What the user should accomplish first |
| Structure | Regions that fit the task: nav, filters, editor, table, chart, gallery, form, timeline, proof, footer |
| Visual style | Domain-appropriate descriptors, not a universal "premium" style |
| Components | Specific UI components and states |
| Data/content | Real labels or safe placeholders when data is intentionally unknown |

## Output Shape

Use this flexible format:

```markdown
[One-line purpose and desired feel]

**Design Context:**
- Platform:
- Audience:
- Mood:
- Existing design system notes:

**Screen Structure:**
- Primary task area:
- Supporting context:
- Actions and states:
- Responsive behavior:

**Constraints:**
- Preserve:
- Avoid:
- Assets/data needed:
```

## Examples

For "make me a login page", output a login prompt with the right brand posture. It may be centered, split-screen, minimal, playful, enterprise, or mobile-first depending on context.

For "add a search bar", output a targeted edit: location, input behavior, empty/focus/loading states, keyboard behavior, and what should remain unchanged.

## Quality Bar

- Good prompts are specific without being prescriptive.
- Design systems are context, not chains.
- Use cards, heroes, gradients, illustrations, dense tables, or minimal white layouts only when they serve the product.
