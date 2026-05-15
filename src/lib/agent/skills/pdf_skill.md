---
name: pdf
description: Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs to make them searchable. If the user mentions a .pdf file or asks to produce one, use this skill.
license: Proprietary. LICENSE.txt has complete terms
---

# PDF Processing Guide

## EterX Office Artifact Protocol

For ordinary new PDF deliverables, use `office_artifact_builder(format="pdf")` instead of inventing a new ReportLab or browser-print script.

1. Research and draft substantial content first. Use `.workspaces/sandbox/*.md` only for internal chunking and synthesis.
2. Export the final consumer PDF with `office_artifact_builder`.
3. Save the final `.pdf` to the exact user-requested path, or to the Desktop for relative filenames.
4. Share only the final `.pdf` path in the answer. Do not expose sandbox drafts, helper scripts, or temporary render files unless requested.
5. Use custom PDF libraries only for existing-PDF operations such as merge, split, rotate, watermark, form fill, encryption, OCR, precise page drawing, or extraction.

Sandbox rule: `.workspaces/sandbox` is only for drafts and staging inputs. The final `.pdf` must be written to Desktop or the user-requested real path.

The final PDF is a consumer artifact. It must be polished, substantive, and directly usable.

## Codex-Grade PDF Workflow

Choose the path from the job, then verify the artifact:

1. New PDF deliverable: draft real content, structure it for scanning, build with the office/PDF builder, and verify the produced PDF.
2. Existing PDF operation: inspect page count, native text vs scanned/OCR needs, metadata if relevant, then apply the smallest correct PDF transformation.
3. Extraction task: report what was extractable, what was scanned or uncertain, and preserve tables/images separately when the user needs structured output.
4. Redaction task: remove or flatten sensitive content when possible. Do not only draw a black rectangle over text and call it safe.
5. Render or inspect output pages when possible before final delivery. Text extraction alone does not catch layout, page order, missing images, or bad overlays.

### PDF Output Gate

- First page should immediately communicate what the PDF is, when it was prepared, and why the reader should care.
- Long PDFs need headings, page numbers, source notes, and readable tables.
- Generated reports should use concise sections, not walls of text.
- Converted DOCX/PPTX/XLSX-to-PDF outputs must still be checked as PDFs, not just checked in the source format.
- Only share the final PDF unless the user asked for intermediate page images, OCR text, logs, or extracted tables.

## Senior PDF Intelligence

PDF work splits into two very different classes. Choose correctly.

### Class A: New Consumer PDF

Use `office_artifact_builder(format="pdf")` for ordinary generated reports, memos, briefs, summaries, one-pagers, study notes, invoices without complex accounting logic, and simple printable documents.

Quality rules:

- Content must be final-reader ready. Do not create a PDF that merely stores draft notes.
- Structure should be obvious from the first page: title, date/context, key result, then supporting sections.
- Use concise sections, tables, and source notes. PDF readers scan; make scanning easy.
- Avoid huge unbroken paragraphs. Split into short paragraphs and numbered findings.
- If the task needs current facts, use research first and preserve the evidence trail.
- For rich visuals, include real Markdown image URLs/local paths in the source draft. The PDF builder will try the DOCX rendering/conversion path first so image/table rendering can carry across when LibreOffice is available.
- If PDF conversion support is unavailable, the native PDF fallback still produces a readable PDF and should not expose internal failure details unless the user asks.

### Class B: Existing PDF Operations

Use custom PDF tooling for merge, split, rotate, watermark, OCR, extraction, redaction, form fill, encryption, page images, or precise page-level manipulation.

Quality rules:

- Never `cat` or plain-read a PDF as text.
- For extraction, report page count and whether text is native or likely scanned.
- For OCR, preserve original where possible and create a searchable output copy.
- For merge/split, preserve page order and clearly name the final output.
- For sensitive edits/redaction, do not just cover text visually; remove or flatten content when possible.

### PDF QA

Before reporting completion:

1. Verify the output `.pdf` exists and has a non-trivial file size.
2. Verify the output `.pdf` is outside `.workspaces/sandbox` unless the user explicitly requested that location.
3. For generated PDFs, verify the first page contains the expected title and content.
4. For transformed PDFs, verify page count and intended operation result.
5. For visual PDFs, verify images/charts are either embedded or intentionally represented with an unavailable-image note.
6. For OCR/extraction/redaction tasks, verify the specific requested operation, not only file creation.
7. Share only the final PDF path unless the user asks for processing logs or intermediate files.

## Professional Content Standards

**Do NOT create PDFs full of Lorem Ipsum or dummy data.** A PDF is a final deliverable — it must look and read like it was produced by a professional analyst.

### Content-First Rules
- **Search first**: If asked for a report on a company, topic, or event — use web search to gather real facts, figures, and dates before writing any code
- **Write real prose**: Every paragraph must be substantive. No filler. State the finding, back it with a number, explain its implication.
- **Tailor the report type**: Financial reports → tables + margins + YoY growth. Research reports → methodology + findings + charts. Executive summaries → 1-pager, bullets, big numbers up front.
- **Images must be real**: Fetch actual images from URLs using `requests.get()`. Never reference files that don't exist.

### 🚨 Python packages: install globally (pip), NOT in project root
pip installs don't trigger Next.js restarts — you can run `pip install reportlab pypdf pdfplumber pillow requests` safely. Output files to `.workspaces/sandbox/` to keep things organized.

## Overview

This guide covers PDF processing with Python. Always install dependencies first: `pip install reportlab pypdf pdfplumber pillow requests`

## ⚠️ Always: Check output after creation
```python
import os
size = os.path.getsize('output.pdf')
print(f'PDF created: {size} bytes')  # Should be >5000 bytes
assert size > 1000, 'PDF too small — generation likely failed'
```

## Quick Start

```python
from pypdf import PdfReader, PdfWriter

# Read a PDF
reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")

# Extract text
text = ""
for page in reader.pages:
    text += page.extract_text()
```

## Python Libraries

### pypdf - Basic Operations

#### Merge PDFs
```python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf", "doc3.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)

with open("merged.pdf", "wb") as output:
    writer.write(output)
```

#### Split PDF
```python
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as output:
        writer.write(output)
```

#### Extract Metadata
```python
reader = PdfReader("document.pdf")
meta = reader.metadata
print(f"Title: {meta.title}")
print(f"Author: {meta.author}")
print(f"Subject: {meta.subject}")
print(f"Creator: {meta.creator}")
```

#### Rotate Pages
```python
reader = PdfReader("input.pdf")
writer = PdfWriter()

page = reader.pages[0]
page.rotate(90)  # Rotate 90 degrees clockwise
writer.add_page(page)

with open("rotated.pdf", "wb") as output:
    writer.write(output)
```

### pdfplumber - Text and Table Extraction

#### Extract Text with Layout
```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        print(text)
```

#### Extract Tables
```python
with pdfplumber.open("document.pdf") as pdf:
    for i, page in enumerate(pdf.pages):
        tables = page.extract_tables()
        for j, table in enumerate(tables):
            print(f"Table {j+1} on page {i+1}:")
            for row in table:
                print(row)
```

#### Advanced Table Extraction
```python
import pandas as pd

with pdfplumber.open("document.pdf") as pdf:
    all_tables = []
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            if table:  # Check if table is not empty
                df = pd.DataFrame(table[1:], columns=table[0])
                all_tables.append(df)

# Combine all tables
if all_tables:
    combined_df = pd.concat(all_tables, ignore_index=True)
    combined_df.to_excel("extracted_tables.xlsx", index=False)
```

### reportlab - Create PDFs

#### Professional Branded Report (full template)
```python
import requests
from io import BytesIO
from reportlab.lib.pagesizes import letter, A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    HRFlowable, Image, KeepTogether
)
from reportlab.platypus.frames import Frame
from reportlab.platypus.doctemplate import PageTemplate
from reportlab.pdfgen import canvas
from functools import partial

# ——— Color palette (customize per brand)
PRIMARY   = colors.HexColor('#1E3A5F')   # deep navy
ACCENT    = colors.HexColor('#2E86AB')   # bright blue
LIGHT_BG  = colors.HexColor('#F0F4F8')  # off-white bg
MUTED     = colors.HexColor('#6B7280')   # gray text
WHITE     = colors.white
BLACK     = colors.black

# ——— Custom styles
def build_styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle('DocTitle',
        fontName='Helvetica-Bold', fontSize=26, textColor=PRIMARY,
        spaceAfter=6, alignment=TA_LEFT))
    styles.add(ParagraphStyle('DocSubtitle',
        fontName='Helvetica', fontSize=13, textColor=MUTED,
        spaceAfter=20, alignment=TA_LEFT))
    styles.add(ParagraphStyle('SectionHead',
        fontName='Helvetica-Bold', fontSize=14, textColor=PRIMARY,
        spaceBefore=18, spaceAfter=6))
    styles.add(ParagraphStyle('BodyText2',
        fontName='Helvetica', fontSize=10, textColor=BLACK,
        leading=15, spaceAfter=8))
    styles.add(ParagraphStyle('Caption',
        fontName='Helvetica-Oblique', fontSize=8, textColor=MUTED,
        alignment=TA_CENTER, spaceAfter=4))
    return styles

# ——— Header/footer on every page
def draw_header_footer(canvas_obj, doc, title='Report', subtitle=''):
    canvas_obj.saveState()
    w, h = letter
    # Header bar
    canvas_obj.setFillColor(PRIMARY)
    canvas_obj.rect(0, h - 50, w, 50, fill=1, stroke=0)
    canvas_obj.setFillColor(WHITE)
    canvas_obj.setFont('Helvetica-Bold', 12)
    canvas_obj.drawString(0.5*inch, h - 32, title)
    canvas_obj.setFont('Helvetica', 9)
    canvas_obj.drawRightString(w - 0.5*inch, h - 32, subtitle)
    # Footer
    canvas_obj.setFillColor(MUTED)
    canvas_obj.setFont('Helvetica', 8)
    canvas_obj.drawString(0.5*inch, 20, f'Page {doc.page}')
    canvas_obj.drawCentredString(w/2, 20, '© 2025 Your Company')
    canvas_obj.restoreState()

# ——— Fetch image from URL
def image_from_url(url, width=4*inch, height=3*inch):
    resp = requests.get(url, timeout=10)
    resp.raise_for_status()
    return Image(BytesIO(resp.content), width=width, height=height)

# ——— Build document
def build_report(output_path='report.pdf', report_title='Report Title'):
    styles = build_styles()
    doc = SimpleDocTemplate(
        output_path, pagesize=letter,
        leftMargin=0.75*inch, rightMargin=0.75*inch,
        topMargin=0.9*inch, bottomMargin=0.7*inch
    )
    # Bind header/footer
    on_page = partial(draw_header_footer, title=report_title, subtitle='Confidential')

    story = []
    story.append(Paragraph(report_title, styles['DocTitle']))
    story.append(Paragraph('Generated April 2025', styles['DocSubtitle']))
    story.append(HRFlowable(width='100%', thickness=2, color=ACCENT, spaceAfter=16))

    story.append(Paragraph('Executive Summary', styles['SectionHead']))
    story.append(Paragraph('Your content here...', styles['BodyText2']))

    # Professional table
    data = [['Metric', 'Q1', 'Q2', 'Q3'],
            ['Revenue', '$1.2M', '$1.5M', '$1.8M'],
            ['Growth',  '12%',  '18%',  '22%']]
    tbl = Table(data, colWidths=[2.5*inch, 1.5*inch, 1.5*inch, 1.5*inch])
    tbl.setStyle(TableStyle([
        ('BACKGROUND',  (0,0), (-1,0), PRIMARY),
        ('TEXTCOLOR',   (0,0), (-1,0), WHITE),
        ('FONTNAME',    (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE',    (0,0), (-1,-1), 10),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [WHITE, LIGHT_BG]),
        ('GRID',        (0,0), (-1,-1), 0.5, colors.HexColor('#D1D5DB')),
        ('ALIGN',       (1,0), (-1,-1), 'CENTER'),
        ('TOPPADDING',  (0,0), (-1,-1), 6),
        ('BOTTOMPADDING',(0,0), (-1,-1), 6),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(tbl)

    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    print(f'✅ {output_path} created')

build_report('output.pdf', 'Q3 Financial Report')
```

#### Simple PDF (quick)
```python
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet

doc = SimpleDocTemplate('report.pdf', pagesize=letter)
styles = getSampleStyleSheet()
story = [
    Paragraph('Report Title', styles['Title']),
    Spacer(1, 12),
    Paragraph('Body text here', styles['Normal']),
    PageBreak(),
    Paragraph('Page 2', styles['Heading1']),
]
doc.build(story)
```

#### Subscripts and Superscripts

**IMPORTANT**: Never use Unicode subscript/superscript characters (₀₁₂₃₄₅₆₇₈₉, ⁰¹²³⁴⁵⁶⁷⁸⁹) in ReportLab PDFs. The built-in fonts do not include these glyphs, causing them to render as solid black boxes.

Instead, use ReportLab's XML markup tags in Paragraph objects:
```python
from reportlab.platypus import Paragraph
from reportlab.lib.styles import getSampleStyleSheet

styles = getSampleStyleSheet()

# Subscripts: use <sub> tag
chemical = Paragraph("H<sub>2</sub>O", styles['Normal'])

# Superscripts: use <super> tag
squared = Paragraph("x<super>2</super> + y<super>2</super>", styles['Normal'])
```

For canvas-drawn text (not Paragraph objects), manually adjust font the size and position rather than using Unicode subscripts/superscripts.

## Command-Line Tools

### pdftotext (poppler-utils)
```bash
# Extract text
pdftotext input.pdf output.txt

# Extract text preserving layout
pdftotext -layout input.pdf output.txt

# Extract specific pages
pdftotext -f 1 -l 5 input.pdf output.txt  # Pages 1-5
```

### qpdf
```bash
# Merge PDFs
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf

# Split pages
qpdf input.pdf --pages . 1-5 -- pages1-5.pdf
qpdf input.pdf --pages . 6-10 -- pages6-10.pdf

# Rotate pages
qpdf input.pdf output.pdf --rotate=+90:1  # Rotate page 1 by 90 degrees

# Remove password
qpdf --password=mypassword --decrypt encrypted.pdf decrypted.pdf
```

### pdftk (if available)
```bash
# Merge
pdftk file1.pdf file2.pdf cat output merged.pdf

# Split
pdftk input.pdf burst

# Rotate
pdftk input.pdf rotate 1east output rotated.pdf
```

## Common Tasks

### Extract Text from Scanned PDFs
```python
# Requires: pip install pytesseract pdf2image
import pytesseract
from pdf2image import convert_from_path

# Convert PDF to images
images = convert_from_path('scanned.pdf')

# OCR each page
text = ""
for i, image in enumerate(images):
    text += f"Page {i+1}:\n"
    text += pytesseract.image_to_string(image)
    text += "\n\n"

print(text)
```

### Add Watermark
```python
from pypdf import PdfReader, PdfWriter

# Create watermark (or load existing)
watermark = PdfReader("watermark.pdf").pages[0]

# Apply to all pages
reader = PdfReader("document.pdf")
writer = PdfWriter()

for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)

with open("watermarked.pdf", "wb") as output:
    writer.write(output)
```

### Extract Images
```bash
# Using pdfimages (poppler-utils)
pdfimages -j input.pdf output_prefix

# This extracts all images as output_prefix-000.jpg, output_prefix-001.jpg, etc.
```

### Password Protection
```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

for page in reader.pages:
    writer.add_page(page)

# Add password
writer.encrypt("userpassword", "ownerpassword")

with open("encrypted.pdf", "wb") as output:
    writer.write(output)
```

## Quick Reference

| Task | Best Tool | Command/Code |
|------|-----------|--------------|
| Merge PDFs | pypdf | `writer.add_page(page)` |
| Split PDFs | pypdf | One page per file |
| Extract text | pdfplumber | `page.extract_text()` |
| Extract tables | pdfplumber | `page.extract_tables()` |
| Create PDFs | reportlab | Canvas or Platypus |
| Command line merge | qpdf | `qpdf --empty --pages ...` |
| OCR scanned PDFs | pytesseract | Convert to image first |
| Fill PDF forms | pdf-lib or pypdf (see FORMS.md) | See FORMS.md |

## Next Steps

- For advanced pypdfium2 usage, see REFERENCE.md
- For JavaScript libraries (pdf-lib), see REFERENCE.md
- If you need to fill out a PDF form, follow the instructions in FORMS.md
- For troubleshooting guides, see REFERENCE.md
