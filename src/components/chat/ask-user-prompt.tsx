'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Check, ChevronLeft, ChevronRight, MessageSquareMore, X } from 'lucide-react';
import {
  formatAskUserAnswers, getAskUserFields, type AskUserAnswer, type AskUserField, type AskUserInput, type AskUserStatus,
} from '../../lib/ask-user';

interface AskUserProps extends AskUserInput {
  timestamp: number;
  responseKey?: string;
  status?: AskUserStatus;
  answeredWith?: string;
  onAnswer?: (answer: string | null) => void;
  sourceTitle?: string;
  onHide?: () => void;
}

type Draft = { text: string; selected: string[] };
const emptyDraft: Draft = { text: '', selected: [] };

const statusLabels: Record<Exclude<AskUserStatus, 'pending'>, string> = {
  answered: 'Answered',
  dismissed: 'Dismissed',
  interrupted: 'Interrupted',
  expired: 'Expired',
  closed: 'Closed',
};

function buildAnswer(field: AskUserField, draft: Draft): AskUserAnswer {
  const answer: AskUserAnswer = { id: field.id, question: field.question, mode: field.mode, answer: draft.text.trim(), selectedOption: null };
  if (!draft.selected.length) return answer;
  if (field.mode === 'confirm') return { ...answer, answer: draft.selected[0] };
  const byValue = new Map(field.options.map(option => [option.value, option]));
  const selected = draft.selected.flatMap(value => byValue.has(value) ? [byValue.get(value)!] : []);
  if (field.mode === 'rank' && selected.length !== field.options.length) return answer;
  return {
    ...answer,
    answer: selected.map(option => option.label).join(field.mode === 'rank' ? ' → ' : ', '),
    selectedOption: field.mode === 'choice' ? selected[0] ?? null : selected,
  };
}

export function AskUserPrompt(props: AskUserProps) {
  const { timestamp, responseKey, urgent, onAnswer, answeredWith, sourceTitle, onHide } = props;
  const { question, mode, options, questions, required, context, defaultValue, placeholder } = props;
  const fields = useMemo(() => getAskUserFields({ question, mode, options, questions, required, context, defaultValue, placeholder }),
    [question, mode, options, questions, required, context, defaultValue, placeholder]);
  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState(() => new Map<string, Draft>());
  const [busy, setBusy] = useState<'send' | 'dismiss' | null>(null);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<{ status: Exclude<AskUserStatus, 'pending'>; answer?: string }>();
  const inFlight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const moveFocus = useRef(false);
  const titleId = useId();
  const contextId = useId();

  const currentIndex = Math.min(step, fields.length - 1);
  const field = fields[currentIndex];
  const status = receipt?.status ?? (answeredWith ? 'answered' : props.status ?? 'pending');
  const openedFromFocus = Boolean(onHide);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    heading.current?.focus({ preventScroll: true });
  }, [currentIndex]);

  useEffect(() => {
    if (openedFromFocus && status === 'pending') heading.current?.focus();
  }, [openedFromFocus, status]);

  if (!field) return null;

  const grouped = fields.length > 1;
  const groupTitle = questions?.length ? question?.trim() : '';
  const cardTitle = groupTitle || (grouped ? 'Questions' : field.question);
  const hideOnEscape = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || !onHide) return;
    event.preventDefault();
    event.stopPropagation();
    onHide();
  };

  if (status !== 'pending') {
    const reply = receipt?.answer || answeredWith;
    return (
      <details className="eterx-ask-shell eterx-ask-receipt" onKeyDown={hideOnEscape}>
        <summary>
          {status === 'answered' ? <Check size={16} aria-hidden="true" /> : <MessageSquareMore size={16} aria-hidden="true" />}
          <span className="eterx-ask-receipt-title">{cardTitle}</span>
          <span className="eterx-ask-receipt-status">{statusLabels[status]}</span>
          <ChevronRight size={15} className="eterx-ask-disclosure" aria-hidden="true" />
        </summary>
        <div className="eterx-ask-receipt-body">
          {reply ? <p>{reply}</p> : grouped ? <ol>{fields.map(item => <li key={item.id}>{item.question}</li>)}</ol> : <p>{field.question}</p>}
          {onHide && <button type="button" className="eterx-ask-secondary" onClick={onHide}>Hide card</button>}
        </div>
      </details>
    );
  }

  const draft = drafts.get(field.id) ?? emptyDraft;
  const currentAnswer = buildAnswer(field, draft).answer;
  const isLast = currentIndex === fields.length - 1;
  const hasOptions = field.options.length > 0 && (field.mode === 'choice' || field.mode === 'multi_select' || field.mode === 'rank');
  const isRanking = hasOptions && field.mode === 'rank';
  const isChoice = hasOptions && field.mode === 'choice';
  const isConfirm = field.mode === 'confirm';
  const positions = new Map(draft.selected.map((value, index) => [value, index]));
  const rankedOptions = isRanking ? [...field.options].sort((left, right) => {
    const last = field.options.length;
    return (positions.get(left.value) ?? last) - (positions.get(right.value) ?? last);
  }) : field.options;
  const help = [questions?.length ? context?.trim() : '', field.context].filter((value, index, all) => value && all.indexOf(value) === index);
  const canAdvance = Boolean(currentAnswer || (!field.required && grouped));

  const goTo = (index: number) => {
    setError('');
    if (index === currentIndex) return;
    moveFocus.current = true;
    setStep(index);
  };

  const updateDraft = (value: Draft) => {
    setError('');
    setDrafts(previous => new Map(previous).set(field.id, value));
  };

  const pick = (value: string) => {
    const selected = draft.selected.includes(value);
    const next = selected ? draft.selected.filter(item => item !== value)
      : isChoice || isConfirm ? [value] : [...draft.selected, value];
    updateDraft({ selected: next, text: '' });
  };

  const moveRank = (index: number, offset: number) => {
    const selected = [...draft.selected];
    const next = index + offset;
    [selected[index], selected[next]] = [selected[next], selected[index]];
    updateDraft({ selected, text: '' });
  };

  const useSuggestion = (value: string) => {
    const parts = isChoice ? [value] : value.split(',').map(part => part.trim());
    const selected = parts.map(part => field.options.find(option => option.value === part || option.label === part)?.value);
    if (hasOptions && selected.every((option): option is string => option !== undefined) &&
        (!isRanking || selected.length === field.options.length)) {
      updateDraft({ selected: [...new Set(selected)], text: '' });
    } else {
      updateDraft({ text: value, selected: [] });
    }
  };

  const commit = async (answers: AskUserAnswer[] | null) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(answers ? 'send' : 'dismiss');
    setError('');
    try {
      const payload = answers ? { answers } : { dismiss: true };
      const response = await fetch('/api/agent/answer', {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responseKey: responseKey || ('ask_user_' + timestamp), ...payload }),
      });
      const result = await response.json().catch(() => null);
      if (response.status === 404 || response.status === 410) {
        setReceipt({ status: 'closed' });
        return;
      }
      if (!response.ok || result?.success !== true) throw new Error(result?.error || 'Could not save your reply. Try again.');
      const answer = answers ? String(result.answer || formatAskUserAnswers(answers)) : null;
      setReceipt(answer ? { status: 'answered', answer } : { status: 'dismissed' });
      onAnswer?.(answer);
    } catch (failure) {
      setError(failure instanceof Error && failure.name !== 'TimeoutError' && failure.name !== 'TypeError'
        ? failure.message : 'Could not reach the agent. Try again.');
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const advance = (skip = false) => {
    if (inFlight.current) return;
    if (skip) updateDraft(emptyDraft);
    if (!isLast) {
      goTo(currentIndex + 1);
      return;
    }
    const answers = fields.map(item => buildAnswer(item, skip && item.id === field.id ? emptyDraft : drafts.get(item.id) ?? emptyDraft));
    const missing = fields.findIndex((item, index) => item.required && !answers[index].answer);
    if (missing >= 0) {
      goTo(missing);
      setError('Complete this question before sending your answers.');
      return;
    }
    void commit(answers.some(item => item.answer) ? answers : null);
  };

  return (
    <form className="eterx-ask-shell eterx-ask-panel" aria-labelledby={titleId} aria-busy={Boolean(busy)}
      onKeyDown={hideOnEscape}
      onSubmit={event => {
        event.preventDefault();
        if (canAdvance) advance();
      }}>
      <header className="eterx-ask-header">
        <span className="eterx-ask-emblem"><MessageSquareMore size={16} aria-hidden="true" /></span>
        <span className="eterx-ask-heading-label">
          {groupTitle || (urgent ? 'Input needed' : 'Question for you')}
          <small>
            {sourceTitle && <span className="eterx-ask-source" title={sourceTitle}>{'From ' + sourceTitle}</span>}
            {props.behavior === 'continue' ? 'Work can continue while you answer' : 'Waiting for your reply'}
          </small>
        </span>
        {onHide && <button type="button" className="eterx-ask-secondary" onClick={onHide}>Hide card</button>}
        <button type="button" className="eterx-ask-icon" onClick={() => void commit(null)} disabled={Boolean(busy)}
          aria-label="Dismiss without answering" title="Dismiss without answering">
          <X size={17} aria-hidden="true" />
        </button>
      </header>

      <div className="eterx-ask-body">
        <h3 id={titleId} ref={heading} tabIndex={-1} className="eterx-ask-question">{field.question}</h3>
        {help.length > 0 && <div className="eterx-ask-context" id={contextId}>{help.map(text => <p key={text}>{text}</p>)}</div>}

        {isRanking && <p className="eterx-ask-hint">Select in order, then use the arrows to adjust your ranking.</p>}
        {hasOptions && (
          <div className="eterx-ask-options" role="group" aria-labelledby={titleId} key={field.id}>
            {rankedOptions.map(option => {
              const position = positions.get(option.value) ?? -1;
              const selected = position >= 0;
              return (
                <div className="eterx-ask-option-row" key={option.value} data-selected={selected || undefined}>
                  <button type="button" className="eterx-ask-option" aria-pressed={selected} disabled={Boolean(busy)}
                    onClick={() => pick(option.value)}>
                    <span className="eterx-ask-mark" data-round={isChoice || undefined} aria-hidden="true">
                      {selected && (isRanking ? position + 1 : <Check size={12} />)}
                    </span>
                    <span className="eterx-ask-option-copy">
                      <span>{option.label}</span>
                      {option.description && <small>{option.description}</small>}
                    </span>
                    {selected && isRanking && <span className="sr-only">{'Rank ' + (position + 1)}</span>}
                  </button>
                  {selected && isRanking && (
                    <div className="eterx-ask-reorder">
                      <button type="button" className="eterx-ask-icon" aria-label={'Move ' + option.label + ' up'}
                        onClick={() => moveRank(position, -1)} disabled={Boolean(busy) || position === 0}><ArrowUp size={15} /></button>
                      <button type="button" className="eterx-ask-icon" aria-label={'Move ' + option.label + ' down'}
                        onClick={() => moveRank(position, 1)} disabled={Boolean(busy) || position === draft.selected.length - 1}><ArrowDown size={15} /></button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {isConfirm ? (
          <div className="eterx-ask-confirm" role="group" aria-labelledby={titleId}>
            {['Yes', 'No'].map(value => (
              <button type="button" className="eterx-ask-secondary" key={value} aria-pressed={draft.selected.includes(value)}
                disabled={Boolean(busy)} onClick={() => pick(value)}>{value}</button>
            ))}
          </div>
        ) : field.mode === 'text' ? (
          <textarea className="eterx-ask-input" rows={3} aria-labelledby={titleId} aria-describedby={help.length ? contextId : undefined}
            value={draft.text} disabled={Boolean(busy)} placeholder={field.placeholder || 'Write your answer'}
            onChange={event => updateDraft({ text: event.target.value, selected: [] })}
            onKeyDown={event => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }} />
        ) : (
          <input className="eterx-ask-input" aria-labelledby={titleId} aria-describedby={help.length ? contextId : undefined}
            value={draft.text} disabled={Boolean(busy)}
            placeholder={field.placeholder || (hasOptions ? 'Or write your own answer' : field.mode === 'fill_blank' ? 'Fill in the blank' : 'Write your answer')}
            onChange={event => updateDraft({ text: event.target.value, selected: [] })} />
        )}

        {!isConfirm && field.defaultValue && !draft.text && !draft.selected.length && (
          <button type="button" className="eterx-ask-suggestion" disabled={Boolean(busy)}
            onClick={() => useSuggestion(field.defaultValue!)}>{'Use suggestion · ' + field.defaultValue}</button>
        )}
      </div>

      {error && <p className="eterx-ask-error" role="alert">{error}</p>}

      <footer className="eterx-ask-footer">
        {grouped && (
          <nav className="eterx-ask-pages" aria-label="Question navigation">
            <button type="button" className="eterx-ask-icon" onClick={() => goTo(currentIndex - 1)}
              disabled={Boolean(busy) || currentIndex === 0} aria-label="Previous question"><ChevronLeft size={17} /></button>
            <span aria-live="polite">{currentIndex + 1} of {fields.length}</span>
            <button type="button" className="eterx-ask-icon" onClick={() => goTo(currentIndex + 1)}
              disabled={Boolean(busy) || isLast} aria-label="Next question"><ChevronRight size={17} /></button>
          </nav>
        )}
        <div className="eterx-ask-actions">
          {!field.required && (
            <button type="button" className="eterx-ask-secondary" onClick={() => advance(true)} disabled={Boolean(busy)}>Skip</button>
          )}
          <button type="submit" className="eterx-ask-submit" disabled={Boolean(busy) || !canAdvance}>
            {busy === 'send' ? 'Sending…' : busy === 'dismiss' ? 'Dismissing…' : !isLast ? 'Next' : grouped ? 'Send answers' : 'Send answer'}
            {!busy && <ArrowRight size={15} aria-hidden="true" />}
          </button>
        </div>
      </footer>
    </form>
  );
}
