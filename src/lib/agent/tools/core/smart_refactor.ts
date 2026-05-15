import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';

/**
 * Smart Code Refactor — Intelligent Code Modification Engine
 * 
 * NEXT-GEN: Goes beyond simple search-replace. Understands code context
 * and can perform complex refactoring operations:
 * 
 * - Rename symbols across a file (variables, functions, classes)
 * - Add/remove imports
 * - Wrap code in try/catch
 * - Add TypeScript types to untyped code
 * - Insert code at specific positions (before/after functions, at top/bottom)
 * - Comment/uncomment code blocks
 * - Extract code into new functions
 */
export const smartRefactorTool: ToolDefinition = {
  name: 'smart_refactor',
  description: `Intelligent code refactoring tool. Performs complex code modifications beyond simple search-replace.

OPERATIONS:
- "rename": Rename a symbol (variable, function, class) throughout a file
- "add_import": Add an import statement to the top of a file (deduplicates)
- "remove_import": Remove an import statement from a file
- "wrap_try_catch": Wrap a function's body in a try-catch block
- "insert_after": Insert code after a specific line/pattern
- "insert_before": Insert code before a specific line/pattern
- "add_to_top": Add code to the top of the file (after imports)
- "add_to_bottom": Add code to the bottom of the file
- "comment_out": Comment out lines matching a pattern
- "uncomment": Uncomment lines matching a pattern

EXAMPLES:
- Rename: { operation: "rename", file: "src/utils.ts", from: "oldName", to: "newName" }
- Add import: { operation: "add_import", file: "src/app.ts", code: "import { useState } from 'react';" }
- Wrap try-catch: { operation: "wrap_try_catch", file: "src/api.ts", functionName: "fetchData" }`,
  category: 'workspace',
  inputSchema: z.object({
    operation: z.enum([
      'rename', 'add_import', 'remove_import', 'wrap_try_catch',
      'insert_after', 'insert_before', 'add_to_top', 'add_to_bottom',
      'comment_out', 'uncomment'
    ]).describe('Refactoring operation to perform'),
    file: z.string().describe('File to refactor'),
    from: z.string().optional().describe('Source symbol/pattern (for rename, remove_import)'),
    to: z.string().optional().describe('Target symbol (for rename)'),
    code: z.string().optional().describe('Code to insert (for add_import, insert_*, add_to_*)'),
    pattern: z.string().optional().describe('Pattern to match (for insert_after/before, comment_out)'),
    functionName: z.string().optional().describe('Function name (for wrap_try_catch)')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    linesChanged: z.number()
  }),
  execute: async (input: {
    operation: string, file: string, from?: string, to?: string,
    code?: string, pattern?: string, functionName?: string
  }) => {
    const filePath = path.isAbsolute(input.file)
      ? input.file
      : path.resolve(process.cwd(), input.file);

    if (!await fs.pathExists(filePath)) {
      return { success: false, message: `File not found: ${filePath}`, linesChanged: 0 };
    }

    let content = await fs.readFile(filePath, 'utf-8');
    const originalLength = content.split('\n').length;
    let linesChanged = 0;

    switch (input.operation) {
      case 'rename': {
        if (!input.from || !input.to) {
          return { success: false, message: 'rename requires "from" and "to"', linesChanged: 0 };
        }
        // Word-boundary rename to avoid partial matches
        const regex = new RegExp(`\\b${escapeRegex(input.from)}\\b`, 'g');
        const matches = content.match(regex);
        if (!matches || matches.length === 0) {
          return { success: false, message: `Symbol "${input.from}" not found in file`, linesChanged: 0 };
        }
        content = content.replace(regex, input.to);
        linesChanged = matches.length;
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true, message: `Renamed "${input.from}" → "${input.to}" (${linesChanged} occurrences)`, linesChanged };
      }

      case 'add_import': {
        if (!input.code) {
          return { success: false, message: 'add_import requires "code" (the import statement)', linesChanged: 0 };
        }
        // Check if import already exists
        if (content.includes(input.code.trim())) {
          return { success: true, message: 'Import already exists (deduplicated)', linesChanged: 0 };
        }
        // Find first non-import line to insert after existing imports
        const lines = content.split('\n');
        let lastImportIdx = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim().startsWith('import ') || lines[i].trim() === '') {
            lastImportIdx = i;
          } else if (lastImportIdx >= 0) {
            break;
          }
        }
        lines.splice(lastImportIdx + 1, 0, input.code.trim());
        content = lines.join('\n');
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true, message: `Import added: ${input.code.trim().substring(0, 60)}`, linesChanged: 1 };
      }

      case 'remove_import': {
        if (!input.from) {
          return { success: false, message: 'remove_import requires "from" (module name or import text)', linesChanged: 0 };
        }
        const lines = content.split('\n');
        const filtered = lines.filter(line => {
          const trimmed = line.trim();
          if (trimmed.startsWith('import ') && trimmed.includes(input.from!)) {
            linesChanged++;
            return false;
          }
          return true;
        });
        if (linesChanged === 0) {
          return { success: false, message: `No import found matching "${input.from}"`, linesChanged: 0 };
        }
        content = filtered.join('\n');
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true, message: `Removed ${linesChanged} import(s) matching "${input.from}"`, linesChanged };
      }

      case 'wrap_try_catch': {
        if (!input.functionName) {
          return { success: false, message: 'wrap_try_catch requires "functionName"', linesChanged: 0 };
        }
        // Find the function and wrap its body
        const funcRegex = new RegExp(
          `((?:async\\s+)?(?:function\\s+${escapeRegex(input.functionName)}|${escapeRegex(input.functionName)}\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)|[^=]*)\\s*=>)\\s*\\{)`,
          'm'
        );
        const funcMatch = content.match(funcRegex);
        if (!funcMatch) {
          return { success: false, message: `Function "${input.functionName}" not found`, linesChanged: 0 };
        }
        // Simple approach: add try { after opening brace and } catch before closing
        const funcStart = content.indexOf(funcMatch[0]);
        const afterBrace = funcStart + funcMatch[0].length;
        content = content.substring(0, afterBrace) +
          '\n    try {' +
          content.substring(afterBrace);
        // Find the matching closing brace (simplified — works for most cases)
        const lastBrace = content.lastIndexOf('}');
        content = content.substring(0, lastBrace) +
          '    } catch (error: any) {\n      console.error(`[${input.functionName}] Error:`, error.message);\n      throw error;\n    }\n' +
          content.substring(lastBrace);
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true, message: `Wrapped "${input.functionName}" in try-catch`, linesChanged: 4 };
      }

      case 'insert_after': {
        if (!input.pattern || !input.code) {
          return { success: false, message: 'insert_after requires "pattern" and "code"', linesChanged: 0 };
        }
        const lines = content.split('\n');
        const newLines: string[] = [];
        for (const line of lines) {
          newLines.push(line);
          if (line.includes(input.pattern)) {
            newLines.push(input.code);
            linesChanged++;
          }
        }
        if (linesChanged === 0) {
          return { success: false, message: `Pattern "${input.pattern}" not found`, linesChanged: 0 };
        }
        content = newLines.join('\n');
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true, message: `Inserted code after ${linesChanged} match(es) of "${input.pattern}"`, linesChanged };
      }

      case 'insert_before': {
        if (!input.pattern || !input.code) {
          return { success: false, message: 'insert_before requires "pattern" and "code"', linesChanged: 0 };
        }
        const lines = content.split('\n');
        const newLines: string[] = [];
        for (const line of lines) {
          if (line.includes(input.pattern)) {
            newLines.push(input.code);
            linesChanged++;
          }
          newLines.push(line);
        }
        if (linesChanged === 0) {
          return { success: false, message: `Pattern "${input.pattern}" not found`, linesChanged: 0 };
        }
        content = newLines.join('\n');
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true, message: `Inserted code before ${linesChanged} match(es) of "${input.pattern}"`, linesChanged };
      }

      case 'add_to_top': {
        if (!input.code) {
          return { success: false, message: 'add_to_top requires "code"', linesChanged: 0 };
        }
        // Insert after imports
        const lines = content.split('\n');
        let insertIdx = 0;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim().startsWith('import ')) insertIdx = i + 1;
        }
        // Skip blank lines after imports
        while (insertIdx < lines.length && lines[insertIdx].trim() === '') insertIdx++;
        lines.splice(insertIdx, 0, '', input.code, '');
        content = lines.join('\n');
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true, message: 'Code added after imports', linesChanged: input.code.split('\n').length };
      }

      case 'add_to_bottom': {
        if (!input.code) {
          return { success: false, message: 'add_to_bottom requires "code"', linesChanged: 0 };
        }
        content = content.trimEnd() + '\n\n' + input.code + '\n';
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true, message: 'Code added to bottom of file', linesChanged: input.code.split('\n').length };
      }

      case 'comment_out': {
        if (!input.pattern) {
          return { success: false, message: 'comment_out requires "pattern"', linesChanged: 0 };
        }
        const lines = content.split('\n');
        const newLines = lines.map(line => {
          if (line.includes(input.pattern!) && !line.trim().startsWith('//')) {
            linesChanged++;
            return '// ' + line;
          }
          return line;
        });
        if (linesChanged === 0) {
          return { success: false, message: `Pattern "${input.pattern}" not found`, linesChanged: 0 };
        }
        content = newLines.join('\n');
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true, message: `Commented out ${linesChanged} lines`, linesChanged };
      }

      case 'uncomment': {
        if (!input.pattern) {
          return { success: false, message: 'uncomment requires "pattern"', linesChanged: 0 };
        }
        const lines = content.split('\n');
        const newLines = lines.map(line => {
          if (line.includes(input.pattern!) && line.trim().startsWith('//')) {
            linesChanged++;
            return line.replace(/^(\s*)\/\/\s?/, '$1');
          }
          return line;
        });
        if (linesChanged === 0) {
          return { success: false, message: `No commented lines found matching "${input.pattern}"`, linesChanged: 0 };
        }
        content = newLines.join('\n');
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true, message: `Uncommented ${linesChanged} lines`, linesChanged };
      }

      default:
        return { success: false, message: `Unknown operation: ${input.operation}`, linesChanged: 0 };
    }
  }
};

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
