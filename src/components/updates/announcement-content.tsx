'use client';

import { createElement, useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { ANNOUNCEMENT_TAGS, readAnnouncementHtml, type AnnouncementNode } from '../../lib/app-presentation/announcement-html';
import { announcementImageSource, announcementLink, type AnnouncementDraft } from '../../lib/app-presentation/contract';

function htmlNodes(nodes: AnnouncementNode[], preview: boolean): ReactNode {
  return nodes.map((node, index) => {
    if ('text' in node) return node.text;
    const { tag, attributes, children } = node;
    const props = { ...attributes, key: index };
    if (tag === 'a') {
      return preview
        ? createElement('span', { key: index, className: 'announcement-preview-link' }, htmlNodes(children, preview))
        : createElement('a', { ...props, target: '_blank', rel: 'noopener noreferrer' }, htmlNodes(children, preview));
    }
    if (tag === 'img') return createElement('img', { ...props, decoding: 'async' });
    if (tag === 'br' || tag === 'hr') return createElement(tag, props);
    return createElement(tag, props, htmlNodes(children, preview));
  });
}

export function AnnouncementContent({ format, body, preview = false }: Pick<AnnouncementDraft, 'format' | 'body'> & { preview?: boolean }) {
  const html = useMemo(() => format === 'html' ? readAnnouncementHtml(body) : [], [format, body]);
  return (
    <div className="app-announcement-content">
      {format === 'html' ? htmlNodes(html, preview) : (
        <ReactMarkdown
          skipHtml
          allowedElements={ANNOUNCEMENT_TAGS}
          unwrapDisallowed
          urlTransform={(url, key) => (key === 'src' ? announcementImageSource(url) : announcementLink(url)) ?? ''}
          components={{
            a: ({ href, children }) => href && !preview
              ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
              : <span className={href ? 'announcement-preview-link' : undefined}>{children}</span>,
            img: ({ src, alt }) => typeof src === 'string' && src
              ? <img src={src} alt={alt || ''} decoding="async" />
              : alt ? <span>{alt}</span> : null,
          }}
        >{body}</ReactMarkdown>
      )}
    </div>
  );
}

export function AnnouncementMessage({ announcement, preview }: { announcement: AnnouncementDraft; preview?: boolean }) {
  return <>
    {announcement.body.trim() && <AnnouncementContent format={announcement.format} body={announcement.body} preview={preview} />}
    {announcement.sections.map((section, index) => (
      <section className="app-announcement-section" key={index}>
        <h2>{section.title}</h2>
        <AnnouncementContent format={section.format} body={section.body} preview={preview} />
      </section>
    ))}
  </>;
}
