import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// @ts-ignore ReactMarkdown's bundled typings vary between minor versions.
import ReactMarkdown from 'react-markdown';
import {
  markdownComponents,
  normalizeMarkdownForRendering,
  remarkPlugins,
  rehypePlugins,
} from '../src/components/chat/markdown-renderer';
import { LocalFileLinkChip, encodeLocalFileHref } from '../src/components/chat/local-file-link';

const renderMarkdown = (value: string) => renderToStaticMarkup(
  <ReactMarkdown
    remarkPlugins={remarkPlugins}
    rehypePlugins={rehypePlugins}
    components={markdownComponents as any}
  >
    {normalizeMarkdownForRendering(value)}
  </ReactMarkdown>,
);

const normalized = normalizeMarkdownForRendering('\uFEFF# Title\r\n\r\n<thought>private stream detail</thought>Visible text\u0000');
assert.equal(normalized, '# Title\n\nVisible text');

const repairedTable = normalizeMarkdownForRendering('| Name | Status |\n| Alice | Ready |');
assert.match(repairedTable, /\| Name \| Status \|\n\| --- \| --- \|/);

const currency = normalizeMarkdownForRendering('Revenue: \\$2,339,235.12$ and AOV: $186.02$');
assert.equal(currency, 'Revenue: \\$2,339,235.12\\$ and AOV: \\$186.02\\$');

const artifactPath = 'C:\\Users\\AAYUSHI\\OneDrive\\Desktop\\Swiggy_Instamart_vs_Zepto_Market_Analysis_2026.docx';
const canonicalArtifactLink = `[Swiggy_Instamart_vs_Zepto_Market_Analysis_2026.docx](${ encodeLocalFileHref(artifactPath) })`;
const escapedArtifactInput = `FILE ${ String.fromCharCode(92) }${ canonicalArtifactLink }`;
const escapedArtifactLink = normalizeMarkdownForRendering(escapedArtifactInput);
assert.equal(escapedArtifactLink, `FILE ${ canonicalArtifactLink }`);
assert.doesNotMatch(escapedArtifactLink, /\$\$[\s\S]*eterx-local-file/);
assert.match(renderMarkdown(escapedArtifactLink), /eterx-local-file-chip/);

const artifactDirectory = 'C:\\Users\\AAYUSHI\\OneDrive\\Desktop\\Fresh_Retail_Sales_2026\\';
const linkedDirectory = normalizeMarkdownForRendering(`Created at: \`${artifactDirectory}\``);
assert.match(linkedDirectory, /eterx-local-file:/);
assert.match(renderMarkdown(linkedDirectory), /eterx-local-file-chip/);

for (const directoryPath of [
  '/Users/aayushi/Desktop/Retail Analysis/',
  '/Volumes/Shared/Retail Analysis/',
  '/home/aayushi/reports/retail-analysis/',
  '/mnt/shared/retail-analysis/',
  '\\\\fileserver\\reports\\retail-analysis\\',
]) {
  const normalizedDirectory = normalizeMarkdownForRendering(`Output: \`${directoryPath}\``);
  assert.match(normalizedDirectory, /eterx-local-file:/);
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
assert.doesNotMatch(decoratedHeadingMarkup, /🔎/);
assert.match(decoratedHeadingMarkup, />Data Cleaning Rules<\/h1>/);

const fileChipMarkup = renderToStaticMarkup(
  <LocalFileLinkChip filePath="C:\\Reports\\Cleaned_Retail_Store_Sales.xlsx" compact />,
);
assert.match(fileChipMarkup, /eterx-local-file-chip/);
assert.match(fileChipMarkup, /h-8 w-8/);

console.log('markdown-renderer.integration: ok');
