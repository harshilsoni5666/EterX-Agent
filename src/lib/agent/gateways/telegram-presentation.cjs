'use strict';

const path = require('path');
const { fileURLToPath } = require('url');

function localPathFromHref(value) {
  let href = String(value || '').trim().replace(/^<|>$/g, '');
  try {
    if (/^#?eterx-local-file:/i.test(href)) href = decodeURIComponent(href.replace(/^#?eterx-local-file:/i, ''));
    else if (/^file:\/\//i.test(href)) href = fileURLToPath(href);
  } catch { return null; }
  if (/[\0\r\n]/.test(href)) return null;
  return path.isAbsolute(href) || path.win32.isAbsolute(href) ? href : null;
}

function localFileKey(value) {
  const file = localPathFromHref(value) || String(value || '');
  return /^[a-z]:[\\/]|^\\\\/i.test(file) ? path.win32.normalize(file).toLowerCase() : path.normalize(file);
}
const filename = value => String(value || '').replace(/\\/g, '/').split('/').pop() || 'File';
const internalHref = value => /^(?:#?eterx-local-file:|file:|sandbox:)/i.test(value) || Boolean(localPathFromHref(value));

// Balanced delimiters preserve spaces and parentheses in real filenames.
function readLink(source, start) {
  const image = source[start] === '!';
  const open = start + (image ? 1 : 0);
  if (source[open] !== '[') return null;
  let i = open + 1; let depth = 1;
  for (; i < source.length && depth; i++) {
    if (source[i] === '\\' && /[\[\]\\]/.test(source[i + 1] || '')) { i++; continue; }
    if (source[i] === '[') depth++;
    if (source[i] === ']') depth--;
  }
  if (depth || source[i] !== '(') return null;
  const label = source.slice(open + 1, i - 1);
  const hrefStart = ++i;
  let angle = false; depth = 1;
  for (; i < source.length; i++) {
    if (source[i] === '\n') return null;
    if (source[i] === '<' && i === hrefStart) angle = true;
    if (source[i] === '>' && angle) { angle = false; continue; }
    if (angle) continue;
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) break;
  }
  if (i >= source.length) return null;
  const raw = source.slice(hrefStart, i).trim();
  const url = raw.startsWith('<') ? raw.slice(1, raw.indexOf('>')) : raw.replace(/\s+["'][^"']*["']\s*$/, '');
  return { start, end: i + 1, label, url, image, path: localPathFromHref(url), local: internalHref(url) };
}

function localFileLinks(value) {
  const source = String(value || ''); const links = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\' && ['\\', '`', '[', ']', '!', '~'].includes(source[i + 1])) { i++; continue; }
    // Examples inside fenced or inline code are not deliverable instructions.
    if (source[i] === '`' || (source.startsWith('~~~', i) && /^\s{0,3}$/.test(source.slice(source.lastIndexOf('\n', i - 1) + 1, i)))) {
      const delimiter = source.slice(i).match(/^(?:`+|~{3,})/)[0];
      const close = source.indexOf(delimiter, i + delimiter.length);
      if (close < 0) break;
      i = close + delimiter.length - 1; continue;
    }
    if (source[i] !== '[' && !(source[i] === '!' && source[i + 1] === '[')) continue;
    const link = readLink(source, i);
    if (!link) continue;
    if (link.local) links.push(link);
    i = link.end - 1;
  }
  return links;
}

function replaceLocalFileLinks(value, replace) {
  let text = String(value || '');
  for (const link of localFileLinks(text).reverse()) {
    text = text.slice(0, link.start) + replace(link) + text.slice(link.end);
  }
  return text;
}

function cleanText(value) {
  return String(value || '')
    .replace(/<(analysis|thinking|reasoning|thought|scratchpad)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, '')
    .replace(/\r\n?/g, '\n')
    // Older bot history can cause the model to copy the former transport
    // header. Keep it out of new messages as well as removing its injection.
    .replace(/^\s*(?:\[Conversation\s+\d+\]|Conversation\s+\d+)\s*\n/i, '')
    .replace(/\u0000/g, '');
}
function hideInternalLinks(value) {
  return String(value).replace(/#?eterx-local-file:[^\s<>`]+/gi, match => filename(localPathFromHref(match) || 'File'));
}

function renderTelegramText(value) {
  let text = ''; const entities = [];
  const append = value => { text += hideInternalLinks(value); };
  const span = (type, start, extra = {}) => {
    if (text.length > start) entities.push({ type, offset: start, length: text.length - start, ...extra });
  };
  const inline = (source, nesting = 0) => {
    if (nesting > 8) { append(source); return; }
    for (let i = 0; i < source.length;) {
      if (source[i] === '\\' && /[*_`~\[\]()>#+!\\]/.test(source[i + 1] || '')) { append(source[i + 1]); i += 2; continue; }
      if (source[i] === '`') {
        const marker = source.slice(i).match(/^`+/)[0];
        const end = source.indexOf(marker, i + marker.length);
        if (end >= 0) { const start = text.length; append(source.slice(i + marker.length, end)); span('code', start); i = end + marker.length; continue; }
      }
      const link = readLink(source, i);
      if (link) {
        const start = text.length;
        append((link.label || filename(link.path || link.url)).replace(/`/g, '').replace(/^\*+|\*+$/g, ''));
        if (!link.local) {
          try {
            const url = new URL(link.url);
            if (['https:', 'http:', 'mailto:', 'tg:'].includes(url.protocol)) span('text_link', start, { url: url.href });
          } catch { /* Keep the label readable when a URL is incomplete. */ }
        }
        i = link.end; continue;
      }
      const marker = ['**', '__', '~~', '*', '_'].find(item => source.startsWith(item, i)
        && !(item.includes('_') && /[\p{L}\p{N}]/u.test(source[i - 1] || '')));
      if (marker) {
        const end = source.indexOf(marker, i + marker.length);
        if (end > i + marker.length && !/\n\n/.test(source.slice(i, end))) {
          const start = text.length; const before = entities.length;
          inline(source.slice(i + marker.length, end), nesting + 1);
          // Telegram forbids formatting entities that contain inline code.
          if (!entities.slice(before).some(entity => ['code', 'pre'].includes(entity.type))) span(marker === '~~' ? 'strikethrough' : marker.length === 2 ? 'bold' : 'italic', start);
          i = end + marker.length; continue;
        }
      }
      const internal = source.slice(i).match(/^#?eterx-local-file:[^\s<>`]+/i);
      if (internal) { append(filename(localPathFromHref(internal[0]) || 'File')); i += internal[0].length; continue; }
      append(source[i++]);
    }
  };
  const lines = cleanText(value).trim().split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i) append('\n');
    const fence = lines[i].match(/^\s*(`{3,}|~{3,})([\w+-]*)\s*$/);
    if (fence) {
      const content = []; const marker = fence[1];
      while (++i < lines.length && !lines[i].trim().startsWith(marker)) content.push(lines[i]);
      const start = text.length; append(content.join('\n')); span('pre', start, fence[2] ? { language: fence[2] } : {}); continue;
    }
    if (/^\s*\|/.test(lines[i]) && /^\s*\|?\s*:?-{3}/.test(lines[i + 1] || '')) {
      const rows = [lines[i]]; i++;
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(lines[++i]);
      const start = text.length;
      append(rows.map(row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()).join(' · ')).join('\n'));
      span('pre', start); continue;
    }
    const heading = lines[i].match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/);
    if (heading) { const start = text.length; const before = entities.length; inline(heading[1]); if (!entities.slice(before).some(entity => ['code', 'pre'].includes(entity.type))) span('bold', start); continue; }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(lines[i])) continue;
    inline(lines[i].replace(/^(\s*)[-*+]\s+/, '$1• ').replace(/^\s*>\s?/, '│ '));
  }
  return { text, entities: entities.sort((a, b) => a.offset - b.offset || b.length - a.length) };
}

// Telegram entity offsets use UTF-16, as do JS string offsets. Split only at
// code point boundaries and carry clipped entity ranges into every chunk.
function splitTelegramText(rendered, limit = 3500) {
  const parts = []; const max = Math.max(100, Math.min(4000, limit));
  for (let start = 0; start < rendered.text.length;) {
    let end = Math.min(start + max, rendered.text.length);
    if (end < rendered.text.length) {
      const paragraph = rendered.text.lastIndexOf('\n\n', end - 1);
      const line = rendered.text.lastIndexOf('\n', end - 1);
      const space = rendered.text.lastIndexOf(' ', end - 1);
      const boundary = [paragraph, line, space].find(index => index > start + max * 0.55);
      if (boundary !== undefined) end = boundary + 1;
      const unit = rendered.text.charCodeAt(end - 1);
      if (unit >= 0xD800 && unit <= 0xDBFF) end--;
    }
    const entities = rendered.entities.flatMap(entity => {
      const left = Math.max(start, entity.offset); const right = Math.min(end, entity.offset + entity.length);
      return right > left ? [{ ...entity, offset: left - start, length: right - left }] : [];
    }).slice(0, 95);
    const text = rendered.text.slice(start, end);
    if (text.trim()) parts.push({ text, entities });
    start = end;
  }
  return parts;
}
const formatTelegramText = (value, limit) => splitTelegramText(renderTelegramText(value), limit);

module.exports = { localPathFromHref, localFileKey, localFileLinks, replaceLocalFileLinks, cleanText, renderTelegramText, formatTelegramText };
