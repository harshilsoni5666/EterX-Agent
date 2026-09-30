'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { buildFilePreviewUrl } from '../../lib/path-utils';
import { safeCopyTextToClipboard } from '../ui/copy-button';

type Preview = { filePath?: string; file?: File; name?: string };
export function AttachmentTextPreviewHost() {
  const [request, setRequest] = useState<Preview | null>(null);
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const open = (event: Event) => setRequest((event as CustomEvent<Preview>).detail);
    window.addEventListener('eterx-preview-text', open);
    return () => window.removeEventListener('eterx-preview-text', open);
  }, []);
  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    let alive = true;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    setText(''); setStatus('Loading…');
    const read = async () => {
      try {
        let value: string;
        if (request.file && typeof request.file.text === 'function') value = await request.file.text();
        else {
          if (!request.filePath) throw new Error('Missing attachment');
          const response = await fetch(buildFilePreviewUrl(request.filePath), { signal: controller.signal });
          if (!response.ok) throw new Error('Could not load attachment');
          value = await response.text();
        }
        if (alive) { setText(value); setStatus(''); }
      } catch { if (alive) setStatus('Could not load this attachment. Close and try again.'); }
    };
    void read();
    return () => { alive = false; controller.abort(); previousFocus?.focus({ preventScroll: true }); };
  }, [request]);
  if (!request) return null;
  return createPortal(<dialog ref={dialog} className="eterx-text-preview" aria-labelledby="eterx-text-preview-title"
    onCancel={() => setRequest(null)} onClick={event => { if (event.target === event.currentTarget) setRequest(null); }}>
    <div className="eterx-text-preview-panel">
      <header className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-4">
        <h2 id="eterx-text-preview-title" className="min-w-0 flex-1 truncate text-sm font-semibold">{request.name || 'Pasted text'}</h2>
        <button type="button" disabled={Boolean(status)} className="rounded-md px-2 py-1 text-sm hover:bg-[var(--muted)]"
          onClick={async () => { const ok = await safeCopyTextToClipboard(text); if (!ok) setStatus('Could not copy text'); }}>Copy</button>
        <button type="button" autoFocus onClick={() => setRequest(null)} className="rounded-md px-2 py-1 text-sm hover:bg-[var(--muted)]">Close</button>
      </header>
      {status && <p role="status" className="px-5 py-3 text-sm">{status}</p>}
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-5 text-[13px] leading-relaxed [overflow-wrap:anywhere]">{text}</pre>
      <footer className="border-t border-[var(--border)] px-5 py-3 text-xs text-[var(--muted-foreground)]">{text.length.toLocaleString()} characters · {text ? text.split('\n').length.toLocaleString() : 0} lines</footer>
    </div>
  </dialog>, document.body);
}
