'use client';

import { memo, useMemo, useRef } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { buildFilePreviewUrl, isAbsolutePathLike } from '../../lib/path-utils';
import { decodeLocalFileHref, encodeLocalFileHref } from './local-file-link';
import { markdownComponents, remarkPlugins, rehypePlugins } from './markdown-renderer';
import { revealInWorkspaceScroller } from './workspace-scroll';

export const isMarkdownDocument = (path: string) => /\.(md|markdown|mdown|mkd|mdx)$/i.test(path);

// Document headings use familiar #section anchors, including duplicate headings.
// Mark fenced/indented code explicitly so even a single line stays a code block.
function remarkDocumentStructure() {
  return (tree: any) => {
    const used = new Set<string>();
    const text = (node: any): string => typeof node.value === 'string'
      ? node.value : (node.children || []).map(text).join('');
    const visit = (node: any) => {
      if (node.type === 'heading' || node.type === 'code') {
        node.data ||= {};
        node.data.hProperties ||= {};
        if (node.type === 'heading') {
          const slug = text(node).trim().toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-') || 'section';
          let id = slug, suffix = 0;
          while (used.has(id)) id = `${slug}-${++suffix}`;
          used.add(id);
          node.data.hProperties.id = id;
        } else node.data.hProperties['data-document-code'] = true;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

const documentRemarkPlugins = [...remarkPlugins, remarkDocumentStructure];
const MarkdownCode = markdownComponents.code;

function resolveDocumentUrl(url: string, path: string, key: string) {
  const native = /^(?:#?eterx-local-file:|file:|[a-z]:[\\/]|\\\\)/i.test(url)
    ? decodeLocalFileHref(url) : null;
  if (!native && /^(?:#|\/\/|[a-z][\w+.-]*:)/i.test(url)) return defaultUrlTransform(url);
  if (!url) return '';
  let target = native || url.split(/[?#]/)[0];
  if (!native) { try { target = decodeURIComponent(target); } catch {} }
  if (!target) return '';
  const resolved = isAbsolutePathLike(target) ? target : path.replace(/[\\/][^\\/]*$/, '') + '/' + target;
  return key === 'src' ? buildFilePreviewUrl(resolved) : encodeLocalFileHref(resolved);
}

export const WorkspaceMarkdownPreview = memo(function WorkspaceMarkdownPreview({ content, path, onOpenFile }: {
  content: string;
  path: string;
  onOpenFile: (path: string) => void;
}) {
  const article = useRef<HTMLElement>(null);
  const openFile = useRef(onOpenFile);
  openFile.current = onOpenFile;
  const components = useMemo(() => ({
    ...markdownComponents,
    // File contents are rendered as authored, without the chat renderer's path
    // chips or executable HTML/JS preview fences. MDX is displayed as Markdown.
    code: ({ node, className, children, ...props }: any) => {
      if (!node?.properties?.['data-document-code']) {
        return <code className="eterx-markdown-inline-code">{children}</code>;
      }
      const language = /language-([^\s]+)/.exec(className || '')?.[1] || '';
      const sourceLanguage: Record<string, string> = { 'js-preview': 'javascript', 'html-preview': 'html', 'react-preview': 'jsx', preview: 'text' };
      return <MarkdownCode node={node} inline={false} className={`language-${sourceLanguage[language] || language || 'text'}`} {...props}>{children}</MarkdownCode>;
    },
    a: ({ node, href, children, ...props }: any) => {
      const local = decodeLocalFileHref(href);
      const anchor = !local && href?.startsWith('#');
      return <a {...props} href={href} className="eterx-workspace-markdown-link"
        target={!local && !anchor ? '_blank' : undefined} rel={!local && !anchor ? 'noopener noreferrer' : undefined}
        onClick={event => {
          if (local) { event.preventDefault(); openFile.current(local); }
          else if (anchor) {
            event.preventDefault();
            let id = href.slice(1);
            try { id = decodeURIComponent(id); } catch {}
            const target = Array.from(article.current?.querySelectorAll<HTMLElement>('[id]') || []).find(element => element.id === id);
            const scroller = article.current?.closest<HTMLElement>('.eterx-workspace-document-scroll');
            if (target && scroller) revealInWorkspaceScroller(scroller, target, 'start');
            if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
          }
        }}>{children}</a>;
    },
    img: ({ node, alt, src, title }: any) => <img src={src} alt={alt || ''} title={title} loading="lazy" decoding="async" className="eterx-workspace-markdown-image" />,
  }), []);

  return <article ref={article} className="eterx-workspace-markdown" aria-label={`Preview of ${path.split(/[\\/]/).pop()}`}>
    {content.trim() ? <ReactMarkdown remarkPlugins={documentRemarkPlugins} rehypePlugins={rehypePlugins}
      components={components} urlTransform={(url, key) => resolveDocumentUrl(url, path, key)}>{content}</ReactMarkdown>
      : <p className="eterx-workspace-markdown-empty">This Markdown file is empty.</p>}
  </article>;
});
