'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, type CSSProperties } from 'react';
import type { AnnouncementDraft } from '../../lib/app-presentation/contract';
import { AnnouncementMessage } from './announcement-content';

export function AnnouncementDialog({ announcement, dismiss, preview = false }: {
  announcement: AnnouncementDraft; dismiss: () => void; preview?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  return (
    <dialog ref={ref} className="eterx-announcement" aria-labelledby={titleId}
      style={{ '--announcement-width': announcement.width + 'px' } as CSSProperties}
      onCancel={event => { event.preventDefault(); dismiss(); }}>
      <div className="eterx-announcement-frame">
        <header className="eterx-announcement-header">
          <h1 id={titleId}>{announcement.title}</h1>
          <button type="button" className="eterx-announcement-close" aria-label="Close announcement" autoFocus onClick={dismiss}>
            <X size={17} strokeWidth={1.8} />
          </button>
        </header>
        <div className="eterx-announcement-scroll" tabIndex={0} aria-label="Announcement details">
          <AnnouncementMessage announcement={announcement} preview={preview} />
        </div>
      </div>
    </dialog>
  );
}
