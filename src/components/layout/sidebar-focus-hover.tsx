import React from 'react';
import { createPortal } from 'react-dom';
import { motion, useIsPresent, useReducedMotion } from 'framer-motion';
import { GitCommitHorizontal } from 'lucide-react';
import type { ChatCommitReceipt } from '../../lib/git/chat-commits';

type PreviewKind = 'chat' | 'commits';
const CHAT_HOVER_DELAY = 900;
const COMMIT_HOVER_DELAY = 400;
export const focusRowExit = {
  opacity: [1, 1, 0],
  transition: { duration: 0.44, times: [0, 0.55, 1] },
};

const COMMIT_BADGE = '[data-focus-commit-badge]';

function previewKind(target: EventTarget | null): PreviewKind | null {
  if (!(target instanceof Element)) return null;
  if (target.closest(COMMIT_BADGE)) return 'commits';
  return target.closest('button, input, textarea') ? null : 'chat';
}

export function FocusChatHover({ children, preview, commits, disabled: preventPreview }: {
  children: React.ReactElement<{ 'aria-describedby'?: string }>;
  preview: React.ReactNode;
  commits: ChatCommitReceipt[];
  disabled: boolean;
}) {
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();
  const disabled = preventPreview || !present;
  const id = React.useId();
  const row = React.useRef<HTMLDivElement>(null);
  const panel = React.useRef<HTMLDivElement>(null);
  const timer = React.useRef<number | undefined>(undefined);
  const hoverKind = React.useRef<PreviewKind | null>(null);
  const [open, setOpen] = React.useState<PreviewKind | null>(null);
  const [position, setPosition] = React.useState<{ left: number; top: number } | null>(null);

  const dismiss = React.useCallback(() => {
    clearTimeout(timer.current);
    hoverKind.current = null;
    setOpen(null);
    setPosition(null);
  }, []);

  React.useEffect(() => () => clearTimeout(timer.current), []);
  React.useEffect(() => {
    if (disabled || (open === 'commits' && !commits.length)) dismiss();
  }, [commits.length, disabled, dismiss, open]);

  React.useLayoutEffect(() => {
    const trigger = open === 'commits' ? row.current?.querySelector(COMMIT_BADGE) : row.current;
    const popover = panel.current;
    if (disabled || !open || !trigger || !popover) return;

    const place = () => {
      const anchor = trigger.getBoundingClientRect();
      const { width, height } = popover.getBoundingClientRect();
      const gap = 8;
      const margin = 10;
      let left = anchor.right + gap;
      let top = anchor.top;
      if (open === 'commits') {
        left = anchor.right - width;
        top = anchor.top - height - gap;
        if (top < margin) top = anchor.bottom + gap;
      } else if (left + width + margin > window.innerWidth) {
        if (anchor.left - width - gap >= margin) left = anchor.left - width - gap;
        else { left = anchor.left; top = anchor.bottom + gap; }
      }
      setPosition({
        left: Math.max(margin, Math.min(left, window.innerWidth - width - margin)),
        top: Math.max(margin, Math.min(top, window.innerHeight - height - margin)),
      });
    };

    place();
    if (open === 'commits') trigger.setAttribute('aria-describedby', id);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : undefined;
    observer?.observe(trigger);
    observer?.observe(popover);
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !row.current?.contains(event.target)) dismiss();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('pointerdown', dismissOutside, true);
    return () => {
      observer?.disconnect();
      if (open === 'commits') trigger.removeAttribute('aria-describedby');
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('pointerdown', dismissOutside, true);
    };
  }, [disabled, dismiss, id, open]);

  const show = (kind: PreviewKind) => {
    if (disabled || (kind === 'commits' && !commits.length)) return;
    clearTimeout(timer.current);
    if (kind !== open) setPosition(null);
    setOpen(kind);
  };

  return (
    <motion.div
      ref={row}
      className="eterx-focus-preview-anchor"
      inert={!present}
      data-focus-leaving={!present || undefined}
      layout={reducedMotion ? false : "position"}
      exit={reducedMotion ? undefined : focusRowExit}
      onPointerOver={event => {
        if (disabled || event.pointerType !== 'mouse' || event.buttons) return;
        const kind = previewKind(event.target);
        if (kind === hoverKind.current) return;
        dismiss();
        hoverKind.current = kind;
        if (!kind) return;
        timer.current = window.setTimeout(() => show(kind), kind === 'commits' ? COMMIT_HOVER_DELAY : CHAT_HOVER_DELAY);
      }}
      onPointerLeave={dismiss}
      onWheel={dismiss}
      onPointerDown={dismiss}
      onFocusCapture={event => {
        if (!event.target.matches(':focus-visible')) return;
        const kind = previewKind(event.target);
        if (kind) show(kind);
      }}
      onBlurCapture={dismiss}
      onClickCapture={event => {
        if (!(event.target instanceof Element) || !event.target.closest(COMMIT_BADGE)) return;
        show('commits');
      }}
      onKeyDownCapture={event => {
        if (event.key === 'Escape' && (open || hoverKind.current)) {
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      {React.cloneElement(children, { 'aria-describedby': open === 'chat' ? id : undefined })}
      {open && !disabled && createPortal(
        <div
          ref={panel}
          id={id}
          role="tooltip"
          className="eterx-focus-preview"
          data-kind={open}
          style={position || { visibility: 'hidden' }}
        >
          {open === 'chat' ? preview : (
            <ul className="eterx-focus-preview-commits" aria-label="Chat commits">
              {commits.slice(0, 6).map(commit => (
                <li key={commit.hash}>
                  <GitCommitHorizontal size={14} aria-hidden="true" />
                  <code>{commit.hash.slice(0, 8)}</code>
                  <span>{commit.subject}</span>
                </li>
              ))}
              {commits.length > 6 && <li className="eterx-focus-preview-more">{commits.length - 6} more</li>}
            </ul>
          )}
        </div>,
        document.body,
      )}
    </motion.div>
  );
}
