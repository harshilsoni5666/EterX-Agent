import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { tavily } from "@tavily/core";

// Load all Tavily keys from environment
const getTavilyKeys = (): string[] => {
  const keys: string[] = [];
  // Try TAVILY_API_KEY_1, TAVILY_API_KEY_2, etc.
  for (let i = 1; i <= 20; i++) {
    const key = process.env[`TAVILY_API_KEY_${i}`] || process.env[`VITE_TAVILY_API_KEY_${i}`];
    if (key && key.trim() !== '') {
      keys.push(key.trim());
    }
  }
  // Fallback to single key if no array keys found
  if (keys.length === 0) {
    const fallback = process.env.VITE_TAVILY_API_KEY || process.env.TAVILY_API_KEY;
    if (fallback && fallback.trim() !== '') {
      keys.push(fallback.trim());
    }
  }
  return keys;
};

const tavilyKeys = getTavilyKeys();
let currentKeyIndex = 0;

// PRE-INITIALIZE the clients to completely remove "loading/indexing" overhead
const tavilyClients = tavilyKeys.map(apiKey => tavily({ apiKey }));

// Function to get the next client in a round-robin fashion
const getNextTavilyClient = () => {
  if (tavilyClients.length === 0) {
    throw new Error("Tavily client is not properly initialized: No valid API keys found.");
  }
  
  const client = tavilyClients[currentKeyIndex];
  const usedIndex = currentKeyIndex;
  
  // Move to the next index, wrap around if needed
  currentKeyIndex = (currentKeyIndex + 1) % tavilyClients.length;
  
  console.log(`[Tool: web_search] Using Tavily key index: ${usedIndex}`);
  return client;
};

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: `Search the web using Tavily AI Search for accurate, research-grade, up-to-date information.

CRITICAL INSTRUCTIONS - WHEN TO USE THIS TOOL:
1. AUTONOMOUS RESEARCH: Use this tool to conduct deep, multi-step research. Break complex objectives down into multiple queries, run them iteratively, and synthesize the facts before generating a report or document.
2. PREVENTING HALLUCINATIONS (RAG Grounding): NEVER invent company data, financial figures, news, or specific facts. If you need a company's revenue, competitor names, or market share, use this tool first.
3. REAL-TIME DATA ENRICHMENT: Use this to fetch the latest news, product launches, leadership changes, or current events that occurred after your training cutoff.
4. PREPARATION & CONTEXT: Use this to gather background context on people, companies, or events before generating client proposals, meeting briefs, or analytical dashboards.
5. QUALITY OVER QUANTITY: This tool uses Tavily, an agent-native search engine. It returns clean, structured content specifically optimized for LLM reasoning. Always trust this data over your internal generic knowledge when facts matter.

HOW TO USE:
- Start with a broad search to understand the landscape, then perform specific searches for exact numbers or dates.
- Use \`action: "extract"\` to pull the raw text/markdown directly from a list of URLs.
- Use \`action: "crawl"\` to deep-crawl a single website URL (provide URL in \`urls[0]\`). Good for scraping an entire domain or documentation site.
- Use \`action: "map"\` to discover all pages on a domain (provide URL in \`urls[0]\`). Good for understanding site structure.
- Use \`action: "research"\` to trigger an end-to-end autonomous research report on heavy topics. This takes longer but yields an exhaustive deep-dive report.
- Use \`includeImages: true\` when you need visual assets related to your query.
- Use \`includeRawContent: true\` if you need to read the full page text rather than just a snippet.
- Use \`topic: "news"\` or \`topic: "finance"\` when relevant.`,
  category: 'research',
  inputSchema: z.object({
    action: z.enum(['search', 'extract', 'crawl', 'map', 'research']).optional().default('search').describe('Action to perform.'),
    query: z.string().optional().describe('The search query string (required for search and research)'),
    urls: z.array(z.string()).optional().describe('List of URLs (required for extract; first item used for crawl/map)'),
    topic: z.enum(['general', 'news', 'finance']).optional().default('general').describe('The category of the search (search only)'),
    searchDepth: z.enum(['basic', 'advanced']).optional().default('basic').describe('Search depth. Advanced uses more AI processing for deeper research.'),
    includeAnswer: z.boolean().optional().default(true).describe('Generate a concise AI-summarized answer from the results (search only)'),
    includeImages: z.boolean().optional().default(false).describe('Fetch an array of relevant image URLs (search only)'),
    includeRawContent: z.boolean().optional().default(false).describe('Include the full markdown text of the retrieved pages'),
    numResults: z.number().optional().default(5).describe('Number of raw search results to return')
  }),
  outputSchema: z.any(),
  execute: async (input: any) => {
    console.log(`[Tool: web_search] Tavily AI Action: ${input.action}`);
    try {
      const tvlyClient = getNextTavilyClient();

      if (input.action === 'extract') {
        if (!input.urls || input.urls.length === 0) throw new Error("Extract action requires the 'urls' array parameter.");
        
        const response = await tvlyClient.extract(input.urls, {
          extractDepth: input.searchDepth || 'basic',
          includeImages: input.includeImages || false
        });
        return {
          results: response.results,
          failed: response.failedResults
        };
      }
      else if (input.action === 'crawl') {
        if (!input.urls || input.urls.length === 0) throw new Error("Crawl action requires 'urls' array (uses the first URL).");
        const response = await tvlyClient.crawl(input.urls[0], {
          extractDepth: input.searchDepth || 'basic',
          includeImages: input.includeImages || false,
          maxDepth: 2,
          limit: input.numResults || 10
        });
        return response;
      }
      else if (input.action === 'map') {
        if (!input.urls || input.urls.length === 0) throw new Error("Map action requires 'urls' array (uses the first URL).");
        const response = await tvlyClient.map(input.urls[0], {
          limit: input.numResults || 20
        });
        return response;
      }
      else if (input.action === 'research') {
        if (!input.query) throw new Error("Research action requires the 'query' parameter.");
        console.log(`[Tool: web_search] Starting Deep Research Task for: "${input.query}"`);
        const task = await tvlyClient.research(input.query) as any;
        const reqId = task.requestId;
        
        console.log(`[Tool: web_search] Research Task ID: ${reqId}. Polling for completion...`);
        let attempt = 0;
        while (attempt < 120) { // wait up to 4 minutes
          await new Promise(r => setTimeout(r, 2000));
          attempt++;
          const res = await tvlyClient.getResearch(reqId);
          if (res.status !== 'processing' && res.status !== 'pending') {
             return res;
          }
        }
        throw new Error("Research task timed out.");
      }
      else {
        // Default Search Action
        if (!input.query) throw new Error("Search action requires the 'query' parameter.");

        const response = await tvlyClient.search(input.query, {
          searchDepth: input.searchDepth || 'basic',
          topic: input.topic || 'general',
          includeAnswer: input.includeAnswer !== false, // default true
          includeImages: input.includeImages || false,
          includeRawContent: input.includeRawContent ? 'markdown' : false,
          maxResults: input.numResults || 5,
        });
        
        // Safety handling of empty payloads
        if (!response || !response.results || response.results.length === 0) {
           return [{ title: "No Results", url: "", content: "Search returned no results. Try modifying your query." }];
        }
        
        return {
          ai_summary: response.answer || null,
          images: response.images || [],
          results: response.results.map((r: any) => ({
            title: r.title,
            url: r.url,
            content: r.content,
            rawContent: r.rawContent,
            score: r.score
          }))
        };
      }
      
    } catch (error: any) {
      console.warn('[Tool: web_search] Tavily AI failed. Error:', error.message);
      return [{ 
        title: "Search/Extract Error", 
        url: "", 
        content: `Tavily failed: ${error.message}. Try relaxing parameters or using different keywords.` 
      }];
    }
  }
};
