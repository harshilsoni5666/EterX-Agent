import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { codeIntelligence } from '../../adaptive';
import path from 'path';

/**
 * Code Intelligence Tool — Deep Code Understanding
 * 
 * Analyzes code structure without needing to read entire files.
 * Extracts: imports, exports, functions, classes, interfaces, dependencies.
 * Can also build dependency graphs for entire directories.
 */
export const codeIntelTool: ToolDefinition = {
  name: 'code_intelligence',
  description: `Deep code analysis tool. Analyzes code structure without reading entire files.

MODES:
- "analyze": Analyze a single file — returns imports, exports, functions, classes, interfaces, dependencies, complexity
- "graph": Build a dependency graph for a directory — shows how files import each other, entry points, external deps

EXAMPLES:
- Analyze: { mode: "analyze", target: "src/lib/agent/gemini.ts" }
- Graph: { mode: "graph", target: "src/lib/agent" }

Use this BEFORE modifying code to understand the codebase structure.`,
  category: 'workspace',
  inputSchema: z.object({
    mode: z.enum(['analyze', 'graph']).describe('Analysis mode'),
    target: z.string().describe('File path (for analyze) or directory path (for graph)')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    mode: z.string(),
    result: z.any()
  }),
  execute: async (input: { mode: string, target: string }) => {
    const targetPath = path.isAbsolute(input.target)
      ? input.target
      : path.resolve(process.cwd(), input.target);

    try {
      if (input.mode === 'analyze') {
        const analysis = await codeIntelligence.analyzeFile(targetPath);
        return {
          success: true,
          mode: 'analyze',
          result: {
            ...analysis,
            path: targetPath,
            summary: `${analysis.lineCount} lines | ${analysis.complexity} | ${analysis.functions.length} functions | ${analysis.classes.length} classes | ${analysis.imports.length} imports | ${analysis.exports.length} exports`
          }
        };
      }

      if (input.mode === 'graph') {
        const graph = await codeIntelligence.analyzeDependencyGraph(targetPath);
        return {
          success: true,
          mode: 'graph',
          result: {
            ...graph,
            summary: `${graph.files} files | ${graph.internalDeps.length} internal deps | ${graph.externalDeps.length} external deps | ${graph.entryPoints.length} entry points`
          }
        };
      }

      return { success: false, mode: input.mode, result: { error: 'Unknown mode' } };
    } catch (error: any) {
      return { success: false, mode: input.mode, result: { error: error.message } };
    }
  }
};
