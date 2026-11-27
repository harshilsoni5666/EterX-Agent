import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { announcementImageSource, announcementLink } from './contract';

export const ANNOUNCEMENT_TAGS = [
  'p', 'br', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 's', 'del',
  'blockquote', 'code', 'pre', 'hr', 'a', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span',
] as const;
type Tag = typeof ANNOUNCEMENT_TAGS[number];
export type AnnouncementNode = { text: string } | { tag: Tag; attributes: Record<string, string>; children: AnnouncementNode[] };

const allowed = new Set<string>(ANNOUNCEMENT_TAGS);
const discarded = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'form', 'link', 'meta', 'base',
  'audio', 'video', 'canvas', 'select', 'button', 'textarea',
]);
const voidTags = new Set(['br', 'hr', 'img']);

export function readAnnouncementHtml(html: string): AnnouncementNode[] {
  let remaining = 3_000;
  const read = (nodes: DefaultTreeAdapterTypes.ChildNode[], depth: number): AnnouncementNode[] => {
    if (depth > 32 || remaining <= 0) return [];
    const output: AnnouncementNode[] = [];
    for (const node of nodes) {
      if (remaining-- <= 0) break;
      if ('value' in node && node.nodeName === '#text') {
        output.push({ text: node.value });
        continue;
      }
      if (!('tagName' in node) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || discarded.has(node.tagName)) continue;
      const children = read(node.childNodes, depth + 1);
      if (!allowed.has(node.tagName)) {
        output.push(...children);
        continue;
      }

      let tag = node.tagName as Tag;
      const attribute = (name: string) => node.attrs.find(item => item.name === name && !item.namespace)?.value;
      const attributes: Record<string, string> = {};
      if (tag === 'a') {
        const href = announcementLink(attribute('href'));
        if (href) attributes.href = href;
        else tag = 'span';
      }
      if (tag === 'img') {
        const src = announcementImageSource(attribute('src'));
        if (!src) continue;
        attributes.src = src;
        attributes.alt = (attribute('alt') ?? '').slice(0, 200);
      }
      if (tag === 'ol') {
        const start = attribute('start');
        if (start && /^\d{1,4}$/.test(start)) attributes.start = start;
      }
      output.push({ tag, attributes, children });
    }
    return output;
  };
  return read(parseFragment(html, { scriptingEnabled: false }).childNodes, 0);
}

function escape(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function sanitizeAnnouncementHtml(body: string) {
  function serialize(node: AnnouncementNode): string {
    if ('text' in node) return escape(node.text);
    const { tag, attributes, children } = node;
    const props = Object.entries(attributes).map(([key, value]) => ' ' + key + '="' + escape(value) + '"').join('');
    const start = '<' + tag + props + '>';
    return voidTags.has(tag) ? start : start + children.map(serialize).join('') + '</' + tag + '>';
  }
  const nodes = readAnnouncementHtml(body);
  const hasContent = (node: AnnouncementNode): boolean =>
    'text' in node ? Boolean(node.text.trim()) : node.tag === 'img' || node.children.some(hasContent);
  return nodes.some(hasContent) ? nodes.map(serialize).join('').trim() : '';
}
