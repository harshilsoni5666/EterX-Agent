export type WebSource = { url: string; hostname: string; title: string; favicon?: string };
export type WebActivity = 'search' | 'research' | 'read' | 'crawl' | 'map';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/** Decode recorded JSON without interpreting scripts or arbitrary result fields. */
export function parseToolResult(value: unknown): unknown {
  for (let depth = 0; depth < 4 && typeof value === 'string'; depth++) {
    const input = value.trim();
    if (input.length > 1_000_000 || !/^[\[{]/.test(input)) break;
    try { value = JSON.parse(input); } catch { break; }
  }
  return value;
}

export function webSourceUrl(value: unknown): string | null {
  const input = text(value);
  if (!/^https?:\/\//i.test(input) || /[\s\u0000-\u001f]/.test(input)) return null;
  try {
    const url = new URL(input);
    return url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function getWebActivity(log: Record<string, any>, result?: unknown): WebActivity | null {
  const name = text(log.toolName || log.tool || log.name)
    .replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[.\s-]+/g, '_');
  if (name === 'image_asset_search') return null;
  const webTool = /(?:^|_)(?:web_search|search_web|browser_search|web_fetch|fetch_url|read_url|read_web_page|web_research|deep_research|research|crawl_website|map_website|(?:tavily|firecrawl|exa|brave)_(?:search|extract|scrape|crawl|map|research)|web_+run)$/.test(name);
  const label = text(log.text).toLowerCase();
  if (!webTool && log.iconCategory !== 'web_search'
    && !/^(?:researching|deep researching|searched the web|searching the web|web searched|reading source|read web page)$/.test(label)) return null;
  const args = object(parseToolResult(log.toolArgs || log.args));
  const data = object(parseToolResult(result ?? log.toolResult ?? log.result));
  const action = text(args.action || data.providerAction || data.action).toLowerCase();
  if (action === 'research' || /(?:^|_)research$/.test(name) || label === 'deep researching' || data.research === true) return 'research';
  if (action === 'crawl' || /(?:^|_)crawl(?:_website)?$/.test(name)) return 'crawl';
  if (action === 'map' || /(?:^|_)map(?:_website)?$/.test(name)) return 'map';
  if (['extract', 'read', 'fetch', 'scrape'].includes(action) || /(?:fetch|read_url|read_web_page|extract|scrape)/.test(name)
    || /^(?:reading source|read web page)$/.test(label)) return 'read';
  return 'search';
}

export const WEB_ACTIVITY_LABELS: Record<WebActivity, { done: string; live: string; failed: string }> = {
  search: { done: 'Searched the web', live: 'Searching the web', failed: 'Web search failed' },
  research: { done: 'Researched the web', live: 'Researching the web', failed: 'Web research failed' },
  read: { done: 'Read web sources', live: 'Reading web sources', failed: 'Could not read web sources' },
  crawl: { done: 'Explored website', live: 'Exploring website', failed: 'Could not explore website' },
  map: { done: 'Mapped website', live: 'Mapping website', failed: 'Could not map website' },
};

/** Sources come from results, never from a query, requested URL, or provider endpoint. */
export function extractWebSources(result: unknown): WebSource[] {
  const sources = new Map<string, WebSource>();
  const visited = new WeakSet<object>();
  let remaining = 4_000;
  const add = (value: unknown, title?: unknown, favicon?: unknown) => {
    const url = webSourceUrl(value);
    if (!url) return;
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./i, '');
    let icon: string | undefined;
    if (text(favicon)) {
      try { icon = webSourceUrl(new URL(text(favicon), parsed.origin).href) || undefined; } catch { /* Use the site's fallback icon. */ }
    }
    const previous = sources.get(url);
    sources.set(url, { url, hostname, title: text(title) || previous?.title || hostname, favicon: icon || previous?.favicon });
  };
  const visit = (input: unknown, depth = 0) => {
    if (depth > 10 || remaining-- <= 0 || sources.size >= 500) return;
    const value = parseToolResult(input);
    if (typeof value === 'string') {
      const content = value.slice(0, 256_000);
      // Markdown citations and recorded search headings both carry real URLs.
      for (const match of content.matchAll(/https?:\/\/[^\s<>"\u0000-\u001f]+/gi)) {
        let url = match[0].replace(/[.,;:!?\]}]+$/, '');
        while (url.endsWith(')') && (url.match(/\)/g)?.length || 0) > (url.match(/\(/g)?.length || 0)) url = url.slice(0, -1);
        add(url);
      }
      return;
    }
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    const data = object(value);
    if (/^(?:image|image_url|input_image|audio|video)$/.test(text(data.type))) return;
    const metadata = object(data.metadata);
    const url = data.url || data.uri || data.link || data.href || data.source_url || data.sourceUrl || data.sourceURL || metadata.sourceURL || metadata.url;
    add(url, data.title || data.name || metadata.title, data.favicon || data.favicon_url || metadata.favicon);
    for (const key of ['results', 'search_results', 'organic_results', 'sources', 'citations', 'references', 'urls', 'links', 'items', 'pages', 'documents', 'web', 'data', 'result', 'toolResult', 'structuredContent', 'value', 'url_citation', 'annotations', 'groundingChunks', 'groundingMetadata', 'action']) {
      if (data[key] !== undefined) visit(data[key], depth + 1);
    }
    // Do not harvest incidental links from the body of a page we already have.
    if (!webSourceUrl(url)) for (const key of ['content', 'text', 'output', 'answer', 'report', 'ai_summary']) {
      if (data[key] !== undefined) visit(data[key], depth + 1);
    }
  };
  visit(result);
  return [...sources.values()];
}

export function toolResultFailed(result: unknown): boolean {
  const data = object(parseToolResult(result));
  return data.success === false || data.isError === true || data.is_error === true || Boolean(data.error)
    || ['failed', 'error'].includes(text(data.status).toLowerCase());
}

export function getToolMedia(result: unknown): Array<{ src: string; label: string }> {
  const data = object(parseToolResult(result));
  const items = Array.isArray(data.assets) ? data.assets : Array.isArray(data.images) ? data.images : [data];
  return items.flatMap(item => {
    const asset = object(item);
    const src = text(asset.displayUrl || asset.localPath || asset.filePath || asset.filepath || asset.path || asset.publicPath || asset.src || asset.url || item);
    if (!src || !(/^(?:https?:\/\/|data:image\/|\/api\/chat\/media\?)/i.test(src) || /\.(?:png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)(?:[?#]|$)/i.test(src))) return [];
    return [{ src, label: text(asset.filename || asset.title || asset.name || asset.alt) || 'Generated media' }];
  });
}

/** Only views with a defined presentation get a disclosure; unknown results stay quiet. */
export function hasDesignedToolPreview(toolName: unknown, result: unknown): boolean {
  const name = text(toolName).toLowerCase();
  const parsed = parseToolResult(result);
  const data = object(parsed);
  if (data.__eterxContextDigest === true || parsed == null) return false;
  if (name === 'get_skill_guidelines' || name === 'skill_loader') {
    return Boolean(text(parsed) || text(data.guidelines) || text(object(data.output).guidelines) || text(data.content) || text(data.output) || text(data.text) || text(data.message));
  }
  if (name === 'spawn_sub_agent') return Array.isArray(data.agents) || Array.isArray(object(data.graph).nodes);
  if (name === 'database' || name === 'db_query') {
    const rows = Array.isArray(parsed) ? parsed : data.rows;
    return (Array.isArray(rows) && rows.every(row => row !== null && typeof row === 'object' && !Array.isArray(row))) || toolResultFailed(data);
  }
  if (['image_generator', 'image_asset_search', 'video_generator'].includes(name)) return getToolMedia(data).length > 0;
  return false;
}
