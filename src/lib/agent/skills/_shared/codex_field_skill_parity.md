# Codex Field Skill Parity Guide

Apply this guide with the domain skill that was loaded. It mirrors the practical operating standards from the strongest local Codex skills: use the right artifact workflow, inspect real outputs, and deliver only the useful final result.

## Field Routing

- If the user asks for an Office artifact, produce the real consumer file type: `.docx`, `.pdf`, `.xlsx`, or `.pptx`. Do not substitute Markdown, CSV, screenshots, helper scripts, or sandbox drafts unless the user explicitly requested that format.
- Use `.workspaces/sandbox` only for drafts, extracted data, notes, helper scripts, and staging. Final user-facing artifacts go to the requested path or a natural Desktop filename.
- For current facts, public companies, markets, legal/regulatory items, API behavior, prices, or schedules, gather current evidence before writing claims. Do not fill gaps with confident-looking guesses.
- For small or messy prompts, infer a professional deliverable shape and execute. Ask only when the missing input blocks the task or creates a safety/permission risk.

## Documents And PDFs

- Treat reports, memos, SOPs, proposals, letters, manuals, and research documents as communication design, not text dumps.
- Choose the document shape from the reader need: executive summary, findings, recommendations, appendix; or purpose, prerequisites, steps, checks, escalation; or problem, solution, scope, timeline, next steps.
- Build content first. Every section should have a useful point, evidence, or action. Remove filler, placeholders, dummy numbers, and generic paragraphs.
- Use tables for comparisons, risks, schedules, decisions, and source-backed data. Use callouts for key insight, risk, assumption, recommendation, or limitation.
- Use real images, logos, screenshots, charts, maps, or diagrams only when they help the document. Do not invent real-world visuals. If an image cannot be fetched, keep the artifact usable with a clear unavailable-image note.
- For DOCX, use the system document/office builder for normal artifacts. Use manual OOXML/custom scripting only for advanced edits such as tracked changes, comments, existing-template surgery, custom section layout, or features the builder cannot express.
- For PDFs, distinguish new consumer PDFs from existing-PDF operations. Use the office/PDF builder for new reports and custom PDF tooling for merge, split, rotate, watermark, form fill, extraction, OCR, encryption, or redaction.
- Before claiming completion, verify the final file exists, has non-trivial size, has the expected title/content, and does not expose sandbox drafts or helper files as the deliverable.
- When rendering or conversion tools are available, visually inspect pages for clipped text, broken tables, missing images, bad spacing, and awkward page breaks before finalizing.

## Spreadsheets

- Treat a workbook as an editable decision system, not a static table.
- For vague requests, build the useful default: Summary or Dashboard first, then Data/Cleaned Data, Calculations or Assumptions, and Sources/Notes when needed.
- Use real Excel formulas for derived values: totals, margins, growth, variance, ranks, percentages, scenario outputs, and KPI blocks. Do not hardcode calculated outputs unless the user asked for static values.
- Preserve raw data when transforming files. For cleaning, include Original, Cleaned, Rejected, and Validation Summary when row loss or rule decisions matter.
- Use native workbook features where appropriate: freeze panes, filters, tables, data validation, conditional formatting, number/date/percent/currency formats, formulas, charts, dashboard areas, source notes, and comments/notes.
- Use real charts for trends, comparisons, shares, distributions, funnels, pipelines, or KPI movement. Do not fake charts with text when Excel charting is appropriate.
- Format every meaningful sheet, not only the first table. Headers, widths, wraps, filters, freeze panes, and number formats must be consistent.
- Before finalizing, verify sheet names, row and column counts, headers, formulas, charts, source notes, non-empty required fields, and no obvious formula errors such as `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, or `#N/A`.
- For researched/current data, include source names or URLs and the retrieval date in the workbook.

## Presentations

- Treat a deck as a sequence of decisions, not a decorated document.
- Build story first: audience, desired decision or understanding, thesis, narrative arc, and one job per slide.
- Slide titles should state the point, not the category. Prefer "Revenue grew 22% as retention improved" over "Financial Results".
- One slide gets one dominant read: title, number, chart, image, diagram, table, or process. Split slides that try to carry multiple unrelated messages.
- Use editable presentation-native content whenever possible: text, shapes, tables, charts, diagrams, and placed raster assets. Do not ship screenshots of slides as the deck.
- Use real images, logos, screenshots, charts, or source-backed visuals for factual topics. Do not invent company, product, person, place, or market imagery.
- Data-rich decks need real charts or well-designed tables when the relationship is chartable. KPI cards and callouts can support the message but should not replace the data object.
- Avoid bullet walls, generic card grids, repeated boxed layouts, unreadable tiny text, and placeholder content. Keep slides visually varied but coherent.
- Before finalizing, render or inspect slides when possible. Fix text overlap, clipping, accidental wrapping, broken images, unreadable colors, blank slides, and chart/table defects.

## Browser And Computer Use

- Browser work is stateful. Read the current page state before the first meaningful action and after each action that can change the page.
- Prefer structured page state for choosing selectors and screenshots only when visual confirmation matters. Do not request both repeatedly if one is enough.
- Use one browser action at a time. After a click, type, select, submit, scroll, upload, or navigation, use the returned state or a fresh read before choosing the next action.
- If an action fails, do not repeat the same action blindly. Use failure context, visible refs, current URL, text, enabled/visible state, overlays, and alternative selectors.
- Prefer human-like but efficient actions: scroll only as needed, click visible/enabled elements, type into focused fields, and wait for the specific signal that proves the next state.
- Do not brute-force site URLs, search query grids, or many candidate pages. Try one focused route, then switch to visible navigation or explain the remaining uncertainty.
- For irreversible or sensitive actions such as purchase, booking, payment, deletion, sending messages, changing account settings, or bypassing security checks, stop for confirmation at the final boundary.
- For logged-in, protected, or security-sensitive sites, respect the visible workflow. Do not attempt to bypass access controls, CAPTCHAs, MFA, or anti-abuse protections.
- When Chrome/extension UI feedback exists, use it as user-facing confidence only; correctness still comes from page state and action results.

## Images And Visual Assets

- Choose raster image generation only when the user needs a bitmap asset: photo, illustration, texture, sprite, mockup, product image, cover, background, or cutout.
- Do not use generated raster images where repo-native SVG, icon components, CSS, canvas, or editable Office shapes are the better artifact.
- For edits, preserve target identity, composition, text, brand, and other invariants unless the user asked to change them.
- For project-bound assets, save the final selected image inside the project or requested location. Do not leave referenced assets only in a private generated-images or temp directory.
- For transparency, validate alpha and edge quality before using the asset. If true transparency or complex cutouts are not available, say so instead of pretending.
- Always inspect generated or edited images for subject accuracy, text readability, unwanted artifacts, watermarking, and fit for the consuming artifact.

## API Docs And Current Technical Guidance

- For OpenAI or other API/provider guidance, prefer official current documentation when the user asks about latest/current/default behavior, model choice, migration, or parameters.
- Preserve explicit targets. If the user names a model, API version, provider, or library, do not silently retarget to a newer one.
- Keep migrations narrow. Update model strings, config fields, and directly related prompts only when required; do not rewrite unrelated provider logic or environment setup.
- Do not invent pricing, limits, model availability, parameter names, compatibility, or breaking changes.
- If docs and local code disagree, state the conflict and make the smallest defensible change.

## Skill And Plugin Authoring

- Skills need strong trigger descriptions, compact procedural bodies, and progressive disclosure. Put long examples, APIs, or templates in references or scripts.
- A good skill says when to use it, what evidence to gather, what workflow to follow, how to validate, and what final output should look like.
- For plugin scaffolds, keep required structure intact: manifest, optional skills/scripts/assets/hooks/MCP/apps, and marketplace metadata only when requested.
- Do not create surprising or unsafe skills. Skill behavior must match its description and should not hide unrelated automation.
- Prefer reusable scripts for deterministic repetitive work instead of long fragile prompt instructions.

## Final Response Discipline

- Say what was actually created, changed, sent, opened, verified, or still missing.
- Link or report only final deliverables unless the user asked for internals.
- Do not claim success from intent. Claim success only from file checks, rendered/inspected artifacts, page confirmations, test results, or source-backed evidence.
