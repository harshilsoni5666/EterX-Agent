import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import Papa from 'papaparse';
import fs from 'fs-extra';
import { createReadStream } from 'fs';
import { resolveReadableWorkspacePath } from '../../workspace/path_resolver';

export const csvAnalyzerTool: ToolDefinition = {
  name: 'csv_data_analyzer',
  description: 'Fast-profile CSV files from the workspace. By default returns schema/columns and preview without scanning the full file; set fullScan=true only when exact row count is required.',
  category: 'workspace',
  inputSchema: z.object({
    filename: z.string().describe('The CSV filename in the workspace to analyze'),
    previewRows: z.number().default(5).describe('How many rows to preview'),
    fullScan: z.boolean().optional().default(false).describe('Set true only when exact row count/full scan is required')
  }),
  outputSchema: z.object({
    totalRows: z.number(),
    totalRowsExact: z.boolean().optional(),
    sampled: z.boolean().optional(),
    columns: z.array(z.string()),
    preview: z.array(z.any()),
    warnings: z.array(z.any()).optional(),
    largeFileSafe: z.boolean().optional(),
    note: z.string().optional(),
    error: z.string().optional()
  }),
  execute: async (input: { filename: string, previewRows: number, fullScan?: boolean }) => {
    const safePath = resolveReadableWorkspacePath(input.filename);
    console.log(`[Tool: csv_analyzer] Analyzing ${safePath}`);
    
    try {
      const previewLimit = Math.max(0, input.previewRows || 5);
      const parsed = input.fullScan
        ? await parseCsvStreaming(safePath, previewLimit, true)
        : await parseCsvPreview(safePath, previewLimit);
      if (parsed.errors.length > 0) {
        console.warn('[Tool: csv_analyzer] Parsing warnings:', parsed.errors.slice(0, 5));
      }

      return {
        totalRows: parsed.totalRows,
        totalRowsExact: parsed.totalRowsExact,
        sampled: !parsed.totalRowsExact,
        columns: parsed.columns,
        preview: parsed.preview,
        warnings: parsed.errors.slice(0, 5).map((err: any) => ({
          type: err.type,
          code: err.code,
          message: err.message,
          row: err.row,
        })),
        largeFileSafe: true,
        note: parsed.totalRowsExact
          ? 'Full CSV scan completed.'
          : 'Fast preview only. Columns and preview are reliable for schema inspection; call with fullScan=true only if exact row count is needed.'
      };
    } catch (error: any) {
      return { totalRows: 0, columns: [], preview: [], error: error.message };
    }
  }
};

async function parseCsvPreview(filename: string, previewRows: number): Promise<{ totalRows: number; totalRowsExact: boolean; columns: string[]; preview: any[]; errors: any[] }> {
  const sample = await readCsvSample(filename);
  const parsed = Papa.parse(sample, {
    header: true,
    skipEmptyLines: true,
    preview: Math.max(previewRows, 1),
  });
  return {
    totalRows: Array.isArray(parsed.data) ? parsed.data.length : 0,
    totalRowsExact: false,
    columns: parsed.meta.fields || [],
    preview: (parsed.data as any[]).slice(0, previewRows),
    errors: parsed.errors || [],
  };
}

function parseCsvStreaming(filename: string, previewRows: number, fullScan: boolean): Promise<{ totalRows: number; totalRowsExact: boolean; columns: string[]; preview: any[]; errors: any[] }> {
  return new Promise((resolve, reject) => {
    const preview: any[] = [];
    const errors: any[] = [];
    let totalRows = 0;
    let columns: string[] = [];
    const stream = createReadStream(filename, { encoding: 'utf-8' });
    const parser = Papa.parse(Papa.NODE_STREAM_INPUT, {
      header: true,
      skipEmptyLines: true,
    });

    parser.on('data', (row: any) => {
      totalRows++;
      if (!columns.length && row && typeof row === 'object') columns = Object.keys(row);
      if (preview.length < previewRows) preview.push(row);
    });
    parser.on('error', (error: any) => {
      errors.push(error);
      reject(error);
    });
    parser.on('finish', () => {
      resolve({ totalRows, totalRowsExact: fullScan, columns, preview, errors });
    });
    stream.on('error', reject);
    stream.pipe(parser);
  });
}

function readCsvSample(filename: string, maxBytes = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      let text = Buffer.concat(chunks).toString('utf-8');
      if (total >= maxBytes) {
        const lastNewline = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
        if (lastNewline > 0) text = text.slice(0, lastNewline + 1);
      }
      resolve(text);
    };
    const stream = createReadStream(filename, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      total += buffer.length;
      if (total >= maxBytes) {
        stream.destroy();
      }
    });
    stream.on('error', (error: any) => {
      if ((error as any).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      if (settled) return;
      settled = true;
      reject(error);
    });
    stream.on('close', finish);
    stream.on('end', finish);
  });
}
