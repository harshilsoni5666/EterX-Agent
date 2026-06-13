---
name: file-reading
description: "Use when the user asks about a local file, uploaded file, attachment, dataset, archive, image, PDF, document, spreadsheet, presentation, log, or unknown file path that has not already been inspected. Route each file type to the safest first-read strategy and gather evidence before making claims."
category: core
icon: FolderOpen
---

# File Reading

Use this skill to inspect files without guessing from names, extensions, or stale context.

## Core Protocol

1. Resolve the path and verify the file exists before reading.
2. Inspect file size and type before choosing a reader.
3. Read the smallest useful slice first for large files.
4. Preserve the original file unless the user asked for a modification.
5. Never claim row counts, page counts, sheet names, metadata, dates, totals, or content until verified from the file.
6. If a file is too large or binary, profile it and report exactly what was sampled.

## Dispatch

| File type | First move | Notes |
| --- | --- | --- |
| Text, Markdown, code, logs | Size check, then targeted read/search | For logs, inspect tail plus error patterns before full scans. |
| CSV, TSV, JSONL | Sample rows, infer delimiter/schema, then process with a structured parser | Avoid loading huge files fully unless needed. |
| JSON, YAML | Parse structure first, then inspect relevant keys | Do not trust comments or file names as data. |
| XLSX, XLSM, XLS, ODS | Load workbook metadata: sheets, dimensions, headers, formulas | Use the spreadsheet skill for edits, formulas, charts, or formatting. |
| PDF | Identify page count, extract text sample, detect scans/images | Use OCR or page rendering only when text extraction is insufficient. |
| DOCX, DOC, RTF, ODT | Extract text/structure with document-aware tooling | Use the DOCX skill for edits, comments, tracked changes, or formatting. |
| PPTX, PPT | Inspect slide count, titles, notes, media, and layouts | Use the PPTX skill for deck creation or visual edits. |
| Images | Inspect dimensions, format, alpha channel, EXIF if relevant | Use visual inspection when content matters. |
| Archives | List manifest first; do not auto-extract unknown archives | Extract only requested safe members into a controlled location. |
| Unknown/binary | Identify magic bytes and metadata before opening | Do not run unknown executables or scripts. |

## Evidence Rules

- Cite the exact file path and the specific sheet/page/section/row range inspected when useful.
- For tables, preserve headers and mention parsing assumptions.
- For transformed data, keep raw input separate from cleaned output.
- For sensitive files, redact secrets and personal data in summaries.
- If a tool is unavailable, state the fallback used and its limits.

## Completion Checklist

- File existence verified.
- File type and size understood.
- Relevant content inspected with an appropriate reader.
- Claims are grounded in observed content.
- Any unread or partially sampled portions are disclosed.
