---
name: pptx
description: Use whenever a `.pptx` file is involved as input or output: creating, reading, extracting, editing, updating, merging, splitting, templating, speaker notes, pitch decks, slide decks, presentations, and PowerPoint deliverables.
license: Proprietary. LICENSE.txt has complete terms
---

# PPTX Skill

Slide decks are decision and communication artifacts. They should be editable PowerPoint files with a clear story, appropriate visual system, and verified slide rendering.

## Core Rules

- Deliver a real `.pptx` when the user asks for slides/deck/presentation.
- Choose the deck shape from the audience and purpose. Do not force a pitch-deck template, dashboard style, colored cards, flowcharts, or one visual motif onto every use case.
- Use real evidence for factual decks. Do not invent company data, market numbers, logos, screenshots, people, products, or citations.
- Build editable native content where possible: text, shapes, tables, charts, diagrams, notes, and placed image assets.
- Use screenshots/images as source material or visual evidence, not as a substitute for editable slides unless the task is explicitly a screenshot deck.
- Keep final decks outside `.workspaces/sandbox` unless explicitly requested.

## Choose The Right Path

| Task | Best Path |
|---|---|
| New ordinary deck | Storyboard, then use the highest-level office/presentation builder available |
| Brand/template deck | Preserve template masters, layouts, fonts, colors, and placeholders |
| Existing deck edit | Inspect slides and make surgical changes |
| Data deck | Build workbook/chart source first when data needs calculations |
| Technical deck | Use readable architecture diagrams, sequence flows, tables, or code snippets as appropriate |
| Image-heavy deck | Use verified local image assets and check crop/readability |
| Speaker deck | Keep slides clean and put detail in speaker notes |

## Story First

Classify the deck before styling:

- Executive: situation, insight, decision, risk, action.
- Investor: problem, market, product, traction, model, ask.
- Sales/client: pain, desired outcome, solution, proof, scope, next step.
- Technical: problem, constraints, architecture, tradeoffs, rollout, risks.
- Training: learning goal, concept, example, practice, recap.
- Creative/brand: mood, reveal, proof, experience, call to action.

Each slide should have one job. If a slide has two unrelated jobs, split it.

## Design Freedom With Discipline

- Match the visual language to the audience and subject.
- A minimal white academic slide, dense board appendix, playful workshop slide, and premium launch slide can all be correct.
- Vary layouts when variety helps comprehension; keep consistency when repetition helps scanning.
- Use boxes/cards only when they contain real objects such as charts, tables, UI screenshots, maps, timelines, or structured comparisons.
- Avoid default generated-deck habits: repeated equal card grids, vague titles, decorative title lines, fake metrics, and text walls.

## Evidence And Assets

- For current facts, browse or use primary/current sources when required by the task.
- Use real logos/images/screenshots only when they improve the slide.
- Cite source names or URLs in speaker notes, footers, or a sources slide when data came from research.
- If a needed asset cannot be obtained, keep the deck usable and state the limitation.
- Do not hardcode broken image URLs or placeholder media.

## Practical Commands

```bash
# Extract text from an existing deck
python -m markitdown input.pptx

# Unpack for structural inspection
python -m zipfile -e input.pptx unpacked/

# Render preview PDF
soffice --headless --convert-to pdf output.pptx

# Render PDF pages to images for slide QA
pdftoppm -png -r 150 output.pdf slide
```

Use `pptxgenjs` or another structured PPTX library when custom generation is needed. Prefer project/native office builders for normal decks.

## Existing Deck Editing

1. Extract text and inspect slide count/layouts.
2. Identify master/template constraints if any.
3. Make the smallest change that satisfies the request.
4. Preserve speaker notes, comments, alt text, slide order, charts, and embedded media unless changing them is part of the task.
5. Render or inspect changed slides when possible.

## Slide QA Gate

Before reporting completion:

- Final `.pptx` exists, is non-trivial in size, and is at the requested/user-facing path.
- Slide count and ordering match the requested structure.
- Titles are meaningful for the deck type.
- Text is readable and does not overlap, clip, wrap badly, or collide with footers.
- Images, logos, charts, tables, and diagrams are present and readable where used.
- No unresolved placeholders, fake numbers, generic company names, broken image references, or blank slides remain.
- Rendered/previewed slides were checked when possible; otherwise state the limitation.
- Final response gives the final `.pptx` path and any checks not run.

## When To Use Advanced Custom Generation

Use custom slide code when the deck needs:

- Precise branded layouts or template surgery.
- Large-scale deck generation from structured data.
- Native charts, complex diagrams, or repeated slide systems.
- Speaker notes, image processing, or generated variants.
- Existing deck merge/split/update operations.

Even then, keep the output editable and verify the rendered result.
