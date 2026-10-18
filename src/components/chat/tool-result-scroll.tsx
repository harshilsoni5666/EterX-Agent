import React, { useLayoutEffect, useRef, useState } from 'react';

/** Short results keep their natural height; long results share one reading area. */
export function ToolResultScroll({ children, label, className = '' }: {
  children: React.ReactNode;
  label: string;
  className?: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const measure = () => setOverflow(viewport.scrollHeight - viewport.clientHeight > 2);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    observer?.observe(content);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  return (
    <div ref={viewportRef} className="eterx-tool-result-scroll eterx-activity-child-scroll eterx-scrollbar" role="region" aria-label={label} tabIndex={overflow ? 0 : undefined}>
      <div ref={contentRef} className={`eterx-tool-result-content ${className}`}>{children}</div>
    </div>
  );
}
