import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import fs from 'fs-extra';
import pdfParse from 'pdf-parse';
import { resolveReadableWorkspacePath } from '../../workspace/path_resolver';

export const pdfParserTool: ToolDefinition = {
  name: 'parse_pdf',
  description: 'Extract raw text from a PDF file located in the workspace.',
  category: 'research',
  inputSchema: z.object({
    filename: z.string().describe('The filename of the PDF in the workspace')
  }),
  outputSchema: z.object({
    pageCount: z.number(),
    textContext: z.string(),
    error: z.string().optional()
  }),
  execute: async (input: { filename: string }) => {
    const safePath = resolveReadableWorkspacePath(input.filename);
    console.log(`[Tool: parse_pdf] Reading PDF ${safePath}`);
    
    try {
      if (!await fs.pathExists(safePath)) {
        throw new Error(`File not found: ${input.filename}`);
      }
      const dataBuffer = await fs.readFile(safePath);
      const data = await pdfParse(dataBuffer);
      
      return { 
        pageCount: data.numpages, 
        textContext: data.text.substring(0, 20000) // Keep context sane
      };
    } catch (error: any) {
      return { pageCount: 0, textContext: '', error: error.message };
    }
  }
};
