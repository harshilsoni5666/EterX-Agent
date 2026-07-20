import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import fs from 'fs-extra';
import { resolveReadableWorkspacePathForContext } from '../../workspace/path_resolver';

export const docxParserTool: ToolDefinition = {
  name: 'parse_docx',
  description: 'Extract raw text from a Word document (.docx) file located in the workspace.',
  category: 'research',
  inputSchema: z.object({
    filename: z.string().describe('The filename of the DOCX document in the workspace')
  }),
  outputSchema: z.object({
    textContext: z.string(),
    wordCount: z.number(),
    error: z.string().optional()
  }),
  execute: async (input: { filename: string }, context?: any) => {
    const safePath = resolveReadableWorkspacePathForContext(input.filename, context);
    console.log(`[Tool: parse_docx] Reading DOCX ${safePath}`);
    
    try {
      if (!await fs.pathExists(safePath)) {
        throw new Error(`File not found: ${input.filename}`);
      }
      
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(safePath);
      const xmlContent = zip.readAsText('word/document.xml', 'utf8');
      if (!xmlContent) {
        throw new Error('Could not find word/document.xml inside docx archive');
      }

      // Extract paragraphs (<w:p>) and text blocks (<w:t>)
      const paragraphRegex = /<w:p\b[^>]*>(.*?)<\/w:p>/g;
      const textRegex = /<w:t\b[^>]*>(.*?)<\/w:t>/g;
      
      const paragraphs: string[] = [];
      let match;
      while ((match = paragraphRegex.exec(xmlContent)) !== null) {
        const pContent = match[1];
        const textMatches = pContent.match(textRegex);
        if (textMatches) {
          const pText = textMatches
            .map(tMatch => tMatch.replace(/<[^>]+>/g, ''))
            .join('')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'");
          paragraphs.push(pText);
        }
      }

      const text = paragraphs.join('\n');
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      
      return { 
        textContext: text.substring(0, 100000), // Return a generous amount of text
        wordCount
      };
    } catch (error: any) {
      return { textContext: '', wordCount: 0, error: error.message };
    }
  }
};
