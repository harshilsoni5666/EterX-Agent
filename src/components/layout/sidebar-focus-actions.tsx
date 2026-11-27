import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { AlarmClock, Check, MessageCircleQuestionMark, RotateCcw, X } from 'lucide-react';
import { AskUserPrompt } from '../chat/ask-user-prompt';

type ScheduleAt = number | 'now';

const hours = (value: number) => value * 3_600_000;
const timeLabel = (at: number, weekday = false) => new Date(at).toLocaleString(undefined, {
  ...(weekday ? { weekday: 'short' as const } : {}),
  hour: 'numeric', minute: '2-digit',
});

function scheduleChoices(now: number) {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const monday = new Date(now);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  monday.setHours(9, 0, 0, 0);
  return [
    { label: 'In 1 hour', at: now + hours(1) },
    { label: 'In 3 hours', at: now + hours(3) },
    { label: 'Tomorrow', at: tomorrow.getTime() },
    { label: 'Next week', at: monday.getTime(), weekday: true },
  ];
}

function toLocalInput(at: number) {
  const date = new Date(at);
  return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function FocusScheduleActions({ settled, title, task, scheduledAt, onSchedule, onSettle }: {
  settled: boolean;
  title: string;
  task: boolean;
  scheduledAt?: number;
  onSchedule: (at: ScheduleAt) => void | Promise<void>;
  onSettle: () => void | Promise<void>;
}) {
  const [now, setNow] = React.useState(() => Date.now());
  const [custom, setCustom] = React.useState(false);
  const customOpening = React.useRef(false);
  const [customAt, setCustomAt] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const pending = React.useRef(false);
  const [error, setError] = React.useState('');
  const run = async (action: () => void | Promise<void>, closeCustom = false) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      if (closeCustom) setCustom(false);
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : 'Unable to save this change.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const options = scheduleChoices(now);
  const SettleIcon = settled ? RotateCcw : Check;

  return (
    <span className="eterx-focus-row-actions" data-interacting={busy || custom || undefined}>
      <DropdownMenu.Root modal={false} onOpenChange={open => { if (open) { setNow(Date.now()); setError(''); } }}>
        <DropdownMenu.Trigger asChild>
          <button type="button" disabled={busy} aria-label={task ? 'Change scheduled run time' : 'Set chat reminder'}
            onClick={event => event.stopPropagation()}>
            <AlarmClock size={15} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            aria-label={task ? 'Schedule task' : 'Remind me'}
            className="eterx-sidebar-menu eterx-focus-schedule-menu"
            side="bottom" align="end" sideOffset={6} collisionPadding={10}
            onClick={event => event.stopPropagation()}
            onCloseAutoFocus={event => {
              if (customOpening.current) {
                event.preventDefault();
                customOpening.current = false;
              }
            }}
          >
            <DropdownMenu.Label className="eterx-focus-schedule-label">{title}</DropdownMenu.Label>
            <DropdownMenu.Item onSelect={() => void run(() => onSchedule('now'))} className="eterx-sidebar-project-menu-item">
              <span>Now</span><small>{task ? 'Run now' : 'Wake now'}</small>
            </DropdownMenu.Item>
            {options.map(option => (
              <DropdownMenu.Item key={option.label} onSelect={() => void run(() => onSchedule(option.at))}
                className="eterx-sidebar-project-menu-item">
                <span>{option.label}</span><small>{timeLabel(option.at, option.weekday)}</small>
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator />
            <DropdownMenu.Item className="eterx-sidebar-project-menu-item" onSelect={() => {
              customOpening.current = true;
              setCustomAt(toLocalInput(scheduledAt && scheduledAt > Date.now() ? scheduledAt : Date.now() + hours(1)));
              setCustom(true);
            }}>Custom…</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <button type="button" disabled={busy} onClick={event => {
        event.stopPropagation();
        void run(onSettle);
      }}>
        <SettleIcon size={14} aria-hidden="true" />
        {settled ? 'Restore' : 'Settle'}
      </button>
      {error && !custom && <span className="eterx-focus-action-error" role="alert">{error}</span>}
      <Dialog.Root open={custom} onOpenChange={setCustom}>
        <Dialog.Portal>
          <Dialog.Overlay className="eterx-focus-dialog-overlay" />
          <Dialog.Content className="eterx-focus-dialog" aria-describedby={undefined}
            onClick={event => event.stopPropagation()}>
            <Dialog.Title>{task ? 'Schedule task' : 'Set chat reminder'}</Dialog.Title>
            <Dialog.Close className="eterx-focus-dialog-close" aria-label="Close"><X size={16} /></Dialog.Close>
            <form onSubmit={event => {
              event.preventDefault();
              event.stopPropagation();
              const at = new Date(customAt).getTime();
              if (!Number.isFinite(at) || at <= Date.now()) { setError('Choose a future date and time.'); return; }
              void run(() => onSchedule(at), true);
            }}>
              <label>Date and time
                <input type="datetime-local" required value={customAt} min={toLocalInput(Date.now())}
                  onChange={event => setCustomAt(event.target.value)} />
              </label>
              {error && <p role="alert">{error}</p>}
              <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </span>
  );
}

export function FocusQuestionButton({ question, title, onAnswer }: {
  question: any;
  title: string;
  onAnswer: (timestamp: number, answer: string, responseKey?: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="eterx-sidebar-focus-status eterx-focus-input-button" data-status="input"
          aria-label={'Answer question in ' + title} onClick={event => event.stopPropagation()}>
          <MessageCircleQuestionMark size={15} aria-hidden="true" /> Input
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="eterx-focus-dialog-overlay" />
        <Dialog.Content className="eterx-focus-dialog eterx-focus-question-dialog" aria-describedby={undefined}
          onClick={event => event.stopPropagation()}>
          <Dialog.Title className="sr-only">{'Question from ' + title}</Dialog.Title>
          <Dialog.Close className="eterx-focus-dialog-close" aria-label="Close question"><X size={16} /></Dialog.Close>
          <AskUserPrompt
            key={question.responseKey || question.timestamp}
            question={question.question}
            mode={question.mode || 'text'}
            options={question.options || []}
            questions={Array.isArray(question.questions) ? question.questions : undefined}
            context={question.context}
            defaultValue={question.defaultValue}
            urgent={question.urgent}
            timestamp={question.timestamp}
            responseKey={question.responseKey}
            onAnswer={answer => {
              onAnswer(question.timestamp, answer, question.responseKey);
              setOpen(false);
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
