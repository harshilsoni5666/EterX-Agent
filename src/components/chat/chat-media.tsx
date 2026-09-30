'use client';

import React, { useEffect, useRef, useState } from 'react';
import { normalizePathForComparison } from '../../lib/path-utils';

export type ChatMediaItem = {
  id: string; name: string; mimeType: string; path: string;
  originalPath?: string; size: number; createdAt: number; previewUrl: string;
};

const EMPTY_MEDIA: ChatMediaItem[] = [];
export const ChatMediaContext = React.createContext<ChatMediaItem[]>(EMPTY_MEDIA);
export const ChatMediaOwnerContext = React.createContext<string | null>(null);

export function findChatMedia(items: ChatMediaItem[], attachment: { id?: string; localPath?: string; path?: string }) {
  const path = normalizePathForComparison(attachment.localPath || attachment.path);
  return items.find(item => (attachment.id && item.id === attachment.id) || (path &&
    [item.path, item.originalPath].some(value => normalizePathForComparison(value) === path)));
}

export function useChatMedia(chatId: string | null, revision: string, menuOpen: boolean) {
  const [state, setState] = useState<{ chatId: string; items: ChatMediaItem[] } | null>(null);
  const cache = useRef(new Map<string, ChatMediaItem[]>());
  const [error, setError] = useState<{ chatId: string; message: string } | null>(null);
  const [retryCount, retry] = useState(0);
  useEffect(() => {
    if (!chatId) return;
    const controller = new AbortController();
    void fetch(`/api/chat/media?chatId=${encodeURIComponent(chatId)}`, { signal: controller.signal, cache: 'no-store' })
      .then(response => { if (!response.ok) throw new Error('Attachment catalogue unavailable'); return response.json(); })
      .then(value => {
        if (!controller.signal.aborted && value.chatId === chatId && Array.isArray(value.attachments)) {
          setState({ chatId, items: value.attachments });
          cache.current.delete(chatId);
          cache.current.set(chatId, value.attachments);
          if (cache.current.size > 32) cache.current.delete(cache.current.keys().next().value!);
          setError(null);
        }
      }).catch(() => {
        if (!controller.signal.aborted) setError({ chatId, message: 'Could not load saved attachments.' });
      });
    return () => controller.abort();
  }, [chatId, revision, menuOpen, retryCount]);
  return {
    items: state?.chatId === chatId ? state.items : cache.current.get(chatId || '') || EMPTY_MEDIA,
    error: error?.chatId === chatId ? error.message : '',
    retry: () => retry(value => value + 1),
  };
}
