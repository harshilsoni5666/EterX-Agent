---
name: stitch-design
description: Use for Stitch design generation, editing, prompt refinement, and optional design-system synthesis. Supports high-fidelity UI design while adapting to the user's product and not forcing one visual system.
---

# Stitch Design

Use Stitch to create or edit screens from user intent. The job is to make the prompt clearer and the output more useful, not to impose a standard page formula.

## Workflow Routing

| User Intent | Workflow |
|---|---|
| Create a new screen | Turn intent into a clear generation prompt and call the available Stitch generation tool |
| Edit an existing screen | Make a targeted edit prompt that preserves everything else |
| Create/update design guidance | Analyze existing screens and write a concise `DESIGN.md` |
| Export implementation assets | Retrieve generated HTML/screenshots and save them locally when needed |

## Prompt Preparation

Before generation or edit:

1. Identify platform, audience, product type, primary task, and content priority.
2. Read `DESIGN.md` only if it exists and is relevant to the current project.
3. Add design context that helps this specific request.
4. Avoid hardcoded sections such as hero/footer/cards unless they fit.
5. Preserve the user's requested mood, even when it is playful, utilitarian, dense, minimal, experimental, or plain.

## Prompt Shape

```markdown
[Purpose and desired feel]

Design context:
- Platform:
- Audience:
- Product type:
- Existing visual system:

Screen requirements:
- Primary task:
- Main regions/components:
- Key states:
- Responsive behavior:
- Assets/data:

Avoid:
- [Only patterns that would harm this specific product]
```

## After Tool Calls

- Save generated HTML and screenshots only when the workflow needs local assets.
- Surface useful generated descriptions/suggestions to the user.
- If output misses the brief, prefer a targeted edit over a full regeneration.
- Keep project IDs and screen IDs in local metadata only when the workflow needs repeatable follow-up.

## Quality Bar

- The design should match the domain and user goal.
- Consistency matters for multi-screen products, but creative divergence is allowed when the user asks for it.
- Accessibility, readable text, meaningful states, and responsive layout are always more important than decorative style.
