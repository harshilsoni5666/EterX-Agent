/** Reveal content inside exactly one pane, without scrollIntoView moving its
 * ancestors (the main chat, tab strip, or a retained workspace). */
export function revealInWorkspaceScroller(container: HTMLElement, target: HTMLElement, block: 'nearest' | 'center' | 'start' = 'nearest') {
  const viewport = container.getBoundingClientRect();
  const bounds = target.getBoundingClientRect();
  const top = bounds.top - viewport.top - container.clientTop;
  const left = bounds.left - viewport.left - container.clientLeft;
  let nextTop = container.scrollTop, nextLeft = container.scrollLeft;
  if (block === 'center') nextTop += top - Math.max(0, (container.clientHeight - bounds.height) / 2);
  else if (block === 'start') nextTop += top - 16;
  else if (top < 0) nextTop += top;
  else if (top + bounds.height > container.clientHeight) nextTop += top + bounds.height - container.clientHeight;
  // Leave room for the sticky source line-number gutter.
  const gutter = target.closest('.eterx-workspace-code') ? 58 : 8;
  if (left < gutter) nextLeft += left - gutter;
  else if (left + bounds.width > container.clientWidth - 8) nextLeft += left + bounds.width - container.clientWidth + 8;
  container.scrollTo({ top: Math.max(0, nextTop), left: Math.max(0, nextLeft), behavior: 'auto' });
}
