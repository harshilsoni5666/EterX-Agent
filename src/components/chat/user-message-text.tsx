'use client';

import React, { useId, useLayoutEffect, useRef, useState } from 'react';

export const UserMessageText = React.memo(({ text }: { text: string }) => {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => setOverflows(node.scrollHeight > 280);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);
  return <div className="eterx-user-query-text min-w-0 w-full text-left">
    <div id={id} ref={content} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
      style={{ maxHeight: expanded ? undefined : 280, overflow: 'hidden',
        maskImage: !expanded && overflows ? 'linear-gradient(black calc(100% - 28px), transparent)' : undefined }}>
      {text}
    </div>
    {overflows && <button type="button" aria-expanded={expanded} aria-controls={id}
      onClick={() => {
        if (expanded && content.current) {
          const scroll = content.current.closest<HTMLElement>('.eterx-chat-feed-scroll');
          if (scroll) {
            const offset = content.current.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
            if (offset < 0) scroll.scrollTop += offset - 16;
          }
        }
        setExpanded(value => !value);
      }}
      className="mt-2 rounded-md px-1 py-1 text-[12px] font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-current">
      {expanded ? 'Show less' : 'Show more'}
    </button>}
  </div>;
});
