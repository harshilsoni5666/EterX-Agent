import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { normalizeReleaseNotes, MAX_RELEASE_NOTES_BYTES, RELEASE_NOTE_LABELS } = require('../electron/release-notes.js');
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const [packageText, source] = await Promise.all([
  readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  readFile(path.join(projectRoot, 'release-notes.json'), 'utf8'),
]);
const { version } = JSON.parse(packageText);
const tagVersion = process.env.RELEASE_TAG?.replace(/^v/, '') || version;
if (tagVersion !== version) throw new Error('The release tag must match package.json before preparing release notes.');
if (Buffer.byteLength(source, 'utf8') > MAX_RELEASE_NOTES_BYTES) throw new Error('Keep release-notes.json under 64 KiB.');
const notes = normalizeReleaseNotes(JSON.parse(source), version);
if (!notes) throw new Error('Update release-notes.json with this version, a summary, and customer-facing highlights. Use each section kind once and at most 100 highlights.');
const outputPath = process.argv[2];
if (!outputPath) throw new Error('Provide the destination path for the generated Markdown release notes.');
const escapeMarkdown = text => text.replace(/([\\`*_{}\[\]()<>#+.!|~>])/g, '\\$1');
const markdown = [
  `# What’s New in EterX ${version}`,
  '',
  escapeMarkdown(notes.summary),
  ...notes.sections.flatMap(section => [
    '',
    `## ${RELEASE_NOTE_LABELS[section.kind]}`,
    '',
    ...section.items.map(item => `- **${escapeMarkdown(item.title)}**${item.description ? ` — ${escapeMarkdown(item.description)}` : ''}`),
  ]),
  '',
].join('\n');
await writeFile(path.resolve(outputPath), markdown, 'utf8');
