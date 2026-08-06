import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { globalToolRegistry } from '../registry';
import { shouldExposeToolToRuntime } from '../../builder-agent';
import { normalizeRegistryToolArgs, validateRegistryToolArgs } from '../tool-args';
import { enforceToolCapability } from '../security/tool_policy';
import { shouldExposeMainAgentTool } from '../main-tool-policy';
import { searchToolCapabilities } from '../tool-schema-router';

const SEARCH_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'want', 'need',
  'please', 'could', 'would', 'should', 'tool', 'using', 'make', 'have',
]);

function deferredDescriptionScore(query: string, name: string, description: string): number {
  const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9_\s-]/g, ' ');
  const terms = normalizedQuery.split(/\s+/).filter(term => term.length >= 3 && !SEARCH_STOP_WORDS.has(term));
  const normalizedName = name.toLowerCase().replace(/[_-]+/g, ' ');
  const normalizedDescription = description.toLowerCase();
  let score = normalizedName.includes(normalizedQuery.trim()) ? 80 : 0;
  for (const term of terms) {
    if (normalizedName.includes(term)) score += 18;
    else if (normalizedDescription.includes(term)) score += 4;
  }
  return score;
}

export const toolFinderTool: ToolDefinition = {
  name: 'tool_finder',
  description: 'Search deferred EterX tools by capability. Results include each input schema. If a needed tool is not directly available, call this tool again with action="execute", toolName, and argumentsJson. This provider-neutral fallback works when native tool search is unavailable.',
  category: 'core',
  inputSchema: z.object({
    action: z.enum(['search', 'execute']).optional().describe('Search deferred tools (default) or execute one returned match.'),
    query: z.string().optional().describe('What you want to do, e.g. "find tsx files", "batch read configs", "apply patch". Optional for execute.'),
    limit: z.number().optional().describe('Maximum matches to return (default: 8)'),
    toolName: z.string().optional().describe('Exact matched tool name when action is execute.'),
    argumentsJson: z.string().optional().describe('JSON object matching the returned input schema when action is execute.'),
    arguments: z.record(z.string(), z.any()).optional().describe('Structured arguments matching the returned input schema when action is execute.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    query: z.string(),
    matches: z.array(z.object({
      name: z.string(),
      description: z.string(),
      score: z.number(),
      inputSchema: z.any().optional(),
    })),
    recommendedChains: z.array(z.object({
      intent: z.string(),
      tools: z.array(z.string()),
    })),
    error: z.string().optional(),
    executedTool: z.string().optional(),
    result: z.any().optional(),
  }),
  execute: async (input: { action?: 'search' | 'execute'; query?: string; limit?: number; toolName?: string; argumentsJson?: string; arguments?: Record<string, any> }, context: any = {}) => {
    const query = String(input.query || input.toolName || '').trim();
    if (input.action === 'execute') {
      // Models sometimes put the exact result name in query after a search.
      // Accept it here so discovery remains a reliable bridge to deferred tools.
      const toolName = String(input.toolName || input.query || '').trim();
      if (!toolName || toolName === 'tool_finder') {
        return { success: false, query, matches: [], recommendedChains: [], error: 'A non-discovery toolName is required.' };
      }
      const tool = globalToolRegistry.getTool(toolName);
      if (!tool || !shouldExposeToolToRuntime(toolName, false) || !shouldExposeMainAgentTool(toolName)) {
        return { success: false, query, matches: [], recommendedChains: [], error: `Tool "${toolName}" is not available in this runtime.` };
      }
      const functionDeclaration = globalToolRegistry.getFunctionDeclaration(toolName);
      const requiredArguments = Array.isArray(functionDeclaration?.parameters?.required)
        ? functionDeclaration.parameters.required.map((value: unknown) => String(value))
        : [];
      let rawArguments: any = input.arguments || {};
      try {
        if (input.argumentsJson) rawArguments = JSON.parse(input.argumentsJson);
      } catch {
        return {
          success: false,
          query,
          matches: [{ name: tool.name, description: tool.description.slice(0, 180), score: 100, inputSchema: functionDeclaration?.parameters }],
          recommendedChains: [],
          error: 'argumentsJson must be a valid JSON object.',
        };
      }
      if (!rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) {
        return {
          success: false,
          query,
          matches: [{ name: tool.name, description: tool.description.slice(0, 180), score: 100, inputSchema: functionDeclaration?.parameters }],
          recommendedChains: [],
          error: 'argumentsJson must contain a JSON object.',
        };
      }
      const normalized = normalizeRegistryToolArgs(toolName, rawArguments);
      const permission = enforceToolCapability(toolName, normalized, context);
      if (!permission.allowed) {
        return { success: false, query, matches: [], recommendedChains: [], error: permission.reason };
      }
      const missingArguments = requiredArguments.filter((key) => {
        const value = normalized?.[key];
        return value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0);
      });
      if (missingArguments.length > 0) {
        return {
          success: true,
          query,
          matches: [{
            name: tool.name,
            description: tool.description.slice(0, 180),
            score: 100,
            inputSchema: functionDeclaration?.parameters,
          }],
          recommendedChains: [],
          result: {
            needsArguments: true,
            toolName,
            requiredArguments: missingArguments,
            instruction: 'Call this same deferred tool again with structured arguments or argumentsJson matching inputSchema.',
          },
        };
      }
      const validation = validateRegistryToolArgs(tool, normalized);
      if (!validation.success) {
        return {
          success: false,
          query,
          matches: [{ name: tool.name, description: tool.description.slice(0, 180), score: 100, inputSchema: functionDeclaration?.parameters }],
          recommendedChains: [],
          error: `${validation.error} Supply the missing fields and retry this same deferred tool.`,
        };
      }
      const result = await tool.execute(validation.args, context);
      return { success: true, query, matches: [], recommendedChains: [], executedTool: toolName, result };
    }

    const limit = Math.min(input.limit || 8, 15);
    const allTools = globalToolRegistry.getAllTools()
      .filter(tool => shouldExposeToolToRuntime(tool.name, false)
        && shouldExposeMainAgentTool(tool.name)
        && enforceToolCapability(tool.name, {}, context).allowed);

    const capabilitySearch = searchToolCapabilities(allTools, query, limit);
    const toolsByName = new Map(allTools.map(tool => [tool.name, tool]));
    let matches = capabilitySearch.matches.map(match => {
      const tool = toolsByName.get(match.name)!;
      return {
        name: tool.name,
        description: tool.description.slice(0, 180),
        score: match.score,
        inputSchema: globalToolRegistry.getFunctionDeclaration(tool.name)?.parameters,
      };
    });
    // Description search is deliberately deferred to this on-demand call. It
    // preserves obscure capabilities without letting generic description words
    // inflate the direct schema bundle on every model request.
    if (matches.length === 0) {
      matches = allTools
        .map(tool => ({
          name: tool.name,
          description: tool.description.slice(0, 180),
          score: deferredDescriptionScore(query, tool.name, tool.description),
          inputSchema: globalToolRegistry.getFunctionDeclaration(tool.name)?.parameters,
        }))
        .filter(match => match.score > 0)
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .slice(0, limit);
    }
    const recommendedChains = capabilitySearch.matchedIntents.slice(0, 3).map(intent => ({
      intent,
      tools: capabilitySearch.matches.filter(match => match.intent === intent).map(match => match.name),
    }));

    return {
      success: true,
      query,
      matches,
      recommendedChains,
      error: matches.length ? undefined : 'No confident capability match. Rephrase the goal or use an exact tool name.',
    };
  },
};
