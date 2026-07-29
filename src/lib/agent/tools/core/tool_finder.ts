import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { globalToolRegistry } from '../registry';
import { shouldExposeToolToRuntime } from '../../builder-agent';

function scoreTool(query: string, name: string, description: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;

  const tokens = q.split(/\s+/).filter(Boolean);
  let score = 0;
  const haystack = `${name} ${description}`.toLowerCase();

  if (name.toLowerCase().includes(q)) score += 12;
  if (haystack.includes(q)) score += 8;

  for (const token of tokens) {
    if (name.toLowerCase().includes(token)) score += 4;
    if (description.toLowerCase().includes(token)) score += 2;
    if (haystack.includes(token)) score += 1;
  }

  return score;
}

const TOOL_CHAINS: Array<{ pattern: RegExp; tools: string[] }> = [
  { pattern: /\b(how does|how do|where is|what handles|architecture|flow|works?)\b/i, tools: ['workspace_semantic_search', 'workspace_search_text', 'workspace_read_many_files'] },
  { pattern: /\b(symbol|definition|reference|usage|called from)\b/i, tools: ['workspace_search_text', 'workspace_read_file'] },
  { pattern: /\b(outline|structure|imports|exports)\b/i, tools: ['workspace_file_outline', 'workspace_search_text'] },
  { pattern: /\b(find|locate|which file|where is)\b/i, tools: ['workspace_semantic_search', 'workspace_find_files', 'workspace_search_text', 'workspace_read_file'] },
  { pattern: /\b(read|inspect|open|view)\b/i, tools: ['workspace_read_many_files', 'workspace_read_file'] },
  { pattern: /\b(edit|patch|fix|change|replace|refactor)\b/i, tools: ['workspace_edit_file'] },
  { pattern: /\b(create|write|new file|scaffold)\b/i, tools: ['workspace_write_file'] },
  { pattern: /\b(test|build|lint|verify|typecheck)\b/i, tools: ['workspace_verify_code', 'workspace_run_command'] },
  { pattern: /\b(search|grep|symbol|usage)\b/i, tools: ['workspace_search_text', 'workspace_find_files'] },
  { pattern: /\b(script|transform|migration|analyze data)\b/i, tools: ['workspace_run_command', 'csv_data_analyzer'] },
];

export const toolFinderTool: ToolDefinition = {
  name: 'tool_finder',
  description: 'Discover the best EterX tools for a capability. Use when unsure which tool to call.',
  category: 'core',
  inputSchema: z.object({
    query: z.string().describe('What you want to do, e.g. "find tsx files", "batch read configs", "apply patch"'),
    limit: z.number().optional().describe('Maximum matches to return (default: 8)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    query: z.string(),
    matches: z.array(z.object({
      name: z.string(),
      description: z.string(),
      score: z.number(),
    })),
    recommendedChains: z.array(z.object({
      intent: z.string(),
      tools: z.array(z.string()),
    })),
  }),
  execute: async (input: { query: string; limit?: number }) => {
    const limit = Math.min(input.limit || 8, 15);
    const allTools = globalToolRegistry.getAllTools()
      .filter(tool => shouldExposeToolToRuntime(tool.name, false));

    const matches = allTools
      .map(tool => ({
        name: tool.name,
        description: tool.description.slice(0, 180),
        score: scoreTool(input.query, tool.name, tool.description),
      }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const recommendedChains = TOOL_CHAINS
      .filter(chain => chain.pattern.test(input.query))
      .map(chain => ({
        intent: chain.pattern.source,
        tools: chain.tools.filter(name => globalToolRegistry.getTool(name)),
      }))
      .filter(chain => chain.tools.length > 0)
      .slice(0, 3);

    return {
      success: true,
      query: input.query,
      matches: matches.length > 0 ? matches : allTools.slice(0, limit).map(tool => ({
        name: tool.name,
        description: tool.description.slice(0, 180),
        score: 0,
      })),
      recommendedChains,
    };
  },
};
