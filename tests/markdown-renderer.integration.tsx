import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// @ts-ignore ReactMarkdown's bundled typings vary between minor versions.
import ReactMarkdown from 'react-markdown';
import {
  MarkdownStreamContext,
  markdownComponents,
  normalizeMarkdownForRendering,
  remarkPlugins,
  rehypePlugins,
  replyRemarkPlugins,
} from '../src/components/chat/markdown-renderer';
import { LocalFileLinkChip, encodeLocalFileHref } from '../src/components/chat/local-file-link';
import { RICH_ANSWER_POLICY } from '../src/lib/agent/response-format';
import { ANSWER_VISUAL_LANGUAGE, parseAnswerVisual } from '../src/lib/markdown/answer-visual';

const renderMarkdown = (value: string, { streaming = false, reply = true } = {}) => renderToStaticMarkup(
  <MarkdownStreamContext.Provider value={streaming}>
    <ReactMarkdown
      remarkPlugins={reply ? replyRemarkPlugins : remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={markdownComponents as any}
    >
      {normalizeMarkdownForRendering(value)}
    </ReactMarkdown>
  </MarkdownStreamContext.Provider>,
);

const normalized = normalizeMarkdownForRendering('\uFEFF# Title\r\n\r\n<thought>private stream detail</thought>Visible text\u0000');
assert.equal(normalized, '# Title\n\nVisible text');

const authoredTable = normalizeMarkdownForRendering('| Name | Status |\n| Alice | Ready |');
assert.equal(authoredTable, '| Name | Status |\n| Alice | Ready |');

const currency = normalizeMarkdownForRendering('Revenue: \\$2,339,235.12$ and AOV: $186.02$');
assert.equal(currency, 'Revenue: \\$2,339,235.12$ and AOV: $186.02$');

const artifactPath = 'C:\\Users\\AAYUSHI\\OneDrive\\Desktop\\Swiggy_Instamart_vs_Zepto_Market_Analysis_2026.docx';
const canonicalArtifactLink = `[Swiggy_Instamart_vs_Zepto_Market_Analysis_2026.docx](${ encodeLocalFileHref(artifactPath) })`;
const escapedArtifactInput = `FILE ${ String.fromCharCode(92) }${ canonicalArtifactLink }`;
const escapedArtifactLink = normalizeMarkdownForRendering(escapedArtifactInput);
assert.equal(escapedArtifactLink, escapedArtifactInput);
assert.doesNotMatch(renderMarkdown(escapedArtifactLink), /eterx-local-file-chip/);

const artifactDirectory = 'C:\\Users\\AAYUSHI\\OneDrive\\Desktop\\Fresh_Retail_Sales_2026\\';
const linkedDirectory = normalizeMarkdownForRendering(`Created at: \`${artifactDirectory}\``);
assert.equal(linkedDirectory, `Created at: \`${artifactDirectory}\``);
assert.match(renderMarkdown(linkedDirectory), /eterx-local-file-chip/);

for (const directoryPath of [
  '/Users/aayushi/Desktop/Retail Analysis/',
  '/Volumes/Shared/Retail Analysis/',
  '/home/aayushi/reports/retail-analysis/',
  '/mnt/shared/retail-analysis/',
  '\\\\fileserver\\reports\\retail-analysis\\',
]) {
  const normalizedDirectory = normalizeMarkdownForRendering(`Output: \`${directoryPath}\``);
  assert.equal(normalizedDirectory, `Output: \`${directoryPath}\``);
  assert.match(renderMarkdown(normalizedDirectory), /eterx-local-file-chip/);
}

// An already-authored link containing the full path must not be wrapped a
// second time by the plain-text path linker.
const fullPathLink = normalizeMarkdownForRendering(`[${ artifactPath }](${ encodeLocalFileHref(artifactPath) })`);
assert.doesNotMatch(fullPathLink, /\[\[/);
assert.equal((fullPathLink.match(/eterx-local-file:/g) || []).length, 1);

const markup = renderMarkdown([
  '# A stable heading',
  '',
  'A paragraph with an ![example image](https://example.com/example.png).',
  '',
  '```ts',
  'const answer = true;',
  '```',
].join('\n'));

// Custom code/image renderers must not be nested in ReactMarkdown's default
// block wrappers. Those invalid trees are a common source of browser-specific
// layout repair and disappearing content during streaming.
assert.doesNotMatch(markup, /<pre>\s*<div/);
assert.doesNotMatch(markup, /<p>\s*<figure/);
assert.match(markup, /class="[^"]*eterx-answer-heading-1[^"]*"/);
assert.match(markup, /id="a-stable-heading-\d+"/);
assert.match(markup, /eterx-markdown-image-caption/);

const decoratedHeadingMarkup = renderMarkdown('# 🔎 Data Cleaning Rules');
assert.match(decoratedHeadingMarkup, />🔎 Data Cleaning Rules<\/h1>/);

const fileChipMarkup = renderToStaticMarkup(
  <LocalFileLinkChip filePath="C:\\Reports\\Cleaned_Retail_Store_Sales.xlsx" compact />,
);
assert.match(fileChipMarkup, /eterx-local-file-chip/);
assert.match(fileChipMarkup, /<img[^>]*src="\/icons\/files\/spreadsheet\.svg"[^>]*class="h-4 w-4 /);
assert.match(fileChipMarkup, /aria-label="Open Cleaned_Retail_Store_Sales\.xlsx in default app"/);

// Provider prompt examples must speak the same protocol as the feed renderer.
const examples = [...RICH_ANSWER_POLICY.matchAll(/(\{"type":.*\})\./g)].map(match => match[1]);
assert.deepEqual(examples.map(source => parseAnswerVisual(source)?.type), ['metrics', 'bar', 'line', 'timeline']);
const visualFence = (source: string, closed = true) => [
  `\`\`\`${ANSWER_VISUAL_LANGUAGE}`, source, ...(closed ? ['```'] : []),
].join('\n');
for (const [index, type] of ['metrics', 'bar', 'line', 'timeline'].entries()) {
  const rendered = renderMarkdown(`Results follow.\n\n${visualFence(examples[index])}\n\nFurther context.`, { streaming: true });
  assert.match(rendered, new RegExp(`data-visual-type="${type}"`));
  assert.match(rendered, /Results follow\./);
  assert.match(rendered, /Further context\./);
  assert.doesNotMatch(rendered, /eterx-code-card /);
}

const incompleteVisual = visualFence(examples[0], false);
assert.equal(renderMarkdown(incompleteVisual, { streaming: true }), '');
assert.match(renderMarkdown(incompleteVisual), /data-language="json"/);
assert.doesNotMatch(renderMarkdown(visualFence(examples[0]), { reply: false }), /data-visual-type/);
assert.doesNotMatch(renderMarkdown('Thanks, that works.'), /data-visual-type|<details/);

for (const source of [
  '{"type":"bar","title":"Invalid","items":[{"label":"Too big","value":1e400}]}',
  '{"type":"timeline","title":"Invalid","domain":[0,4],"items":[{"label":"Outside","start":3,"end":6}]}',
  '{"type":"timeline","title":"Invalid","items":[{"label":"Reverse","start":3,"end":2}]}',
  '{"type":"line","title":"Invalid","items":[{"label":"First","value":null},{"label":"Second","value":1}]}',
  '{"type":"metrics",',
]) {
  assert.equal(parseAnswerVisual(source), null);
  const fallback = renderMarkdown(visualFence(source));
  assert.doesNotMatch(fallback, /data-visual-type/);
  assert.match(fallback, /data-language="json"/);
}

const literal = visualFence(JSON.stringify({ type: 'metrics', title: '<script>alert(1)</script>', items: [{ label: 'Input', value: '<img src=x>' }] }));
assert.match(renderMarkdown(literal), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
assert.doesNotMatch(renderMarkdown(literal), /<(?:script|img) /);
assert.match(renderMarkdown(`> [!DETAILS] Data collection\n>\n> Measured **at source**.\n>\n> ${canonicalArtifactLink}`), /<summary>Data collection<\/summary>.*<strong[^>]*>at source<\/strong>/s);
assert.match(renderMarkdown(`> [!DETAILS] Data collection\n>\n> ${canonicalArtifactLink}`), /eterx-local-file-chip/);
assert.doesNotMatch(renderMarkdown('> \\[!DETAILS] Quoted text\n>\n> Ordinary quote.'), /<details/);

console.log('markdown-renderer.integration: ok');
