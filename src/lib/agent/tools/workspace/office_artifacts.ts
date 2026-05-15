import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs/promises';
import fse from 'fs-extra';
import pptxgen from 'pptxgenjs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveReadableWorkspacePath, resolveFinalArtifactPath } from '../../workspace/path_resolver';
import { docxGeneratorTool } from './docx';

const AdmZip = require('adm-zip');
const execFileAsync = promisify(execFile);

type ArtifactTheme = {
  bg: string;
  fg: string;
  accent: string;
  muted: string;
  stripe: string;
  font: string;
};

type SlideInput = {
  title?: string;
  subtitle?: string;
  body?: string;
  bullets?: string[];
  image?: string;
  notes?: string;
};

type SheetInput = {
  name?: string;
  rows: unknown[];
  note?: string;
  source?: string;
};

type WorkbookSheet = {
  name: string;
  rows: unknown[][];
  note?: string;
  source?: string;
};

type ChartSpec = {
  sheetIndex: number;
  chartIndex: number;
  sheetName: string;
  title: string;
  categoryCol: number;
  valueCols: number[];
  lastRow: number;
  anchorCol: number;
  anchorRow: number;
};

type CellComment = {
  ref: string;
  text: string;
};

const XLSX_WIDTH_SAMPLE_ROWS = 2500;
const XLSX_CHART_MAX_ROWS = 501;
const XLSX_CONDITIONAL_FORMAT_MAX_ROWS = 25000;

const THEMES: Record<string, ArtifactTheme> = {
  executive: { bg: 'F7F9FC', fg: '172033', accent: '17324D', muted: '667085', stripe: 'EEF3F7', font: 'Aptos' },
  modern: { bg: 'FFFFFF', fg: '111827', accent: '1E2761', muted: '6B7280', stripe: 'F6F8FA', font: 'Aptos' },
  classic: { bg: 'FFFDF8', fg: '252525', accent: '2B2B2B', muted: '666666', stripe: 'F7F4EF', font: 'Georgia' },
  minimal: { bg: 'FFFFFF', fg: '111827', accent: '111827', muted: '6B7280', stripe: 'F9FAFB', font: 'Arial' },
};

export const officeArtifactBuilderTool: ToolDefinition = {
  name: 'office_artifact_builder',
  description: `Create user-facing Office artifacts without writing custom terminal scripts.

Use this when the user asks for:
- DOCX / Word document
- PDF document
- PPTX / PowerPoint / slides
- XLSX / Excel / spreadsheet

Supports real visual assets:
- DOCX/PDF: Markdown image lines can reference real image URLs or local paths.
- PPTX: each slide may include image with a real URL or local path.
- XLSX: creates polished workbook sheets with frozen headers, filters, column sizing, formulas, styled tables, real embedded charts, and cell comments that explain summary metrics, data sources, field meanings, formulas, blanks, and large-data optimizations. Use custom spreadsheet tooling only for macros, pivots, or highly specialized models.

Workflow:
1. Draft long content in .workspaces/sandbox only when chunking is needed.
2. Call this tool with source_md_path or structured slides/sheets.
3. Share only the final output path from this tool unless the user asks for drafts/scripts. Final artifacts never remain in .workspaces/sandbox or .temp.`,
  category: 'workspace',
  inputSchema: z.object({
    format: z.enum(['docx', 'pdf', 'pptx', 'xlsx']).describe('Final consumer artifact format to create'),
    filepath: z.string().describe('Final output path or filename. Use Desktop/requested real path, not .workspaces/sandbox. Relative names save to Desktop.'),
    title: z.string().optional().describe('Artifact title'),
    audience: z.string().optional().describe('Intended reader/viewer audience, e.g. executives, investors, students, technical team'),
    purpose: z.string().optional().describe('Business or communication purpose, e.g. decision memo, pitch, analysis, training'),
    markdown: z.string().optional().describe('Markdown source content used to compose the Office artifact'),
    source_md_path: z.string().optional().describe('Markdown draft path to read from CWD, sandbox, temp, Desktop, or absolute path'),
    theme: z.enum(['executive', 'modern', 'classic', 'minimal']).optional().describe('Professional theme'),
    slides: z.array(z.object({
      title: z.string().optional(),
      subtitle: z.string().optional(),
      body: z.string().optional(),
      bullets: z.array(z.string()).optional(),
      image: z.string().optional().describe('Real image URL or local image path to embed in this slide'),
      notes: z.string().optional(),
    })).optional().describe('Structured slide content for PPTX'),
    sheets: z.string().optional().describe('Optional JSON array string of sheet objects, e.g. [{"name":"Data","rows":[["Metric","Value"],["Revenue",1200],["Growth","=B2/1000"]]}]'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string(),
    format: z.string(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input: any) => {
    try {
      const theme = THEMES[input.theme || 'modern'] || THEMES.modern;
      const markdown = await loadMarkdown(input.markdown, input.source_md_path);
      const parsedSheets = parseSheetsInput(input.sheets);
      const targetPath = resolveFinalArtifactPath(input.filepath, `.${input.format}`, input.title);
      await fse.ensureDir(path.dirname(targetPath));

      if (input.format === 'docx') {
        const result = await docxGeneratorTool.execute({
          filepath: targetPath,
          title: input.title || 'Document',
          markdown: markdown || sheetRowsToMarkdown(normalizeSheets(parsedSheets, '', input.title)[0].rows),
          theme: input.theme || 'modern',
        }, {});
        if (!result.success) throw new Error(result.error || 'DOCX generation failed');
      } else if (input.format === 'pdf') {
        const pdfText = markdown || sheetRowsToMarkdown(normalizeSheets(parsedSheets, '', input.title)[0].rows);
        const converted = await tryBuildPdfViaDocx(targetPath, input.title || 'Document', pdfText, input.theme || 'modern');
        if (!converted) await fs.writeFile(targetPath, buildPdf(input.title || 'Document', pdfText, theme));
      } else if (input.format === 'pptx') {
        const slides = normalizeSlides(input.slides, markdown, input.title, input.audience, input.purpose);
        await buildPptx(targetPath, input.title || 'Presentation', slides, theme);
      } else if (input.format === 'xlsx') {
        const sheets = normalizeSheets(parsedSheets, markdown, input.title);
        await buildXlsx(targetPath, sheets, theme);
      } else {
        throw new Error(`Unsupported office artifact format: ${input.format}`);
      }

      const stat = await fs.stat(targetPath);
      return {
        success: true,
        path: targetPath,
        format: input.format,
        message: `Created ${input.format.toUpperCase()} artifact at ${targetPath} (${(stat.size / 1024).toFixed(1)} KB).`,
      };
    } catch (error: any) {
      return {
        success: false,
        path: '',
        format: input.format || '',
        message: `Artifact generation failed: ${error.message}`,
        error: error.message,
      };
    }
  },
};

async function loadMarkdown(markdown?: string, sourcePath?: string): Promise<string> {
  if (sourcePath) {
    return fs.readFile(resolveReadableWorkspacePath(sourcePath), 'utf-8');
  }
  return markdown || '';
}

async function tryBuildPdfViaDocx(targetPath: string, title: string, markdown: string, theme: string): Promise<boolean> {
  const tempDir = path.resolve(process.cwd(), '.temp', 'office-artifacts');
  await fse.ensureDir(tempDir);
  const tempDocx = path.join(tempDir, `pdf_source_${Date.now()}.docx`);

  const docxResult = await docxGeneratorTool.execute({
    filepath: tempDocx,
    title,
    markdown,
    theme,
    internal_output: true,
  }, {});
  if (!docxResult.success) return false;

  const commands = [
    'soffice',
    'libreoffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ];

  for (const command of commands) {
    try {
      await execFileAsync(command, ['--headless', '--convert-to', 'pdf', '--outdir', path.dirname(targetPath), tempDocx], { timeout: 60000 });
      const convertedPath = path.join(path.dirname(targetPath), `${path.basename(tempDocx, '.docx')}.pdf`);
      if (await fse.pathExists(convertedPath)) {
        if (path.resolve(convertedPath).toLowerCase() !== path.resolve(targetPath).toLowerCase()) {
          await fse.move(convertedPath, targetPath, { overwrite: true });
        }
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

async function materializeImage(source: string): Promise<string | null> {
  try {
    if (!/^https?:\/\//i.test(source)) {
      return resolveReadableWorkspacePath(source);
    }

    const response = await fetch(source);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!/^image\//i.test(contentType)) throw new Error(`URL is not an image (${contentType || 'unknown content type'})`);
    const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
    const tempDir = path.resolve(process.cwd(), '.temp', 'office-artifacts', 'images');
    await fse.ensureDir(tempDir);
    const imagePath = path.join(tempDir, `image_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`);
    await fs.writeFile(imagePath, Buffer.from(await response.arrayBuffer()));
    return imagePath;
  } catch (error: any) {
    console.warn(`[office_artifact_builder] Could not materialize image "${source}": ${error.message}`);
    return null;
  }
}

function normalizeSlides(inputSlides?: SlideInput[], markdown = '', title = 'Presentation', audience?: string, purpose?: string): SlideInput[] {
  if (inputSlides?.length) return inputSlides;

  const chunks = markdown
    ? markdown.split(/\n(?=#{1,2}\s)|\n---+\n/g).map(chunk => chunk.trim()).filter(Boolean)
    : [];

  if (!chunks.length) {
    return [{ title, subtitle: [audience, purpose].filter(Boolean).join(' | ') || undefined, bullets: ['Summary', 'Key points', 'Next steps'] }];
  }

  return chunks.map((chunk, index) => {
    const lines = chunk.split('\n').map(line => line.trim()).filter(Boolean);
    const headingIndex = lines.findIndex(line => /^#{1,3}\s/.test(line));
    const slideTitle = headingIndex >= 0 ? lines[headingIndex].replace(/^#{1,3}\s*/, '') : (index === 0 ? title : `Section ${index + 1}`);
    const bullets = lines
      .filter(line => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
      .map(line => line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''))
      .slice(0, 6);
    const imageMatch = lines.join('\n').match(/!\[([^\]]*)\]\(([^)]+)\)/);
    const body = lines
      .filter(line => !/^#{1,3}\s/.test(line) && !/^[-*]\s+/.test(line) && !/^\d+\.\s+/.test(line) && !line.startsWith('|'))
      .filter(line => !/^!\[[^\]]*\]\([^)]+\)$/.test(line))
      .join(' ')
      .slice(0, 700);
    return { title: slideTitle, bullets: bullets.length ? bullets : undefined, body: body || undefined, image: imageMatch?.[2] };
  }).slice(0, 40);
}

async function buildPptx(filePath: string, title: string, slides: SlideInput[], theme: ArtifactTheme): Promise<void> {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'EterX AI';
  pptx.subject = title;
  pptx.title = title;
  pptx.company = 'EterX';
  pptx.theme = {
    headFontFace: theme.font,
    bodyFontFace: theme.font,
  };

  for (let index = 0; index < slides.length; index++) {
    const slideInput = slides[index];
    const slide = pptx.addSlide();
    slide.background = { color: theme.bg };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.18, fill: { color: theme.accent }, line: { color: theme.accent } });
    slide.addText(slideInput.title || `Slide ${index + 1}`, {
      x: 0.55, y: 0.45, w: 12.2, h: 0.55,
      fontFace: theme.font, fontSize: index === 0 ? 30 : 25, bold: true, color: theme.accent,
      margin: 0,
    });

    if (slideInput.subtitle) {
      slide.addText(slideInput.subtitle, {
        x: 0.58, y: 1.1, w: 11.8, h: 0.35,
        fontFace: theme.font, fontSize: 15, color: theme.muted,
      });
    }

    const bullets = slideInput.bullets?.filter(Boolean).slice(0, 8) || [];
    if (bullets.length) {
      slide.addText(bullets.map(item => `- ${item}`).join('\n'), {
        x: 0.85, y: slideInput.subtitle ? 1.65 : 1.35, w: slideInput.image ? 6.4 : 11.7, h: 4.55,
        fontFace: theme.font, fontSize: 17, color: theme.fg,
        breakLine: false, fit: 'shrink', paraSpaceAfter: 10,
      });
    } else if (slideInput.body) {
      slide.addText(slideInput.body, {
        x: 0.85, y: slideInput.subtitle ? 1.65 : 1.35, w: slideInput.image ? 6.4 : 11.5, h: 4.8,
        fontFace: theme.font, fontSize: 16, color: theme.fg,
        fit: 'shrink', breakLine: false,
      });
    }

    if (slideInput.image) {
      const imagePath = await materializeImage(slideInput.image);
      if (imagePath) {
        slide.addImage({ path: imagePath, x: 7.65, y: 1.45, w: 4.95, h: 3.7 });
      }
    }

    slide.addText(`${index + 1}`, {
      x: 12.25, y: 6.92, w: 0.5, h: 0.2,
      fontFace: theme.font, fontSize: 9, color: theme.muted, align: 'right',
    });

    if (slideInput.notes) slide.addNotes(slideInput.notes);
  }

  await pptx.writeFile({ fileName: filePath });
}

function normalizeSheets(inputSheets?: SheetInput[], markdown = '', title = 'Sheet1'): SheetInput[] {
  if (inputSheets?.length) return inputSheets.map((sheet, index) => ({
    name: sheet.name || `Sheet${index + 1}`,
    rows: Array.isArray(sheet.rows) ? sheet.rows : [],
    note: sheet.note,
    source: sheet.source,
  }));
  const tables = extractMarkdownTables(markdown);
  if (tables.length) {
    return tables.map((table, index) => ({
      name: tables.length === 1 ? (title || 'Data') : `Table ${index + 1}`,
      rows: table,
    }));
  }
  return [{ name: title || 'Sheet1', rows: [['Item', 'Value'], ['Generated', new Date().toISOString()]] }];
}

function parseSheetsInput(value: unknown): SheetInput[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value as SheetInput[];
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as SheetInput[] : undefined;
  } catch {
    return undefined;
  }
}

function extractMarkdownTables(markdown: string): string[][][] {
  const tables: string[][][] = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim().startsWith('|') && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[i + 1].trim())) {
      const rows = [splitTableRow(lines[i])];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      if (rows.length) tables.push(rows);
    }
  }
  return tables;
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function sheetRowsToMatrix(rows: unknown[]): unknown[][] {
  if (!rows.length) return [['Item', 'Value']];
  if (rows.every(row => typeof row === 'object' && row !== null && !Array.isArray(row))) {
    const headers = Array.from(new Set(rows.flatMap(row => Object.keys(row as Record<string, unknown>))));
    return [headers, ...rows.map(row => headers.map(header => (row as Record<string, unknown>)[header] ?? ''))];
  }
  return rows.map(row => Array.isArray(row) ? row : [row]);
}

function buildXlsx(filePath: string, sheets: SheetInput[], theme: ArtifactTheme): void {
  const zip = new AdmZip();
  const dataSheets = uniquifySheetNames(sheets.slice(0, 12).map((sheet, index) => ({
    name: sanitizeSheetName(sheet.name || `Sheet${index + 1}`),
    rows: sheetRowsToMatrix(sheet.rows),
    note: sheet.note,
    source: sheet.source,
  })));
  const safeSheets = withWorkbookSummary(dataSheets);
  const chartSpecs = buildChartSpecs(safeSheets);
  const sheetComments = new Map<number, CellComment[]>();
  safeSheets.forEach((sheet, index) => {
    const comments = buildSheetComments(sheet, index === 0);
    if (comments.length) sheetComments.set(index + 1, comments);
  });

  zip.addFile('[Content_Types].xml', Buffer.from(buildContentTypes(safeSheets.length, chartSpecs.length, Array.from(sheetComments.keys()))));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`));
  zip.addFile('xl/workbook.xml', Buffer.from(buildWorkbookXml(safeSheets)));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(buildWorkbookRels(safeSheets.length)));
  zip.addFile('xl/styles.xml', Buffer.from(buildStylesXml(theme)));

  safeSheets.forEach((sheet, index) => {
    const sheetNumber = index + 1;
    const chartSpec = chartSpecs.find(chart => chart.sheetIndex === index + 1);
    const comments = sheetComments.get(sheetNumber) || [];
    const drawingRelId = chartSpec ? 'rId1' : undefined;
    const commentsRelId = comments.length ? `rId${chartSpec ? 2 : 1}` : undefined;
    const vmlRelId = comments.length ? `rId${chartSpec ? 3 : 2}` : undefined;
    zip.addFile(`xl/worksheets/sheet${sheetNumber}.xml`, Buffer.from(buildWorksheetXml(sheet.rows, theme, index, chartSpec, drawingRelId, vmlRelId)));
    if (chartSpec || comments.length) {
      zip.addFile(`xl/worksheets/_rels/sheet${sheetNumber}.xml.rels`, Buffer.from(buildWorksheetRels(sheetNumber, chartSpec, commentsRelId, vmlRelId)));
    }
    if (chartSpec) {
      zip.addFile(`xl/drawings/drawing${chartSpec.chartIndex}.xml`, Buffer.from(buildDrawingXml(chartSpec)));
      zip.addFile(`xl/drawings/_rels/drawing${chartSpec.chartIndex}.xml.rels`, Buffer.from(buildDrawingRels(chartSpec)));
      zip.addFile(`xl/charts/chart${chartSpec.chartIndex}.xml`, Buffer.from(buildChartXml(chartSpec, theme)));
    }
    if (comments.length) {
      zip.addFile(`xl/comments${sheetNumber}.xml`, Buffer.from(buildCommentsXml(comments)));
      zip.addFile(`xl/drawings/vmlDrawing${sheetNumber}.vml`, Buffer.from(buildVmlCommentsXml(comments)));
    }
  });

  zip.writeZip(filePath);
}

function buildChartSpecs(sheets: WorkbookSheet[]): ChartSpec[] {
  const specs: ChartSpec[] = [];
  for (let sheetIndex = 1; sheetIndex <= sheets.length; sheetIndex++) {
    if (sheetIndex === 1) continue; // Summary sheet is already an overview.
    const sheet = sheets[sheetIndex - 1];
    const rows = sheet.rows;
    if (rows.length < 4 || (rows[0]?.length || 0) < 2) continue;

    const maxCols = rows[0].length;
    const chartSampleRows = rows.slice(1, XLSX_CHART_MAX_ROWS);
    let categoryCol = rows[0].findIndex((_, col) => chartSampleRows.some(row => !isNumericValue(row[col])));
    if (categoryCol < 0) categoryCol = 0;

    const valueCols: number[] = [];
    for (let col = 0; col < maxCols; col++) {
      if (col === categoryCol) continue;
      const values = chartSampleRows.map(row => row[col]);
      const numericCount = values.filter(isNumericValue).length;
      if (numericCount >= Math.max(2, Math.ceil(values.filter(v => v != null && String(v).trim() !== '').length * 0.5))) {
        valueCols.push(col);
      }
      if (valueCols.length >= 3) break;
    }
    if (!valueCols.length) continue;

    const chartIndex = specs.length + 1;
    specs.push({
      sheetIndex,
      chartIndex,
      sheetName: sheet.name,
      title: `${sheet.name} Overview`,
      categoryCol,
      valueCols,
      lastRow: Math.min(rows.length, XLSX_CHART_MAX_ROWS),
      anchorCol: maxCols <= 6 ? maxCols + 1 : 0,
      anchorRow: maxCols <= 6 ? 1 : rows.length + 2,
    });
  }
  return specs.slice(0, 6);
}

function buildSheetComments(sheet: WorkbookSheet, isSummary: boolean): CellComment[] {
  const comments = new Map<string, string[]>();
  const add = (ref: string, text: string) => {
    if (!comments.has(ref)) comments.set(ref, []);
    comments.get(ref)!.push(text);
  };

  const profile = profileSheet(sheet.rows);
  if (isSummary) {
    add('A1', 'Workbook overview. Use this sheet to check row counts, formula counts, blank-cell counts, and source coverage before trusting the workbook.');
  } else {
    const sourceNote = [sheet.source, sheet.note].filter(Boolean).join(' | ');
    add('A1', `Data sheet: ${Math.max(sheet.rows.length - 1, 0)} data rows, ${sheet.rows[0]?.length || 0} columns, ${profile.numericColumns} numeric columns, ${profile.formulaCells} formula cells.${sourceNote ? ` Source/note: ${sourceNote}` : ''}`);
    if (sheet.rows.length > XLSX_CONDITIONAL_FORMAT_MAX_ROWS) {
      add('A1', `Large data mode enabled: conditional color-scale formatting is skipped after ${XLSX_CONDITIONAL_FORMAT_MAX_ROWS.toLocaleString('en-US')} rows to keep generation fast and the workbook responsive. Filters, frozen headers, formulas, typed values, widths, and summary profiling remain active.`);
    }
    if (sheet.rows.length > XLSX_WIDTH_SAMPLE_ROWS) {
      add('A1', `Column widths are sampled from the first ${XLSX_WIDTH_SAMPLE_ROWS.toLocaleString('en-US')} rows for efficiency on high-volume sheets.`);
    }
  }

  const headers = sheet.rows[0] || [];
  const sampledRows = sheet.rows.length > XLSX_WIDTH_SAMPLE_ROWS ? sheet.rows.slice(1, XLSX_WIDTH_SAMPLE_ROWS + 1) : sheet.rows.slice(1);
  for (let col = 0; col < Math.min(headers.length, 30); col++) {
    const header = headers[col];
    const values = sampledRows.map(row => row[col]);
    const semantic = headerSemantic(header);
    const formulaCount = values.filter(value => typeof value === 'string' && value.trim().startsWith('=')).length;
    const numericCount = values.filter(isNumericValue).length;
    const blanks = values.filter(value => value == null || String(value).trim() === '').length;
    const parts = [`Column "${String(header || colName(col))}".`];
    if (sheet.rows.length > XLSX_WIDTH_SAMPLE_ROWS) parts.push(`Profiled from the first ${XLSX_WIDTH_SAMPLE_ROWS.toLocaleString('en-US')} data rows for fast generation.`);
    if (semantic === 'currency') parts.push('Formatted as a currency/value metric where possible.');
    if (semantic === 'percent') parts.push('Formatted as a percentage metric where possible.');
    if (numericCount > 0) parts.push(`${numericCount} numeric-looking values detected.`);
    if (formulaCount > 0) parts.push(`${formulaCount} formulas preserved as Excel formulas.`);
    if (blanks > 0) parts.push(`${blanks} blank cells detected; verify whether blanks are intentional.`);
    add(`${colName(col)}1`, parts.join(' '));
  }

  return Array.from(comments.entries()).map(([ref, lines]) => ({
    ref,
    text: lines.join('\n\n'),
  }));
}

function withWorkbookSummary(sheets: WorkbookSheet[]): WorkbookSheet[] {
  if (!sheets.length) return [{ name: 'Summary', rows: [['Metric', 'Value'], ['Sheets', 0], ['Generated', new Date().toISOString()]] }];
  const totalRows = sheets.reduce((sum, sheet) => sum + Math.max(sheet.rows.length - 1, 0), 0);
  const totalColumns = Math.max(...sheets.map(sheet => sheet.rows[0]?.length || 0), 0);
  const formulaCells = sheets.reduce((sum, sheet) => sum + countFormulaCells(sheet.rows), 0);
  const blankCells = sheets.reduce((sum, sheet) => sum + countBlankCells(sheet.rows), 0);
  const summaryRows: unknown[][] = [
    ['Workbook Summary', 'Value'],
    ['Sheets', sheets.length],
    ['Data Rows', totalRows],
    ['Max Columns', totalColumns],
    ['Formula Cells', formulaCells],
    ['Blank Cells', blankCells],
    ['Generated', new Date().toISOString()],
    [],
    ['Sheet', 'Rows', 'Columns', 'Numeric Columns', 'Formula Cells', 'Blank Cells', 'Source/Note'],
    ...sheets.map(sheet => {
      const profile = profileSheet(sheet.rows);
      return [
        sheet.name,
        Math.max(sheet.rows.length - 1, 0),
        sheet.rows[0]?.length || 0,
        profile.numericColumns,
        profile.formulaCells,
        profile.blankCells,
        [sheet.source, sheet.note].filter(Boolean).join(' | '),
      ];
    }),
  ];
  return [{ name: 'Summary', rows: summaryRows }, ...sheets];
}

function uniquifySheetNames(sheets: WorkbookSheet[]): WorkbookSheet[] {
  const seen = new Map<string, number>();
  return sheets.map((sheet) => {
    const base = sanitizeSheetName(sheet.name || 'Sheet');
    const key = base.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (count === 0) return { ...sheet, name: base };
    const suffix = ` ${count + 1}`;
    return { ...sheet, name: sanitizeSheetName(`${base.slice(0, 31 - suffix.length)}${suffix}`) };
  });
}

function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/*?:[\]]/g, ' ').trim() || 'Sheet';
  return cleaned.slice(0, 31);
}

function colName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function xmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function countFormulaCells(rows: unknown[][]): number {
  return rows.reduce((sum, row) => sum + row.filter(value => typeof value === 'string' && value.trim().startsWith('=')).length, 0);
}

function countBlankCells(rows: unknown[][]): number {
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (!maxCols) return 0;
  return rows.reduce((sum, row) => {
    let blanks = 0;
    for (let i = 0; i < maxCols; i++) {
      const value = row[i];
      if (value == null || String(value).trim() === '') blanks++;
    }
    return sum + blanks;
  }, 0);
}

function profileSheet(rows: unknown[][]): { numericColumns: number; formulaCells: number; blankCells: number } {
  const headers = rows[0] || [];
  const dataRows = rows.length > XLSX_WIDTH_SAMPLE_ROWS ? rows.slice(1, XLSX_WIDTH_SAMPLE_ROWS + 1) : rows.slice(1);
  let numericColumns = 0;
  for (let col = 0; col < headers.length; col++) {
    const values = dataRows.map(row => row[col]);
    if (values.filter(isNumericValue).length >= Math.max(1, Math.ceil(values.filter(v => v != null && String(v).trim() !== '').length * 0.5))) {
      numericColumns++;
    }
  }
  return {
    numericColumns,
    formulaCells: countFormulaCells(rows),
    blankCells: countBlankCells(rows),
  };
}

function inferCellKind(value: unknown): 'formula' | 'number' | 'date' | 'text' {
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string' && value.trim().startsWith('=')) return 'formula';
  return 'text';
}

function isNumericValue(value: unknown): boolean {
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  if (typeof value !== 'string') return false;
  const cleaned = value.trim().replace(/[$,%]/g, '').replace(/,/g, '');
  return cleaned !== '' && Number.isFinite(Number(cleaned));
}

function headerSemantic(header: unknown): 'percent' | 'currency' | 'number' | 'text' {
  const text = String(header || '').toLowerCase();
  if (/%|percent|percentage|margin|rate|yield|growth|change|roi|roe|roa/.test(text)) return 'percent';
  if (/revenue|sales|cost|expense|profit|price|amount|budget|income|cash|market cap|capex|opex|ebitda|arr|mrr|value|valuation/.test(text)) return 'currency';
  if (/count|units|quantity|qty|volume|score|rank|index|employees|customers|users/.test(text)) return 'number';
  return 'text';
}

function excelDateSerial(value: Date): number {
  const epoch = Date.UTC(1899, 11, 30);
  return (value.getTime() - epoch) / 86400000;
}

function coerceDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?$/.test(value.trim())) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function columnWidths(rows: unknown[][]): number[] {
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 1);
  const sampleRows = rows.length > XLSX_WIDTH_SAMPLE_ROWS ? rows.slice(0, XLSX_WIDTH_SAMPLE_ROWS) : rows;
  return Array.from({ length: maxCols }, (_, colIndex) => {
    const maxLen = sampleRows.reduce((max, row) => {
      const value = row[colIndex];
      return Math.max(max, String(value ?? '').length);
    }, 8);
    return Math.min(Math.max(maxLen + 3, 10), 42);
  });
}

function styleForCell(value: unknown, rowIndex: number, header?: unknown): string {
  if (rowIndex === 0) return ' s="1"';
  const semantic = headerSemantic(header);
  if (inferCellKind(value) === 'formula') {
    if (semantic === 'percent') return ' s="5"';
    if (semantic === 'currency') return ' s="6"';
    if (semantic === 'number') return ' s="3"';
  }
  if (inferCellKind(value) === 'number') {
    if (semantic === 'percent') return ' s="5"';
    if (semantic === 'currency') return ' s="6"';
    return ' s="3"';
  }
  const maybeDate = coerceDate(value);
  if (maybeDate) return ' s="4"';
  return rowIndex % 2 === 0 ? ' s="2"' : '';
}

function buildCellXml(value: unknown, cellRef: string, rowIndex: number, header?: unknown): string {
  const style = styleForCell(value, rowIndex, header);
  const maybeDate = coerceDate(value);
  if (maybeDate) {
    return `<c r="${cellRef}"${style}><v>${excelDateSerial(maybeDate)}</v></c>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${cellRef}"${style}><v>${value}</v></c>`;
  }
  if (typeof value === 'string' && value.trim().startsWith('=')) {
    return `<c r="${cellRef}"${style}><f>${xmlEscape(value.trim().slice(1))}</f><v>0</v></c>`;
  }
  return `<c r="${cellRef}" t="inlineStr"${style}><is><t>${xmlEscape(value)}</t></is></c>`;
}

function buildWorksheetXml(rows: unknown[][], theme: ArtifactTheme, sheetIndex: number, chartSpec?: ChartSpec, drawingRelId?: string, vmlRelId?: string): string {
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 1);
  const ref = `A1:${colName(maxCols - 1)}${Math.max(rows.length, 1)}`;
  const widths = columnWidths(rows);
  const cols = widths.map((width, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
  ).join('');
  let body = '';
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const cells = row.map((value, colIndex) => {
      const cellRef = `${colName(colIndex)}${rowIndex + 1}`;
      return buildCellXml(value, cellRef, rowIndex, rows[0]?.[colIndex]);
    }).join('');
    const height = rowIndex === 0 ? ' ht="24" customHeight="1"' : '';
    body += `<row r="${rowIndex + 1}"${height}>${cells}</row>`;
  }
  const autoFilter = rows.length > 1 && maxCols > 1 ? `<autoFilter ref="${ref}"/>` : '';
  const conditionalFormatting = buildConditionalFormatting(rows);

  const drawing = chartSpec && drawingRelId ? `<drawing r:id="${drawingRelId}"/>` : '';
  const legacyDrawing = vmlRelId ? `<legacyDrawing r:id="${vmlRelId}"/>` : '';
  const relNs = drawing || legacyDrawing ? ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${relNs}>
  <sheetPr><tabColor rgb="FF${sheetIndex === 0 ? theme.accent : theme.stripe}"/></sheetPr>
  <dimension ref="${ref}"/>
  <sheetViews><sheetView showGridLines="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${cols}</cols>
  <sheetData>${body}</sheetData>
  ${autoFilter}
  ${conditionalFormatting}
  <printOptions horizontalCentered="1"/>
  <pageMargins left="0.5" right="0.5" top="0.7" bottom="0.7" header="0.3" footer="0.3"/>
  <pageSetup paperSize="1" orientation="${maxCols > 8 ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>
  ${drawing}
  ${legacyDrawing}
</worksheet>`;
}

function buildConditionalFormatting(rows: unknown[][]): string {
  if (rows.length < 4) return '';
  if (rows.length > XLSX_CONDITIONAL_FORMAT_MAX_ROWS) return '';
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 1);
  let priority = 1;
  const blocks: string[] = [];
  for (let col = 0; col < maxCols; col++) {
    const values = rows.slice(1).map(row => row[col]);
    const numericCount = values.filter(isNumericValue).length;
    if (numericCount < 3) continue;
    const colRef = colName(col);
    const sqref = `${colRef}2:${colRef}${rows.length}`;
    blocks.push(`<conditionalFormatting sqref="${sqref}"><cfRule type="colorScale" priority="${priority++}"><colorScale><cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/><color rgb="FFF8696B"/><color rgb="FFFFEB84"/><color rgb="FF63BE7B"/></colorScale></cfRule></conditionalFormatting>`);
  }
  return blocks.join('');
}

function buildWorkbookXml(sheets: Array<{ name: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr date1904="0"/>
  <bookViews><workbookView activeTab="0"/></bookViews>
  <sheets>${sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>
  <calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/>
</workbook>`;
}

function buildWorkbookRels(count: number): string {
  const rels = Array.from({ length: count }, (_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}<Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function buildContentTypes(count: number, chartCount = 0, commentSheetNumbers: number[] = []): string {
  const sheets = Array.from({ length: count }, (_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('');
  const drawings = Array.from({ length: chartCount }, (_, index) =>
    `<Override PartName="/xl/drawings/drawing${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`
  ).join('');
  const charts = Array.from({ length: chartCount }, (_, index) =>
    `<Override PartName="/xl/charts/chart${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`
  ).join('');
  const comments = commentSheetNumbers.map(sheetNumber =>
    `<Override PartName="/xl/comments${sheetNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheets}
  ${drawings}
  ${charts}
  ${comments}
</Types>`;
}

function buildWorksheetRels(sheetNumber: number, chart?: ChartSpec, commentsRelId?: string, vmlRelId?: string): string {
  const rels: string[] = [];
  if (chart) {
    rels.push(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${chart.chartIndex}.xml"/>`);
  }
  if (commentsRelId) {
    rels.push(`<Relationship Id="${commentsRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments${sheetNumber}.xml"/>`);
  }
  if (vmlRelId) {
    rels.push(`<Relationship Id="${vmlRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing${sheetNumber}.vml"/>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rels.join('\n  ')}
</Relationships>`;
}

function buildCommentsXml(comments: CellComment[]): string {
  const entries = comments.map(comment =>
    `<comment ref="${xmlEscape(comment.ref)}" authorId="0" shapeId="0"><text><r><rPr><sz val="9"/><color indexed="81"/><rFont val="Calibri"/><family val="2"/></rPr><t>${xmlEscape(comment.text)}</t></r></text></comment>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <authors><author>EterX workbook intelligence</author></authors>
  <commentList>${entries}</commentList>
</comments>`;
}

function buildVmlCommentsXml(comments: CellComment[]): string {
  const shapes = comments.map((comment, index) => {
    const cell = cellRefToRowCol(comment.ref);
    const shapeId = 1025 + index;
    const anchorCol = Math.max(cell.col + 1, 1);
    const anchorRow = Math.max(cell.row, 0);
    return `<v:shape id="_x0000_s${shapeId}" type="#_x0000_t202" style="position:absolute;margin-left:80pt;margin-top:5pt;width:220pt;height:95pt;z-index:${index + 1};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto">
    <v:fill color2="#ffffe1"/>
    <v:shadow on="t" color="black" obscured="t"/>
    <v:path o:connecttype="none"/>
    <v:textbox style="mso-direction-alt:auto"><div style="text-align:left"/></v:textbox>
    <x:ClientData ObjectType="Note">
      <x:MoveWithCells/>
      <x:SizeWithCells/>
      <x:Anchor>${anchorCol}, 15, ${anchorRow}, 2, ${anchorCol + 3}, 15, ${anchorRow + 5}, 16</x:Anchor>
      <x:AutoFill>False</x:AutoFill>
      <x:Row>${cell.row}</x:Row>
      <x:Column>${cell.col}</x:Column>
    </x:ClientData>
  </v:shape>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
  <o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>
  <v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe">
    <v:stroke joinstyle="miter"/>
    <v:path gradientshapeok="t" o:connecttype="rect"/>
  </v:shapetype>
  ${shapes}
</xml>`;
}

function cellRefToRowCol(ref: string): { row: number; col: number } {
  const match = /^([A-Z]+)(\d+)$/i.exec(ref);
  if (!match) return { row: 0, col: 0 };
  const letters = match[1].toUpperCase();
  let col = 0;
  for (const char of letters) {
    col = col * 26 + (char.charCodeAt(0) - 64);
  }
  return { row: Math.max(Number(match[2]) - 1, 0), col: Math.max(col - 1, 0) };
}

function buildDrawingRels(chart: ChartSpec): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chart.chartIndex}.xml"/>
</Relationships>`;
}

function quoteSheetName(name: string): string {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function excelRange(sheetName: string, col: number, startRow: number, endRow: number): string {
  const colRef = colName(col);
  return `${quoteSheetName(sheetName)}!$${colRef}$${startRow}:$${colRef}$${endRow}`;
}

function buildDrawingXml(chart: ChartSpec): string {
  const fromCol = chart.anchorCol;
  const fromRow = chart.anchorRow;
  const toCol = fromCol + 8;
  const toRow = fromRow + 15;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>${fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>${toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr><xdr:cNvPr id="${chart.chartIndex + 1}" name="Chart ${chart.chartIndex}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`;
}

function buildChartXml(chart: ChartSpec, theme: ArtifactTheme): string {
  const categories = excelRange(chart.sheetName, chart.categoryCol, 2, chart.lastRow);
  const series = chart.valueCols.map((col, index) => {
    const titleCell = `${quoteSheetName(chart.sheetName)}!$${colName(col)}$1`;
    const values = excelRange(chart.sheetName, col, 2, chart.lastRow);
    return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:strRef><c:f>${xmlEscape(titleCell)}</c:f></c:strRef></c:tx><c:cat><c:strRef><c:f>${xmlEscape(categories)}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${xmlEscape(values)}</c:f></c:numRef></c:val></c:ser>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:date1904 val="0"/>
  <c:chart>
    <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1200" b="1"><a:solidFill><a:srgbClr val="${theme.accent}"/></a:solidFill></a:rPr><a:t>${xmlEscape(chart.title)}</a:t></a:r></a:p></c:rich></c:tx></c:title>
    <c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:axId val="123456"/><c:axId val="123457"/></c:barChart><c:catAx><c:axId val="123456"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="123457"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="123457"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="123456"/><c:crosses val="autoZero"/></c:valAx></c:plotArea>
    <c:legend><c:legendPos val="r"/><c:layout/></c:legend>
    <c:plotVisOnly val="1"/>
  </c:chart>
</c:chartSpace>`;
}

function buildStylesXml(theme: ArtifactTheme): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="$#,##0.00;($#,##0.00);-"/></numFmts>
  <fonts count="3"><font><sz val="11"/><name val="${xmlEscape(theme.font)}"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="${xmlEscape(theme.font)}"/></font><font><sz val="11"/><color rgb="FF111827"/><name val="${xmlEscape(theme.font)}"/></font></fonts>
  <fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF${theme.accent}"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF${theme.stripe}"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD0D5DD"/></left><right style="thin"><color rgb="FFD0D5DD"/></right><top style="thin"><color rgb="FFD0D5DD"/></top><bottom style="thin"><color rgb="FFD0D5DD"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"/><xf numFmtId="4" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="164" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="165" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="166" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function sheetRowsToMarkdown(rows: unknown[]): string {
  const matrix = sheetRowsToMatrix(rows);
  return matrix.map(row => row.map(value => String(value ?? '')).join(' | ')).join('\n');
}

function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, block => block.replace(/^```[^\n]*\n?/, '').replace(/```$/, ''))
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*]\s+/gm, '- ')
    .replace(/[*_`~]/g, '')
    .trim();
}

function buildPdf(title: string, markdown: string, theme: ArtifactTheme): Buffer {
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 54;
  const lineHeight = 15;
  const maxChars = 92;
  const text = markdownToPlainText(markdown);
  const lines = wrapText(`${title}\n\n${text}`, maxChars);
  const linesPerPage = Math.floor((pageHeight - margin * 2) / lineHeight);
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }
  if (!pages.length) pages.push([title]);

  const objects: string[] = [];
  const pageObjectIds: number[] = [];
  const contentObjectIds: number[] = [];

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  for (const pageLines of pages) {
    const content = buildPdfPageContent(pageLines, margin, pageHeight, lineHeight, theme);
    contentObjectIds.push(objects.length + 1);
    objects.push(`<< /Length ${Buffer.byteLength(content, 'utf-8')} >>\nstream\n${content}\nendstream`);
    pageObjectIds.push(objects.length + 1);
    objects.push('');
  }

  objects[1] = `<< /Type /Pages /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`;

  for (let i = 0; i < pageObjectIds.length; i++) {
    objects[pageObjectIds[i] - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectIds[i]} 0 R >>`;
  }

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'utf-8'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'utf-8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'utf-8');
}

function buildPdfPageContent(lines: string[], margin: number, pageHeight: number, lineHeight: number, theme: ArtifactTheme): string {
  const accent = hexToRgb(theme.accent);
  return lines.map((line, index) => {
    const y = pageHeight - margin - index * lineHeight;
    const isTitle = index === 0;
    const font = isTitle ? '/F2 16 Tf' : '/F1 10 Tf';
    const color = isTitle ? `${accent.r.toFixed(3)} ${accent.g.toFixed(3)} ${accent.b.toFixed(3)} rg` : '0.07 0.09 0.12 rg';
    return `BT ${font} ${color} ${margin} ${y} Td (${pdfEscape(line)}) Tj ET`;
  }).join('\n');
}

function wrapText(text: string, maxChars: number): string[] {
  const output: string[] = [];
  for (const paragraph of text.split(/\n/)) {
    if (!paragraph.trim()) {
      output.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > maxChars) {
        output.push(line);
        line = word;
      } else {
        line = `${line} ${word}`.trim();
      }
    }
    if (line) output.push(line);
  }
  return output;
}

function pdfEscape(value: string): string {
  return value.replace(/[\\()]/g, match => `\\${match}`).replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?');
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace(/^#/, '').padEnd(6, '0').slice(0, 6);
  return {
    r: parseInt(clean.slice(0, 2), 16) / 255,
    g: parseInt(clean.slice(2, 4), 16) / 255,
    b: parseInt(clean.slice(4, 6), 16) / 255,
  };
}
