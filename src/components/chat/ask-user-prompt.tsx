import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageCircleQuestion, Send, Check, ChevronRight, Clock, Zap, X } from 'lucide-react';

interface AskUserOption {
  label: string;
  description?: string;
  value: string;
}

interface AskUserProps {
  question: string;
  mode: 'choice' | 'text' | 'confirm';
  options?: AskUserOption[];
  context?: string;
  defaultValue?: string;
  urgent?: boolean;
  timestamp: number;
  onAnswer: (answer: string, selectedOption?: AskUserOption) => void;
}

export const AskUserPrompt: React.FC<AskUserProps> = ({
  question,
  mode,
  options = [],
  context,
  defaultValue,
  urgent,
  timestamp,
  onAnswer
}) => {
  const [textInput, setTextInput] = useState(defaultValue || '');
  const [answered, setAnswered] = useState(false);
  const [answeredValue, setAnsweredValue] = useState('');
  const [visible, setVisible] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setTimeout(() => {
      if (mode === 'text') textareaRef.current?.focus();
    }, 350);
  }, [mode]);

  // After answering, fade out then unmount completely
  const handleSubmit = (answer: string, option?: AskUserOption) => {
    if (answered) return;
    setAnswered(true);
    setAnsweredValue(answer);

    fetch('/api/agent/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responseKey: `ask_user_${timestamp}`, answer, selectedOption: option || null })
    }).catch(err => console.error('[AskUser] Failed to send answer:', err));

    onAnswer(answer, option);

    // Unmount after short delay so user sees their selection
    setTimeout(() => setVisible(false), 1800);
  };

  if (!visible) return null;

  return (
    <AnimatePresence mode="wait">
      {!answered ? (
        <motion.div
          key="question"
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.97, transition: { duration: 0.25 } }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="my-4 w-full"
          style={{
            background: urgent
              ? 'linear-gradient(135deg, rgba(245,158,11,0.06) 0%, rgba(15,15,15,0.95) 100%)'
              : 'linear-gradient(135deg, rgba(99,102,241,0.07) 0%, rgba(15,15,15,0.95) 100%)',
            borderRadius: 20,
            border: urgent ? '1px solid rgba(245,158,11,0.22)' : '1px solid rgba(99,102,241,0.22)',
            backdropFilter: 'blur(24px)',
            boxShadow: urgent
              ? '0 8px 40px rgba(245,158,11,0.08), inset 0 1px 0 rgba(255,255,255,0.04)'
              : '0 8px 40px rgba(99,102,241,0.08), inset 0 1px 0 rgba(255,255,255,0.04)',
          }}
        >
          {/* Top accent line */}
          <div style={{
            height: 1,
            background: urgent
              ? 'linear-gradient(90deg, transparent, rgba(245,158,11,0.5), transparent)'
              : 'linear-gradient(90deg, transparent, rgba(99,102,241,0.5), transparent)',
            borderRadius: '20px 20px 0 0',
          }} />

          <div style={{ padding: '18px 20px 20px' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div style={{
                width: 30, height: 30, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                background: urgent ? 'rgba(245,158,11,0.12)' : 'rgba(99,102,241,0.12)',
                border: urgent ? '1px solid rgba(245,158,11,0.2)' : '1px solid rgba(99,102,241,0.2)',
              }}>
                {urgent
                  ? <Zap style={{ width: 14, height: 14, color: '#f59e0b' }} />
                  : <MessageCircleQuestion style={{ width: 14, height: 14, color: '#818cf8' }} />}
              </div>
              <span style={{
                fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
                color: urgent ? 'rgba(245,158,11,0.7)' : 'rgba(129,140,248,0.7)',
              }}>
                {urgent ? 'Input needed' : 'Quick question'}
              </span>
            </div>

            {/* Question */}
            <p style={{ fontSize: 15, fontWeight: 500, color: '#E8E6E3', lineHeight: 1.6, marginBottom: context ? 8 : 18 }}>
              {question}
            </p>
            {context && (
              <p style={{ fontSize: 12, color: '#6B6966', lineHeight: 1.5, marginBottom: 16, fontStyle: 'italic' }}>
                {context}
              </p>
            )}

            {/* CHOICE MODE — pill chips */}
            {mode === 'choice' && options.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {options.map((option, i) => (
                  <motion.button
                    key={option.value}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.06, duration: 0.28 }}
                    onClick={() => handleSubmit(option.value, option)}
                    style={{
                      width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12,
                      padding: '11px 14px', borderRadius: 12, cursor: 'pointer', border: 'none',
                      background: 'rgba(255,255,255,0.035)', transition: 'all 0.18s ease',
                      outline: '1px solid rgba(255,255,255,0.07)',
                    }}
                    whileHover={{ background: 'rgba(255,255,255,0.07)', outline: '1px solid rgba(255,255,255,0.13)', scale: 1.005 }}
                    whileTap={{ scale: 0.985 }}
                  >
                    <div style={{
                      width: 24, height: 24, borderRadius: 8, background: 'rgba(255,255,255,0.05)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                      border: '1px solid rgba(255,255,255,0.08)',
                    }}>
                      <ChevronRight style={{ width: 12, height: 12, color: '#555350' }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: '#C8C6C3' }}>{option.label}</div>
                      {option.description && (
                        <div style={{ fontSize: 11.5, color: '#6B6966', marginTop: 2 }}>{option.description}</div>
                      )}
                    </div>
                  </motion.button>
                ))}
              </div>
            )}

            {/* TEXT MODE */}
            {mode === 'text' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <textarea
                  ref={textareaRef}
                  value={textInput}
                  onChange={e => setTextInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (textInput.trim()) handleSubmit(textInput.trim());
                    }
                  }}
                  placeholder={defaultValue ? `Default: ${defaultValue}` : 'Type your answer…'}
                  rows={2}
                  style={{
                    width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 12, padding: '10px 14px', fontSize: 13.5, color: '#E8E6E3',
                    resize: 'none', outline: 'none', lineHeight: 1.6,
                    fontFamily: 'inherit', transition: 'border-color 0.2s',
                    boxSizing: 'border-box',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.35)'; }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                  {defaultValue && (
                    <button
                      onClick={() => handleSubmit(defaultValue)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px',
                        borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer',
                        fontSize: 12, color: '#6B6966', transition: 'color 0.15s',
                      }}
                    >
                      <Clock style={{ width: 11, height: 11 }} />
                      Use default
                    </button>
                  )}
                  <motion.button
                    onClick={() => textInput.trim() && handleSubmit(textInput.trim())}
                    disabled={!textInput.trim()}
                    whileTap={textInput.trim() ? { scale: 0.94 } : {}}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px',
                      borderRadius: 10, border: 'none', cursor: textInput.trim() ? 'pointer' : 'not-allowed',
                      fontSize: 13, fontWeight: 500,
                      background: textInput.trim() ? 'rgba(99,102,241,0.18)' : 'rgba(255,255,255,0.05)',
                      color: textInput.trim() ? '#a5b4fc' : '#555350',
                      outline: textInput.trim() ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent',
                      transition: 'all 0.18s',
                    }}
                  >
                    <Send style={{ width: 12, height: 12 }} />
                    Send
                  </motion.button>
                </div>
              </div>
            )}

            {/* CONFIRM MODE */}
            {mode === 'confirm' && (
              <div style={{ display: 'flex', gap: 10 }}>
                <motion.button
                  onClick={() => handleSubmit('yes')}
                  whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.96 }}
                  style={{
                    flex: 1, padding: '11px 0', borderRadius: 12, border: 'none', cursor: 'pointer',
                    background: 'rgba(52,211,153,0.1)', color: '#34d399', fontSize: 13.5, fontWeight: 500,
                    outline: '1px solid rgba(52,211,153,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    transition: 'all 0.18s',
                  }}
                >
                  <Check style={{ width: 14, height: 14 }} />
                  Yes, proceed
                </motion.button>
                <motion.button
                  onClick={() => handleSubmit('no')}
                  whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.96 }}
                  style={{
                    flex: 1, padding: '11px 0', borderRadius: 12, border: 'none', cursor: 'pointer',
                    background: 'rgba(248,81,73,0.08)', color: '#f85149', fontSize: 13.5, fontWeight: 500,
                    outline: '1px solid rgba(248,81,73,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    transition: 'all 0.18s',
                  }}
                >
                  <X style={{ width: 14, height: 14 }} />
                  No, skip
                </motion.button>
              </div>
            )}
          </div>
        </motion.div>
      ) : (
        <motion.div
          key="answered"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0, transition: { duration: 0.3 } }}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px',
            borderRadius: 12, background: 'rgba(52,211,153,0.06)',
            border: '1px solid rgba(52,211,153,0.15)',
            fontSize: 13, color: '#6B6966', marginTop: 12, marginBottom: 4,
          }}
        >
          <Check style={{ width: 13, height: 13, color: '#34d399', flexShrink: 0 }} />
          <span style={{ color: '#8C8A88' }}>Answered:</span>
          <span style={{ color: '#C8C6C3', fontWeight: 500 }}>{answeredValue}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
