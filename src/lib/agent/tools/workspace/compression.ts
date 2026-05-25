import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';
import {
  hasRuntimeWorkspaceContext,
  resolveFinalArtifactPathForContext,
  resolveReadableWorkspacePath,
  resolveReadableWorkspacePathForContext,
  resolveWorkspacePathForContext,
} from '../../workspace/path_resolver';

const execAsync = promisify(exec);

function psQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Compression Tool — Zip/Unzip/Archive
 * 
 * Compress files into archives or extract them.
 * Supports ZIP format via PowerShell's Compress-Archive.
 */
export const compressionTool: ToolDefinition = {
  name: 'file_compression',
  description: 'Compress files/folders into ZIP archives or extract ZIP files. Use this for bundling deliverables, creating backups, or extracting downloaded archives.',
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
    
    console.log(`[Tool: file_compression] ${input.action}: ${sourcePath}`);

    try {
      switch (input.action) {
        case 'compress': {
          const destPath = input.destination 
            ? resolveFinalArtifactPathForContext(input.destination, '.zip', undefined, context)
            : resolveFinalArtifactPathForContext(`${path.basename(sourcePath)}.zip`, '.zip', undefined, context);

          const pattern = input.includePattern ? `-Filter ${psQuote(input.includePattern)}` : '';
          const psScript = `Compress-Archive -Path ${psQuote(sourcePath)} -DestinationPath ${psQuote(destPath)} -Force ${pattern}`;
          
          await fs.ensureDir(path.dirname(destPath));
          await execAsync(psScript, { shell: 'powershell.exe' });

          if (await fs.pathExists(destPath)) {
            const stats = await fs.stat(destPath);
            return {
              success: true,
              message: `✅ Compressed to: ${path.basename(destPath)} (${(stats.size / 1024).toFixed(1)} KB)`,
              outputPath: destPath
            };
          }
          return { success: false, message: 'Compression completed but output file not found.' };
        }

        case 'extract': {
          const destDir = input.destination 
            ? resolveWorkspacePathForContext(input.destination, context)
            : sourcePath.replace('.zip', '_extracted');

          await fs.ensureDir(destDir);
          await execAsync(
            `Expand-Archive -Path ${psQuote(sourcePath)} -DestinationPath ${psQuote(destDir)} -Force`,
            { shell: 'powershell.exe' }
          );

          const files = await fs.readdir(destDir, { recursive: true });
          return {
            success: true,
            message: `✅ Extracted ${files.length} items to: ${path.basename(destDir)}`,
            outputPath: destDir,
            filesExtracted: files.length
          };
        }

        case 'list': {
          const { stdout } = await execAsync(
            `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::OpenRead(${psQuote(sourcePath)}).Entries | Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 300`,
            { shell: 'powershell.exe' }
          );
          return { success: true, message: stdout.trim() };
        }

        default:
          return { success: false, message: 'Unknown action' };
      }
    } catch (error: any) {
      return { success: false, message: `Compression error: ${error.message}` };
    }
  }
};
