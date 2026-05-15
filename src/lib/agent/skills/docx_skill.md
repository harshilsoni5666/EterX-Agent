---
name: docx
description: "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a 'report', 'memo', 'letter', 'template', or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation."
license: Proprietary. LICENSE.txt has complete terms
---

# DOCX creation, editing, and analysis

## EterX Office Artifact Protocol

For ordinary new Word deliverables, use the system tools before writing custom scripts:

1. Draft long content in `.workspaces/sandbox/*.md` only when chunking or research synthesis is needed.
2. Create the final user-facing file with `docx_generator` or `office_artifact_builder(format="docx")`.
3. Save the final `.docx` to the exact user-requested path, or to the Desktop for relative filenames.
4. Share only the final `.docx` path in the answer. Do not share sandbox drafts, helper scripts, XML folders, or temporary files unless the user explicitly asks for them.
5. Use manual `docx`/XML scripting only for advanced editing of an existing document, tracked changes, comments, custom images, section-level layout work, or features the system generator does not support.

Sandbox rule: `.workspaces/sandbox` is only for Markdown drafts, source notes, images, and helper data. Never save the final `.docx` there. If a draft was built in sandbox, compile it into a real final filename on Desktop or the user-requested location.

The agent should write the document content and structure; the system generator handles packaging, page numbers, table styling, headings, and final file placement.

## Codex-Grade DOCX Workflow

Use this workflow for every meaningful Word deliverable unless the user explicitly asks for a raw draft:

1. Classify the document: report, memo, SOP, proposal, manual, form, letter, template, or research document.
2. Plan the reader journey: first-page promise, heading ladder, body density, tables, callouts, visuals, appendix, and final action.
3. Write real content before styling. If facts are current or external, research first and keep source notes.
4. Build the final `.docx` with the highest-level document/office builder available. Use manual DOCX/OOXML code only when the generator cannot express the needed feature.
5. Render or preview the final document when possible. Inspect pages for clipped text, broken tables, missing glyphs, awkward page breaks, overlap, missing images, and bad header/footer behavior.
6. Repair and re-check before claiming completion. Do not judge a Word file only by XML, file size, or text extraction.

### Layout Gate

- Text must have a clear hierarchy: title, subtitle/context, H1/H2/H3, body, captions, footnotes/source notes.
- Tables need intentional widths, repeating headers when long, readable padding, clear units, and no clipped/wrapped headers that hide meaning.
- Forms need usable response controls, space to write, clear labels, and sensible grouping; do not make forms look like dense spreadsheets.
- Dense documents should use appendices and visual anchors so the main narrative stays readable.
- For edits to an existing document, preserve the original structure and make local changes unless the user requested a rewrite.

### Codex Document Parity Rules

- A DOCX is not complete until the latest generated file has passed a render or preview review when that capability is available. Text extraction and XML inspection are not enough because they miss clipping, overlap, broken tables, missing glyphs, stale fields, and header/footer drift.
- Rendered PNG/PDF previews are QA artifacts. Do not send them as the deliverable unless the user asked for previews. Send the final `.docx`.
- Inspect every page for final delivery, not only the first page. For long documents, at minimum inspect the cover/front matter, every table-heavy page, every image/chart page, and the final page; if any defect appears, repair and re-check.
- For comments, tracked changes, hyperlinks, TOC, captions, cross-references, forms/content controls, protection, watermarks, metadata scrubbing, redaction, or multi-document merge, do a structural check as well as a visual check.
- For review/edit tasks, use surgical inline edits, comments, or tracked changes where appropriate. Do not rewrite the whole file just because a smaller change is requested.
- For privacy or redaction tasks, remove metadata and sensitive content properly. Do not only cover sensitive text visually.
- For accessibility-sensitive work, check heading order, table headers, image alt text, link text, and reading order where possible.

## Senior Document Intelligence

Do not treat DOCX generation as a formatting task. Treat it as professional communication design.

### Choose the Document Shape Dynamically

Pick the structure from the user's intent, not from a fixed template:

| Intent | Best Shape | What Makes It Excellent |
|--------|------------|-------------------------|
| Executive report | Cover, executive summary, findings, recommendations, appendix | Clear decisions, quantified evidence, short sections |
| Technical document | Purpose, architecture, constraints, interfaces, edge cases, rollout | Diagrams, tables, numbered requirements |
| Proposal | Client problem, outcome, scope, plan, investment, next steps | Business language, concrete deliverables, confidence |
| SOP/manual | Prerequisites, roles, steps, checks, escalation, glossary | Repeatable instructions, warnings, screenshots/diagrams |
| Research paper | Abstract, context, methodology, findings, discussion, references | Source discipline, balanced analysis, citations |
| Letter/memo | Header, context, core message, requested action | Brevity, authority, direct next step |

### Content Architecture Rules

- Start every substantial document with the outcome the reader needs, not a generic introduction.
- Use tables for comparison, decisions, risks, timelines, and source-backed data.
- Use callouts for insight, risk, recommendation, assumption, and limitation.
- Use diagrams for systems, workflows, dependencies, or decision logic.
- Use appendices for dense support material so the main narrative stays readable.
- Never allow a section to contain only one vague paragraph. Either deepen it or remove it.

### Rendering Quality Rules

- Font, accent color, cover page, headers, and tables must match the document's purpose. A legal memo, board deck handout, and technical SOP should not look identical.
- Use consistent spacing: headings need breathing room; tables need compact row padding; body text must not look like a slide.
- Prefer restrained professional styling over decorative effects.
- Do not use emoji, novelty fonts, arbitrary gradients, or oversized decorative titles in business documents.
- Make every table self-explanatory with clear headers and units.

### Real Visual Asset Rules

- Use real images only when they improve the document: product photos, company logos, maps, architecture diagrams, screenshots, charts, or source-backed visuals.
- Do not use AI-generated images for factual reports unless the user explicitly asks for generated art.
- For real-time/company/current-topic visuals, search or scrape for real public image URLs first, then include Markdown image lines so `docx_generator` can embed them.
- Always include useful alt/caption text in the Markdown image syntax.
- If an image cannot be fetched, the document should still render with an unavailable-image note instead of failing the whole artifact.

### Chart And Data Visual Rules

- For numeric comparisons, trends, distributions, or shares, create a chart artifact first with the chart tool or a custom verified script, then embed the resulting real local image in the DOCX.
- Use tables for exact values and charts for pattern recognition. A professional report often needs both.
- Every chart needs title, axis labels or legend, units, and source note when data came from research.

### Required Final QA

Before reporting completion:

1. Confirm the final `.docx` exists and is not tiny.
2. Confirm the final `.docx` is outside `.workspaces/sandbox` unless the user explicitly requested that location.
3. Confirm the answer references only the final document path.
4. Confirm no placeholders, fake numbers, or unverified current claims remain.
5. Confirm headings, lists, tables, images, charts, and page numbering are rendered through the generator or validated custom code.
6. Confirm visual QA was performed when preview/rendering is available, or clearly state the limitation if rendering was unavailable.
7. If content depends on current facts, include sources in the document or the final answer as appropriate.

## Professional Content Standards

**Before writing a single line of code, understand what to write.** A well-formatted empty document is worthless. The content must be real, intelligent, and appropriate for the document type.

### Content-First Workflow
1. **Understand the domain** — If the user says "write a business report on Tesla," use web search to get real revenue figures, real news, real data. Do NOT invent numbers.
2. **Pick the right document type** — Reports need executive summaries and sections. Memos are short and action-oriented. Proposals have problems, solutions, timelines, and costs. Contracts need clauses and definitions.
3. **Write like a senior professional** — Avoid filler. Every paragraph should add value. Use:
   - Active voice: "Revenue grew 22%" not "22% growth was experienced"
   - Specific facts: "$4.2M ARR" not "significant revenue"
   - Clear structure: problem → analysis → recommendation → action
4. **Match tone to audience** — Board memos: concise, formal, data-driven. Technical specs: precise, numbered, unambiguous. Client proposals: confident, benefit-focused.

### Document Type Cheat Sheet

| Request | Sections to Include |
|---------|-------------------|
| Business Report | Executive Summary, Key Findings, Data Analysis, Recommendations, Appendix |
| Board Memo | To/From/Date header, Context, Key Points (3-5 bullets max), Decision Required |
| Technical Spec | Overview, Requirements, Architecture, API Contracts, Edge Cases, Timeline |
| Client Proposal | Problem Statement, Proposed Solution, Scope, Timeline, Investment, Next Steps |
| Research Paper | Abstract, Introduction, Methodology, Results, Discussion, Conclusion, References |
| Contract/Agreement | Parties, Definitions, Terms, Obligations, Payment, Termination, Signatures |

### Real Data Integration
- Always **search the web first** when writing reports on companies, industries, or current events
- Pull actual figures, dates, names — never use placeholders like "Company X" or "$X million"
- If given a topic, ask: "What are the 3-5 most important facts a reader would expect to see?" — then go find them

## Overview

A .docx file is a ZIP archive containing XML files.

## Quick Reference

| Task | Approach |
|------|----------|
| Read/analyze content | `pandoc` or unpack for raw XML |
| Create new document | Use `docx-js` - see Creating New Documents below |
| Edit existing document | Unpack → edit XML → repack - see Editing Existing Documents below |

### 🚨 Document Quality Rules — Check Before Saving

1. **NO placeholder content** — No "Lorem ipsum", no "Your Name Here", no "[Insert data]". Research and write real content.
2. **Typography hierarchy must be clear** — H1 > H2 > Body. Never make body text the same size as headings.
3. **Tables must have a header row with shading** — A table with no header row looks unfinished.
4. **Images must be real** — Fetch via `https.get()` + buffer. Never reference a local path that doesn't exist.
5. **Dynamic Professional Layouts** — Remove arbitrary limits. Instead of strictly forcing a separate cover page, adapt dynamically! If it's a technical memo, use an inline header. If it's an extensive research report, use a beautiful cover page. You decide based on what looks most premium.
6. **Page numbers in footer for any document > 2 pages** — Always include current page number.
7. **File size check after writing** — `fs.statSync('output.docx').size` must be > 5000 bytes.
8. **Visuals and Flowcharts Are Mandatory** — Never write walls of text. Use Tavily Image Search or Mermaid.ink dynamic flowcharts to visually structure the document.

### Advanced Document Patterns

#### Pattern A: Professional Cover Page
```javascript
// First section = cover page (no header/footer)
// Second section = body with header/footer
const doc = new Document({
  sections: [
    {
      
      // Body section with header/footer
      headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: 'Q3 2025 Executive Report', font: 'Arial', size: 18, color: '6B7280' })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'Page ', font: 'Arial', size: 16 }), new TextRun({ children: [PageNumber.CURRENT], font: 'Arial', size: 16 })] })] }) },
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      children: [ /* your content paragraphs here */ ]
    }
  ]
});
```

#### Pattern B: Colored Callout Box (Info / Warning / Tip)
```javascript
// Colored callout — use for key insights, warnings, or tips
function calloutBox(text, bgColor = 'EBF5FB', borderColor = '2E86AB', label = 'KEY INSIGHT') {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [200, 9160],
    rows: [new TableRow({
      children: [
        // Left accent bar
        new TableCell({
          width: { size: 200, type: WidthType.DXA },
          shading: { fill: borderColor, type: ShadingType.CLEAR },
          children: [new Paragraph({ children: [] })],
          borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
        }),
        // Content
        new TableCell({
          width: { size: 9160, type: WidthType.DXA },
          shading: { fill: bgColor, type: ShadingType.CLEAR },
          margins: { top: 120, bottom: 120, left: 240, right: 240 },
          children: [
            new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 18, color: borderColor, font: 'Arial' })] }),
            new Paragraph({ children: [new TextRun({ text, size: 20, font: 'Arial', color: '1F2937' })] }),
          ],
          borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
        }),
      ]
    })]
  });
}
// Usage: calloutBox('Revenue grew 31% YoY, driven by data center demand.', 'EBF5FB', '2E86AB', 'KEY FINDING')
// Warning: calloutBox('Margin compression risk if COGS increases > 5%.', 'FEF3C7', 'F59E0B', '⚠ RISK')
```

#### Pattern C: Dynamic Architecture & Flowcharts (via Mermaid.ink)
### Images

```javascript
// CRITICAL: type parameter is REQUIRED
new Paragraph({
  children: [new ImageRun({
    type: "png", // Required: png, jpg, jpeg, gif, bmp, svg
    data: fs.readFileSync("image.png"),
    transformation: { width: 200, height: 150 },
    altText: { title: "Title", description: "Desc", name: "Name" } // All three required
  })]
})
```

#### Pattern D: Pull Quote (large styled quote)
```javascript
function pullQuote(text, attribution) {
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: '2E86AB', space: 20 }, right: { style: BorderStyle.SINGLE, size: 12, color: '2E86AB', space: 20 } },
      spacing: { before: 360, after: 120 },
      indent: { left: 720, right: 720 },
      children: [new TextRun({ text: `"${text}"`, font: 'Arial', size: 32, italics: true, color: '1E3A5F' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 360 },
      indent: { left: 720, right: 720 },
      children: [new TextRun({ text: `— ${attribution}`, font: 'Arial', size: 20, color: '6B7280' })],
    }),
  ];
}
```

#### Pattern D: Two-Column Letterhead Header
```javascript
// Company name left, date right — using tab stops
new Paragraph({
  tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '2E86AB', space: 4 } },
  spacing: { after: 400 },
  children: [
    new TextRun({ text: 'NovaTech Corporation', font: 'Arial', size: 24, bold: true, color: '1E3A5F' }),
    new TextRun({ text: '\tApril 30, 2025', font: 'Arial', size: 20, color: '6B7280' }),
  ],
})
```



### Converting .doc to .docx

Legacy `.doc` files must be converted before editing:

```bash
python scripts/office/soffice.py --headless --convert-to docx document.doc
```

### Reading Content

```bash
# Text extraction with tracked changes
pandoc --track-changes=all document.docx -o output.md

# Raw XML access
python scripts/office/unpack.py document.docx unpacked/
```

### Converting to Images

```bash
python scripts/office/soffice.py --headless --convert-to pdf document.docx
pdftoppm -jpeg -r 150 document.pdf page
```

### Accepting Tracked Changes

To produce a clean document with all tracked changes accepted (requires LibreOffice):

```bash
python scripts/accept_changes.py input.docx output.docx
```

---

## Creating New Documents

Generate .docx files with JavaScript, then validate.

### CRITICAL: Use sandbox for internal work only — never expose it as the final deliverable

Installing `npm` packages in the Next.js project root triggers hot-reload and **breaks the entire UI**. Always create and work inside the dedicated sandbox directory:

```bash
# 1. Create isolated working directory inside the sandbox
mkdir -p .workspaces/sandbox/docx-gen && cd .workspaces/sandbox/docx-gen

# 2. DO NOT RE-INSTALL if already present (saves time)
if [ ! -d "node_modules/docx" ]; then npm install docx@8.5.0; fi

# 3. Write your script here, then run it
node generate.js

# 4. Output file will be at: .workspaces/sandbox/docx-gen/output.docx
```

**Why**: Any `package.json` or `node_modules` created at the project root causes Next.js to restart, which kills the agent's UI connection mid-task.

---

## 🏆 Advanced Industry Use Cases

### 1. The Legal Review / Redline
*   **Workflow**: Use the unpacking/XML manipulation method to perform precise tracked changes.
*   **Standard**: Every deletion must be wrapped in `<w:del>` and every addition in `<w:ins>` with accurate timestamps.
*   **Professionalism**: Preserve all existing formatting and styles from the original document.

### 2. High-End Technical Whitepaper
*   **Cover Page**: Professional, minimalist design with logo and abstract.
*   **Navigation**: Mandatory Table of Contents (`new TableOfContents(...)`) with clickable links.
*   **Visuals**: Use **Pattern C** (Mermaid Diagrams) for system architecture and high-quality Tavily-searched images for context.
*   **Footnotes**: Use for citations to ensure high academic credibility.

### 3. Detailed Technical Manual / SOP
*   **Structure**: Hierarchical numbering (1.1, 1.1.1, etc.).
*   **Callouts**: Frequent use of **Pattern B** (Callout Boxes) for "WARNING," "TIP," or "NOTE."
*   **Images**: Clear screenshots or diagrams with numbered captions.

---

### Safe Import Pattern (copy exactly)
```javascript
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  ImageRun, Header, Footer, AlignmentType, PageOrientation, LevelFormat,
  ExternalHyperlink, InternalHyperlink, Bookmark,
  TabStopType, TabStopPosition, SectionType,
  HeadingLevel, BorderStyle, WidthType, ShadingType,
  PageNumber, TableOfContents
} = require('docx');

// ⚠️ FootnoteReferenceRun, PositionalTab, TableOfContents, Column — check if available
// before using: if (!require('docx').TableOfContents) skip it

async function main() {
  const doc = new Document({ sections: [{ children: [] }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync('output.docx', buffer);
  console.log('✅ output.docx created:', fs.statSync('output.docx').size, 'bytes');
}
main().catch(e => { console.error('❌ FAILED:', e.message); process.exit(1); });
```

### Fetching Images from URLs (Real-time)
```javascript
const https = require('https');
const http = require('http');

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Usage:
const imgBuffer = await downloadImage('https://example.com/logo.png');
new ImageRun({
  type: 'png',
  data: imgBuffer,
  transformation: { width: 200, height: 100 }
})
```

### Validation
After creating the file, validate it. If validation fails, unpack, fix the XML, and repack.
```bash
python scripts/office/validate.py doc.docx
```

### Page Size

```javascript
// CRITICAL: docx-js defaults to A4, not US Letter
// Always set page size explicitly for consistent results
sections: [{
  properties: {
    page: {
      size: {
        width: 12240,   // 8.5 inches in DXA
        height: 15840   // 11 inches in DXA
      },
      margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } // 1 inch margins
    }
  },
  children: [/* content */]
}]
```

**Common page sizes (DXA units, 1440 DXA = 1 inch):**

| Paper | Width | Height | Content Width (1" margins) |
|-------|-------|--------|---------------------------|
| US Letter | 12,240 | 15,840 | 9,360 |
| A4 (default) | 11,906 | 16,838 | 9,026 |

**Landscape orientation:** docx-js swaps width/height internally, so pass portrait dimensions and let it handle the swap:
```javascript
size: {
  width: 12240,   // Pass SHORT edge as width
  height: 15840,  // Pass LONG edge as height
  orientation: PageOrientation.LANDSCAPE  // docx-js swaps them in the XML
},
// Content width = 15840 - left margin - right margin (uses the long edge)
```

### Styles (Override Built-in Headings)

Use Arial as the default font (universally supported). Keep titles black for readability.

```javascript
const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 24 } } }, // 12pt default
    paragraphStyles: [
      // IMPORTANT: Use exact IDs to override built-in styles
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 } }, // outlineLevel required for TOC
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 180, after: 180 }, outlineLevel: 1 } },
    ]
  },
  sections: [{
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Title")] }),
    ]
  }]
});
```

### Lists (NEVER use unicode bullets)

```javascript
// ❌ WRONG - never manually insert bullet characters
new Paragraph({ children: [new TextRun("• Item")] })  // BAD
new Paragraph({ children: [new TextRun("\u2022 Item")] })  // BAD

// ✅ CORRECT - use numbering config with LevelFormat.BULLET
const doc = new Document({
  numbering: {
    config: [
      { reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "numbers",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [{
    children: [
      new Paragraph({ numbering: { reference: "bullets", level: 0 },
        children: [new TextRun("Bullet item")] }),
      new Paragraph({ numbering: { reference: "numbers", level: 0 },
        children: [new TextRun("Numbered item")] }),
    ]
  }]
});

// ⚠️ Each reference creates INDEPENDENT numbering
// Same reference = continues (1,2,3 then 4,5,6)
// Different reference = restarts (1,2,3 then 1,2,3)
```

### Tables

**CRITICAL: Tables need dual widths** - set both `columnWidths` on the table AND `width` on each cell. Without both, tables render incorrectly on some platforms.

```javascript
// CRITICAL: Always set table width for consistent rendering
// CRITICAL: Use ShadingType.CLEAR (not SOLID) to prevent black backgrounds
const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };

new Table({
  width: { size: 9360, type: WidthType.DXA }, // Always use DXA (percentages break in Google Docs)
  columnWidths: [4680, 4680], // Must sum to table width (DXA: 1440 = 1 inch)
  rows: [
    new TableRow({
      children: [
        new TableCell({
          borders,
          width: { size: 4680, type: WidthType.DXA }, // Also set on each cell
          shading: { fill: "D5E8F0", type: ShadingType.CLEAR }, // CLEAR not SOLID
          margins: { top: 80, bottom: 80, left: 120, right: 120 }, // Cell padding (internal, not added to width)
          children: [new Paragraph({ children: [new TextRun("Cell")] })]
        })
      ]
    })
  ]
})
```

**Table width calculation:**

Always use `WidthType.DXA` — `WidthType.PERCENTAGE` breaks in Google Docs.

```javascript
// Table width = sum of columnWidths = content width
// US Letter with 1" margins: 12240 - 2880 = 9360 DXA
width: { size: 9360, type: WidthType.DXA },
columnWidths: [7000, 2360]  // Must sum to table width
```

**Width rules:**
- **Always use `WidthType.DXA`** — never `WidthType.PERCENTAGE` (incompatible with Google Docs)
- Table width must equal the sum of `columnWidths`
- Cell `width` must match corresponding `columnWidth`
- Cell `margins` are internal padding - they reduce content area, not add to cell width
- For full-width tables: use content width (page width minus left and right margins)

### Images

```javascript
// CRITICAL: type parameter is REQUIRED
new Paragraph({
  children: [new ImageRun({
    type: "png", // Required: png, jpg, jpeg, gif, bmp, svg
    data: fs.readFileSync("image.png"),
    transformation: { width: 200, height: 150 },
    altText: { title: "Title", description: "Desc", name: "Name" } // All three required
  })]
})
```

### Page Breaks

```javascript
// CRITICAL: PageBreak must be inside a Paragraph
new Paragraph({ children: [new PageBreak()] })

// Or use pageBreakBefore
new Paragraph({ pageBreakBefore: true, children: [new TextRun("New page")] })
```

### Hyperlinks

```javascript
// External link
new Paragraph({
  children: [new ExternalHyperlink({
    children: [new TextRun({ text: "Click here", style: "Hyperlink" })],
    link: "https://example.com",
  })]
})

// Internal link (bookmark + reference)
// 1. Create bookmark at destination
new Paragraph({ heading: HeadingLevel.HEADING_1, children: [
  new Bookmark({ id: "chapter1", children: [new TextRun("Chapter 1")] }),
]})
// 2. Link to it
new Paragraph({ children: [new InternalHyperlink({
  children: [new TextRun({ text: "See Chapter 1", style: "Hyperlink" })],
  anchor: "chapter1",
})]})
```

### Footnotes

```javascript
const doc = new Document({
  footnotes: {
    1: { children: [new Paragraph("Source: Annual Report 2024")] },
    2: { children: [new Paragraph("See appendix for methodology")] },
  },
  sections: [{
    children: [new Paragraph({
      children: [
        new TextRun("Revenue grew 15%"),
        new FootnoteReferenceRun(1),
        new TextRun(" using adjusted metrics"),
        new FootnoteReferenceRun(2),
      ],
    })]
  }]
});
```

### Tab Stops

```javascript
// Right-align text on same line (e.g., date opposite a title)
new Paragraph({
  children: [
    new TextRun("Company Name"),
    new TextRun("\tJanuary 2025"),
  ],
  tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
})

// Dot leader (e.g., TOC-style)
new Paragraph({
  children: [
    new TextRun("Introduction"),
    new TextRun({ children: [
      new PositionalTab({
        alignment: PositionalTabAlignment.RIGHT,
        relativeTo: PositionalTabRelativeTo.MARGIN,
        leader: PositionalTabLeader.DOT,
      }),
      "3",
    ]}),
  ],
})
```

### Multi-Column Layouts

```javascript
// Equal-width columns
sections: [{
  properties: {
    column: {
      count: 2,          // number of columns
      space: 720,        // gap between columns in DXA (720 = 0.5 inch)
      equalWidth: true,
      separate: true,    // vertical line between columns
    },
  },
  children: [/* content flows naturally across columns */]
}]

// Custom-width columns (equalWidth must be false)
sections: [{
  properties: {
    column: {
      equalWidth: false,
      children: [
        new Column({ width: 5400, space: 720 }),
        new Column({ width: 3240 }),
      ],
    },
  },
  children: [/* content */]
}]
```

Force a column break with a new section using `type: SectionType.NEXT_COLUMN`.

### Table of Contents

```javascript
// CRITICAL: Headings must use HeadingLevel ONLY - no custom styles
new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" })
```

### Headers/Footers

```javascript
sections: [{
  properties: {
    page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } // 1440 = 1 inch
  },
  headers: {
    default: new Header({ children: [new Paragraph({ children: [new TextRun("Header")] })] })
  },
  footers: {
    default: new Footer({ children: [new Paragraph({
      children: [new TextRun("Page "), new TextRun({ children: [PageNumber.CURRENT] })]
    })] })
  },
  children: [/* content */]
}]
```

### Critical Rules for docx-js

- **Install locally, not globally** - run `npm install docx@8.5.0` in script dir, then `node script.js`
- **Always wrap in async main()** - `Packer.toBuffer` is async; missing await = empty/corrupt file
- **Always log file size after write** - `fs.statSync('out.docx').size` should be >5000 bytes; if <1000 = corrupt
- **Set page size explicitly** - docx-js defaults to A4; use US Letter (12240 x 15840 DXA) for US documents
- **Landscape: pass portrait dimensions** - docx-js swaps width/height internally; pass short edge as `width`, long edge as `height`, and set `orientation: PageOrientation.LANDSCAPE`
- **Never use `\n`** - use separate Paragraph elements
- **Never use unicode bullets** - use `LevelFormat.BULLET` with numbering config
- **PageBreak must be in Paragraph** - standalone creates invalid XML
- **ImageRun requires `type`** - always specify png/jpg/etc. Download URL images with https.get() before inserting
- **Always set table `width` with DXA** - never use `WidthType.PERCENTAGE` (breaks in Google Docs)
- **Tables need dual widths** - `columnWidths` array AND cell `width`, both must match
- **Table width = sum of columnWidths** - for DXA, ensure they add up exactly
- **Always add cell margins** - use `margins: { top: 80, bottom: 80, left: 120, right: 120 }` for readable padding
- **Use `ShadingType.CLEAR`** - never SOLID for table shading
- **Never use tables as dividers/rules** - use Paragraph border instead
- **TOC requires HeadingLevel only** - no custom styles on heading paragraphs
- **Override built-in styles** - use exact IDs: "Heading1", "Heading2", etc.
- **Include `outlineLevel`** - required for TOC (0 for H1, 1 for H2, etc.)
- **Check exotic imports exist** - `FootnoteReferenceRun`, `TableOfContents`, `PositionalTab` may not exist in all versions; use `require('docx').X` check before using

### 🐛 If the .docx won't open in Word
1. Check console for `❌ FAILED:` errors — fix them first
2. Check file size: `<1000 bytes` = script errored silently
3. Run `python scripts/office/validate.py output.docx` — it shows exact XML errors
4. Most common cause: unresolved `require()` import (e.g. `FootnoteReferenceRun` not in installed version)
5. Fix: remove the problematic import and the feature that uses it, then regenerate

---

## Editing Existing Documents

**Follow all 3 steps in order.**

### Step 1: Unpack
```bash
python scripts/office/unpack.py document.docx unpacked/
```
Extracts XML, pretty-prints, merges adjacent runs, and converts smart quotes to XML entities (`&#x201C;` etc.) so they survive editing. Use `--merge-runs false` to skip run merging.

### Step 2: Edit XML

Edit files in `unpacked/word/`. See XML Reference below for patterns.

**Use "Claude" as the author** for tracked changes and comments, unless the user explicitly requests use of a different name.

**Use the Edit tool directly for string replacement. Do not write Python scripts.** Scripts introduce unnecessary complexity. The Edit tool shows exactly what is being replaced.

**CRITICAL: Use smart quotes for new content.** When adding text with apostrophes or quotes, use XML entities to produce smart quotes:
```xml
<!-- Use these entities for professional typography -->
<w:t>Here&#x2019;s a quote: &#x201C;Hello&#x201D;</w:t>
```
| Entity | Character |
|--------|-----------|
| `&#x2018;` | ‘ (left single) |
| `&#x2019;` | ’ (right single / apostrophe) |
| `&#x201C;` | “ (left double) |
| `&#x201D;` | ” (right double) |

**Adding comments:** Use `comment.py` to handle boilerplate across multiple XML files (text must be pre-escaped XML):
```bash
python scripts/comment.py unpacked/ 0 "Comment text with &amp; and &#x2019;"
python scripts/comment.py unpacked/ 1 "Reply text" --parent 0  # reply to comment 0
python scripts/comment.py unpacked/ 0 "Text" --author "Custom Author"  # custom author name
```
Then add markers to document.xml (see Comments in XML Reference).

### Step 3: Pack
```bash
python scripts/office/pack.py unpacked/ output.docx --original document.docx
```
Validates with auto-repair, condenses XML, and creates DOCX. Use `--validate false` to skip.

**Auto-repair will fix:**
- `durableId` >= 0x7FFFFFFF (regenerates valid ID)
- Missing `xml:space="preserve"` on `<w:t>` with whitespace

**Auto-repair won't fix:**
- Malformed XML, invalid element nesting, missing relationships, schema violations

### Common Pitfalls

- **Replace entire `<w:r>` elements**: When adding tracked changes, replace the whole `<w:r>...</w:r>` block with `<w:del>...<w:ins>...` as siblings. Don't inject tracked change tags inside a run.
- **Preserve `<w:rPr>` formatting**: Copy the original run's `<w:rPr>` block into your tracked change runs to maintain bold, font size, etc.

---

## XML Reference

### Schema Compliance

- **Element order in `<w:pPr>`**: `<w:pStyle>`, `<w:numPr>`, `<w:spacing>`, `<w:ind>`, `<w:jc>`, `<w:rPr>` last
- **Whitespace**: Add `xml:space="preserve"` to `<w:t>` with leading/trailing spaces
- **RSIDs**: Must be 8-digit hex (e.g., `00AB1234`)

### Tracked Changes

**Insertion:**
```xml
<w:ins w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:t>inserted text</w:t></w:r>
</w:ins>
```

**Deletion:**
```xml
<w:del w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
```

**Inside `<w:del>`**: Use `<w:delText>` instead of `<w:t>`, and `<w:delInstrText>` instead of `<w:instrText>`.

**Minimal edits** - only mark what changes:
```xml
<!-- Change "30 days" to "60 days" -->
<w:r><w:t>The term is </w:t></w:r>
<w:del w:id="1" w:author="Claude" w:date="...">
  <w:r><w:delText>30</w:delText></w:r>
</w:del>
<w:ins w:id="2" w:author="Claude" w:date="...">
  <w:r><w:t>60</w:t></w:r>
</w:ins>
<w:r><w:t> days.</w:t></w:r>
```

**Deleting entire paragraphs/list items** - when removing ALL content from a paragraph, also mark the paragraph mark as deleted so it merges with the next paragraph. Add `<w:del/>` inside `<w:pPr><w:rPr>`:
```xml
<w:p>
  <w:pPr>
    <w:numPr>...</w:numPr>  <!-- list numbering if present -->
    <w:rPr>
      <w:del w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z"/>
    </w:rPr>
  </w:pPr>
  <w:del w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
    <w:r><w:delText>Entire paragraph content being deleted...</w:delText></w:r>
  </w:del>
</w:p>
```
Without the `<w:del/>` in `<w:pPr><w:rPr>`, accepting changes leaves an empty paragraph/list item.

**Rejecting another author's insertion** - nest deletion inside their insertion:
```xml
<w:ins w:author="Jane" w:id="5">
  <w:del w:author="Claude" w:id="10">
    <w:r><w:delText>their inserted text</w:delText></w:r>
  </w:del>
</w:ins>
```

**Restoring another author's deletion** - add insertion after (don't modify their deletion):
```xml
<w:del w:author="Jane" w:id="5">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
<w:ins w:author="Claude" w:id="10">
  <w:r><w:t>deleted text</w:t></w:r>
</w:ins>
```

### Comments

After running `comment.py` (see Step 2), add markers to document.xml. For replies, use `--parent` flag and nest markers inside the parent's.

**CRITICAL: `<w:commentRangeStart>` and `<w:commentRangeEnd>` are siblings of `<w:r>`, never inside `<w:r>`.**

```xml
<!-- Comment markers are direct children of w:p, never inside w:r -->
<w:commentRangeStart w:id="0"/>
<w:del w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted</w:delText></w:r>
</w:del>
<w:r><w:t> more text</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>

<!-- Comment 0 with reply 1 nested inside -->
<w:commentRangeStart w:id="0"/>
  <w:commentRangeStart w:id="1"/>
  <w:r><w:t>text</w:t></w:r>
  <w:commentRangeEnd w:id="1"/>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>
```

### Images

1. Add image file to `word/media/`
2. Add relationship to `word/_rels/document.xml.rels`:
```xml
<Relationship Id="rId5" Type=".../image" Target="media/image1.png"/>
```
3. Add content type to `[Content_Types].xml`:
```xml
<Default Extension="png" ContentType="image/png"/>
```
4. Reference in document.xml:
```xml
<w:drawing>
  <wp:inline>
    <wp:extent cx="914400" cy="914400"/>  <!-- EMUs: 914400 = 1 inch -->
    <a:graphic>
      <a:graphicData uri=".../picture">
        <pic:pic>
          <pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing>
```

---

## Dependencies

- **pandoc**: Text extraction
- **docx**: `npm install -g docx` (new documents)
- **LibreOffice**: PDF conversion (auto-configured for sandboxed environments via `scripts/office/soffice.py`)
- **Poppler**: `pdftoppm` for images
