---
name: pptx
description: "Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file (even if the extracted content will be used elsewhere, like in an email or summary); editing, modifying, or updating existing presentations; combining or splitting slide files; working with templates, layouts, speaker notes, or comments. Trigger whenever the user mentions \"deck,\" \"slides,\" \"presentation,\" or references a .pptx filename, regardless of what they plan to do with the content afterward. If a .pptx file needs to be opened, created, or touched, use this skill."
license: Proprietary. LICENSE.txt has complete terms
---

# PPTX Skill

## EterX Office Artifact Protocol

For ordinary new slide decks, use `office_artifact_builder(format="pptx")` before writing a one-off `pptxgenjs` script.

1. Research and storyboard first. Use `.workspaces/sandbox/*.md` only for internal outlines, slide notes, and chunked drafts.
2. Export the final `.pptx` with `office_artifact_builder` when the request is a normal presentation, pitch deck, summary deck, class deck, or report deck.
3. Save the final deck to the exact user-requested path, or to the Desktop for relative filenames.
4. Share only the final `.pptx` path in the answer. Do not expose sandbox drafts or helper scripts unless requested.
5. Use custom `pptxgenjs` only for advanced layouts, brand templates, image-heavy decks, speaker-note workflows, existing-file editing, or precise visual systems beyond the system builder.

Sandbox rule: `.workspaces/sandbox` is only for outlines, source notes, images, and helper scripts. Never leave the final deck there.

The agent owns the story, slide titles, evidence, and message hierarchy. The system builder owns file packaging and baseline professional rendering.

## Codex-Grade Presentation Workflow

Use this workflow for every meaningful deck:

1. Classify the deck: executive decision, investor, sales/client, technical, training, research, creative, or template-following.
2. Define the audience, decision to unlock, thesis, narrative arc, tone, slide count, and evidence needs before building slides.
3. Write slide titles as claims. Use body text only to support the claim.
4. Build editable native slide content where possible: text, shapes, tables, charts, diagrams, speaker notes, and placed raster assets.
5. Use real images, logos, screenshots, charts, and source-backed assets for factual topics. Do not invent brand/product/company visuals.
6. Render or preview the final slides when possible. Inspect individual slides for text overlap, clipping, accidental wrapping, broken images, chart defects, unreadable colors, and blank slides.
7. Repair and re-check before claiming the deck is finished.

### Slide Verification Gate

- One slide has one job and one dominant visual/read.
- Titles state the insight or action, not a vague label.
- Data relationships use charts or tables when chartable; KPI cards support but do not replace analysis.
- Text is readable at presentation size and does not collide with images, charts, shapes, or footer/source notes.
- The deck has visual variety without becoming a random collection of layouts.
- Speaker notes carry detail when the slide itself should stay clean.

### Codex Presentation Parity Rules

- Classify content maturity before styling: playful/casual, serious work, technical/educational, premium brand, or template-following. A playful deck should not accidentally become a consulting deck, and a board deck should not become decorative.
- Define a compact design contract: audience posture, tone, format promise, anti-format, palette roles, type roles, image/evidence role, and slide density roles.
- Build a dedicated title-page concept. The cover must have one dominant idea and should not reuse a generic dashboard, card grid, KPI strip, or normal content-slide shell.
- Avoid using visible cards, panels, tiles, and boxed paragraphs as the default design language. Use boxes only when they hold a real object such as a chart, table, UI surface, map, calendar, reference artifact, or structured comparison.
- Use editable native charts/tables for chartable data. Do not rebuild ordinary bar, line, pie, scatter, waterfall, funnel, histogram, treemap, or table views out of decorative boxes unless there is a clear slide-specific reason.
- Reference documents, PDFs, webpages, and screenshots are source material, not slide cargo. Extract the ideas, stats, quotes, charts, and real visuals that matter; do not paste entire pages into slides unless the slide is explicitly critiquing that artifact.
- Every important text element needs enough slack for PowerPoint rendering. One-line labels, chips, titles, subtitles, metrics, footers, and chart labels must not wrap unexpectedly, clip, or collide.
- Full-size rendered slides are the visual source of truth. Contact sheets or montages help check rhythm but can hide collisions and are not sufficient by themselves.
- After any text-size, layout, chart, or image repair, re-check the affected slide. Stop polishing when requirements are met, but do not ship blocking overlap, clipping, broken images, blank charts, or unreadable colors.

## Senior Deck Intelligence

Do not make slide decks as decorated documents. A deck is a sequence of decisions.

### Story Architecture

Choose the narrative based on the audience:

| Audience | Deck Shape | Primary Goal |
|----------|------------|--------------|
| Executives | Situation, insight, decision, risks, action | Fast decision-making |
| Investors | Problem, market, product, traction, business model, ask | Confidence and urgency |
| Technical team | Problem, architecture, tradeoffs, implementation plan, risks | Alignment and execution |
| Sales/client | Client pain, outcome, solution, proof, scope, next steps | Trust and conversion |
| Training/class | Learning objective, concept, example, exercise, recap | Retention and clarity |

### Slide-Level Rules

- One slide equals one message. If there are two messages, split the slide.
- The title must state the point, not the category.
- The visual must do real work: compare, reveal, sequence, locate, quantify, or simplify.
- Use bullets only when they improve scanning. Prefer stat cards, process steps, comparison tables, timelines, diagrams, and image-backed layouts.
- Keep each slide visually asymmetric enough to feel designed, but aligned enough to feel controlled.
- Use speaker notes when the slide must stay clean but the presenter needs detail.

### Creativity Without Chaos

- Vary layouts across the deck: title, section divider, stat slide, comparison, timeline, visual proof, architecture, recommendation, close.
- Match style to topic. A finance deck should feel precise; a product launch deck can be more visual; a technical architecture deck should be diagram-forward.
- Do not use fixed decorative tropes repeatedly. Repeating the same card grid or title bar on every slide makes the deck feel generated.
- Real brands require real colors, logos, and domain-specific imagery when available.

### Real Visual Asset Rules

- Prefer real images, logos, screenshots, diagrams, and charts over decorative shapes when the topic is factual.
- Do not use AI-generated imagery for companies, products, people, places, or market facts unless the user explicitly asks.
- For each important company/product/place, search or scrape for a real image/logo URL and pass it as a slide `image` field or Markdown image line.
- Use charts for quantitative slides. If the deck references growth, market share, revenue, pricing, adoption, or benchmarks, show the pattern visually.
- Images must be high enough quality to survive slide projection. Avoid tiny thumbnails, watermarked images, and broken hotlinks.

### Deck QA

Before reporting completion:

1. Verify the final `.pptx` exists and is not tiny.
2. Verify the final `.pptx` is outside `.workspaces/sandbox` unless the user explicitly requested that location.
3. Check every slide has a meaningful title.
4. Check every slide has a visual structure beyond plain title plus text.
5. Check there are no placeholders, generic company names, dummy numbers, or broken image references.
6. Check real image/logo/chart slides use actual source assets, not invented visuals.
7. Check rendered/previewed slides when possible and fix visible overlap, clipping, wrapping, blank charts, and unreadable colors.
8. Share only the final `.pptx` path unless the user asks for the outline or source notes.

## Professional Content Standards

**Slides communicate, they don't store information.** Every slide must have a clear message, a visual element, and no wall of text.

### 🚨 HARD RULES — violating these = failure

These are non-negotiable. Check every slide against this list before saving:

1. **NO plain white slides** — Every slide must have a background color, or a strong colored shape/bar anchoring the design. A white rectangle with black text is unacceptable.
2. **NO accent lines under titles** — This is the #1 AI-generated slide tell. Never add a horizontal line under a title. Use whitespace or background contrast instead.
3. **NO bullet walls** — Maximum 4 bullets per slide. Each bullet ≤ 10 words. If you have more content, split across multiple slides.
4. **NO placeholder text** — "Lorem ipsum", "Insert content here", "TBD", "Company Name" = instant failure. Search the web if you don't have the real content.
5. **EVERY slide needs a visual** — shape, chart, image, icon grid, or stat card. A slide with only a title and text bullets is not acceptable.
6. **NO generic colors** — Do not default to plain blue (#0000FF) or plain red (#FF0000). Pick a curated palette (see Color Palettes section) that matches the topic.
7. **Title = the insight, not a label** — "Revenue Grew 31% YoY" beats "Financial Results". "3 Reasons Customers Churn" beats "Customer Analysis".

### 🌐 The "Deep Research First" Protocol (CRITICAL)
**Never start writing a presentation until you have gathered hard facts.** AI-generated fluff ruins decks. You must become an expert on the topic *before* drafting slides.

1. **Mandatory Pre-Search:** If asked to make a deck about a company, industry, or topic, you MUST execute 3-5 distinct web searches using the `search_web` tool before writing any code.
2. **Find the "Why":** Don't just find what a company does. Find their latest quarterly earnings, their main competitors, their recent controversies, their exact market share, and quotes from their CEO.
3. **Use Real Numbers:** Replace "Significant Growth" with "Revenue surged 42% to $1.2B in Q3". Replace "Many Users" with "Passed 50 million MAUs in Europe".
4. **No Dummy Content:** "Insert content here" or "Company Name" equals instant failure. If you don't know it, search for it.
5. **The Title IS the Message:** "Revenue grew 22% driven by iPhone 16 demand" beats "Q3 Financial Results".
6. **Real Media & Branding:** 
   - Fetch actual images via `downloadImage(url)`.
   - **MANDATORY**: Fetch real company logos using `fetchCompanyLogo(domain)` for any company mentioned.
   - Use high-quality SVG icons from the web instead of generic PPT shapes when possible.
7. **The "High-End" Flowchart Rule**: For technical or process slides, use the **Mermaid.ink** pattern (Layout 15). Never use simple lines and boxes; create a colorful, professional architecture diagram.

### 📏 The Golden Grid System
Professional decks use a strict grid. Never "eyeball" it.
- **Top Margin**: 0.5" (Title baseline at 0.4-0.6")
- **Side Margins**: 0.6" (Left/Right)
- **Gutter**: 0.3" between columns or cards.
- **Footer**: Reserved for Page Number and Logo (0.5" from bottom).

- **Slide types to know**: Title → Section divider → Content + image (2-col) → Stat callout (big numbers) → Timeline → Comparison table → Architecture/Flowchart → Closing CTA

### Slide Writing Formula
```
Title:   [Specific insight — not a vague label]
Visual:  [Chart / image / icon grid / stat cards / colored shape]
Body:    [3-4 bullets max, each ≤ 10 words, each a complete thought]
Source:  [Bottom right, 8pt, muted color if using real data]
```

### Mandatory Self-Check Before Saving
Before calling `pptx.writeFile()`, mentally verify each slide:
- [ ] Does it have a non-white background OR a dominant colored element (sidebar, header bar, card)?
- [ ] Is there at least one visual element (shape, image, chart)?
- [ ] Does the title state a specific insight?
- [ ] Are there fewer than 5 bullet points?
- [ ] Is there NO horizontal accent line under the title?

If any slide fails a check — fix it before saving.


## Quick Reference

| Task | Guide |
|------|-------|
| Read/analyze content | `python -m markitdown presentation.pptx` |
| Edit or create from template | Read [editing.md](editing.md) |
| Create from scratch | Read [pptxgenjs.md](pptxgenjs.md) |

---

## Reading Content

```bash
# Text extraction
python -m markitdown presentation.pptx

# Visual overview
python scripts/thumbnail.py presentation.pptx

# Raw XML
python scripts/office/unpack.py presentation.pptx unpacked/
```

---

## Editing Workflow

**Read [editing.md](editing.md) for full details.**

1. Analyze template with `thumbnail.py`
2. Unpack → manipulate slides → edit content → clean → pack

---

## Creating from Scratch

**Use pptxgenjs for new decks.**

### CRITICAL: Use sandbox for internal work only — never expose it as the final deliverable

Installing `npm` packages in the project root **triggers Next.js hot-reload and breaks the UI**. Always isolate:

```bash
# 1. Create isolated sandbox directory
mkdir -p .workspaces/sandbox/pptx-gen && cd .workspaces/sandbox/pptx-gen

# 2. DO NOT RE-INSTALL if already present (saves time)
if [ ! -d "node_modules/pptxgenjs" ]; then npm install pptxgenjs; fi

# 3. Write and run your script here
node build-deck.js

# Output: .workspaces/sandbox/pptx-gen/output.pptx
```

**Never run `npm install` at the project root.** It will cause Next.js to restart, breaking the agent connection mid-generation.

### ⚠️ Critical: Always wrap in async and verify output
```javascript
const PptxGenJS = require('pptxgenjs');
const https = require('https');
const http  = require('http');
const fs    = require('fs');

// ─── BULLETPROOF IMAGE DOWNLOADER ───────────────────────────────────────────
// Returns { b64, mime } — always use BOTH when calling addImage()
// Handles: redirects, MIME detection from headers, SVG rejection, size check
function downloadImage(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) return reject(new Error('Too many redirects'));

    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 8000 }, res => {

      // Follow redirects (301, 302, 307, 308)
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return downloadImage(res.headers.location, maxRedirects - 1)
          .then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      // Detect MIME from Content-Type header
      const ct = (res.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
      const mimeMap = {
        'image/png':  'png',
        'image/jpeg': 'jpeg',
        'image/jpg':  'jpeg',
        'image/gif':  'gif',
        'image/webp': 'png',  // pptxgenjs doesn't support webp — treat as png attempt
        'image/bmp':  'bmp',
      };

      // SVG is NOT supported by pptxgenjs — reject early
      if (ct === 'image/svg+xml' || url.endsWith('.svg')) {
        res.resume();
        return reject(new Error('SVG not supported by pptxgenjs — use PNG/JPG'));
      }

      // Guess from URL extension if header is missing or generic
      let mime = mimeMap[ct];
      if (!mime) {
        const ext = url.split('?')[0].split('.').pop().toLowerCase();
        mime = { png:'png', jpg:'jpeg', jpeg:'jpeg', gif:'gif', bmp:'bmp', webp:'png' }[ext] || 'png';
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < 200) return reject(new Error(`Image too small (${buf.length}B) — probably an error page`));
        resolve({ b64: buf.toString('base64'), mime });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
  });
}

// ─── SAFE addImage wrapper ───────────────────────────────────────────────────
// Always use this instead of slide.addImage() directly
function addImage(slide, imgResult, x, y, w, h, opts = {}) {
  if (!imgResult) return; // silently skip if image failed to load
  slide.addImage({
    data: `image/${imgResult.mime};base64,${imgResult.b64}`,
    x, y, w, h,
    ...opts
  });
}

// ─── LOGO FETCHER with fallback chain ────────────────────────────────────────
async function fetchCompanyLogo(domain) {
  const sources = [
    `https://logo.clearbit.com/${domain}`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  ];
  for (const url of sources) {
    try {
      const result = await downloadImage(url);
      if (result && result.b64.length > 300) return result;
    } catch (e) {
      console.warn(`  ↳ logo source failed: ${url} — ${e.message}`);
    }
  }
  console.warn(`  ↳ No logo found for ${domain} — will use letter fallback`);
  return null;
}

// ─── USAGE EXAMPLES ──────────────────────────────────────────────────────────
// ✅ CORRECT — always destructure { b64, mime } and use the addImage wrapper:
//   const img = await downloadImage('https://example.com/photo.jpg');
//   addImage(slide, img, 1, 1, 5, 3);                    // basic
//   addImage(slide, img, 1, 1, 3, 3, { rounding: true }); // circle crop

// ❌ WRONG — never hardcode the mime type:
//   slide.addImage({ data: `image/png;base64,${b64}`, ... })
//   // This breaks when the server returns a JPEG — use addImage() wrapper instead


async function buildDeck() {
  const pptx = new PptxGenJS();

  // — Master theme colors
  pptx.defineLayout({ name: 'CUSTOM', width: 13.33, height: 7.5 });
  pptx.layout = 'CUSTOM';

  const DARK   = '1E2761';
  const ACCENT = '2E86AB';
  const LIGHT  = 'F0F4F8';
  const WHITE  = 'FFFFFF';

  // — Title slide with full background color
  const s1 = pptx.addSlide();
  s1.background = { color: DARK };
  s1.addShape(pptx.ShapeType.rect, { x: 0, y: 5.8, w: 13.33, h: 0.08, fill: { color: ACCENT }, line: { type: 'none' } });
  s1.addText('Your Presentation Title', {
    x: 0.8, y: 2.2, w: 11, h: 1.4,
    fontSize: 40, bold: true, color: WHITE, align: 'left', fontFace: 'Calibri'
  });
  s1.addText('Subtitle • April 2025', {
    x: 0.8, y: 3.8, w: 8, h: 0.6,
    fontSize: 16, color: 'CADCFC', align: 'left'
  });

  // — Content slide with image from URL
  const s2 = pptx.addSlide();
  s2.background = { color: LIGHT };
  s2.addText('Key Findings', { x: 0.5, y: 0.3, w: 12, h: 0.7, fontSize: 26, bold: true, color: DARK });
  // Accent bar under title
  s2.addShape(pptx.ShapeType.rect, { x: 0.5, y: 1.0, w: 1.5, h: 0.06, fill: { color: ACCENT }, line: { type: 'none' } });
  // Bullet content
  s2.addText([
    { text: 'Revenue grew 22% YoY', options: { bullet: true, fontSize: 14 } },
    { text: 'Customer NPS reached 72', options: { bullet: true, fontSize: 14 } },
    { text: 'Launched 3 new product lines', options: { bullet: true, fontSize: 14 } },
  ], { x: 0.5, y: 1.3, w: 6.5, h: 4.5, color: '1F2937', valign: 'top' });

  // — Insert image from URL
  // const imgB64 = await downloadImage('https://example.com/chart.png');
  // s2.addImage({ data: `image/png;base64,${imgB64}`, x: 7.2, y: 1.2, w: 5.5, h: 4.0 });

  // — Stats callout slide
  const s3 = pptx.addSlide();
  s3.background = { color: WHITE };
  s3.addText('By The Numbers', { x: 0.5, y: 0.3, w: 12, h: 0.7, fontSize: 26, bold: true, color: DARK });
  const stats = [
    { val: '$4.2M', label: 'ARR' },
    { val: '1,200', label: 'Customers' },
    { val: '99.9%', label: 'Uptime' },
  ];
  stats.forEach((s, i) => {
    const x = 0.5 + i * 4.2;
    s3.addShape(pptx.ShapeType.roundRect, { x, y: 1.5, w: 3.8, h: 2.5, fill: { color: LIGHT }, line: { color: 'D1D5DB', pt: 1 }, rectRadius: 0.15 });
    s3.addText(s.val, { x, y: 1.9, w: 3.8, h: 1.0, fontSize: 36, bold: true, color: ACCENT, align: 'center' });
    s3.addText(s.label, { x, y: 2.9, w: 3.8, h: 0.5, fontSize: 14, color: MUTED, align: 'center' });
  });

  // — Save
  await pptx.writeFile({ fileName: 'output.pptx' });
  const size = fs.statSync('output.pptx').size;
  console.log(`✅ output.pptx: ${size} bytes`);
  if (size < 5000) throw new Error('File too small — generation failed');
}

buildDeck().catch(e => { console.error('❌', e.message); process.exit(1); });
```

### Background Images
```javascript
// From local file:
slide.background = { path: './bg.jpg' };

// From URL (download first):
const b64 = await downloadImage('https://example.com/bg.jpg');
slide.background = { data: `image/jpeg;base64,${b64}` };
```

### Charts
```javascript
// Bar chart
slide.addChart(pptx.ChartType.bar, [
  { name: 'Revenue', labels: ['Q1','Q2','Q3','Q4'], values: [1.2, 1.5, 1.8, 2.1] }
], { x: 1, y: 1, w: 10, h: 5, chartColors: ['2E86AB'], showValue: true, barGrouping: 'clustered' });

// Line chart (trend)
slide.addChart(pptx.ChartType.line, [
  { name: 'Growth %', labels: ['2020','2021','2022','2023','2024'], values: [5, 12, 18, 24, 31] }
], { x: 0.5, y: 1.2, w: 12, h: 5.5, chartColors: ['2ECC71'], lineDataSymbol: 'dot', lineSize: 3, showValue: true });

// Pie chart
slide.addChart(pptx.ChartType.pie, [
  { name: 'Market Share', labels: ['Us','Competitor A','Competitor B','Other'], values: [42, 28, 18, 12] }
], { x: 2, y: 1, w: 9, h: 6, chartColors: ['1E3A5F','2E86AB','CADCFC','6B7280'], showPercent: true, showLegend: true, legendPos: 'r' });

// Doughnut
slide.addChart(pptx.ChartType.doughnut, [
  { name: 'Completion', labels: ['Done','Remaining'], values: [78, 22] }
], { x: 3, y: 1.5, w: 7, h: 5, chartColors: ['2E86AB','E2E8F0'], holeSize: 65 });
```

---

## Advanced: Company Logos, Image Frames & Brand Intelligence

### Fetching Real Company Logos

**Never use placeholder squares for logos.** Always fetch real logos using this priority chain:

```javascript
const https = require('https');
const http  = require('http');

// Priority chain for logo fetching — try each until one works
async function fetchCompanyLogo(companyDomain) {
  const sources = [
    // 1. Clearbit Logo API (best quality, no auth needed)
    `https://logo.clearbit.com/${companyDomain}`,
    // 2. Google Favicon (fallback, lower res)
    `https://www.google.com/s2/favicons?domain=${companyDomain}&sz=128`,
    // 3. DuckDuckGo icon service
    `https://icons.duckduckgo.com/ip3/${companyDomain}.ico`,
  ];

  for (const url of sources) {
    try {
      const b64 = await downloadImage(url);
      if (b64 && b64.length > 500) return { b64, url };
    } catch (e) { /* try next */ }
  }
  return null; // no logo found
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { timeout: 5000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
      res.on('error', reject);
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

// Usage — fetch logo for a company by their domain:
const tesla  = await fetchCompanyLogo('tesla.com');
const nvidia = await fetchCompanyLogo('nvidia.com');
const apple  = await fetchCompanyLogo('apple.com');

// Insert logo into slide:
if (tesla) {
  slide.addImage({
    data: `image/png;base64,${tesla.b64}`,
    x: 0.3, y: 0.15, w: 1.4, h: 0.55,
  });
}
```

### Styled Image Frames

**Never drop raw images directly.** Always wrap them in a styled frame with border, shadow simulation, or rounded container:

```javascript
// Frame Style 1: Rounded card with shadow simulation
function addFramedImage(slide, imgResult, x, y, w, h, opts = {}) {
  if (!imgResult) return;
  const { borderColor = '2E86AB', shadowColor = 'CBD5E1', radius = 0.15 } = opts;

  // Shadow layer (offset slightly, darker fill)
  slide.addShape(pptx.ShapeType.roundRect, {
    x: x + 0.06, y: y + 0.06, w, h,
    fill: { color: shadowColor }, line: { type: 'none' }, rectRadius: radius
  });

  // White mat background
  slide.addShape(pptx.ShapeType.roundRect, {
    x, y, w, h,
    fill: { color: 'FFFFFF' }, line: { color: borderColor, pt: 1.5 }, rectRadius: radius
  });

  // Image clipped inside frame (slight inset)
  const pad = 0.08;
  addImage(slide, imgResult, x + pad, y + pad, w - pad*2, h - pad*2, { rounding: true });
}

// Frame Style 2: Dark overlay frame (premium look)
function addDarkFramedImage(slide, imgResult, x, y, w, h, caption = '') {
  if (!imgResult) return;
  addImage(slide, imgResult, x, y, w, h);
  // Gradient overlay at bottom
  slide.addShape(pptx.ShapeType.rect, {
    x, y: y + h * 0.65, w, h: h * 0.35,
    fill: { type: 'solid', color: '000000', alpha: 55 }, line: { type: 'none' }
  });
  // Caption text over image
  if (caption) {
    slide.addText(caption, {
      x, y: y + h - 0.45, w, h: 0.4,
      fontSize: 10, color: 'FFFFFF', align: 'center', bold: true
    });
  }
}

// Frame Style 3: Circle crop (for headshots / team photos)
function addCirclePhoto(slide, imgResult, cx, cy, diameter) {
  if (!imgResult) return;
  // Outline ring
  slide.addShape(pptx.ShapeType.ellipse, {
    x: cx - 0.04, y: cy - 0.04, w: diameter + 0.08, h: diameter + 0.08,
    fill: { color: '2E86AB' }, line: { type: 'none' }
  });
  // White inner ring
  slide.addShape(pptx.ShapeType.ellipse, {
    x: cx - 0.02, y: cy - 0.02, w: diameter + 0.04, h: diameter + 0.04,
    fill: { color: 'FFFFFF' }, line: { type: 'none' }
  });
  // Photo
  addImage(slide, imgResult, cx, cy, diameter, diameter, { rounding: true });
}
```

### Company Profile Slide System

**Full pattern for "About This Company" or "Competitor Analysis" slides:**

```javascript
async function buildCompanyProfileSlide(pptx, company) {
  // company = { name, domain, description, founded, hq, ceo, revenue, employees, ticker }
  const slide = pptx.addSlide();
  slide.background = { color: '0F1923' }; // near-black background

  // — Fetch logo
  const logo = await fetchCompanyLogo(company.domain);

  // — Left panel: dark card
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.3, y: 0.6, w: 3.8, h: 6.3,
    fill: { color: '1A2535' }, line: { color: '2E86AB', pt: 1 }, rectRadius: 0.15
  });

  // — Logo in frame
  if (logo) {
    slide.addShape(pptx.ShapeType.roundRect, {
      x: 0.75, y: 0.85, w: 2.9, h: 1.6,
      fill: { color: 'FFFFFF' }, line: { type: 'none' }, rectRadius: 0.1
    });
    addImage(slide, logo, 0.9, 0.95, 2.6, 1.4);
  } else {
    // Fallback: company initial letter
    slide.addShape(pptx.ShapeType.roundRect, { x: 0.75, y: 0.85, w: 2.9, h: 1.6, fill: { color: '2E86AB' }, line: { type: 'none' }, rectRadius: 0.1 });
    slide.addText(company.name[0], { x: 0.75, y: 0.85, w: 2.9, h: 1.6, fontSize: 60, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle' });
  }

  // — Company name + ticker
  slide.addText(company.name, { x: 0.4, y: 2.65, w: 3.6, h: 0.55, fontSize: 18, bold: true, color: 'FFFFFF', align: 'center' });
  if (company.ticker) {
    slide.addShape(pptx.ShapeType.roundRect, { x: 1.3, y: 3.25, w: 1.6, h: 0.38, fill: { color: '2E86AB' }, line: { type: 'none' }, rectRadius: 0.08 });
    slide.addText(`$${company.ticker}`, { x: 1.3, y: 3.25, w: 1.6, h: 0.38, fontSize: 13, bold: true, color: 'FFFFFF', align: 'center' });
  }

  // — Key facts in left panel
  const facts = [
    { icon: '🏛', label: 'Founded', val: company.founded },
    { icon: '📍', label: 'HQ', val: company.hq },
    { icon: '👤', label: 'CEO', val: company.ceo },
    { icon: '👥', label: 'Employees', val: company.employees },
  ];
  facts.forEach((f, i) => {
    const y = 3.85 + i * 0.68;
    slide.addText(f.icon, { x: 0.45, y, w: 0.45, h: 0.55, fontSize: 14, align: 'center' });
    slide.addText(f.label, { x: 0.9, y, w: 1.2, h: 0.28, fontSize: 9, color: '94A3B8', bold: true });
    slide.addText(f.val, { x: 0.9, y: y + 0.26, w: 2.9, h: 0.28, fontSize: 10, color: 'E2E8F0' });
  });

  // — Right panel: main content
  slide.addText(company.name, { x: 4.4, y: 0.3, w: 8.5, h: 0.75, fontSize: 30, bold: true, color: 'FFFFFF' });
  slide.addShape(pptx.ShapeType.rect, { x: 4.4, y: 1.1, w: 8.5, h: 0.04, fill: { color: '2E86AB' }, line: { type: 'none' } });

  // Description
  slide.addText(company.description, { x: 4.4, y: 1.3, w: 8.5, h: 1.5, fontSize: 12, color: 'CBD5E1', wrap: true });

  // Revenue metric card
  slide.addShape(pptx.ShapeType.roundRect, { x: 4.4, y: 3.0, w: 2.5, h: 1.5, fill: { color: '1E3A5F' }, line: { color: '2E86AB', pt: 1 }, rectRadius: 0.1 });
  slide.addText('Annual Revenue', { x: 4.4, y: 3.05, w: 2.5, h: 0.38, fontSize: 9, color: '94A3B8', align: 'center', bold: true });
  slide.addText(company.revenue, { x: 4.4, y: 3.4, w: 2.5, h: 0.7, fontSize: 26, bold: true, color: '2ECC71', align: 'center' });

  // Source footnote
  slide.addText(`Source: Public filings, ${new Date().getFullYear()}`, {
    x: 4.4, y: 7.1, w: 8.5, h: 0.3, fontSize: 8, color: '475569', align: 'right'
  });

  return slide;
}

// Usage:
await buildCompanyProfileSlide(pptx, {
  name: 'NVIDIA Corporation',
  domain: 'nvidia.com',
  ticker: 'NVDA',
  description: 'NVIDIA designs and markets graphics processing units (GPUs) and system-on-chip units for the gaming, professional visualization, data center, and automotive markets.',
  founded: '1993',
  hq: 'Santa Clara, CA',
  ceo: 'Jensen Huang',
  revenue: '$60.9B',
  employees: '29,600',
});
```

### Logo Grid Slide (Competitor / Partner Overview)

```javascript
async function buildLogoGridSlide(pptx, title, companies) {
  // companies = [{ name, domain }, ...]
  const slide = pptx.addSlide();
  slide.background = { color: 'F8FAFC' };
  slide.addText(title, { x: 0.5, y: 0.2, w: 12, h: 0.7, fontSize: 26, bold: true, color: '1E3A5F' });
  slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 0.92, w: 12, h: 0.04, fill: { color: '2E86AB' }, line: { type: 'none' } });

  const cols = 4;
  const cardW = 2.8, cardH = 1.8, padX = 0.45, padY = 1.1;

  for (let i = 0; i < companies.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = padX + col * (cardW + 0.25);
    const y = padY + row * (cardH + 0.3);

    // Card shell
    slide.addShape(pptx.ShapeType.roundRect, {
      x, y, w: cardW, h: cardH,
      fill: { color: 'FFFFFF' }, line: { color: 'E2E8F0', pt: 1 }, rectRadius: 0.12
    });

    // Try logo
    const logo = await fetchCompanyLogo(companies[i].domain);
    if (logo) {
      addImage(slide, logo, x+0.3, y+0.2, cardW-0.6, cardH-0.75);
    } else {
      // Fallback: initial letter in accent circle
      slide.addShape(pptx.ShapeType.ellipse, { x: x+0.85, y: y+0.2, w: 1.1, h: 1.1, fill: { color: '2E86AB' }, line: { type: 'none' } });
      slide.addText(companies[i].name[0], { x: x+0.85, y: y+0.2, w: 1.1, h: 1.1, fontSize: 28, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle' });
    }
    // Company name below logo
    slide.addText(companies[i].name, { x, y: y + cardH - 0.5, w: cardW, h: 0.42, fontSize: 10, bold: true, color: '1E3A5F', align: 'center' });
  }
}

// Usage:
await buildLogoGridSlide(pptx, 'The Competitive Landscape', [
  { name: 'NVIDIA', domain: 'nvidia.com' },
  { name: 'AMD', domain: 'amd.com' },
  { name: 'Intel', domain: 'intel.com' },
  { name: 'Qualcomm', domain: 'qualcomm.com' },
  { name: 'Apple', domain: 'apple.com' },
  { name: 'Google', domain: 'google.com' },
  { name: 'Microsoft', domain: 'microsoft.com' },
  { name: 'Meta', domain: 'meta.com' },
]);
```

### Icon Badge System

```javascript
// Colored icon badge — use instead of bullet points for feature lists
function addIconBadge(slide, x, y, icon, headline, subtext, color = '2E86AB') {
  // Colored circle background
  slide.addShape(pptx.ShapeType.ellipse, {
    x, y, w: 0.6, h: 0.6,
    fill: { color }, line: { type: 'none' }
  });
  // Icon (emoji or text)
  slide.addText(icon, { x, y, w: 0.6, h: 0.6, fontSize: 18, align: 'center', valign: 'middle' });
  // Headline
  slide.addText(headline, { x: x + 0.7, y: y + 0.0, w: 4.5, h: 0.3, fontSize: 13, bold: true, color: '1E3A5F' });
  // Subtext
  slide.addText(subtext, { x: x + 0.7, y: y + 0.28, w: 4.5, h: 0.28, fontSize: 10, color: '6B7280' });
}

// Usage — creates a feature list:
const features = [
  { icon: '⚡', title: '10x Faster Processing', sub: 'H100 delivers 4 PFLOPS of AI compute', color: 'F59E0B' },
  { icon: '🔒', title: 'Enterprise Security', sub: 'SOC 2 Type II certified, end-to-end encryption', color: '10B981' },
  { icon: '🌐', title: 'Global Infrastructure', sub: '32 data centers across 18 countries', color: '6366F1' },
];
features.forEach((f, i) => addIconBadge(slide, 0.5, 1.5 + i * 0.85, f.icon, f.title, f.sub, f.color));
```

---


## Slide Layout Code Library

**Use these exact patterns.** Each one produces a professional, visually rich slide. Adapt colors and content — do NOT simplify them into plain text + bullets.

### Layout 1: Left Color Sidebar (best for content slides)
```javascript
// Dark colored left sidebar anchors the design — no plain white
slide.addShape(pptx.ShapeType.rect, {
  x: 0, y: 0, w: 0.18, h: 7.5,
  fill: { color: DARK }, line: { type: 'none' }
});
slide.addText(slideNumber.toString(), {
  x: 0, y: 6.8, w: 0.18, h: 0.5,
  fontSize: 9, color: WHITE, align: 'center', bold: true
});
// Title on light background
slide.background = { color: 'F8FAFC' };
slide.addText('Your Insight Title Here', {
  x: 0.4, y: 0.3, w: 12.5, h: 0.8,
  fontSize: 28, bold: true, color: DARK, fontFace: 'Calibri'
});
// Accent dot instead of line
slide.addShape(pptx.ShapeType.ellipse, {
  x: 0.4, y: 1.1, w: 0.12, h: 0.12,
  fill: { color: ACCENT }, line: { type: 'none' }
});
```

### Layout 2: Stat Cards (3-up metric callout)
```javascript
slide.background = { color: DARK };
slide.addText('Key Metrics', { x: 0.5, y: 0.25, w: 12, h: 0.7, fontSize: 26, bold: true, color: WHITE });

const metrics = [
  { val: '$4.2B', label: 'Annual Revenue', delta: '+31% YoY' },
  { val: '89%',   label: 'Gross Margin',   delta: '+4pts' },
  { val: '2.1M',  label: 'Active Users',   delta: '+18% QoQ' },
];
metrics.forEach((m, i) => {
  const x = 0.4 + i * 4.35;
  // Card background
  slide.addShape(pptx.ShapeType.roundRect, {
    x, y: 1.3, w: 4.0, h: 3.2,
    fill: { color: '1E3A5F' }, line: { color: ACCENT, pt: 1.5 }, rectRadius: 0.12
  });
  // Big number
  slide.addText(m.val, { x, y: 1.7, w: 4.0, h: 1.2, fontSize: 44, bold: true, color: WHITE, align: 'center' });
  // Label
  slide.addText(m.label, { x, y: 2.85, w: 4.0, h: 0.45, fontSize: 13, color: 'CADCFC', align: 'center' });
  // Delta pill
  slide.addShape(pptx.ShapeType.roundRect, { x: x+1.2, y: 3.35, w: 1.6, h: 0.38, fill: { color: '145A32' }, line: { type:'none' }, rectRadius: 0.1 });
  slide.addText(m.delta, { x: x+1.2, y: 3.35, w: 1.6, h: 0.38, fontSize: 11, color: '2ECC71', align: 'center', bold: true });
});
```

### Layout 3: Two-Column (text + image)
```javascript
slide.background = { color: 'F8FAFC' };
// Left: content
slide.addText('Title: Insight Here', { x: 0.5, y: 0.3, w: 6.0, h: 0.75, fontSize: 26, bold: true, color: DARK });
slide.addText([
  { text: 'First key finding — specific fact with number', options: { bullet: { code: '25CF', color: ACCENT }, fontSize: 14, breakLine: true } },
  { text: 'Second finding — what it means for the business', options: { bullet: { code: '25CF', color: ACCENT }, fontSize: 14, breakLine: true } },
  { text: 'Third finding — the implication or action', options: { bullet: { code: '25CF', color: ACCENT }, fontSize: 14, breakLine: true } },
], { x: 0.5, y: 1.3, w: 6.0, h: 4.5, color: '374151', valign: 'top' });
// Right: image
// const imgResult = await downloadImage('https://upload.wikimedia.org/wikipedia/commons/e/e8/Ten_logo.png');
// addImage(slide, imgResult, 7.0, 0.5, 5.8, 6.5, { rounding: true });
// Fallback colored panel:
slide.addShape(pptx.ShapeType.roundRect, { x: 7.0, y: 0.5, w: 5.8, h: 6.5, fill: { color: ACCENT }, line: { type: 'none' }, rectRadius: 0.2 });
```

### Layout 4: Timeline (process / history)
```javascript
slide.background = { color: DARK };
slide.addText('Evolution Timeline', { x: 0.5, y: 0.25, w: 12, h: 0.7, fontSize: 26, bold: true, color: WHITE });
// Horizontal spine
slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 3.6, w: 12.3, h: 0.06, fill: { color: ACCENT }, line: { type:'none' } });

const events = [
  { year: '2021', text: 'Founded in stealth mode' },
  { year: '2022', text: 'Series A — $12M raised' },
  { year: '2023', text: 'Product launch — 50k users' },
  { year: '2024', text: 'Series B — $40M, 500k users' },
];
events.forEach((e, i) => {
  const x = 0.5 + i * 3.15;
  // Dot on spine
  slide.addShape(pptx.ShapeType.ellipse, { x: x+0.8, y: 3.42, w: 0.36, h: 0.36, fill: { color: WHITE }, line: { color: ACCENT, pt: 2 } });
  // Year label
  slide.addText(e.year, { x, y: 3.85, w: 2.8, h: 0.45, fontSize: 16, bold: true, color: ACCENT, align: 'center' });
  // Event text (alternating above/below)
  const textY = i % 2 === 0 ? 1.8 : 4.5;
  slide.addText(e.text, { x, y: textY, w: 2.8, h: 1.2, fontSize: 12, color: 'CADCFC', align: 'center', wrap: true });
  // Connector line
  slide.addShape(pptx.ShapeType.rect, { x: x+0.95, y: i%2===0 ? 2.9 : 3.6, w: 0.04, h: 0.7, fill: { color: 'CADCFC' }, line: { type:'none' } });
});
```

### Layout 5: Comparison Table (before/after, A vs B)
```javascript
slide.background = { color: 'F8FAFC' };
slide.addText('How We Compare', { x: 0.5, y: 0.25, w: 12, h: 0.7, fontSize: 26, bold: true, color: DARK });
const rows = [
  ['Feature', 'Old Approach', 'Our Solution'],
  ['Speed', '3-5 days', '< 2 hours ✓'],
  ['Cost', '$50k setup', 'Pay-as-you-go ✓'],
  ['Accuracy', '72%', '98.4% ✓'],
  ['Integration', 'Manual ETL', 'One-click API ✓'],
];
const colW = [3.5, 3.9, 5.4];
const rowH = 0.75;
rows.forEach((row, r) => {
  row.forEach((cell, c) => {
    const x = 0.4 + colW.slice(0, c).reduce((a,b) => a+b, 0);
    const isHeader = r === 0;
    const isOurs = c === 2;
    slide.addShape(pptx.ShapeType.rect, {
      x, y: 1.1 + r * rowH, w: colW[c], h: rowH,
      fill: { color: isHeader ? DARK : isOurs ? '145A32' : r%2===0 ? 'FFFFFF' : 'F1F5F9' },
      line: { color: 'D1D5DB', pt: 0.5 }
    });
    slide.addText(cell, {
      x, y: 1.1 + r * rowH, w: colW[c], h: rowH,
      fontSize: isHeader ? 13 : 12, bold: isHeader || isOurs,
      color: isHeader || isOurs ? WHITE : DARK, align: 'center', valign: 'middle'
    });
  });
});
```

### Layout 6: Full-Bleed Dark Title Slide
```javascript
// This is the ONLY acceptable title slide pattern
slide.background = { color: DARK };
// Bottom accent stripe
slide.addShape(pptx.ShapeType.rect, { x: 0, y: 6.9, w: 13.33, h: 0.6, fill: { color: ACCENT }, line: { type:'none' } });
// Large decorative circle (top right)
slide.addShape(pptx.ShapeType.ellipse, { x: 9.5, y: -1.5, w: 5, h: 5, fill: { color: '1E3A5F' }, line: { type:'none' } });
// Title
slide.addText('Your Presentation Title', {
  x: 0.7, y: 2.0, w: 8.5, h: 1.6,
  fontSize: 44, bold: true, color: WHITE, fontFace: 'Calibri', wrap: true
});
// Subtitle
slide.addText('Subtitle · Presenter Name · April 2025', {
  x: 0.7, y: 3.8, w: 8.5, h: 0.6,
  fontSize: 16, color: 'CADCFC'
});
// Logo area placeholder
slide.addText('[Logo]', { x: 11.5, y: 6.9, w: 1.5, h: 0.6, fontSize: 10, color: WHITE, align: 'right' });
```

---

### Layout 7: Split-Screen Half Dark / Half Light
```javascript
// Left half: dark with white text — Right half: light with dark text
// Best for: "Problem vs Solution", "Before vs After", "Risk vs Opportunity"
slide.background = { color: 'F8FAFC' };

// Dark left half
slide.addShape(pptx.ShapeType.rect, {
  x: 0, y: 0, w: 6.5, h: 7.5,
  fill: { color: DARK }, line: { type: 'none' }
});
// Left: section label
slide.addText('THE CHALLENGE', {
  x: 0.5, y: 0.5, w: 5.5, h: 0.4,
  fontSize: 10, bold: true, color: ACCENT, charSpacing: 3
});
// Left: main title
slide.addText('Market fragmentation is killing margins', {
  x: 0.5, y: 1.0, w: 5.5, h: 1.8,
  fontSize: 22, bold: true, color: WHITE, wrap: true
});
// Left: supporting points
slide.addText([
  { text: '42% of enterprise deals stall in procurement', options: { bullet: { code: '25BA', color: ACCENT }, fontSize: 12, breakLine: true, color: 'CBD5E1' } },
  { text: '6-month average sales cycle drains pipeline', options: { bullet: { code: '25BA', color: ACCENT }, fontSize: 12, breakLine: true, color: 'CBD5E1' } },
  { text: 'No single vendor owns end-to-end workflow', options: { bullet: { code: '25BA', color: ACCENT }, fontSize: 12, breakLine: true, color: 'CBD5E1' } },
], { x: 0.5, y: 3.0, w: 5.5, h: 3.0, valign: 'top' });

// Divider accent line in the middle
slide.addShape(pptx.ShapeType.rect, {
  x: 6.45, y: 1.5, w: 0.1, h: 4.5,
  fill: { color: ACCENT }, line: { type: 'none' }
});

// Right: section label
slide.addText('OUR SOLUTION', {
  x: 6.8, y: 0.5, w: 6.0, h: 0.4,
  fontSize: 10, bold: true, color: ACCENT, charSpacing: 3
});
// Right: main title
slide.addText('One platform that owns the full sales cycle', {
  x: 6.8, y: 1.0, w: 6.0, h: 1.8,
  fontSize: 22, bold: true, color: DARK, wrap: true
});
// Right: outcome cards
[
  { stat: '3x', label: 'Faster deal close' },
  { stat: '67%', label: 'Higher win rate' },
  { stat: '$2.1M', label: 'Average ACV' },
].forEach((c, i) => {
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 6.8 + i * 2.1, y: 3.2, w: 1.9, h: 2.0,
    fill: { color: 'EBF5FB' }, line: { color: ACCENT, pt: 1 }, rectRadius: 0.1
  });
  slide.addText(c.stat, { x: 6.8+i*2.1, y: 3.5, w: 1.9, h: 0.85, fontSize: 30, bold: true, color: ACCENT, align: 'center' });
  slide.addText(c.label, { x: 6.8+i*2.1, y: 4.35, w: 1.9, h: 0.6, fontSize: 10, color: '374151', align: 'center', wrap: true });
});
```

### Layout 8: Full-Bleed Image with Text Overlay
```javascript
// Best for: opening impact slide, location/product shots, emotional moments
// Always use a real image — fetch it first with downloadImage()

// Background image
const imgResult = await downloadImage('https://images.unsplash.com/photo-1518770660439-4636190af475?w=1400');
if (imgResult) slide.background = { data: `image/${imgResult.mime};base64,${imgResult.b64}` };

// Dark gradient overlay (bottom two-thirds)
slide.addShape(pptx.ShapeType.rect, {
  x: 0, y: 2.5, w: 13.33, h: 5.0,
  fill: { color: '000000', alpha: 65 }, line: { type: 'none' }
});
// Very subtle top gradient
slide.addShape(pptx.ShapeType.rect, {
  x: 0, y: 0, w: 13.33, h: 2.8,
  fill: { color: '000000', alpha: 20 }, line: { type: 'none' }
});

// Eyebrow label
slide.addText('DEEP TECH · 2025', {
  x: 0.7, y: 3.8, w: 12, h: 0.45,
  fontSize: 11, bold: true, color: ACCENT, charSpacing: 4
});
// Big statement title
slide.addText('The Infrastructure Powering the Next Era of AI', {
  x: 0.7, y: 4.3, w: 10, h: 1.8,
  fontSize: 36, bold: true, color: 'FFFFFF', wrap: true
});
// Subtitle
slide.addText('An in-depth analysis of compute, memory, and interconnect trends', {
  x: 0.7, y: 6.15, w: 9, h: 0.55,
  fontSize: 14, color: 'CBD5E1'
});
// Photo credit bottom right
slide.addText('📷 Unsplash', {
  x: 11.5, y: 7.1, w: 1.7, h: 0.3,
  fontSize: 7, color: '94A3B8', align: 'right'
});
```

### Layout 9: Agenda / Table of Contents
```javascript
// Best for: slide 2 of any deck — shows structure and builds credibility
slide.background = { color: DARK };

// Left accent bar
slide.addShape(pptx.ShapeType.rect, {
  x: 0, y: 0, w: 0.22, h: 7.5,
  fill: { color: ACCENT }, line: { type: 'none' }
});

slide.addText('AGENDA', {
  x: 0.5, y: 0.3, w: 6, h: 0.55,
  fontSize: 11, bold: true, color: ACCENT, charSpacing: 4
});
slide.addText("Today's Presentation", {
  x: 0.5, y: 0.85, w: 12.5, h: 0.7,
  fontSize: 28, bold: true, color: WHITE
});

const sections = [
  { num: '01', title: 'Market Overview',        sub: 'Industry size, trends, and key dynamics' },
  { num: '02', title: 'The Problem',             sub: 'What is broken and why it matters now' },
  { num: '03', title: 'Our Solution',            sub: 'Product overview and key differentiators' },
  { num: '04', title: 'Traction & Validation',  sub: 'Customers, revenue, and growth proof' },
  { num: '05', title: 'Team',                    sub: 'Who we are and why we will win' },
  { num: '06', title: 'The Ask',                 sub: 'Funding, use of proceeds, milestones' },
];

sections.forEach((s, i) => {
  const y = 1.85 + i * 0.88;
  const isEven = i % 2 === 0;
  // Row background
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.4, y, w: 12.5, h: 0.78,
    fill: { color: isEven ? '1A2535' : '0F1923' }, line: { type: 'none' }
  });
  // Number badge
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.55, y: y + 0.12, w: 0.55, h: 0.55,
    fill: { color: ACCENT }, line: { type: 'none' }, rectRadius: 0.06
  });
  slide.addText(s.num, { x: 0.55, y: y+0.12, w: 0.55, h: 0.55, fontSize: 13, bold: true, color: WHITE, align: 'center', valign: 'middle' });
  // Section title
  slide.addText(s.title, { x: 1.25, y: y+0.08, w: 7, h: 0.34, fontSize: 14, bold: true, color: WHITE });
  // Subtitle
  slide.addText(s.sub, { x: 1.25, y: y+0.4, w: 7, h: 0.28, fontSize: 10, color: '94A3B8' });
  // Arrow indicator
  slide.addText('›', { x: 12.5, y: y+0.12, w: 0.5, h: 0.55, fontSize: 20, color: ACCENT, align: 'right', valign: 'middle' });
});
```

### Layout 10: Testimonial / Customer Quote
```javascript
// Best for: social proof, customer success, analyst endorsements
slide.background = { color: '0F1923' };

// Large decorative quote mark
slide.addText('\u201C', {
  x: 0.3, y: 0.1, w: 2, h: 2.5,
  fontSize: 180, bold: true, color: '1E3A5F', align: 'left'
});

// The quote itself
slide.addText('Since deploying this platform, our close rate improved by 3x in under 90 days. We went from a 6-month sales cycle to closing enterprise deals in 8 weeks. This is the infrastructure layer we always needed.', {
  x: 1.2, y: 1.2, w: 10.5, h: 3.0,
  fontSize: 22, italics: true, color: 'E2E8F0', wrap: true, lineSpacingMultiple: 1.4
});

// Closing quote mark
slide.addText('\u201D', {
  x: 11.0, y: 3.2, w: 2, h: 2,
  fontSize: 120, bold: true, color: '1E3A5F', align: 'right'
});

// Attribution divider
slide.addShape(pptx.ShapeType.rect, {
  x: 1.2, y: 4.5, w: 1.5, h: 0.05,
  fill: { color: ACCENT }, line: { type: 'none' }
});

// Person name + title + company (with optional circle photo)
slide.addText('Sarah Chen', { x: 1.2, y: 4.7, w: 8, h: 0.42, fontSize: 16, bold: true, color: WHITE });
slide.addText('Chief Revenue Officer · Acme Enterprise (Series C, $120M raised)', {
  x: 1.2, y: 5.12, w: 9, h: 0.38, fontSize: 12, color: '94A3B8'
});

// Star rating
slide.addText('★★★★★', { x: 1.2, y: 5.6, w: 3, h: 0.4, fontSize: 18, color: 'F59E0B' });
```

### Layout 11: Numbered Process Steps (Horizontal)
```javascript
// Best for: how it works, onboarding flow, implementation roadmap
slide.background = { color: 'F8FAFC' };
slide.addText('How It Works', { x: 0.5, y: 0.2, w: 12, h: 0.7, fontSize: 26, bold: true, color: DARK });

const steps = [
  { n: '1', icon: '🔍', title: 'Discover',   body: 'Connect your CRM and data sources in one click. We ingest everything.' },
  { n: '2', icon: '🤖', title: 'Analyze',    body: 'AI maps your pipeline gaps, churn signals, and top opportunities.' },
  { n: '3', icon: '⚡', title: 'Act',        body: 'One-click playbooks push tasks directly to Slack, Salesforce, or email.' },
  { n: '4', icon: '📈', title: 'Scale',      body: 'As you grow, the model improves. Every rep gets smarter recommendations.' },
];

// Connecting line between steps
slide.addShape(pptx.ShapeType.rect, {
  x: 1.1, y: 2.65, w: 10.8, h: 0.05,
  fill: { color: 'CBD5E1' }, line: { type: 'none' }
});

steps.forEach((s, i) => {
  const x = 0.4 + i * 3.25;
  // Step number circle
  slide.addShape(pptx.ShapeType.ellipse, {
    x: x + 0.7, y: 2.25, w: 0.9, h: 0.9,
    fill: { color: ACCENT }, line: { color: 'F8FAFC', pt: 3 }
  });
  slide.addText(s.n, { x: x+0.7, y: 2.25, w: 0.9, h: 0.9, fontSize: 16, bold: true, color: WHITE, align: 'center', valign: 'middle' });

  // Card
  slide.addShape(pptx.ShapeType.roundRect, {
    x, y: 3.4, w: 3.0, h: 3.2,
    fill: { color: WHITE }, line: { color: 'E2E8F0', pt: 1 }, rectRadius: 0.12
  });
  // Icon
  slide.addText(s.icon, { x, y: 3.55, w: 3.0, h: 0.7, fontSize: 28, align: 'center' });
  // Title
  slide.addText(s.title, { x, y: 4.3, w: 3.0, h: 0.45, fontSize: 15, bold: true, color: DARK, align: 'center' });
  // Body
  slide.addText(s.body, { x: x+0.15, y: 4.8, w: 2.7, h: 1.6, fontSize: 10, color: '6B7280', wrap: true, align: 'center' });
});
```

### Layout 12: Team Grid (People Slide)
```javascript
// Best for: team intro slides, advisor boards, leadership pages
// Assumes you have headshot URLs or will use placeholder circles

async function buildTeamSlide(pptx, teamMembers) {
  // teamMembers = [{ name, title, photoUrl, linkedin? }, ...]
  const slide = pptx.addSlide();
  slide.background = { color: DARK };

  // Header
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 1.1, fill: { color: '0F1923' }, line: { type: 'none' } });
  slide.addText('The Team Behind the Vision', { x: 0.5, y: 0.2, w: 12, h: 0.7, fontSize: 26, bold: true, color: WHITE });

  const cols = Math.min(teamMembers.length, 4);
  const cardW = 13.0 / cols - 0.2;

  for (let i = 0; i < teamMembers.length; i++) {
    const m = teamMembers[i];
    const x = 0.15 + i * (cardW + 0.2);
    const y = 1.3;

    // Photo circle
    const dia = cardW * 0.55;
    const cx = x + (cardW - dia) / 2;
    if (m.photoUrl) {
      const imgResult = await downloadImage(m.photoUrl);
      addCirclePhoto(slide, imgResult, cx, y + 0.15, dia);
    } else {
      // Fallback: initials in accent circle
      slide.addShape(pptx.ShapeType.ellipse, { x: cx, y: y+0.15, w: dia, h: dia, fill: { color: ACCENT }, line: { type: 'none' } });
      const initials = m.name.split(' ').map(n => n[0]).join('');
      slide.addText(initials, { x: cx, y: y+0.15, w: dia, h: dia, fontSize: 28, bold: true, color: WHITE, align: 'center', valign: 'middle' });
    }

    // Name
    slide.addText(m.name, { x, y: y + dia + 0.3, w: cardW, h: 0.42, fontSize: 13, bold: true, color: WHITE, align: 'center' });
    // Title
    slide.addText(m.title, { x, y: y + dia + 0.7, w: cardW, h: 0.5, fontSize: 10, color: '94A3B8', align: 'center', wrap: true });
  }
  return slide;
}

// Usage:
await buildTeamSlide(pptx, [
  { name: 'Alex Rivera',  title: 'CEO & Co-Founder · Ex-Google', photoUrl: null },
  { name: 'Priya Sharma', title: 'CTO · Ex-Stripe, MIT PhD',      photoUrl: null },
  { name: 'James Park',   title: 'VP Sales · Ex-Salesforce',      photoUrl: null },
  { name: 'Leila Nouri',  title: 'Head of Design · Ex-Figma',     photoUrl: null },
]);
```

### Layout 13: Section Divider / Transition Slide
```javascript
// Use between major sections — creates visual rhythm and breathing room
// Keep minimal: section number + section name only

const sectionNum = '03';
const sectionTitle = 'Our Solution';
const sectionSub = 'How we solve the problem — and why now';

slide.background = { color: ACCENT };

// Giant section number (decorative, low opacity)
slide.addText(sectionNum, {
  x: -0.5, y: -0.8, w: 8, h: 6,
  fontSize: 300, bold: true, color: '1E3A5F',
  transparency: 70, align: 'left'
});

// Section label
slide.addText(`SECTION ${sectionNum}`, {
  x: 7.5, y: 2.5, w: 5.5, h: 0.45,
  fontSize: 10, bold: true, color: WHITE, charSpacing: 4, align: 'right'
});
// Section title
slide.addText(sectionTitle, {
  x: 7.5, y: 3.0, w: 5.5, h: 1.2,
  fontSize: 36, bold: true, color: WHITE, align: 'right'
});
// Subtitle
slide.addText(sectionSub, {
  x: 7.5, y: 4.25, w: 5.5, h: 0.5,
  fontSize: 13, color: 'CADCFC', align: 'right'
});
// Thin divider line
slide.addShape(pptx.ShapeType.rect, {
  x: 9.8, y: 2.45, w: 3.2, h: 0.04,
  fill: { color: WHITE }, line: { type: 'none' }
});
```

### Layout 14: Closing / CTA Slide
```javascript
// Always end with a clear call-to-action — what should the audience do next?
slide.background = { color: DARK };

// Centered content
slide.addText('Ready to Get Started?', {
  x: 1, y: 1.5, w: 11, h: 1.2,
  fontSize: 40, bold: true, color: WHITE, align: 'center'
});
slide.addText('Join 500+ enterprise teams already using our platform to close faster and grow smarter.', {
  x: 1.5, y: 2.85, w: 10, h: 0.9,
  fontSize: 16, color: 'CBD5E1', align: 'center', wrap: true
});

// CTA button (simulated with rounded rect)
slide.addShape(pptx.ShapeType.roundRect, {
  x: 4.4, y: 4.0, w: 4.5, h: 0.85,
  fill: { color: ACCENT }, line: { type: 'none' }, rectRadius: 0.12
});
slide.addText('Book a Demo →', {
  x: 4.4, y: 4.0, w: 4.5, h: 0.85,
  fontSize: 18, bold: true, color: WHITE, align: 'center', valign: 'middle'
});

// Contact details row
slide.addText('hello@company.com  ·  company.com  ·  @companyhandle', {
  x: 1, y: 5.2, w: 11, h: 0.4,
  fontSize: 12, color: '6B7280', align: 'center'
});

// Logo in footer
const logo = await fetchCompanyLogo('company.com');
if (logo) {
  addImage(slide, logo, 5.9, 6.6, 1.5, 0.6);
}

// Subtle bottom stripe
slide.addShape(pptx.ShapeType.rect, {
  x: 0, y: 7.3, w: 13.33, h: 0.2,
  fill: { color: ACCENT }, line: { type: 'none' }
});
```

### Layout 15: High-End Technical Architecture / Flowchart
```javascript
// AGI SUPER-PATTERN: Dynamically generate complex, colorful flowcharts directly in PPTX!
// Use 'classDef' to color-code nodes (e.g. database=orange, api=green, frontend=blue).
slide.background = { color: LIGHT_BG };

slide.addText('System Architecture & Data Flow', {
  x: 0.6, y: 0.4, w: 10, h: 0.6,
  fontSize: 28, bold: true, color: DARK
});

// COMPLEX VIBRANT MERMAID SYNTAX
const flowChart = \`
graph TD;
  classDef user fill:#3498db,stroke:#2980b9,color:#fff,stroke-width:2px;
  classDef backend fill:#2ecc71,stroke:#27ae60,color:#fff,stroke-width:2px;
  classDef db fill:#e67e22,stroke:#d35400,color:#fff,stroke-width:2px;
  classDef cloud fill:#9b59b6,stroke:#8e44ad,color:#fff,stroke-width:2px;

  U[User App]:::user -->|Auth| API(API Gateway):::backend;
  API -->|Route| LB{Load Balancer}:::cloud;
  LB --> S1[Service A]:::backend;
  LB --> S2[Service B]:::backend;
  S1 --> Cache[(Redis)]:::db;
  S2 --> RDS[(PostgreSQL)]:::db;
\`;

// Base64 encode and fetch
const base64Str = Buffer.from(flowChart).toString('base64');
const mermaidUrl = \`https://mermaid.ink/img/\${base64Str}?type=png&bgColor=white&theme=neutral\`;

const diagramObj = await downloadImage(mermaidUrl).catch(() => null);
if (diagramObj) {
  // Center the diagram in the content area
  addImage(slide, diagramObj, 1.0, 1.2, 11.3, 5.5);
}
```

---

## 🏆 Advanced Industry Use Cases

### 1. The Investor Pitch Deck
*   **Slide 1**: Hook + Logo.
*   **Slide 2**: The "Trillion Dollar" Problem (use Layout 8 with a powerful background image).
*   **Slide 3**: The Solution (use Layout 7 Split-Screen).
*   **Slide 4**: Traction / Growth (use Layout 2 Stat Cards with 3-4 huge numbers).
*   **Slide 5**: Market Map (use a Grid of Competitor Logos fetched via `fetchCompanyLogo`).

### 2. Technical System Specification
*   **Overview**: Executive summary of the stack.
*   **Deep Dive**: Use **Layout 15** (Architecture Diagram) to show how data moves.
*   **Security**: Use Layout 4 (Icon Grid) to list encryption, auth, and audit logs.

### 3. Professional Monthly Business Review (MBR)
*   **Executive Summary**: Use Layout 1 (Sidebar) for key takeaways.
*   **Financial Performance**: Table showing Actual vs Budget (use real numbers from research).
*   **Roadmap**: Use Layout 11 (Process Steps) to show Q1-Q4 progression.

---

### Layout Selection Guide

| Situation | Use Layout |
|-----------|-----------|
| Deck opening | 6 (Full-Bleed Dark Title) or 8 (Full-Bleed Image) |
| Second slide always | 9 (Agenda) |
| Metrics / numbers | 2 (Stat Cards) |
| Content explanation | 1 (Left Sidebar) or 3 (Two-Column) |
| Problem vs Solution | 7 (Split-Screen) |
| How it works | 11 (Process Steps) |
| Proof / customers | 10 (Testimonial) |
| Competition | Layout from Logo Grid section |
| Company deep-dive | Company Profile Slide system |
| Team intro | 12 (Team Grid) |
| Between sections | 13 (Section Divider) |
| Architecture / Process | 15 (Dynamic Flowchart) |
| Final slide | 14 (Closing CTA) |

---


**Don't create boring slides.** Plain bullets on a white background won't impress anyone. Consider ideas from this list for each slide.

### Before Starting

- **Pick a bold, content-informed color palette**: The palette should feel designed for THIS topic. If swapping your colors into a completely different presentation would still "work," you haven't made specific enough choices.
- **Dominance over equality**: One color should dominate (60-70% visual weight), with 1-2 supporting tones and one sharp accent. Never give all colors equal weight.
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a visual motif**: Pick ONE distinctive element and repeat it — rounded image frames, icons in colored circles, thick single-side borders. Carry it across every slide.

### Color Palettes

Choose colors that match your topic — don't default to generic blue. Use these palettes as inspiration:

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| **Midnight Executive** | `1E2761` (navy) | `CADCFC` (ice blue) | `FFFFFF` (white) |
| **Forest & Moss** | `2C5F2D` (forest) | `97BC62` (moss) | `F5F5F5` (cream) |
| **Coral Energy** | `F96167` (coral) | `F9E795` (gold) | `2F3C7E` (navy) |
| **Warm Terracotta** | `B85042` (terracotta) | `E7E8D1` (sand) | `A7BEAE` (sage) |
| **Ocean Gradient** | `065A82` (deep blue) | `1C7293` (teal) | `21295C` (midnight) |
| **Charcoal Minimal** | `36454F` (charcoal) | `F2F2F2` (off-white) | `212121` (black) |
| **Teal Trust** | `028090` (teal) | `00A896` (seafoam) | `02C39A` (mint) |
| **Berry & Cream** | `6D2E46` (berry) | `A26769` (dusty rose) | `ECE2D0` (cream) |
| **Sage Calm** | `84B59F` (sage) | `69A297` (eucalyptus) | `50808E` (slate) |
| **Cherry Bold** | `990011` (cherry) | `FCF6F5` (off-white) | `2F3C7E` (navy) |

### For Each Slide

**Every slide needs a visual element** — image, chart, icon, or shape. Text-only slides are forgettable.

**Layout options:**
- Two-column (text left, illustration on right)
- Icon + text rows (icon in colored circle, bold header, description below)
- 2x2 or 2x3 grid (image on one side, grid of content blocks on other)
- Half-bleed image (full left or right side) with content overlay

**Data display:**
- Large stat callouts (big numbers 60-72pt with small labels below)
- Comparison columns (before/after, pros/cons, side-by-side options)
- Timeline or process flow (numbered steps, arrows)

**Visual polish:**
- Icons in small colored circles next to section headers
- Italic accent text for key stats or taglines

### Typography

**Choose an interesting font pairing** — don't default to Arial. Pick a header font with personality and pair it with a clean body font.

| Header Font | Body Font |
|-------------|-----------|
| Georgia | Calibri |
| Arial Black | Arial |
| Calibri | Calibri Light |
| Cambria | Calibri |
| Trebuchet MS | Calibri |
| Impact | Arial |
| Palatino | Garamond |
| Consolas | Calibri |

| Element | Size |
|---------|------|
| Slide title | 36-44pt bold |
| Section header | 20-24pt bold |
| Body text | 14-16pt |
| Captions | 10-12pt muted |

### Spacing

- 0.5" minimum margins
- 0.3-0.5" between content blocks
- Leave breathing room—don't fill every inch

### Avoid (Common Mistakes)

- **Don't repeat the same layout** — vary columns, cards, and callouts across slides
- **Don't center body text** — left-align paragraphs and lists; center only titles
- **Don't skimp on size contrast** — titles need 36pt+ to stand out from 14-16pt body
- **Don't default to blue** — pick colors that reflect the specific topic
- **Don't mix spacing randomly** — choose 0.3" or 0.5" gaps and use consistently
- **Don't style one slide and leave the rest plain** — commit fully or keep it simple throughout
- **Don't create text-only slides** — add images, icons, charts, or visual elements; avoid plain title + bullets
- **Don't forget text box padding** — when aligning lines or shapes with text edges, set `margin: 0` on the text box or offset the shape to account for padding
- **Don't use low-contrast elements** — icons AND text need strong contrast against the background; avoid light text on light backgrounds or dark text on dark backgrounds
- **NEVER use accent lines under titles** — these are a hallmark of AI-generated slides; use whitespace or background color instead

---

## QA (Required)

**Assume there are problems. Your job is to find them.**

Your first render is almost never correct. Approach QA as a bug hunt, not a confirmation step. If you found zero issues on first inspection, you weren't looking hard enough.

### Content QA

```bash
python -m markitdown output.pptx
```

Check for missing content, typos, wrong order.

**When using templates, check for leftover placeholder text:**

```bash
python -m markitdown output.pptx | grep -iE "\bx{3,}\b|lorem|ipsum|\bTODO|\[insert|this.*(page|slide).*layout"
```

If grep returns results, fix them before declaring success.

### Visual QA

**⚠️ USE SUBAGENTS** — even for 2-3 slides. You've been staring at the code and will see what you expect, not what's there. Subagents have fresh eyes.

Convert slides to images (see [Converting to Images](#converting-to-images)), then use this prompt:

```
Visually inspect these slides. Assume there are issues — find them.

Look for:
- Overlapping elements (text through shapes, lines through words, stacked elements)
- Text overflow or cut off at edges/box boundaries
- Decorative lines positioned for single-line text but title wrapped to two lines
- Source citations or footers colliding with content above
- Elements too close (< 0.3" gaps) or cards/sections nearly touching
- Uneven gaps (large empty area in one place, cramped in another)
- Insufficient margin from slide edges (< 0.5")
- Columns or similar elements not aligned consistently
- Low-contrast text (e.g., light gray text on cream-colored background)
- Low-contrast icons (e.g., dark icons on dark backgrounds without a contrasting circle)
- Text boxes too narrow causing excessive wrapping
- Leftover placeholder content

For each slide, list issues or areas of concern, even if minor.

Read and analyze these images — run `ls -1 "$PWD"/slide-*.jpg` and use the exact absolute paths it prints:
1. <absolute-path>/slide-N.jpg — (Expected: [brief description])
2. <absolute-path>/slide-N.jpg — (Expected: [brief description])
...

Report ALL issues found, including minor ones.
```

### Verification Loop

1. Generate slides → Convert to images → Inspect
2. **List issues found** (if none found, look again more critically)
3. Fix issues
4. **Re-verify affected slides** — one fix often creates another problem
5. Repeat until a full pass reveals no new issues

**Do not declare success until you've completed at least one fix-and-verify cycle.**

---

## Converting to Images

Convert presentations to individual slide images for visual inspection:

```bash
python scripts/office/soffice.py --headless --convert-to pdf output.pptx
rm -f slide-*.jpg
pdftoppm -jpeg -r 150 output.pdf slide
ls -1 "$PWD"/slide-*.jpg
```

**Pass the absolute paths printed above directly to the view tool.** The `rm` clears stale images from prior runs. `pdftoppm` zero-pads based on page count: `slide-1.jpg` for decks under 10 pages, `slide-01.jpg` for 10-99, `slide-001.jpg` for 100+.

**After fixes, rerun all four commands above** — the PDF must be regenerated from the edited `.pptx` before `pdftoppm` can reflect your changes.

---

## Dependencies

- `pip install "markitdown[pptx]"` - text extraction
- `pip install Pillow` - thumbnail grids
- `npm install -g pptxgenjs` - creating from scratch
- LibreOffice (`soffice`) - PDF conversion (auto-configured for sandboxed environments via `scripts/office/soffice.py`)
- Poppler (`pdftoppm`) - PDF to images
