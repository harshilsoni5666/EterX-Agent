import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';
import { resolveReadableWorkspacePath } from '../../workspace/path_resolver';

const execAsync = promisify(exec);

/**
 * Real-Time Verification Tool — Internal Quality Control Engine
 * 
 * Lets the agent verify its own work without external intervention.
 * Supports multiple verification modes:
 * - file_exists: Check if a file/directory exists
 * - file_content: Read and validate file contents against expected patterns
 * - file_size: Verify file size is within expected range
 * - command_output: Run a command and check if output matches expectations
 * - code_syntax: Verify code compiles/parses without errors
 * - compare_files: Diff two files and report differences
 * - port_check: Verify if a service is running on a port
 * - json_valid: Validate JSON structure
 * - screenshot_verify: Take a screenshot and confirm visual state
 */
export const realTimeVerifierTool: ToolDefinition = {
  name: 'realtime_verify',
  description: `Run internal verification checks on your own work. Use this AFTER creating files, running commands, or completing steps to ensure quality. 
Modes:
- file_exists: Check if file/dir exists at path
- file_content: Read file and check if it contains expected text
- file_size: Verify file size (min/max bytes)
- command_output: Run a command and check output against expected pattern
- code_syntax: Verify code file compiles (supports .ts, .js, .py, .json)
- compare_files: Diff two files for differences
- port_check: Check if a port is in use (service running)
- json_valid: Validate JSON file structure
- html_valid: Basic HTML structure validation
Use this to self-verify before reporting completion.`,
  category: 'core',
  inputSchema: z.object({
    mode: z.enum([
      'file_exists', 'file_content', 'file_size', 
      'command_output', 'code_syntax', 'compare_files',
      'port_check', 'json_valid', 'html_valid'
    ]).describe('Type of verification to perform'),
    target: z.string().describe('Primary target — filepath, command, or port number'),
    expected: z.string().optional().describe('Expected value for content/output checks (regex or substring)'),
    secondaryTarget: z.string().optional().describe('Second filepath for compare_files mode'),
    minSize: z.number().optional().describe('Minimum file size in bytes (for file_size mode)'),
    maxSize: z.number().optional().describe('Maximum file size in bytes (for file_size mode)')
  }),
  outputSchema: z.object({
    passed: z.boolean(),
    mode: z.string(),
    details: z.string(),
    evidence: z.string()
  }),
  execute: async (input: {
    mode: string, target: string, expected?: string,
    secondaryTarget?: string, minSize?: number, maxSize?: number
  }) => {
    console.log(`[Tool: realtime_verify] Mode: ${input.mode} | Target: ${input.target}`);

    const resolvePath = (p: string) => resolveReadableWorkspacePath(p);

    try {
      switch (input.mode) {
        // ─── FILE EXISTS ──────────────────────────────────────────
        case 'file_exists': {
          const fp = resolvePath(input.target);
          const exists = await fs.pathExists(fp);
          const stat = exists ? await fs.stat(fp) : null;
          return {
            passed: exists,
            mode: 'file_exists',
            details: exists
              ? `✅ EXISTS: ${fp} (${stat?.isDirectory() ? 'directory' : `file, ${(stat!.size / 1024).toFixed(1)} KB`})`
              : `❌ NOT FOUND: ${fp}`,
            evidence: exists ? `Size: ${stat!.size} bytes | Modified: ${stat!.mtime.toISOString()}` : 'File does not exist'
          };
        }

        // ─── FILE CONTENT CHECK ───────────────────────────────────
        case 'file_content': {
          const fp = resolvePath(input.target);
          if (!await fs.pathExists(fp)) {
            return { passed: false, mode: 'file_content', details: `❌ File not found: ${fp}`, evidence: '' };
          }
          const content = await fs.readFile(fp, 'utf-8');
          const preview = content.substring(0, 500);

          if (!input.expected) {
            return {
              passed: content.length > 0,
              mode: 'file_content',
              details: content.length > 0 ? `✅ File has content (${content.length} chars)` : '❌ File is empty',
              evidence: `First 500 chars:\n${preview}`
            };
          }

          // Check if content contains expected (supports regex)
          let matches = false;
          try {
            const regex = new RegExp(input.expected, 'i');
            matches = regex.test(content);
          } catch {
            matches = content.toLowerCase().includes(input.expected.toLowerCase());
          }

          return {
            passed: matches,
            mode: 'file_content',
            details: matches
              ? `✅ File contains expected pattern: "${input.expected}"`
              : `❌ Expected pattern NOT found: "${input.expected}"`,
            evidence: `File size: ${content.length} chars\nFirst 500 chars:\n${preview}`
          };
        }

        // ─── FILE SIZE CHECK ──────────────────────────────────────
        case 'file_size': {
          const fp = resolvePath(input.target);
          if (!await fs.pathExists(fp)) {
            return { passed: false, mode: 'file_size', details: `❌ File not found: ${fp}`, evidence: '' };
          }
          const stat = await fs.stat(fp);
          const size = stat.size;
          const minOk = !input.minSize || size >= input.minSize;
          const maxOk = !input.maxSize || size <= input.maxSize;
          const passed = minOk && maxOk;

          return {
            passed,
            mode: 'file_size',
            details: passed
              ? `✅ File size OK: ${size} bytes (${(size / 1024).toFixed(1)} KB)`
              : `❌ File size out of range: ${size} bytes (expected ${input.minSize || 0}-${input.maxSize || '∞'})`,
            evidence: `Exact size: ${size} bytes | Min: ${input.minSize || 'none'} | Max: ${input.maxSize || 'none'}`
          };
        }

        // ─── COMMAND OUTPUT CHECK ─────────────────────────────────
        case 'command_output': {
          try {
            const { stdout, stderr } = await execAsync(input.target, {
              timeout: 30000,
              maxBuffer: 5 * 1024 * 1024,
              cwd: process.cwd()
            });
            const output = stdout + stderr;
            const preview = output.substring(0, 1000);

            if (!input.expected) {
              return {
                passed: true,
                mode: 'command_output',
                details: `✅ Command executed successfully`,
                evidence: preview
              };
            }

            let matches = false;
            try {
              matches = new RegExp(input.expected, 'i').test(output);
            } catch {
              matches = output.toLowerCase().includes(input.expected.toLowerCase());
            }

            return {
              passed: matches,
              mode: 'command_output',
              details: matches
                ? `✅ Output matches expected: "${input.expected}"`
                : `❌ Output does NOT match: "${input.expected}"`,
              evidence: preview
            };
          } catch (error: any) {
            const output = (error.stdout || '') + (error.stderr || error.message);
            return {
              passed: false,
              mode: 'command_output',
              details: `❌ Command failed with exit code ${error.code || 1}`,
              evidence: output.substring(0, 1000)
            };
          }
        }

        // ─── CODE SYNTAX CHECK ────────────────────────────────────
        case 'code_syntax': {
          const fp = resolvePath(input.target);
          if (!await fs.pathExists(fp)) {
            return { passed: false, mode: 'code_syntax', details: `❌ File not found: ${fp}`, evidence: '' };
          }
          const ext = path.extname(fp).toLowerCase();
          let command = '';

          if (ext === '.ts' || ext === '.tsx') {
            command = `npx tsc --noEmit --pretty "${fp}" 2>&1`;
          } else if (ext === '.js' || ext === '.jsx') {
            command = `node --check "${fp}" 2>&1`;
          } else if (ext === '.py') {
            command = `python -c "import py_compile; py_compile.compile('${fp.replace(/\\/g, '/')}', doraise=True)" 2>&1`;
          } else if (ext === '.json') {
            command = `node -e "JSON.parse(require('fs').readFileSync('${fp.replace(/\\/g, '/')}','utf-8'))" 2>&1`;
          } else {
            return { passed: true, mode: 'code_syntax', details: `⚠️ No syntax checker for ${ext}`, evidence: 'Skipped' };
          }

          try {
            const { stdout, stderr } = await execAsync(command, { timeout: 30000, cwd: process.cwd() });
            const output = (stdout + stderr).trim();
            const hasErrors = output.toLowerCase().includes('error');
            return {
              passed: !hasErrors,
              mode: 'code_syntax',
              details: hasErrors ? `❌ Syntax errors found` : `✅ Syntax valid: ${fp}`,
              evidence: output.substring(0, 1000) || 'No output (clean)'
            };
          } catch (error: any) {
            return {
              passed: false,
              mode: 'code_syntax',
              details: `❌ Syntax check failed for ${fp}`,
              evidence: ((error.stdout || '') + (error.stderr || error.message)).substring(0, 1000)
            };
          }
        }

        // ─── COMPARE FILES ────────────────────────────────────────
        case 'compare_files': {
          if (!input.secondaryTarget) {
            return { passed: false, mode: 'compare_files', details: '❌ secondaryTarget required for compare_files', evidence: '' };
          }
          const fp1 = resolvePath(input.target);
          const fp2 = resolvePath(input.secondaryTarget);

          if (!await fs.pathExists(fp1)) return { passed: false, mode: 'compare_files', details: `❌ File 1 not found: ${fp1}`, evidence: '' };
          if (!await fs.pathExists(fp2)) return { passed: false, mode: 'compare_files', details: `❌ File 2 not found: ${fp2}`, evidence: '' };

          const content1 = await fs.readFile(fp1, 'utf-8');
          const content2 = await fs.readFile(fp2, 'utf-8');
          const identical = content1 === content2;

          if (identical) {
            return { passed: true, mode: 'compare_files', details: '✅ Files are identical', evidence: `Both ${content1.length} chars` };
          }

          // Find first difference
          let diffLine = 0;
          const lines1 = content1.split('\n');
          const lines2 = content2.split('\n');
          for (let i = 0; i < Math.max(lines1.length, lines2.length); i++) {
            if (lines1[i] !== lines2[i]) { diffLine = i + 1; break; }
          }

          return {
            passed: false,
            mode: 'compare_files',
            details: `❌ Files differ at line ${diffLine}`,
            evidence: `File 1: ${content1.length} chars (${lines1.length} lines)\nFile 2: ${content2.length} chars (${lines2.length} lines)\nFirst diff at line ${diffLine}:\n- "${(lines1[diffLine - 1] || '').substring(0, 100)}"\n+ "${(lines2[diffLine - 1] || '').substring(0, 100)}"`
          };
        }

        // ─── PORT CHECK ───────────────────────────────────────────
        case 'port_check': {
          const port = parseInt(input.target);
          if (isNaN(port)) {
            return { passed: false, mode: 'port_check', details: '❌ Invalid port number', evidence: '' };
          }

          try {
            const { stdout } = await execAsync(
              `powershell -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1 | Format-List"`,
              { timeout: 5000 }
            );
            const isActive = stdout.trim().length > 0;
            return {
              passed: isActive,
              mode: 'port_check',
              details: isActive ? `✅ Port ${port} is ACTIVE` : `❌ Port ${port} is NOT in use`,
              evidence: stdout.trim() || 'No connection found'
            };
          } catch {
            return { passed: false, mode: 'port_check', details: `❌ Port ${port} check failed`, evidence: 'Command error' };
          }
        }

        // ─── JSON VALIDATION ──────────────────────────────────────
        case 'json_valid': {
          const fp = resolvePath(input.target);
          if (!await fs.pathExists(fp)) {
            return { passed: false, mode: 'json_valid', details: `❌ File not found: ${fp}`, evidence: '' };
          }
          const raw = await fs.readFile(fp, 'utf-8');
          try {
            const parsed = JSON.parse(raw);
            const keys = Object.keys(parsed);
            return {
              passed: true,
              mode: 'json_valid',
              details: `✅ Valid JSON (${Array.isArray(parsed) ? `array of ${parsed.length}` : `object with ${keys.length} keys`})`,
              evidence: `Top-level keys: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? '...' : ''}`
            };
          } catch (e: any) {
            return { passed: false, mode: 'json_valid', details: `❌ Invalid JSON: ${e.message}`, evidence: raw.substring(0, 300) };
          }
        }

        // ─── HTML VALIDATION ──────────────────────────────────────
        case 'html_valid': {
          const fp = resolvePath(input.target);
          if (!await fs.pathExists(fp)) {
            return { passed: false, mode: 'html_valid', details: `❌ File not found: ${fp}`, evidence: '' };
          }
          const html = await fs.readFile(fp, 'utf-8');
          const hasDoctype = /<!DOCTYPE/i.test(html);
          const hasHtml = /<html/i.test(html);
          const hasHead = /<head/i.test(html);
          const hasBody = /<body/i.test(html);
          const hasClosing = /<\/html>/i.test(html);
          const issues: string[] = [];
          if (!hasDoctype) issues.push('Missing <!DOCTYPE>');
          if (!hasHtml) issues.push('Missing <html>');
          if (!hasHead) issues.push('Missing <head>');
          if (!hasBody) issues.push('Missing <body>');
          if (!hasClosing) issues.push('Missing </html>');

          const passed = issues.length === 0;
          return {
            passed,
            mode: 'html_valid',
            details: passed ? `✅ Valid HTML structure` : `⚠️ HTML issues: ${issues.join(', ')}`,
            evidence: `File size: ${html.length} chars | DOCTYPE: ${hasDoctype} | <html>: ${hasHtml} | <head>: ${hasHead} | <body>: ${hasBody}`
          };
        }

        default:
          return { passed: false, mode: input.mode, details: `❌ Unknown mode: ${input.mode}`, evidence: '' };
      }
    } catch (error: any) {
      return { passed: false, mode: input.mode, details: `❌ Verification error: ${error.message}`, evidence: '' };
    }
  }
};
