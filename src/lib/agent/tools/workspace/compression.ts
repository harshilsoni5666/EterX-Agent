import { z } from 'zod';
import path from 'path';
import fs from 'fs-extra';
// @ts-ignore
import AdmZip from 'adm-zip';
import { ToolDefinition } from '../../schemas';
import {
  hasRuntimeWorkspaceContext,
  resolveFinalArtifactPathForContext,
  resolveReadableWorkspacePath,
  resolveReadableWorkspacePathForContext,
  resolveWorkspacePathForContext,
} from '../../workspace/path_resolver';

function wildcardMatcher(pattern?: string): ((name: string) => boolean) | undefined {
  if (!pattern) return undefined;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const matcher = new RegExp(`^${escaped}$`, 'i');
  return (name: string) => matcher.test(path.basename(name)) || matcher.test(name.replace(/\\/g, '/'));
}

export const compressionTool: ToolDefinition = {
  name: 'file_compression',
  description: 'Compress files/folders into ZIP archives or extract ZIP files on Windows, macOS, and Linux.',
  category: 'workspace',
  inputSchema: z.object({
    action: z.enum(['compress', 'extract', 'list']).describe('compress: create ZIP, extract: unzip, list: view archive contents'),
    source: z.string().describe('Source file/folder path (relative to workspace)'),
    destination: z.string().optional().describe('Output path (default: auto-generated)'),
    includePattern: z.string().optional().describe('Only include files matching this pattern (e.g., "*.ts")')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    outputPath: z.string().optional()
  }),
  execute: async (input: any, context?: any) => {
    const sourcePath = hasRuntimeWorkspaceContext(context)
      ? resolveReadableWorkspacePathForContext(input.source, context)
      : resolveReadableWorkspacePath(input.source);

    try {
      if (input.action === 'compress') {
        const destPath = input.destination
          ? resolveFinalArtifactPathForContext(input.destination, '.zip', undefined, context)
          : resolveFinalArtifactPathForContext(`${path.basename(sourcePath)}.zip`, '.zip', undefined, context);
        const zip = new AdmZip();
        const sourceStats = await fs.stat(sourcePath);
        const filter = wildcardMatcher(input.includePattern);

        if (sourceStats.isDirectory()) {
          zip.addLocalFolder(sourcePath, '', filter);
        } else if (!filter || filter(sourcePath)) {
          zip.addLocalFile(sourcePath);
        } else {
          return { success: false, message: `No files matched ${input.includePattern}.` };
        }

        await fs.ensureDir(path.dirname(destPath));
        zip.writeZip(destPath);
        const outputStats = await fs.stat(destPath);
        return {
          success: true,
          message: `Compressed to: ${path.basename(destPath)} (${(outputStats.size / 1024).toFixed(1)} KB)`,
          outputPath: destPath
        };
      }

      if (input.action === 'extract') {
        const destDir = input.destination
          ? resolveWorkspacePathForContext(input.destination, context)
          : sourcePath.replace(/\.zip$/i, '_extracted');
        await fs.ensureDir(destDir);
        new AdmZip(sourcePath).extractAllTo(destDir, true);
        const files = await fs.readdir(destDir, { recursive: true });
        return {
          success: true,
          message: `Extracted ${files.length} items to: ${path.basename(destDir)}`,
          outputPath: destDir,
          filesExtracted: files.length
        };
      }

      if (input.action === 'list') {
        const entries = new AdmZip(sourcePath).getEntries();
        const listing = entries.map((entry: any) =>
          `${entry.entryName}\t${entry.header.size} bytes\t${entry.header.time.toISOString()}`
        );
        return { success: true, message: listing.join('\n') || 'Archive is empty.' };
      }

      return { success: false, message: 'Unknown action' };
    } catch (error: any) {
      return { success: false, message: `Compression error: ${error.message}` };
    }
  }
};
