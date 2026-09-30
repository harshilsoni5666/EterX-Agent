---
name: docx
description: Use whenever the user wants to create, read, edit, convert, review, redline, comment on, merge, or manipulate Word documents and `.docx` files. Also use for professional reports, memos, letters, SOPs, manuals, proposals, forms, templates, and structured documents when the requested deliverable is Word.
license: Proprietary. LICENSE.txt has complete terms
---

# DOCX Skill

Create or edit real Word documents. A `.docx` deliverable must be useful to the intended reader, not just formatted text.

## Core Rules

- Deliver the requested file type: a real `.docx`, not Markdown, screenshots, XML folders, or helper scripts.
- Pick the document structure from the user's goal. Do not force a cover page, table of contents, flowchart, image, or template when it does not help.
- Use real content. Do not invent facts, names, numbers, citations, images, or completion status.
- For current/company/legal/medical/financial facts, research with appropriate sources before writing.
- Preserve existing document structure when editing unless the user asks for a rewrite.
- Save to the explicit user path when supplied; otherwise use the current chat workspace from runtime context. Do not move outputs to Desktop automatically.

## Runtime and dependencies

Use the runtime-provided OS, selected shell, workspace and executable paths. Pick one suitable generation method and create the deliverable; do not inventory unrelated converters or repeat successful import/version checks. Use `workspace_run_command` with `program` and an `args` array for Python or Node, so source strings and paths do not pass through shell quoting. If an import fails, resolve that specific dependency for the same interpreter, preferably in a workspace virtual environment. Libraries mentioned below are options, not promises that they are installed. Respect an explicit user request to skip checks or tests and report that limitation.

## Choose The Right Path

| Task | Best Path |
|---|---|
| New ordinary document | Use the highest-level office/document builder available |
| Existing document edit | Inspect content and structure, then make surgical edits |
| Template fill | Preserve template styles, fields, tables, headers, and section breaks |
| Tracked changes/comments | Use WordprocessingML/OOXML only where needed |
| Complex layout | Use document builder first; use custom `docx` code only for unsupported features |
| Conversion | Convert with LibreOffice or project-approved tools, then verify output |

## Document Intelligence

Before formatting, decide what the reader needs:

- Report: executive summary, findings, evidence, recommendations, appendix.
- Memo: context, decision/request, key points, risks, next action.
- SOP/manual: prerequisites, roles, steps, checks, escalation, glossary.
- Technical spec: purpose, requirements, architecture, interfaces, edge cases, rollout.
- Proposal: problem, outcome, scope, timeline, investment, next steps.
- Letter/form: concise message, correct fields, signature/response space.

Use tables for comparisons, timelines, risks, decisions, and structured data. Use diagrams, screenshots, charts, or images only when they clarify the document.

## Creation Workflow

1. Classify the document and audience.
2. Build a heading plan and content outline.
3. Gather source facts and assets if needed.
4. Draft concise, specific content.
5. Generate the `.docx` with a structured builder.
6. Verify file existence, size, content, page rendering/preview when available, and final path.

## Editing Workflow

1. Read or extract the current document content.
2. Identify headers, tables, lists, images, comments, tracked changes, fields, styles, and section breaks.
3. Make the smallest change that satisfies the request.
4. Preserve formatting and relationships unless intentionally changing them.
5. Repack/convert if needed and verify the final document opens or renders.

## Practical Commands

Use commands that exist in the environment:

```bash
# Extract readable text
pandoc --track-changes=all input.docx -o extracted.md

# Unpack DOCX package for structural edits
python -m zipfile -e input.docx unpacked/

# Validate package
python -m zipfile -t output.docx

# Convert legacy DOC or render preview PDF
soffice --headless --convert-to docx input.doc
soffice --headless --convert-to pdf output.docx
```

## OOXML Notes

Use manual XML only when the high-level builder cannot express the change.

- Tracked insertions use `<w:ins w:author="EterX" ...>`.
- Tracked deletions use `<w:del w:author="EterX" ...>` and deleted text uses `<w:delText>`.
- Comments require changes in `comments.xml`, relationships, content types, and document markers.
- Preserve namespace declarations, relationship IDs, content types, and section properties.
- Add `xml:space="preserve"` when text nodes contain leading or trailing spaces.
- Do not visually cover sensitive text for redaction; remove content and metadata properly.

## Quality Gate

Before reporting completion:

- Final `.docx` exists, is non-trivial in size, and is at the requested/user-facing path.
- Headings, lists, tables, images, links, captions, page numbers, and headers/footers are coherent.
- No unresolved placeholders, fake data, broken image paths, or unverified current claims remain.
- Tables have readable headers, units, widths, and row spacing.
- Long/dense documents use appendices or visual anchors when helpful.
- If preview/rendering is available, inspect pages for clipping, overlap, bad breaks, missing glyphs, and broken images.
- Final response mentions only the final document path and any checks that could not be run.
