'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, CheckSquare, ChevronRight, ListChecks, Send, Square, Type, X } from 'lucide-react';

type AskUserMode = 'choice' | 'text' | 'confirm' | 'multi_select' | 'short_answer';
type AskUserIncomingMode = AskUserMode | 'questions';

interface AskUserOption {
  label: string;
  description?: string;
  value: string;
}

interface AskUserQuestion {
  id?: string;
  question: string;
  mode?: AskUserIncomingMode;
  options?: AskUserOption[];
  context?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
}

interface AskUserAnswer {
  id: string;
  question: string;
  mode: AskUserMode;
  answer: string;
  selectedOption?: AskUserOption | AskUserOption[] | null;
}

interface AskUserProps {
  question: string;
  mode: AskUserIncomingMode;
  options?: AskUserOption[];
  questions?: AskUserQuestion[];
  context?: string;
  defaultValue?: string;
  urgent?: boolean;
  timestamp: number;
  responseKey?: string;
  answeredWith?: string;
  onAnswer: (answer: string, selectedOption?: AskUserOption | AskUserOption[] | AskUserAnswer[]) => void;
}

async function submitAnswer(
  responseKey: string,
  answer: string,
  option: unknown = null,
  answers: AskUserAnswer[] | null = null,
) {
  const res = await fetch('/api/agent/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ responseKey, answer, selectedOption: option, answers }),
  });

  if (!res.ok) {
    let message = `Answer submit failed (${res.status})`;
    try {
      const data = await res.json();
      message = data.error || message;
    } catch { }
    throw new Error(message);
  }
}

const AskingDots = () => (
  <span className="eterx-ask-dots" aria-hidden="true">
    <span />
    <span />
    <span />
  </span>
);

const validModes = new Set<AskUserMode>(['choice', 'text', 'confirm', 'multi_select', 'short_answer']);

const normalizeOption = (option: any, index: number): AskUserOption | null => {
  if (typeof option === 'string') {
    const label = option.trim();
    return label ? { label, value: label } : null;
  }

  const label = String(option?.label || option?.value || '').trim();
  if (!label) return null;

  const value = String(option?.value || label).trim();
  const description = String(option?.description || '').trim();

  return {
    label,
    value: value || `option_${index + 1}`,
    ...(description ? { description } : {}),
  };
};

const normalizeQuestionMode = (mode: any, options: AskUserOption[]): AskUserMode => {
  const requested = validModes.has(mode) ? mode : 'short_answer';
  if ((requested === 'choice' || requested === 'multi_select') && options.length < 2) {
    return 'short_answer';
  }
  return requested;
};

const formatAnswerSummary = (answers: AskUserAnswer[]) => {
  if (answers.length === 0) return 'No answer provided';
  if (answers.length === 1) return answers[0].answer || 'No answer provided';

  return answers
    .map((answer, index) => `${index + 1}. ${answer.question}: ${answer.answer || 'No answer provided'}`)
    .join('\n');
};

export const AskUserPrompt: React.FC<AskUserProps> = ({
  question,
  mode,
  options = [],
  questions,
  context,
  defaultValue,
  urgent,
  timestamp,
  responseKey,
  answeredWith,
  onAnswer,
}) => {
  const [textValues, setTextValues] = useState<Record<string, string>>({});
  const [multiValues, setMultiValues] = useState<Record<string, string[]>>({});
  const [directReply, setDirectReply] = useState('');
  const [answered, setAnswered] = useState(Boolean(answeredWith));
  const [answeredValue, setAnsweredValue] = useState(answeredWith || '');
  const [doneOpen, setDoneOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const normalizedQuestions = useMemo(() => {
    const sourceQuestions = Array.isArray(questions) && questions.length > 0
      ? questions
      : [{
        id: 'q1',
        question,
        mode,
        options,
        context,
        defaultValue,
        required: true,
      }];

    return sourceQuestions
      .map((rawQuestion, index) => {
        const normalizedOptions = (Array.isArray(rawQuestion.options) ? rawQuestion.options : [])
          .map(normalizeOption)
          .filter(Boolean) as AskUserOption[];
        const id = String(rawQuestion.id || `q${index + 1}`).trim() || `q${index + 1}`;
        const text = String(rawQuestion.question || '').trim();
        const normalizedMode = normalizeQuestionMode(rawQuestion.mode, normalizedOptions);

        return {
          id,
          question: text || 'Please provide the needed detail.',
          mode: normalizedMode,
          options: normalizedOptions,
          context: String(rawQuestion.context || '').trim(),
          defaultValue: String(rawQuestion.defaultValue || '').trim(),
          placeholder: String(rawQuestion.placeholder || '').trim(),
          required: rawQuestion.required === false ? false : true,
        };
      })
      .filter(item => item.question);
  }, [context, defaultValue, mode, options, question, questions]);

  const isQuestionGroup = normalizedQuestions.length > 1 || mode === 'questions';
  const firstTextQuestionId = normalizedQuestions.find(item => item.mode === 'text' || item.mode === 'short_answer')?.id;
  const requiredCount = normalizedQuestions.filter(item => item.required).length;
  const questionTitle = isQuestionGroup
    ? (question || `${normalizedQuestions.length} questions need your input`)
    : normalizedQuestions[0]?.question || question;
  const canUseDefaults = normalizedQuestions.every(item => !item.required || Boolean(item.defaultValue));
  const unansweredRequiredCount = normalizedQuestions.filter(item => {
    if (!item.required) return false;
    if (item.mode === 'multi_select') return (multiValues[item.id] || []).length === 0;
    return !String(textValues[item.id] || '').trim();
  }).length;

  useEffect(() => {
    setTextValues(prev => {
      let changed = false;
      const next: Record<string, string> = {};

      normalizedQuestions.forEach(item => {
        if (prev[item.id] !== undefined) {
          next[item.id] = prev[item.id];
        } else {
          next[item.id] = item.defaultValue || '';
          changed = true;
        }
      });

      if (Object.keys(prev).length !== Object.keys(next).length) changed = true;
      return changed ? next : prev;
    });

    setMultiValues(prev => {
      let changed = false;
      const next: Record<string, string[]> = {};

      normalizedQuestions.forEach(item => {
        if (item.mode === 'multi_select') {
          next[item.id] = prev[item.id] || [];
          if (!prev[item.id]) changed = true;
        }
      });

      if (Object.keys(prev).length !== Object.keys(next).length) changed = true;
      return changed ? next : prev;
    });
  }, [normalizedQuestions]);

  useEffect(() => {
    if (answeredWith) {
      setAnswered(true);
      setAnsweredValue(answeredWith);
    }
  }, [answeredWith]);

  useEffect(() => {
    if (!answered && firstTextQuestionId) {
      const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 200);
      return () => window.clearTimeout(focusTimer);
    }
  }, [answered, firstTextQuestionId]);

  const setTextValue = (id: string, value: string) => {
    setTextValues(prev => ({ ...prev, [id]: value }));
  };

  const toggleMulti = (id: string, value: string) => {
    setMultiValues(prev => {
      const current = prev[id] || [];
      const next = current.includes(value)
        ? current.filter(item => item !== value)
        : [...current, value];
      return { ...prev, [id]: next };
    });
  };

  const buildAnswers = useCallback((textOverride: Record<string, string> = textValues, multiOverride: Record<string, string[]> = multiValues) => {
    const missing: AskUserQuestion[] = [];

    const answers = normalizedQuestions.map((item): AskUserAnswer => {
      if (item.mode === 'multi_select') {
        const selectedValues = multiOverride[item.id] || [];
        const selectedOptions = item.options.filter(option => selectedValues.includes(option.value));
        const answer = selectedOptions.map(option => option.label).join(', ');
        if (item.required && !answer) missing.push(item);
        return {
          id: item.id,
          question: item.question,
          mode: item.mode,
          answer,
          selectedOption: selectedOptions,
        };
      }

      const rawValue = String(textOverride[item.id] || '').trim();
      if (item.required && !rawValue) missing.push(item);

      if (item.mode === 'choice') {
        const selectedOption = item.options.find(option => option.value === rawValue || option.label === rawValue) || null;
        return {
          id: item.id,
          question: item.question,
          mode: item.mode,
          answer: selectedOption?.label || rawValue,
          selectedOption,
        };
      }

      return {
        id: item.id,
        question: item.question,
        mode: item.mode,
        answer: rawValue,
        selectedOption: null,
      };
    });

    return { answers, missing };
  }, [multiValues, normalizedQuestions, textValues]);

  const commitAnswers = useCallback(async (answers: AskUserAnswer[]) => {
    const cleanDisplay = formatAnswerSummary(answers).trim();
    if (answered || isSubmitting || !cleanDisplay) return;

    const selectedOption = answers.length === 1 ? (answers[0].selectedOption || null) : answers;

    setIsSubmitting(true);
    setSubmitError('');
    setAnswered(true);
    setAnsweredValue(cleanDisplay);

    try {
      await submitAnswer(responseKey || `ask_user_${timestamp}`, cleanDisplay, selectedOption, answers);
      onAnswer(cleanDisplay, selectedOption as any);
    } catch (error: any) {
      setAnswered(false);
      setAnsweredValue('');
      setSubmitError(error?.message || 'Could not submit answer.');
    } finally {
      setIsSubmitting(false);
    }
  }, [answered, isSubmitting, onAnswer, responseKey, timestamp]);

  const submitAll = () => {
    const { answers, missing } = buildAnswers();
    if (missing.length > 0) {
      setSubmitError(missing.length === 1
        ? 'Answer the required question before submitting.'
        : `Answer ${missing.length} required questions before submitting.`);
      return;
    }
    commitAnswers(answers);
  };

  const submitDirectReply = () => {
    const answer = directReply.trim();
    if (!answer || normalizedQuestions.length !== 1) return;

    const item = normalizedQuestions[0];
    commitAnswers([{
      id: item.id,
      question: item.question,
      mode: item.mode === 'multi_select' ? 'text' : item.mode,
      answer,
      selectedOption: null,
    }]);
  };

  const submitDefaults = () => {
    if (!canUseDefaults) return;

    const nextText = normalizedQuestions.reduce<Record<string, string>>((acc, item) => {
      acc[item.id] = item.defaultValue || '';
      return acc;
    }, {});

    const nextMulti = normalizedQuestions.reduce<Record<string, string[]>>((acc, item) => {
      if (item.mode === 'multi_select') {
        const defaultParts = item.defaultValue
          .split(',')
          .map(part => part.trim().toLowerCase())
          .filter(Boolean);
        acc[item.id] = item.options
          .filter(option => defaultParts.includes(option.value.toLowerCase()) || defaultParts.includes(option.label.toLowerCase()))
          .map(option => option.value);
      }
      return acc;
    }, {});

    const { answers, missing } = buildAnswers(nextText, nextMulti);
    if (missing.length > 0) return;
    commitAnswers(answers);
  };

  const handleChoice = (item: AskUserQuestion & { id: string; mode: AskUserMode; options: AskUserOption[] }, option: AskUserOption) => {
    const nextText = { ...textValues, [item.id]: option.value };
    setTextValues(nextText);

    if (normalizedQuestions.length === 1 && item.mode === 'choice') {
      const { answers } = buildAnswers(nextText, multiValues);
      commitAnswers(answers);
    }
  };

  const handleConfirm = (item: AskUserQuestion & { id: string; mode: AskUserMode }, value: 'Yes' | 'No') => {
    const nextText = { ...textValues, [item.id]: value };
    setTextValues(nextText);

    if (normalizedQuestions.length === 1) {
      const { answers } = buildAnswers(nextText, multiValues);
      commitAnswers(answers);
    }
  };

  const renderQuestionControl = (item: AskUserQuestion & { id: string; mode: AskUserMode; options: AskUserOption[] }, compact = false) => {
    if (item.mode === 'choice') {
      const selectedValue = textValues[item.id] || '';

      return (
        <div className={compact ? 'eterx-ask-options eterx-ask-options-compact' : 'eterx-ask-options'}>
          {item.options.map((option, index) => {
            const selected = selectedValue === option.value || selectedValue === option.label;
            return (
              <button
                key={option.value || option.label}
                type="button"
                className="eterx-ask-option"
                onClick={() => handleChoice(item, option)}
                disabled={isSubmitting}
                data-selected={selected ? 'true' : undefined}
              >
                <span className="eterx-ask-option-index">{index + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="eterx-ask-option-label">{option.label}</span>
                  {option.description && <span className="eterx-ask-option-desc">{option.description}</span>}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 opacity-45" />
              </button>
            );
          })}
        </div>
      );
    }

    if (item.mode === 'multi_select') {
      const selectedValues = multiValues[item.id] || [];

      return (
        <div className={compact ? 'eterx-ask-options eterx-ask-options-compact' : 'eterx-ask-options'}>
          {item.options.map((option) => {
            const checked = selectedValues.includes(option.value);
            return (
              <button
                key={option.value || option.label}
                type="button"
                className="eterx-ask-option"
                onClick={() => toggleMulti(item.id, option.value)}
                disabled={isSubmitting}
                data-selected={checked ? 'true' : undefined}
              >
                <span className="eterx-ask-check">
                  {checked ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="eterx-ask-option-label">{option.label}</span>
                  {option.description && <span className="eterx-ask-option-desc">{option.description}</span>}
                </span>
              </button>
            );
          })}
          {!compact && (
            <button
              type="button"
              className="eterx-ask-submit"
              onClick={submitAll}
              disabled={selectedValues.length === 0 || isSubmitting}
            >
              <Send className="h-3.5 w-3.5" />
              Submit {selectedValues.length > 0 ? `(${selectedValues.length})` : ''}
            </button>
          )}
        </div>
      );
    }

    if (item.mode === 'confirm') {
      const selectedValue = textValues[item.id] || '';

      return (
        <div className={compact ? 'eterx-ask-confirm eterx-ask-confirm-compact' : 'eterx-ask-confirm'}>
          <button
            type="button"
            className="eterx-ask-submit"
            onClick={() => handleConfirm(item, 'Yes')}
            disabled={isSubmitting}
            data-selected={selectedValue === 'Yes' ? 'true' : undefined}
          >
            <Check className="h-3.5 w-3.5" />
            Yes
          </button>
          <button
            type="button"
            className="eterx-ask-secondary"
            onClick={() => handleConfirm(item, 'No')}
            disabled={isSubmitting}
            data-selected={selectedValue === 'No' ? 'true' : undefined}
          >
            No
          </button>
        </div>
      );
    }

    const value = textValues[item.id] || '';
    const isSingleText = normalizedQuestions.length === 1;
    const isShortAnswer = item.mode === 'short_answer';

    return (
      <div className={isSingleText ? 'eterx-ask-textbox' : 'eterx-ask-textbox eterx-ask-textbox-compact'}>
        {isShortAnswer ? (
          <input
            ref={item.id === firstTextQuestionId ? inputRef as React.RefObject<HTMLInputElement> : undefined}
            value={value}
            onChange={event => setTextValue(item.id, event.target.value)}
            onKeyDown={event => {
              if (isSingleText && event.key === 'Enter') {
                event.preventDefault();
                submitAll();
              }
            }}
            placeholder={item.placeholder || item.defaultValue || 'Type a short answer'}
            className="eterx-ask-input"
          />
        ) : (
          <textarea
            ref={item.id === firstTextQuestionId ? inputRef as React.RefObject<HTMLTextAreaElement> : undefined}
            value={value}
            onChange={event => setTextValue(item.id, event.target.value)}
            onKeyDown={event => {
              if (isSingleText && event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submitAll();
              }
            }}
            placeholder={item.placeholder || item.defaultValue || 'Type your answer'}
            rows={3}
            className="eterx-ask-input eterx-ask-textarea"
          />
        )}
        {isSingleText && (
          <button type="button" className="eterx-ask-submit" onClick={submitAll} disabled={!value.trim() || isSubmitting}>
            <Send className="h-3.5 w-3.5" />
            Send
          </button>
        )}
      </div>
    );
  };

  if (answered) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="eterx-ask-shell eterx-ask-shell-done my-3 w-full"
      >
        <button
          type="button"
          className="eterx-ask-done-toggle"
          onClick={() => setDoneOpen(open => !open)}
          aria-expanded={doneOpen}
        >
          <span className="eterx-ask-status">
            <span className="eterx-ask-status-icon"><Check className="h-3.5 w-3.5" /></span>
            <span>Asked user</span>
          </span>
          <span className="eterx-ask-done-question">{isQuestionGroup ? `${normalizedQuestions.length} questions` : questionTitle}</span>
          <ChevronRight className={`h-4 w-4 shrink-0 transition-transform ${doneOpen ? 'rotate-90' : ''}`} />
        </button>
        <AnimatePresence>
          {doneOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.16 }}
              className="eterx-ask-done-body"
            >
              <div className="eterx-ask-done-label">{isQuestionGroup ? 'Questions' : 'Question'}</div>
              <div className="eterx-ask-done-text">{isQuestionGroup ? questionTitle : normalizedQuestions[0]?.question || questionTitle}</div>
              <div className="eterx-ask-answer">
                <span className="eterx-ask-answer-label">Answer</span>
                <span className="eterx-ask-answer-text">{answeredValue}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    );
  }

  const singleQuestion = normalizedQuestions[0];
  if (!singleQuestion) return null;

  const showDirectReply = normalizedQuestions.length === 1 && ['choice', 'multi_select', 'confirm'].includes(singleQuestion?.mode);

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key="ask-user"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.2 }}
        className="eterx-ask-shell my-4 w-full"
      >
        <div className="eterx-ask-header">
          <span className="eterx-ask-title">
            {isQuestionGroup ? <ListChecks className="h-3.5 w-3.5" /> : <Type className="h-3.5 w-3.5" />}
            {urgent ? 'Input required' : 'Asking user'}
            <AskingDots />
            <span className="eterx-ask-count">{normalizedQuestions.length} {normalizedQuestions.length === 1 ? 'question' : 'questions'}</span>
            {requiredCount > 0 && <span className="eterx-ask-required-chip">{requiredCount} required</span>}
          </span>
          {canUseDefaults && (
            <button type="button" className="eterx-ask-skip" onClick={submitDefaults} disabled={isSubmitting}>
              <X className="h-3.5 w-3.5" />
              Use defaults
            </button>
          )}
        </div>

        <div className="eterx-ask-question">{questionTitle}</div>
        {context && <div className="eterx-ask-context">{context}</div>}

        {isQuestionGroup ? (
          <div className="eterx-ask-form">
            {normalizedQuestions.map((item, index) => (
              <div key={item.id} className="eterx-ask-field">
                <div className="eterx-ask-field-head">
                  <span className="eterx-ask-field-index">{index + 1}</span>
                  <span className="eterx-ask-field-title">{item.question}</span>
                  {item.required && <span className="eterx-ask-field-required">Required</span>}
                </div>
                {item.context && <div className="eterx-ask-field-context">{item.context}</div>}
                {renderQuestionControl(item, true)}
              </div>
            ))}
            <div className="eterx-ask-actions">
              <button
                type="button"
                className="eterx-ask-submit eterx-ask-submit-primary"
                onClick={submitAll}
                disabled={unansweredRequiredCount > 0 || isSubmitting}
              >
                <Send className="h-3.5 w-3.5" />
                Submit answers
              </button>
            </div>
          </div>
        ) : (
          <>
            {renderQuestionControl(singleQuestion)}
            {showDirectReply && (
              <div className="eterx-ask-direct">
                <input
                  value={directReply}
                  onChange={event => setDirectReply(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      submitDirectReply();
                    }
                  }}
                  placeholder="Or reply directly"
                  className="eterx-ask-input"
                />
                <button type="button" className="eterx-ask-icon-submit" onClick={submitDirectReply} disabled={!directReply.trim() || isSubmitting} aria-label="Submit direct reply">
                  <Send className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </>
        )}

        {submitError && <div className="eterx-ask-error">{submitError}</div>}
      </motion.div>
    </AnimatePresence>
  );
};
