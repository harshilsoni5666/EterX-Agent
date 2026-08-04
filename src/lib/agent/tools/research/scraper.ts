import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import * as cheerio from 'cheerio';
import { redactUrlForLog, safeAxiosRequest } from '../shared/url_safety';
import { enforceToolCapability } from '../security/tool_policy';
import { executeSearchWithFailover } from '../../../search/search-runtime';

export const webScraperTool: ToolDefinition = {
  name: 'web_scraper',
  description: 'Read a webpage through the active External service provider first, using its enabled page-reading service and current key/fallback route. If the provider route is unavailable, use the safe direct reader as a last fallback.',
  category: 'research',
  inputSchema: z.object({
    url: z.string().url().describe('The URL of the webpage to scrape')
  }),
  outputSchema: z.object({
    title: z.string(),
    textContext: z.string(),
    error: z.string().optional(),
    provider: z.string().optional(),
    providerActionMode: z.string().optional(),
  }),
  execute: async (input: { url: string }, context?: any) => {
    console.log(`[Tool: web_scraper] Scraping ${redactUrlForLog(input.url)}`);
    try {
      const decision = enforceToolCapability('web_scraper', input, context);
      if (!decision.allowed) {
        return { title: '', textContext: '', error: decision.reason || 'Web scraping is not allowed' };
      }

      try {
        const routed = await executeSearchWithFailover({ action: 'extract', urls: [input.url], includeRawContent: true }, context);
        const item = routed.results[0];
        if (item) {
          return {
            title: item.title || input.url,
            textContext: String(item.rawContent || item.content || '').substring(0, 15000),
            provider: String(routed.provider),
            providerActionMode: String(routed.providerActionMode || 'configured route'),
          };
        }
      } catch (routeError: any) {
        if (/service is disabled/i.test(String(routeError?.message || ''))) {
          return { title: '', textContext: '', error: routeError.message };
        }
        console.warn('[Tool: web_scraper] Provider route unavailable; using safe direct reader:', routeError?.message || routeError);
      }

      const { data } = await safeAxiosRequest<string>({
        url: input.url,
        method: 'GET',
        timeout: 10000,
        responseType: 'text',
        maxContentLength: 2 * 1024 * 1024,
        headers: { 'User-Agent': 'EterX-Agent/1.0 Web Scraper' },
      }, context);
      const $ = cheerio.load(data);

      // Remove noise
      $('script, style, nav, footer, iframe, noscript').remove();

      const title = $('title').text().trim();
      const textContext = $('body').text().replace(/\s+/g, ' ').trim();

      return {
        title,
        textContext: textContext.substring(0, 15000) // Truncate to avoid context bloom
      };
    } catch (error: any) {
      return { title: '', textContext: '', error: error.message };
    }
  }
};
