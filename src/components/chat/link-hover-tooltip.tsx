import React, { useRef, useState } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

export const LinkHoverTooltip = ({ children, text, showFullText = false }: {
  children: React.ReactElement;
  text: string;
  showFullText?: boolean;
}) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [tooltip, setTooltip] = useState<{ boundary: Element | null } | null>(null);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setTooltip(null);
      return;
    }

    // The live browser is a native surface that draws over the app renderer.
    const chatColumn = triggerRef.current?.closest('.eterx-chat-column');
    const browserViewport = chatColumn?.closest('.eterx-main-panel')?.querySelector('.eterx-workspace-browser-viewport');
    setTooltip({ boundary: browserViewport ? chatColumn ?? null : null });
  };

  return (
    <TooltipPrimitive.Provider delayDuration={180} skipDelayDuration={0}>
      <TooltipPrimitive.Root open={tooltip !== null} onOpenChange={handleOpenChange}>
        <TooltipPrimitive.Trigger asChild ref={triggerRef}>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className="eterx-website-link-tooltip"
            side="top"
            sideOffset={4}
            collisionBoundary={tooltip?.boundary ?? undefined}
            collisionPadding={12}
            sticky="always"
            hideWhenDetached
            arrowPadding={8}
          >
            <span className="eterx-website-link-tooltip-url" data-full-text={showFullText || undefined} dir="ltr">{text}</span>
            <TooltipPrimitive.Arrow className="eterx-website-link-tooltip-arrow" width={10} height={5} aria-hidden="true" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
};
