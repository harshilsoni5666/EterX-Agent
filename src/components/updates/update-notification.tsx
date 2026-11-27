'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Sparkles, X } from 'lucide-react';
import type { DesktopUpdateState } from '../../lib/desktop-updates';
import { ReleaseNotesContent } from './release-notes';

type UpdateNotificationProps = {
  state: DesktopUpdateState;
  onOpen: () => void;
  onDismiss: () => void;
};

export function UpdateNotification({ state, onOpen, onDismiss }: UpdateNotificationProps) {
  const previewRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const notes = state.releaseNotes && state.releaseNotes.version === state.availableVersion ? state.releaseNotes : null;
  const needsAttention = state.status === 'error';
  const StatusIcon = needsAttention ? AlertTriangle : state.downloadReady ? CheckCircle2 : Sparkles;
  const title = needsAttention ? 'Update needs attention' : state.downloadReady ? 'Ready to restart' : 'Update available';

  useEffect(() => {
    const preview = previewRef.current;
    const content = contentRef.current;
    if (!preview || !content) return;
    let active = true;
    const measureOverflow = () => {
      if (active) setOverflows(preview.scrollHeight > preview.clientHeight + 1);
    };
    measureOverflow();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measureOverflow) : null;
    observer?.observe(preview);
    observer?.observe(content);
    window.addEventListener('resize', measureOverflow);
    void document.fonts?.ready.then(measureOverflow).catch(() => {});
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener('resize', measureOverflow);
    };
  }, [notes, state.message, needsAttention]);

  return (
    <aside className="eterx-update-notice pointer-events-auto relative flex min-h-0 w-full flex-col overflow-hidden rounded-2xl border shadow-xl" aria-label="Application update">
      <div className="pointer-events-none flex shrink-0 items-center gap-3 px-4 pb-3 pt-4 pr-12" role="status" aria-live="polite" aria-atomic="true">
        <span className="eterx-release-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" aria-hidden="true">
          <StatusIcon size={17} />
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold leading-5">{title}</p>
          <p className="eterx-release-muted mt-0.5 break-words text-[11px]">EterX {state.availableVersion}</p>
          {notes && <span className="sr-only">{notes.summary}</span>}
        </div>
      </div>

      <div ref={previewRef} className="eterx-update-preview pointer-events-none relative mx-4 min-h-0 overflow-hidden" aria-hidden="true">
        <div ref={contentRef} className="pb-3">
          {needsAttention && <p className="eterx-release-muted mb-4 line-clamp-3 break-words text-[12px] leading-relaxed [overflow-wrap:anywhere]">{state.message}</p>}
          <h3 className="mb-2.5 text-[12px] font-semibold">What’s New</h3>
          <ReleaseNotesContent notes={notes} compact />
        </div>
        {overflows && <div className="eterx-update-notice-fade absolute inset-x-0 bottom-0 h-14" aria-hidden="true" />}
      </div>

      <div className="eterx-update-notice-footer pointer-events-none flex shrink-0 items-center justify-between gap-3 border-t px-4 py-3 text-[11.5px] font-medium">
        <span>{overflows ? 'Read all highlights' : 'View update details'}</span>
        <ArrowRight size={14} aria-hidden="true" />
      </div>
      {/* One native button covers the card; dismissal is a separate sibling.
          Clicking any content opens Settings, without downloading/restarting. */}
      <button type="button" className="eterx-update-notice-open absolute inset-0 z-10 cursor-pointer rounded-2xl" onClick={onOpen} aria-label={`Read what’s new in EterX ${state.availableVersion} in Settings`} />
      <button type="button" aria-label="Dismiss update notification" className="absolute right-2.5 top-2.5 z-20 flex h-7 w-7 items-center justify-center rounded-lg opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" onClick={onDismiss}>
        <X size={15} aria-hidden="true" />
      </button>
    </aside>
  );
}
