import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs/promises';
import fse from 'fs-extra';
import { resolveReadableWorkspacePath, resolveWorkspacePath } from '../../workspace/path_resolver';

/**
 * Markdown → HTML Converter
 * 
 * Converts markdown to styled HTML pages. Perfect for generating
 * preview-ready documentation, reports, and formatted output.
 */
export const markdownTool: ToolDefinition = {
  name: 'markdown_to_html',
  description: 'Convert Markdown text to a beautifully styled HTML page. Creates a self-contained HTML file with embedded CSS. Use for report previews, documentation, or sharing formatted content.',
  category: 'workspace',
  inputSchema: z.object({
    markdown: z.string().optional().describe('Markdown content to convert'),
    source_md_path: z.string().optional().describe('Optional markdown file path to render. Supports sandbox, Desktop, CWD, or absolute paths.'),
    title: z.string().optional().default('Document').describe('HTML page title'),
    filename: z.string().optional().describe('Output filename (default: auto-generated)'),
    theme: z.enum(['light', 'dark', 'github']).optional().default('dark').describe('Visual theme')
  }),
  outputSchema: z.object({ success: z.boolean(), filePath: z.string(), message: z.string() }),
  execute: async (input: any) => {
    const filename = input.filename || `doc_${Date.now()}.html`;
    const filePath = resolveWorkspacePath(filename);
    await fse.ensureDir(path.dirname(filePath));
    const theme = input.theme || 'dark';

    let markdown = input.markdown || '';
    if (input.source_md_path) {
      const sourcePath = resolveReadableWorkspacePath(input.source_md_path);
      markdown = await fs.readFile(sourcePath, 'utf-8');
    }
    if (!markdown.trim()) {
      throw new Error('No markdown provided. Use markdown or source_md_path.');
    }

    const html = renderMarkdown(markdown);

    const colors = {
      dark: { bg: '#0d1117', text: '#c9d1d9', heading: '#58a6ff', code: '#161b22', border: '#30363d', link: '#58a6ff' },
      light: { bg: '#ffffff', text: '#24292f', heading: '#0550ae', code: '#f6f8fa', border: '#d0d7de', link: '#0550ae' },
      github: { bg: '#0d1117', text: '#e6edf3', heading: '#79c0ff', code: '#161b22', border: '#30363d', link: '#79c0ff' }
    };
    const c = colors[theme as keyof typeof colors] || colors.dark;

    const fullHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title || 'Document')}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;background:${c.bg};color:${c.text};line-height:1.7;padding:2rem}
.container{max-width:860px;margin:0 auto}
h1,h2,h3{color:${c.heading};margin:1.5rem 0 0.8rem;font-weight:600}
h1{font-size:2rem;border-bottom:1px solid ${c.border};padding-bottom:0.5rem}
h2{font-size:1.5rem} h3{font-size:1.2rem}
p{margin:0.5rem 0} a{color:${c.link}}
code{background:${c.code};padding:2px 6px;border-radius:4px;font-size:0.9em;font-family:'Cascadia Code','Fira Code',monospace}
pre{background:${c.code};border:1px solid ${c.border};border-radius:8px;padding:1rem;overflow-x:auto;margin:1rem 0}
pre code{padding:0;background:none}
ul,ol{padding-left:1.5rem;margin:0.5rem 0}
li{margin:0.3rem 0} blockquote{border-left:3px solid ${c.heading};padding-left:1rem;margin:1rem 0;opacity:0.85}
hr{border:none;border-top:1px solid ${c.border};margin:1.5rem 0}
table{border-collapse:collapse;width:100%;margin:1rem 0}
th,td{border:1px solid ${c.border};padding:8px 12px;text-align:left}
th{background:${c.code}}
img{max-width:100%;height:auto;border-radius:6px;margin:1rem 0}
</style></head>
<body><div class="container">${html}</div></body></html>`;

    await fs.writeFile(filePath, fullHtml, 'utf-8');
    return { success: true, filePath, message: `📄 HTML generated: ${filename} (theme: ${theme})` };
  }
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(value: string): string {
  let text = escapeHtml(value);
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
  return text;
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let inCode = false;
  let codeLang = '';
  let codeLines: string[] = [];

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  const flushCode = () => {
    out.push(`<pre><code class="language-${escapeHtml(codeLang)}">${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    codeLang = '';
    codeLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (line.startsWith('```')) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        closeList();
        inCode = true;
        codeLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCode) {
      codeLines.push(raw);
      continue;
    }

    if (!line) {
      closeList();
      continue;
    }

    if (line.startsWith('|') && lines[i + 1] && isTableSeparator(lines[i + 1])) {
      closeList();
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      i--;
      out.push('<table><thead><tr>');
      out.push(headers.map(header => `<th>${renderInline(header)}</th>`).join(''));
      out.push('</tr></thead><tbody>');
      for (const row of rows) {
        out.push('<tr>');
        out.push(row.map(cell => `<td>${renderInline(cell)}</td>`).join(''));
        out.push('</tr>');
      }
      out.push('</tbody></table>');
      continue;
    }

    if (/^#{1,6}\s/.test(line)) {
      closeList();
      const level = Math.min(6, line.match(/^#+/)![0].length);
      out.push(`<h${level}>${renderInline(line.replace(/^#{1,6}\s*/, ''))}</h${level}>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (listType !== 'ul') {
        closeList();
        listType = 'ul';
        out.push('<ul>');
      }
      out.push(`<li>${renderInline(line.replace(/^[-*]\s+/, ''))}</li>`);
    } else if (/^\d+\.\s+/.test(line)) {
      if (listType !== 'ol') {
        closeList();
        listType = 'ol';
        out.push('<ol>');
      }
      out.push(`<li>${renderInline(line.replace(/^\d+\.\s+/, ''))}</li>`);
    } else if (line.startsWith('> ')) {
      closeList();
      out.push(`<blockquote>${renderInline(line.replace(/^>\s*/, ''))}</blockquote>`);
    } else if (line === '---' || line === '***') {
      closeList();
      out.push('<hr>');
    } else {
      closeList();
      out.push(`<p>${renderInline(line)}</p>`);
    }
  }

  if (inCode) flushCode();
  closeList();
  return out.join('\n');
}
