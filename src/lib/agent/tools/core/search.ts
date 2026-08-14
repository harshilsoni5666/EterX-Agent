import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { enforceToolCapability } from '../security/tool_policy';
import { executeSearchWithFailover } from '../../../search/search-runtime';

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: `Search the live web through the active model's native search when enabled and available, then fall back to the provider configured in External service settings.

Use this tool whenever current facts, recent changes, source citations, documentation, market data, or web-grounded verification matter. The runtime checks the selected model's built-in search capability first, then reads the latest External service settings for every call. It applies the configured provider order and automatically fails over across the saved provider and API-key pool when a request fails. A model change therefore changes the native-search decision immediately, and a settings change changes provider, credentials, endpoint, and fallback routing without restarting the agent.

Provider routes have different strengths. Tavily provides provider-native search, extraction, crawling, mapping, and research; Firecrawl provides search and page reading, with a separate self-hosted route for local instances; Exa provides semantic search and content reading; Parallel provides objective search with source excerpts; Brave, SearXNG, DuckDuckGo, and xAI are search-first routes. When a selected route does not provide a native reading, crawl, or map action, the runtime uses its safe agent-level URL reader and returns provider capabilities and action mode in the result. Deep research remains available for every route through multi-angle search plus source reading, while Tavily can use its native research operation.

Actions:
- search: find current web results and concise source content.
- extract: retrieve readable content from a list of URLs.
- crawl: retrieve readable content from a starting URL.
- map: discover links from a starting URL.
- research: run provider-native research when supported, otherwise perform a multi-angle, source-rich search in this same tool.

Never invent current facts when this tool can verify them. Treat returned URLs and content as evidence, and cite the relevant sources in the final answer.`,
  category: 'research',
  inputSchema: z.object({
    action: z.enum(['search', 'extract', 'crawl', 'map', 'research']).optional().default('search').describe('Action to perform.'),
    query: z.string().optional().describe('The search query string (required for search and research)'),
    urls: z.array(z.string()).optional().describe('List of URLs (required for extract; first item used for crawl/map)'),
    topic: z.enum(['general', 'news', 'finance']).optional().default('general').describe('The category of the search (search only)'),
    searchDepth: z.enum(['basic', 'advanced']).optional().default('basic').describe('Search depth where supported by the active provider.'),
    includeAnswer: z.boolean().optional().default(true).describe('Generate a concise provider answer when supported.'),
    includeImages: z.boolean().optional().default(false).describe('Include source images when supported.'),
    includeImageDescriptions: z.boolean().optional().default(true).describe('Include image descriptions when supported.'),
    includeRawContent: z.boolean().optional().default(false).describe('Include full readable source text when supported.'),
    numResults: z.number().optional().default(5).describe('Number of results to return.'),
  }),
  outputSchema: z.any(),
  execute: async (input: any, context?: any) => {
    const decision = enforceToolCapability('web_search', input, context);
    if (!decision.allowed) return { error: decision.reason || 'Web search is not allowed' };

    try {
      const response = await executeSearchWithFailover(input, context);
      return response;
    } catch (error: any) {
      console.warn('[Tool: web_search] External search failed:', error?.message || error);
      return {
        error: error?.message || 'External search failed.',
        results: [],
      };
    }
  },
};
