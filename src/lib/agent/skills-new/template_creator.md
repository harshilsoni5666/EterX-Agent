---
name: template-creator
description: Use when the user asks to turn one reference document, presentation, spreadsheet, image, email, or message into a reusable artifact template, or to update one existing personal template.
category: documents
icon: Copy
---

# Template Creator

Create a reusable template only from a clearly identified reference. Keep the reference, structure, voice, and visual rules together so future outputs are reproducible.

## Supported references

- `.docx` for documents
- `.pptx` for presentations
- `.xlsx` for spreadsheets
- `.png` or another supplied image for visual templates
- `.txt` for an explicitly identified email or message template

## Workflow

1. Confirm the exact reference and intended future use.
2. Inspect its structure, hierarchy, styles, repeated fields, and visual system.
3. Infer a concise template name and trigger description.
4. Preserve the canonical reference inside the template package when permitted.
5. Create explicit editable placeholders and document which fields are required.
6. Generate a preview and test one representative output.
7. Keep the original reference unchanged and report the new template path.

## Rules

- Create a new template by default; update only the exact template the user names.
- Do not silently overwrite a reference or a similarly named template.
- Do not invent content that is not present in the reference or request.
- Keep templates local unless the user explicitly authorizes sharing or publishing.
