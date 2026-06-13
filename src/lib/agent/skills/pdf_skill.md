---
name: pdf
description: Use whenever the user wants to create, read, extract from, edit, merge, split, rotate, watermark, redact, OCR, convert, fill forms in, secure, inspect, or otherwise manipulate PDF files. Also use when the final requested deliverable is a polished `.pdf`.
license: Complete terms in LICENSE.txt
---

# PDF Skill

PDFs are final consumer artifacts or fixed-layout source files. Treat them as files with page geometry, embedded assets, metadata, and sometimes hidden text layers, not plain text.

## Core Rules

- Deliver a real `.pdf` when PDF is requested.
- Choose the method from the job. Do not force ReportLab, browser printing, screenshots, or a branded report template when another path is better.
- New PDFs need reader-ready content. Existing PDFs need page/order/content preservation unless the user requests changes.
- Do not fake OCR, redaction, signatures, extracted tables, or successful conversion.
- Sensitive redaction must remove or flatten sensitive content; covering text visually is not enough.
- Keep final PDFs outside `.workspaces/sandbox` unless explicitly requested.

## Choose The Right Path

| Task | Best Path |
|---|---|
| New report/brief/one-pager | Build from structured content with the office/PDF builder or a suitable document-to-PDF pipeline |
| Existing PDF extraction | Use `pdfplumber`, `pypdf`, `pdftotext`, OCR when scanned |
| Merge/split/rotate | Use `pypdf`, `qpdf`, or `pdfjam` style page tools |
| OCR scanned PDF | Use OCR tooling and keep a searchable output copy |
| Form fill | Use AcroForm-aware tooling and verify filled fields visually |
| Redaction | Use a true redaction workflow and verify text is not extractable |
| Conversion from DOCX/PPTX/XLSX | Convert source file, then QA the resulting PDF pages |

## New PDF Workflow

1. Identify audience and purpose: report, memo, invoice, handout, manual, certificate, form, or visual one-pager.
2. Write real content and gather source assets.
3. Pick layout appropriate to purpose: dense report, printable form, executive summary, visual handout, or technical appendix.
4. Generate the PDF with structured tooling.
5. Inspect page count, text extraction, images, tables, margins, and page breaks.

Use charts, screenshots, images, or diagrams only when they improve communication. A text-only PDF is fine for legal letters or memos; a visual report may need charts and figures.

## Existing PDF Workflow

1. Inspect page count, metadata, encryption, text layer availability, forms, annotations, and scan quality.
2. Choose extraction or manipulation method.
3. Preserve page order and document fidelity.
4. Save a new output file unless the user explicitly wants overwrite.
5. Verify the output structurally and, when possible, visually.

## Practical Commands

Use available tools:

```bash
# Metadata and page count
pdfinfo input.pdf

# Text extraction
pdftotext -layout input.pdf output.txt

# Render pages for inspection
pdftoppm -png -r 150 input.pdf page

# Validate package/repair possibilities
qpdf --check input.pdf

# Convert Office document to PDF
soffice --headless --convert-to pdf input.docx
```

Python libraries commonly useful:

```bash
pip install pypdf pdfplumber reportlab pillow
```

Use OCR tools only when installed and appropriate, such as `ocrmypdf` or Tesseract-based workflows.

## Extraction Quality

- Text PDFs: preserve layout for tables when possible and note confidence.
- Scanned PDFs: OCR first or clearly state that there is no text layer.
- Tables: validate row/column alignment against rendered pages.
- Images: extract at original quality where possible.
- Citations/page references: include page numbers when summarizing or extracting evidence.

## QA Gate

Before reporting completion:

- Final `.pdf` exists, has expected page count, and is at the requested/user-facing path.
- For generated PDFs, content is final-reader ready and not draft filler.
- For manipulated PDFs, page order, rotation, watermarks/redactions/forms match the request.
- Text extraction or rendered previews were checked when relevant.
- Images/charts are embedded or intentionally replaced with a clear unavailable-image note.
- Metadata/sensitive content was handled correctly for privacy/redaction tasks.
- Final response gives the final PDF path and states any verification limitation.
