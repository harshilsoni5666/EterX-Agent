import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, ShadingType, BorderStyle,
  Header, Footer, PageNumber, PageBreak, LevelFormat, ImageRun
} from 'docx';
import fs from 'fs/promises';
import fse from 'fs-extra';
import path from 'path';
import { resolveWorkspacePath, resolveFinalArtifactPath, getWorkspacePathCandidates, resolveReadableWorkspacePath } from '../../workspace/path_resolver';

/**
 * Rich DOCX Generator — creates professional Word documents with:
 * - Headings (H1/H2/H3)
 * - Tables with zebra-striped rows
 * - Bold/italic/underline text formatting
 * - Headers and footers with page numbers
 * - Page breaks between major sections
 * - Proper font sizing and spacing
 * - Saves to ANY user-specified path
 */

// Cleaned out the complex JSON schema. Now using a massive raw Markdown string to let the LLM breathe.

export const docxGeneratorTool: ToolDefinition = {
  name: 'docx_generator',
  description: `Generate a PROFESSIONAL Microsoft Word (.docx) document with rich formatting. Supports headings (H1-H3), paragraphs, tables, bullet lists, ordered lists, page breaks, and real images from Markdown image syntax.

IMPORTANT: When creating a document, you MUST provide DEEP, SUBSTANTIAL content:
- 1 page ≈ 500 words.
- Write MASSIVE, comprehensive paragraphs of real content, NOT placeholder text.
- Formatted purely in standard Markdown.
- Include tables with real data, not empty rows.
- Include real image URLs or local image paths as Markdown image lines when visuals help: ![Caption](https://...)

The file is saved to the EXACT path you specify — use full paths like C:\\Users\\AAYUSHI\\Desktop\\report.docx`,

  category: 'workspace',
  inputSchema: z.object({
    filepath: z.string().describe('Final DOCX path or filename. Use Desktop/requested real path, not .workspaces/sandbox. Relative names save to Desktop.'),
    title: z.string().describe('Document title shown on cover page'),
    subtitle: z.string().optional().describe('Optional subtitle or description'),
    author: z.string().optional().describe('Document author name'),
    theme: z.enum(['executive', 'modern', 'classic', 'minimal']).optional().describe('Professional visual style. Defaults to modern.'),
    fontFamily: z.string().optional().describe('Optional document font family, e.g. Aptos, Calibri, Georgia, Arial'),
    accentColor: z.string().optional().describe('Optional hex color without # for headings/table headers, e.g. 1E2761'),
    target_pages: z.number().optional().describe('Target number of pages. If set, content is validated to ensure minimum ~450 words per page. Use this to prevent thin documents.'),
    source_md_path: z.string().optional().describe('Path to a workspace .md draft file to compile into the DOCX. Use this if you drafted the report incrementally.'),
    markdown: z.string().optional().describe('The ENTIRE document content written as a massive Markdown string. Use if not using source_md_path.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string(),
    pages_estimate: z.number().optional(),
    error: z.string().optional()
  }),
  execute: async (input: any) => {
    console.log(`[Tool: docx_generator] Building professional document: ${ input.filepath }`);

    try {
      let markdown = input.markdown || '';

      if (input.source_md_path) {
         // Use the same read candidates as workspace_read_file: CWD,
         // sandbox/temp, Desktop, then the normal artifact path.
         const candidatePaths = getWorkspacePathCandidates(input.source_md_path);
         
          let loaded = false;
          for (const candidatePath of candidatePaths) {
            try {
              markdown = await fs.readFile(candidatePath, 'utf8');
             console.log(`[Tool: docx_generator] Loaded document content from: ${ candidatePath }`);
             loaded = true;
             break;
           } catch { /* try next */ }
         }
         
         if (!loaded) {
           console.warn(`[Tool: docx_generator] ⚠️ Could not find source draft at any of ${candidatePaths.length} paths. Using inline markdown if available.`);
           if (!markdown) {
             throw new Error(`Failed to read source draft "${input.source_md_path}" — tried ${candidatePaths.length} locations. Use 'markdown' parameter instead.`);
           }
         }
      }

      if (!markdown) {
         throw new Error('No content provided. You must provide either "markdown" string or a "source_md_path" pointing to a valid .md draft file.');
      }

      // ═══ CONTENT DEPTH VALIDATOR ═══
      // Ensures the content is ACTUALLY deep enough before building the document.
      // This forces the agent to use chunked writing for long documents.
      const wordCount = markdown.split(/\s+/).filter((w: string) => w.length > 0).length;
      const targetPages = input.target_pages || 0;
      const WORDS_PER_PAGE = 450; // Standard threshold
      
      if (targetPages > 0) {
        const minWords = targetPages * WORDS_PER_PAGE;
        if (wordCount < minWords * 0.35) { // Allow 65% tolerance — the agent has limited output per generation
          const shortfall = minWords - wordCount;
          console.warn(`[Tool: docx_generator] ⚠️ Content too thin: ${wordCount} words for ${targetPages} pages (need ~${minWords})`);
          return {
            success: false,
            path: '',
            error: `CONTENT TOO SHORT: You provided ~${wordCount} words but need ~${minWords} words for ${targetPages} pages. You are ${shortfall} words short. ` +
                   `Use workspace_write_file with append:true to build .workspaces/sandbox/draft.md incrementally, then call docx_generator with source_md_path=".workspaces/sandbox/draft.md" and a final Desktop filepath. ` +
                   `Each page needs ~${WORDS_PER_PAGE} words of REAL content (3-5 paragraphs of 4-6 sentences each).`
          };
        }
      } else if (wordCount < 200) {
        // Even without target_pages, reject extremely thin content
        console.warn(`[Tool: docx_generator] ⚠️ Very thin content: only ${wordCount} words`);
      }
      
      console.log(`[Tool: docx_generator] 📝 Content: ${wordCount} words${targetPages ? ` (target: ${targetPages} pages)` : ''}`);

      const docChildren: any[] = [];
      const themes: Record<string, { font: string; heading: string; heading2: string; heading3: string; quote: string; tableStripe: string; muted: string }> = {
        executive: { font: 'Aptos', heading: '17324D', heading2: '244B6B', heading3: '376B8F', quote: '6B4E16', tableStripe: 'F3F6F8', muted: '667085' },
        modern: { font: 'Aptos', heading: '1E2761', heading2: '2A367D', heading3: '4A55A2', quote: '555555', tableStripe: 'F6F8FA', muted: '666666' },
        classic: { font: 'Georgia', heading: '2B2B2B', heading2: '4A4A4A', heading3: '666666', quote: '555555', tableStripe: 'F7F4EF', muted: '666666' },
        minimal: { font: 'Arial', heading: '111827', heading2: '374151', heading3: '4B5563', quote: '4B5563', tableStripe: 'F9FAFB', muted: '6B7280' },
      };
      const selectedTheme = themes[input.theme || 'modern'] || themes.modern;
      const docFont = input.fontFamily || selectedTheme.font;
      const accentColor = String(input.accentColor || selectedTheme.heading).replace(/^#/, '').slice(0, 6);

      // ═══ COVER PAGE ═══
      docChildren.push(
        new Paragraph({ spacing: { before: 4000 } }), 
        new Paragraph({
          children: [new TextRun({ text: input.title, bold: true, size: 56, color: accentColor, font: docFont })],
          alignment: AlignmentType.CENTER,
        }),
      );

      if (input.subtitle) {
        docChildren.push(
          new Paragraph({ spacing: { before: 200 } }),
          new Paragraph({
            children: [new TextRun({ text: input.subtitle, size: 28, color: selectedTheme.muted, font: docFont, italics: true })],
            alignment: AlignmentType.CENTER,
          }),
        );
      }

      docChildren.push(
        new Paragraph({ spacing: { before: 600 } }),
        new Paragraph({
          children: [new TextRun({ text: `Date: ${ new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) }`, size: 22, color: selectedTheme.muted, font: docFont })],
          alignment: AlignmentType.CENTER,
        }),
        new Paragraph({ children: [new PageBreak()] }), 
      );

      if (input.author) {
        docChildren.splice(docChildren.length - 2, 0, new Paragraph({
          children: [new TextRun({ text: `Prepared by: ${ input.author }`, size: 22, color: selectedTheme.muted, font: docFont })],
          alignment: AlignmentType.CENTER,
        }));
      }

      // ═══ NATIVE MARKDOWN PARSER ═══
      let tableMode = false;
      let tableRows: TableRow[] = [];
      let isHeaderRow = false;

      // Inline Markdown Parser: parses **bold**, *italics*, and `code` into TextRuns
      const parseMarkdownInline = (text: string, overrideSize = 22, overrideColor?: string): TextRun[] => {
        const runs: TextRun[] = [];
        const pattern = /(\*\*.*?\*\*|\*.*?\*|`.*?`)/g;
        const tokens = text.split(pattern);

        for (const token of tokens) {
          if (!token) continue;
          if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
             runs.push(new TextRun({ text: token.slice(2, -2), bold: true, size: overrideSize, font: docFont, color: overrideColor }));
          } else if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
             runs.push(new TextRun({ text: token.slice(1, -1), italics: true, size: overrideSize, font: docFont, color: overrideColor }));
          } else if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
             runs.push(new TextRun({ text: token.slice(1, -1), font: 'Consolas', size: overrideSize - 2, color: 'D63384', shading: { type: ShadingType.CLEAR, fill: 'F8F9FA' } }));
          } else {
             runs.push(new TextRun({ text: token, size: overrideSize, font: docFont, color: overrideColor }));
          }
        }
        return runs;
      };

      const flushTable = () => {
        if (tableRows.length > 0) {
          docChildren.push(new Paragraph({ spacing: { before: 100 } }));
          docChildren.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: tableRows }));
          docChildren.push(new Paragraph({ spacing: { after: 200 } }));
          tableRows = [];
        }
        tableMode = false;
      };

      const buildImageParagraph = async (alt: string, source: string): Promise<Paragraph | null> => {
        try {
          let data: Buffer;
          if (/^https?:\/\//i.test(source)) {
            const response = await fetch(source);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const contentType = response.headers.get('content-type') || '';
            if (!/^image\//i.test(contentType)) throw new Error(`URL is not an image (${contentType || 'unknown content type'})`);
            data = Buffer.from(await response.arrayBuffer());
          } else {
            data = await fs.readFile(resolveReadableWorkspacePath(source));
          }

          return new Paragraph({
            children: [new ImageRun({
              data,
              transformation: { width: 520, height: 300 },
            } as any)],
            alignment: AlignmentType.CENTER,
            spacing: { before: 160, after: 160 },
          });
        } catch (error: any) {
          console.warn(`[Tool: docx_generator] Could not embed image "${source}": ${error.message}`);
          return new Paragraph({
            children: [new TextRun({ text: alt ? `[Image unavailable: ${alt}]` : `[Image unavailable: ${source}]`, italics: true, color: selectedTheme.muted, font: docFont })],
            spacing: { before: 100, after: 100 },
          });
        }
      };

      // Remove duplicate Title if the LLM typed it at the very top of its markdown
      let cleanMarkdown = markdown;
      const firstLineMatch = cleanMarkdown.split('\n')[0]?.trim();
      if (firstLineMatch && firstLineMatch.replace(/^#+\s*/, '').toLowerCase() === input.title.toLowerCase()) {
         cleanMarkdown = cleanMarkdown.split('\n').slice(1).join('\n');
      }

      const lines = cleanMarkdown.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Table Parsing
        if (line.startsWith('|') && line.endsWith('|')) {
          if (!tableMode) {
            tableMode = true;
            isHeaderRow = true;
          }

          if (line.match(/^\|[\s-:]+\|/)) {
            isHeaderRow = false;
            continue;
          }

          const cells = line.split('|').map((c: string) => c.trim()).filter((_: string, idx: number, arr: string[]) => idx > 0 && idx < arr.length - 1);
          
          tableRows.push(new TableRow({
            children: cells.map((cellText: string) => new TableCell({
              children: [new Paragraph({
                children: parseMarkdownInline(cellText, 20, isHeaderRow ? 'FFFFFF' : '000000'),
                alignment: isHeaderRow ? AlignmentType.CENTER : AlignmentType.LEFT,
              })],
              shading: isHeaderRow ? { fill: accentColor, type: ShadingType.CLEAR } : (tableRows.length % 2 === 0 ? { fill: selectedTheme.tableStripe, type: ShadingType.CLEAR } : undefined),
              margins: { top: 120, bottom: 120, left: 150, right: 150 }
            })),
          }));

          isHeaderRow = false;
          continue;
        } else if (tableMode) {
          flushTable();
        }

        const imageMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        if (imageMatch) {
          const imageParagraph = await buildImageParagraph(imageMatch[1], imageMatch[2]);
          if (imageParagraph) docChildren.push(imageParagraph);
          continue;
        }

        // Headings
        if (line.startsWith('# ')) {
          docChildren.push(new Paragraph({ children: parseMarkdownInline(line.replace(/^#+\s*/, ''), 32, accentColor), heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 120 } }));
        } else if (line.startsWith('## ')) {
          docChildren.push(new Paragraph({ children: parseMarkdownInline(line.replace(/^#+\s*/, ''), 28, selectedTheme.heading2), heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 100 } }));
        } else if (line.match(/^###+\s/)) { // Captures ###, ####, ##### 
          docChildren.push(new Paragraph({ children: parseMarkdownInline(line.replace(/^#+\s*/, ''), 24, selectedTheme.heading3), heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 80 } }));
        } 
        // Blockquotes
        else if (line.startsWith('> ')) {
          docChildren.push(new Paragraph({
             children: parseMarkdownInline(line.replace(/^>\s*/, ''), 22, selectedTheme.quote),
             indent: { left: 720 },
             border: { left: { color: accentColor, space: 15, style: BorderStyle.SINGLE, size: 18 } },
             spacing: { line: 360, after: 200 }
          }));
        }
        // Unordered Lists
        else if (line.startsWith('- ') || line.startsWith('* ')) {
          docChildren.push(new Paragraph({ children: parseMarkdownInline(line.slice(2)), bullet: { level: 0 }, spacing: { line: 320, after: 100 } }));
        }
        // Ordered Lists (e.g. 1. 2. 3.)
        else if (/^\d+\.\s/.test(line)) {
          const match = line.match(/^\d+\.\s(.*)/);
          docChildren.push(new Paragraph({ children: parseMarkdownInline(match ? match[1] : line), numbering: { reference: "default-numbering", level: 0 }, spacing: { line: 320, after: 100 } }));
        }
        // Page break
        else if (line === '---' || line === '***') {
          docChildren.push(new Paragraph({ children: [new PageBreak()] }));
        }
        // Standard Paragraph
        else {
          docChildren.push(new Paragraph({ children: parseMarkdownInline(line), spacing: { line: 360, after: 240 } }));
        }
      }

      flushTable();

      // ═══ BUILD DOCUMENT ═══
      const doc = new Document({
        title: input.title,
        creator: input.author || 'EterX AI',
        numbering: {
          config: [{
            reference: 'default-numbering',
            levels: [{
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 260 } } },
            }],
          }],
        },
        sections: [{
          properties: {
            page: {
              margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }, // 1 inch margins
              size: { width: 12240, height: 15840 }, // Letter size
            },
          },
          headers: {
            default: new Header({
              children: [new Paragraph({
                children: [new TextRun({ text: input.title, italics: true, size: 16, color: selectedTheme.muted, font: docFont })],
                alignment: AlignmentType.RIGHT,
              })],
            }),
          },
          footers: {
            default: new Footer({
              children: [new Paragraph({
                children: [
                  new TextRun({ text: 'Page ', size: 16, color: selectedTheme.muted, font: docFont }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: selectedTheme.muted, font: docFont }),
                ],
                alignment: AlignmentType.CENTER,
              })],
            }),
          },
          children: docChildren,
        }],
      });

      const buffer = await Packer.toBuffer(doc);

      const targetPath = input.internal_output
        ? ensureExtension(resolveWorkspacePath(input.filepath), '.docx')
        : resolveFinalArtifactPath(input.filepath, '.docx', input.title);

      // Ensure parent directory exists
      await fse.ensureDir(path.dirname(targetPath));
      await fs.writeFile(targetPath, buffer);

      // Estimate pages using word count (~500 words per page is standard)
      const totalWords = cleanMarkdown.split(/\s+/).filter((w: string) => w.length > 0).length;
      const estimatedPages = Math.max(1, Math.ceil(totalWords / 500) + 1); // +1 for cover page

      console.log(`[Tool: docx_generator] ✅ Created ${ estimatedPages }-page document (~${totalWords} words) at: ${ targetPath }`);
      return { success: true, path: targetPath, pages_estimate: estimatedPages, word_count: totalWords };
    } catch (error: any) {
      console.error(`[Tool: docx_generator] ❌ Error:`, error.message);
      return { success: false, path: '', error: error.message };
    }
  }
};

function ensureExtension(filePath: string, extension: string): string {
  return filePath.toLowerCase().endsWith(extension.toLowerCase()) ? filePath : `${filePath}${extension}`;
}
