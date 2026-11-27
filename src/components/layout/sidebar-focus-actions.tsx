import React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { AlarmClock, Check, MessageCircleQuestionMark, Play, Reply, RotateCcw } from 'lucide-react';

export function FocusRowActions({ settled, title, onRunNow, onSettle }: {
  settled: boolean;
  title: string;
  onRunNow?: () => void | Promise<void>;
  onSettle: () => void | Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  const pending = React.useRef(false);
  const [error, setError] = React.useState('');
  const run = async (action: () => void | Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : 'Unable to save this change.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const SettleIcon = settled ? RotateCcw : Check;

  return (
    <span className="eterx-focus-row-actions" data-interacting={busy || undefined}>
      {onRunNow && (
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button type="button" disabled={busy} aria-label={`Run options for ${title}`}
              onClick={event => event.stopPropagation()}>
              <AlarmClock size={15} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              aria-label={`Run ${title}`}
              className="eterx-sidebar-menu eterx-focus-run-menu"
              side="bottom" align="end" sideOffset={6} collisionPadding={10}
              onClick={event => event.stopPropagation()}
            >
              <DropdownMenu.Item onSelect={() => void run(onRunNow)} className="eterx-sidebar-menu-item">
                <Play size={14} aria-hidden="true" /> Run now
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}

      <button type="button" disabled={busy} onClick={event => {
        event.stopPropagation();
        void run(onSettle);
      }}>
        <SettleIcon size={14} aria-hidden="true" />
        {settled ? 'Restore' : 'Settle'}
      </button>
      {error && <span className="eterx-focus-action-error" role="alert">{error}</span>}
    </span>
  );
}

export function FocusQuestionButton({ title, expanded, onOpen }: {
  title: string;
  expanded: boolean;
  onOpen: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <button type="button" className="eterx-sidebar-focus-status eterx-focus-input-button" data-status="input"
      aria-label={'Answer question from ' + title} aria-expanded={expanded} onClick={event => {
        event.stopPropagation();
        onOpen(event.currentTarget);
      }}>
      <span className="eterx-focus-input-state eterx-focus-input-default" aria-hidden="true">
        <MessageCircleQuestionMark size={15} /> Input
      </span>
      <span className="eterx-focus-input-state eterx-focus-input-answer" aria-hidden="true">
        <Reply size={15} /> Answer
      </span>
    </button>
  );
}
