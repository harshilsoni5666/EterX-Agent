import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import axios from 'axios';

/**
 * RSS Feed Reader
 * 
 * Fetches and parses RSS/Atom feeds. Zero external dependencies — 
 * uses regex-based XML parsing for maximum reliability.
 */
export const rssFeedTool: ToolDefinition = {
  name: 'rss_feed_reader',
  description: 'Fetch and parse RSS/Atom feeds from any URL. Returns structured article data with title, description, date, link, and author. Use this for news monitoring, content aggregation, blog tracking, or competitor research.',
  category: 'research',
  inputSchema: z.object({
    feedUrl: z.string().url().describe('The URL of the RSS/Atom feed'),
    maxItems: z.number().optional().default(10).describe('Maximum number of items to return (default: 10)')
  }),
  outputSchema: z.object({
    feedTitle: z.string(),
    items: z.array(z.object({
      title: z.string(),
      link: z.string(),
      description: z.string(),
      pubDate: z.string(),
      author: z.string()
    })),
    error: z.string().optional()
  }),
  execute: async (input: { feedUrl: string, maxItems?: number }) => {
    console.log(`[Tool: rss_feed_reader] Fetching feed: ${input.feedUrl}`);

    try {
      const { data: xml } = await axios.get(input.feedUrl, {
        headers: {
          'User-Agent': 'EterX-Agent/1.0 RSS Reader',
          'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml'
        },
        timeout: 15000
      });

      const maxItems = input.maxItems || 10;

      // Detect feed type (RSS vs Atom)
      const isAtom = xml.includes('<feed') && xml.includes('xmlns="http://www.w3.org/2005/Atom"');

      // Extract feed title
      const feedTitleMatch = xml.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
      const feedTitle = feedTitleMatch ? feedTitleMatch[1].trim() : 'Unknown Feed';

      const items: any[] = [];

      if (isAtom) {
        // Parse Atom feed
        const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
        let match;
        while ((match = entryRegex.exec(xml)) !== null && items.length < maxItems) {
          const entry = match[1];
          items.push({
            title: extractTag(entry, 'title'),
            link: extractAtomLink(entry),
            description: stripHtml(extractTag(entry, 'summary') || extractTag(entry, 'content')).substring(0, 500),
            pubDate: extractTag(entry, 'published') || extractTag(entry, 'updated') || '',
            author: extractTag(entry, 'name') || ''
          });
        }
      } else {
        // Parse RSS feed
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        while ((match = itemRegex.exec(xml)) !== null && items.length < maxItems) {
          const item = match[1];
          items.push({
            title: extractTag(item, 'title'),
            link: extractTag(item, 'link'),
            description: stripHtml(extractTag(item, 'description')).substring(0, 500),
            pubDate: extractTag(item, 'pubDate') || extractTag(item, 'dc:date') || '',
            author: extractTag(item, 'author') || extractTag(item, 'dc:creator') || ''
          });
        }
      }

      return { feedTitle, items, totalFound: items.length };

    } catch (error: any) {
      return { feedTitle: '', items: [], error: `Failed to fetch/parse feed: ${error.message}` };
    }
  }
};

// --- Helpers ---

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

function extractAtomLink(entry: string): string {
  const linkMatch = entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/);
  return linkMatch ? linkMatch[1] : '';
}

function stripHtml(str: string): string {
  return str.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}
