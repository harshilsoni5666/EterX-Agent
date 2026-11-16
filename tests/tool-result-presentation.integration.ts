import assert from 'node:assert/strict';
import { extractWebSources, getWebActivity, hasDesignedToolPreview, toolResultFailed, webSourceUrl } from '../src/lib/tool-result-presentation';
import { getActionSummary } from '../src/components/chat/action-summary';

const source = { title: 'A source article', url: 'https://www.example.com/article?q=test#section', favicon: '/icon.png' };
const results = extractWebSources({
  query: 'https://query-only.example',
  results: [null, source, { ...source, favicon: undefined }, { url: 'https://www.example.com/second' }, { url: 'javascript:alert(1)' }],
  failedProviders: [{ url: 'https://provider-endpoint.example' }],
});
assert.equal(results.length, 2, 'duplicate pages collapse, while separate pages on one site remain available');
assert.deepEqual(results[0], { ...source, hostname: 'example.com', favicon: 'https://www.example.com/icon.png' });
assert.equal(results[1].url, 'https://www.example.com/second');

assert.deepEqual(extractWebSources({ structuredContent: { results: [source] }, content: [{ type: 'text', text: JSON.stringify({ sources: [source] }) }] }), [results[0]]);
assert.equal(extractWebSources(JSON.stringify({ data: { citations: [{ url: source.url, title: source.title, favicon: source.favicon }] } }))[0].url, source.url);
assert.equal(extractWebSources({ groundingMetadata: { groundingChunks: [{ web: { uri: source.url, title: source.title } }] } })[0].url, source.url);
assert.deepEqual(extractWebSources({ links: ['https://example.com/a', 'https://example.com/b'] }).map(item => item.url), ['https://example.com/a', 'https://example.com/b']);
assert.deepEqual(extractWebSources('Article (https://example.com/entry_(topic))\n[Next](https://example.org/news).').map(item => item.url), ['https://example.com/entry_(topic)', 'https://example.org/news']);
assert.deepEqual(extractWebSources({ results: [{ url: 'https://example.com/page', content: 'Incidental link: https://unrelated.example' }] }).map(item => item.url), ['https://example.com/page']);
assert.deepEqual(extractWebSources({ results: [], query: source.url, images: [{ url: source.url }] }), []);
assert.deepEqual(extractWebSources('{ malformed result'), []);
const cyclic: Record<string, unknown> = { sources: [source] }; cyclic.data = cyclic;
assert.equal(extractWebSources(cyclic).length, 1, 'malformed cyclic results cannot lock the transcript');
for (const url of ['javascript:alert(1)', 'file:///private.txt', 'data:text/html,hello', 'https://user:password@example.com', 'https://', 'https://example.com/a b']) assert.equal(webSourceUrl(url), null);

for (const name of ['web_search', 'webSearch', 'functions.web_search', 'mcp__search__web_search', 'search_web', 'browser_search', 'web.run', 'web__run']) {
  assert.equal(getWebActivity({ toolName: name }), 'search', name);
}
for (const action of ['search', 'research', 'crawl', 'map', 'extract'] as const) {
  const activity = action === 'extract' ? 'read' : action;
  assert.equal(getWebActivity({ toolName: 'web_search', toolArgs: { action } }), activity);
  assert.equal(getWebActivity({ toolName: 'web_search' }, { providerAction: action }), activity);
}
assert.equal(getWebActivity({ toolName: 'web_fetch' }), 'read');
assert.equal(getWebActivity({ toolName: 'deep_research' }), 'research');
assert.equal(getWebActivity({ toolName: 'workspace_run_command', text: 'Running command', secondary: 'research web_search' }), null);
assert.equal(getWebActivity({ toolName: 'image_asset_search' }), null);
assert.equal(getWebActivity({ toolName: 'search_codebase', iconCategory: 'search' }), null);
assert.equal(getActionSummary({ toolName: 'web_search', toolArgs: { action: 'research' } }).singular, 'Researched the web');
assert.equal(getActionSummary({ toolName: 'imported_action_results' }).singular, 'Tool sequence results');

for (const result of ['raw transcript', { secret: { nested: 'raw JSON' } }, { results: [source] }, { success: true, output: 'raw output' }]) {
  assert.equal(hasDesignedToolPreview('unknown_tool', result), false);
  assert.equal(hasDesignedToolPreview('imported_action_results', result), false);
}
assert.equal(hasDesignedToolPreview('get_skill_guidelines', { guidelines: '# Guidance' }), true);
assert.equal(hasDesignedToolPreview('spawn_sub_agent', { agents: [{ name: 'Researcher', status: 'completed' }] }), true);
assert.equal(hasDesignedToolPreview('db_query', { rows: [{ name: 'A', count: 3 }] }), true);
assert.equal(hasDesignedToolPreview('db_query', { rows: [null, 1] }), false);
assert.equal(hasDesignedToolPreview('image_asset_search', { assets: [{ localPath: 'C:/images/one.png' }] }), true);
assert.equal(hasDesignedToolPreview('image_generator', { provider: 'test', internal: { token: 1 } }), false);
assert.equal(hasDesignedToolPreview('get_skill_guidelines', { __eterxContextDigest: true, evidence: 'raw evidence' }), false);
assert.equal(toolResultFailed(JSON.stringify({ success: false })), true);
assert.equal(toolResultFailed({ results: [], failedProviders: [{ error: 'A fallback provider failed' }] }), false);
console.log('Tool result presentation integration tests passed');
