import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import axios from 'axios';
import * as cheerio from 'cheerio';

export const webScraperTool: ToolDefinition = {
  name: 'web_scraper',
  description: 'Download and parse the text content of a webpage given a URL. Automatically cleans HTML to return readable text.',
  category: 'research',
  inputSchema: z.object({
    url: z.string().url().describe('The URL of the webpage to scrape')
  }),
  outputSchema: z.object({
    title: z.string(),
    textContext: z.string(),
    error: z.string().optional()
  }),
  execute: async (input: { url: string }) => {
    console.log(`[Tool: web_scraper] Scraping ${ input.url }`);
    try {
      const { data } = await axios.get(input.url, { timeout: 10000 });
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
