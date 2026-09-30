'use client';

import React, { useContext, useEffect, useState } from 'react';
import { buildFilePreviewUrl, isAbsolutePathLike } from '../../lib/path-utils';
import { decodeLocalFileHref, LocalFileWorkspaceContext } from './local-file-link';
import { ChatMediaContext, ChatMediaOwnerContext, findChatMedia } from './chat-media';

export function openChatImage(element: HTMLElement, previewUrl: string, savedImages: string[] = []) {
  const scope = element.closest('.eterx-chat-feed') || element.closest('.eterx-user-attachments') || element.parentElement;
  const images = Array.from(scope?.querySelectorAll<HTMLImageElement>('img[data-chat-image]') || [])
    .map(image => image.currentSrc || image.src).filter(Boolean);
  const resolveUrl = (value: string) => {
    const source = String(value || '').trim();
    if (!source) return '';
    try {
      return new URL(source, window.location.href).href;
    } catch {
      // A renderer can still expose a native path before it has resolved the
      // preview route. Convert it here so one click always reaches the viewer.
      return buildFilePreviewUrl(source);
    }
  };
  const url = resolveUrl(previewUrl);
  const gallery = Array.from(new Set([...savedImages, ...images, url].map(resolveUrl).filter(Boolean)));
  window.dispatchEvent(new CustomEvent('eterx-preview-image', {
    detail: { previewUrl: url, images: gallery },
  }));
}

export function ReplyImage({ src, alt }: { src?: string; alt?: string }) {
  const workspace = useContext(LocalFileWorkspaceContext) as string | null | undefined;
  const media = useContext(ChatMediaContext);
  const chatId = useContext(ChatMediaOwnerContext);
  const [retained, setRetained] = useState<{ key: string; url: string } | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const local = src?.startsWith('/api/') ? null : decodeLocalFileHref(src || '');
  const isAbsolute = local ? isAbsolutePathLike(local) : false;
  const path = local && !isAbsolute && workspace
    ? `${workspace.replace(/[\\/]+$/, '')}/${local.replace(/^\.\//, '')}` : local;
  const saved = path ? findChatMedia(media, { path }) : undefined;
  const retentionKey = JSON.stringify([chatId, path]);
  useEffect(() => {
    if (!chatId || !path || !isAbsolutePathLike(path) || saved) return;
    let active = true;
    void fetch('/api/chat/media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, path }),
    }).then(async response => {
      if (!response.ok) return;
      const value = await response.json();
      if (active && typeof value.previewUrl === 'string') {
        setRetained({ key: retentionKey, url: value.previewUrl });
      }
    }).catch(() => { /* Keep the original preview available if saving fails. */ });
    return () => { active = false; };
  }, [chatId, path, saved, retentionKey]);
  const url = saved?.previewUrl || (retained?.key === retentionKey ? retained.url : undefined)
    || (path ? buildFilePreviewUrl(path) : src);
  if (!url) return null;
  return <span className="eterx-markdown-figure my-4" role="figure">
    <button type="button" className="block max-w-full overflow-hidden rounded-xl text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={`Open image: ${alt || 'Image'}`} onClick={event => openChatImage(event.currentTarget, url, media.filter(item => item.mimeType.startsWith('image/')).map(item => item.previewUrl))}>
      {failedSource === url ? <span className="block rounded-xl bg-[var(--muted)] px-4 py-3 text-sm">Image unavailable · {alt || 'Image'}</span>
        : <img key={url} data-chat-image src={url} alt={alt || ''} loading="lazy" decoding="async" onError={() => setFailedSource(url)} onLoad={() => setFailedSource(null)} className="eterx-markdown-image rounded-xl" />}
    </button>
    {alt && <span className="eterx-markdown-image-caption mt-2 text-[12px]">{alt}</span>}
  </span>;
}
