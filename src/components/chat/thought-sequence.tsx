import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import { useFilePanelActions } from '../../contexts/FilePanelContext';
// Only the Lucide icons actually rendered in JSX (not icon-map/TOOL_META)
import {
  ChevronRight, ChevronDown, Monitor, ShieldHalf, Copy, CheckCircle, Maximize2, CornerDownLeft,
  RefreshCw, ExternalLink, Check, Globe, Smartphone, Tablet, Terminal
} from 'lucide-react';
// @ts-ignore
import ReactMarkdown from 'react-markdown';
import { markdownComponents, normalizeMarkdownForRendering, remarkPlugins, rehypePlugins } from './markdown-renderer';
import { AGENT_ICONS, resolveAgentIcon, AgentAssetIcon } from './agent-icons';
import { AgentFace } from './agent-face';


type RevealSpeed = {
  baseDelayMs: number;
  lineDelayMs: number;
  tableDelayMs: number;
  punctuationDelayMs: number;
  burst: number;
  maxDurationMs: number;
};

const TEXT_REVEAL_SPEEDS = {
  workNote: {
    baseDelayMs: 15,
    lineDelayMs: 22,
    tableDelayMs: 28,
    punctuationDelayMs: 24,
    burst: 2,
    maxDurationMs: 620,
  },
  answer: {
    baseDelayMs: 12,
    lineDelayMs: 18,
    tableDelayMs: 24,
    punctuationDelayMs: 22,
    burst: 3,
    maxDurationMs: 2400,
  },
} satisfies Record<'workNote' | 'answer', RevealSpeed>;

const markdownRevealChunkPattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
const fenceStartPattern = /^ {0,3}(`{3,}|~{3,})/;

const splitWordsWithSpacing = (value: string) => {
  const matches = value.match(/\S+\s*/g);
  return matches && matches.length > 0 ? matches : value ? [value] : [];
};

const hasOpenInlineMarkdown = (value: string) => {
  const sanitized = value.replace(/\\./g, '');
  const backticks = sanitized.match(/`/g)?.length || 0;
  if (backticks % 2 === 1) return true;

  const boldA = sanitized.match(/\*\*/g)?.length || 0;
  const boldB = sanitized.match(/__/g)?.length || 0;
  if (boldA % 2 === 1 || boldB % 2 === 1) return true;

  const lastOpenBracket = Math.max(sanitized.lastIndexOf('['), sanitized.lastIndexOf('!['));
  const lastCloseBracket = sanitized.lastIndexOf(']');
  if (lastOpenBracket > lastCloseBracket) return true;

  const lastLinkOpen = sanitized.lastIndexOf('](');
  const lastParenClose = sanitized.lastIndexOf(')');
  return lastLinkOpen > lastParenClose;
};

const pushProseRevealChunks = (line: string, chunks: string[], completeLine: boolean) => {
  let buffered = '';

  splitWordsWithSpacing(line).forEach((word) => {
    if (buffered) {
      buffered += word;
      if (!hasOpenInlineMarkdown(buffered)) {
        chunks.push(buffered);
        buffered = '';
      }
      return;
    }

    if (hasOpenInlineMarkdown(word)) {
      buffered = word;
      return;
    }

    chunks.push(word);
  });

  if (buffered && completeLine) {
    chunks.push(buffered);
  }
};

const isTableLine = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)) return true;
  return /^\|.+\|$/.test(trimmed) || trimmed.split('|').length >= 3;
};

const isTableSeparatorLine = (line: string) =>
  /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());

const isFenceCloseLine = (line: string, openingFence: string) => {
  const char = openingFence[0];
  const escaped = char === '`' ? '`' : '~';
  const pattern = new RegExp(`^ {0,3}${escaped}{${openingFence.length},}\\s*$`);
  return pattern.test(line.trimEnd());
};

const isHeadingLine = (line: string) => /^ {0,3}#{1,6}\s+\S/.test(line);
const isListLine = (line: string) => /^ {0,3}(?:[-+*]|\d{1,2}[.)])\s+\S/.test(line);
const isBlockquoteLine = (line: string) => /^ {0,3}>\s?/.test(line);
const isRuleLine = (line: string) => /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line.trimEnd());
const isDisplayMathBoundary = (line: string) => line.trim() === '$$';

const tokenizeMarkdownForReveal = (value: string) => {
  if (!value) return [];
  const chunks: string[] = [];
  const parts = value.split(markdownRevealChunkPattern).filter(Boolean);

  parts.forEach((part) => {
    if (/^(```|~~~)/.test(part)) {
      chunks.push(part);
      return;
    }

    const lines = part.split(/(?<=\n)/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;
      const nextLine = lines[i + 1] || '';
      const isCompleteLine = line.endsWith('\n');
      const fenceMatch = line.match(fenceStartPattern);

      if (fenceMatch) {
        let block = line;
        let closed = false;
        for (let j = i + 1; j < lines.length; j += 1) {
          block += lines[j];
          if (isFenceCloseLine(lines[j], fenceMatch[1])) {
            closed = true;
            i = j;
            break;
          }
        }
        if (closed) chunks.push(block);
        else break;
        continue;
      }

      if (isDisplayMathBoundary(line)) {
        let block = line;
        let closed = false;
        for (let j = i + 1; j < lines.length; j += 1) {
          block += lines[j];
          if (isDisplayMathBoundary(lines[j])) {
            closed = true;
            i = j;
            break;
          }
        }
        if (closed) chunks.push(block);
        else break;
        continue;
      }

      if (isTableLine(line) && isTableSeparatorLine(nextLine)) {
        chunks.push(line + nextLine);
        i += 1;
        continue;
      }

      if (isTableLine(line) && (isTableSeparatorLine(line) || isTableLine(lines[i - 1] || ''))) {
        chunks.push(line);
        continue;
      }

      if (isTableLine(line)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('|') || trimmed.endsWith('|')) continue;
      }

      if (isHeadingLine(line) || isListLine(line) || isBlockquoteLine(line) || isRuleLine(line)) {
        if (!isCompleteLine) break;
        chunks.push(line);
        continue;
      }

      pushProseRevealChunks(line, chunks, isCompleteLine);
    }
  });

  return chunks;
};

const getRevealDelay = (chunk: string, speed: RevealSpeed) => {
  if (isTableLine(chunk)) return speed.tableDelayMs;
  if (chunk.includes('\n')) return speed.lineDelayMs;
  if (/[.!?;:]\s*$/.test(chunk.trim())) return speed.punctuationDelayMs;
  return speed.baseDelayMs;
};

const usePrefersReducedMotion = (active: boolean) => {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (!active) {
      setReduced(false);
      return;
    }
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener?.('change', sync);
    return () => media.removeEventListener?.('change', sync);
  }, [active]);

  return reduced;
};

const useProgressiveMarkdown = (value: string, enabled: boolean, speed: RevealSpeed) => {
  const reducedMotion = usePrefersReducedMotion(enabled);
  const chunks = useMemo(() => tokenizeMarkdownForReveal(value), [value]);
  const previousValueRef = useRef(value);
  const [visibleCount, setVisibleCount] = useState(() => enabled && !reducedMotion ? 0 : chunks.length);

  useEffect(() => {
    if (!enabled || reducedMotion) {
      previousValueRef.current = value;
      setVisibleCount(chunks.length);
      return;
    }

    setVisibleCount((current) => {
      const previousValue = previousValueRef.current;
      previousValueRef.current = value;
      if (!previousValue || value.startsWith(previousValue)) return Math.min(current, chunks.length);
      return Math.min(current, chunks.length);
    });
  }, [chunks.length, enabled, reducedMotion, value]);

  useEffect(() => {
    if (!enabled || reducedMotion || visibleCount >= chunks.length) return;

    const chunk = chunks[visibleCount] || '';
    const durationBurst = Math.ceil((chunks.length * speed.baseDelayMs) / Math.max(speed.maxDurationMs, 1));
    const isStructuralChunk = isTableLine(chunk) || chunk.includes('\n');
    const burst = isStructuralChunk ? 1 : Math.max(speed.burst, durationBurst);
    const timeout = window.setTimeout(() => {
      setVisibleCount(current => Math.min(chunks.length, current + burst));
    }, getRevealDelay(chunk, speed));

    return () => window.clearTimeout(timeout);
  }, [chunks, enabled, reducedMotion, speed, visibleCount]);

  const visibleText = useMemo(() => chunks.slice(0, visibleCount).join(''), [chunks, visibleCount]);

  return {
    text: enabled && !reducedMotion ? visibleText : value,
    isRevealing: enabled && !reducedMotion && visibleCount < chunks.length,
  };
};

const AnswerWriterCursor = () => (
  <span className="eterx-answer-writer-cursor" aria-hidden="true" />
);

const GhostCodeBlock = ({ inline, className, children, ...props }: any) => {
  if (inline) {
    return <code className="eterx-progressive-ghost-inline-code" {...props}>{children}</code>;
  }

  const content = String(children).replace(/\n$/, '');
  const lineCount = Math.max(1, content.split(/\r?\n/).length);
  const language = /language-([^\s]+)/.exec(className || '')?.[1]?.toLowerCase() || '';
  const diagramLike = language === 'mermaid' || language === 'mmd' || /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|timeline|mindmap)\b/i.test(content.trim());
  const minHeight = diagramLike
    ? Math.max(20, lineCount * 1.45 + 6)
    : lineCount * 1.7 + 2.6;
  return (
    <pre
      className="eterx-progressive-ghost-code"
      style={{ minHeight: `${minHeight}em` }}
    >
      <code>{content}</code>
    </pre>
  );
};

const GhostImage = () => (
  <span className="eterx-progressive-ghost-image" aria-hidden="true" />
);

// Brand connector icons — compact SVGs
const C = ({ d, fill, vb = '0 0 24 24', className }: { d: string, fill: string, vb?: string, className?: string }) => <svg className={className} viewBox={vb} fill={fill}><path d={d} /></svg>;
const SlackIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="#E01E5A"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" /></svg>;
const GitHubIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" /></svg>;
const NotionIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.98-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" /></svg>;
const LinearIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M3.275 18.025 13.95 7.35l2.7 2.7L5.975 20.725c-.733-.55-1.37-1.183-1.925-1.925-.25-.333-.517-.65-.775-.775zM14.3 7l2.7 2.7 2.075-2.075a9.6 9.6 0 0 0-2.7-2.7L14.3 7zM3.45 17.3a9.614 9.614 0 0 1-2.7-2.7L12 3.35l2.7 2.7L3.45 17.3zm-1.15.9L3.6 19.5c.1.1.2.2.3.275L2.575 21.1A11.95 11.95 0 0 1 .9 18.2h1.4zm18.7-13.5L5.25 20.45c.55.375 1.175.7 1.75.95L21.95 5.45c-.25-.575-.55-1.2-.95-1.75zm1.1 3.5L7.25 22.05c.725.25 1.5.4 2.3.45L22 8.5c-.05-.8-.2-1.575-.45-2.3z" /></svg>;
const JiraIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.004-1.005zm5.089-5.088H5.143a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057a5.215 5.215 0 0 0 5.213 5.215V7.43a1.005 1.005 0 0 0-1.058-1.005zm5.089-5.088H10.232a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 22.806 13.9V2.342a1.005 1.005 0 0 0-1.057-1.005z" /></svg>;
const FigmaIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M8 24c2.208 0 4-1.792 4-4v-4H8c-2.208 0-4 1.792-4 4s1.792 4 4 4zm0-20H4C1.792 4 0 5.792 0 8s1.792 4 4 4h4V4zm4 0v8h4c2.208 0 4-1.792 4-4s-1.792-4-4-4h-4zm4 16c2.208 0 4-1.792 4-4s-1.792-4-4-4h-4v4c0 2.208 1.792 4 4 4zm-4-8H8c-2.208 0-4 1.792-4 4s1.792 4 4 4h4v-8z" /></svg>;
const DiscordIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.492c-1.53-.69-3.17-1.2-4.885-1.49a.075.075 0 0 0-.079.036c-.21.369-.444.85-.608 1.23a18.566 18.566 0 0 0-5.487 0 12.36 12.36 0 0 0-.617-1.23A.077.077 0 0 0 8.562 3c-1.714.29-3.354.8-4.885 1.491a.07.07 0 0 0-.032.027C.533 9.093-.32 13.555.099 17.961a.08.08 0 0 0 .031.055 20.03 20.03 0 0 0 5.993 2.98.078.078 0 0 0 .084-.026 13.83 13.83 0 0 0 1.226-1.963.074.074 0 0 0-.041-.104 13.175 13.175 0 0 1-1.872-.878.075.075 0 0 1-.008-.125c.126-.093.252-.19.372-.287a.075.075 0 0 1 .078-.01c3.927 1.764 8.18 1.764 12.061 0a.075.075 0 0 1 .079.009c.12.098.245.195.372.288a.075.075 0 0 1-.006.125c-.598.344-1.22.635-1.873.877a.075.075 0 0 0-.041.105c.36.687.772 1.341 1.225 1.962a.077.077 0 0 0 .084.028 19.963 19.963 0 0 0 6.002-2.981.076.076 0 0 0 .032-.054c.5-5.094-.838-9.52-3.549-13.442a.06.06 0 0 0-.031-.028z" /></svg>;
const StripeIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305z" /></svg>;
const VercelIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M24 22.525H0l12-21.05 12 21.05z" /></svg>;
const AirtableIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M12.006.253l-11.05 4.01c-.654.237-.647 1.16.01 1.388l11.068 3.859a3.93 3.93 0 0 0 2.594 0l11.068-3.86c.657-.227.664-1.15.01-1.387l-11.05-4.01a3.93 3.93 0 0 0-2.65 0zM1.419 10.192a.928.928 0 0 0-.924.928v9.148c0 .512.417.917.924.917a.93.93 0 0 0 .296-.048l10.124-3.506a.928.928 0 0 0 .632-.88V7.604a.928.928 0 0 0-1.22-.88L1.419 10.192zm21.162 0l-10.124-3.504a.928.928 0 0 0-1.22.88V16.75a.928.928 0 0 0 .632.88l10.124 3.506a.928.928 0 0 0 1.22-.88v-9.148a.928.928 0 0 0-.632-.916z" /></svg>;
const PostmanIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M13.527.099C6.955-.744.942 3.9.099 10.473c-.843 6.572 3.8 12.584 10.373 13.428 6.573.843 12.587-3.801 13.428-10.374C24.744 6.955 20.101.943 13.527.099zm2.471 7.507l-4.602 4.6-1.62-1.619 4.602-4.6 1.62 1.619zm-7.803-.123l5.18 5.176-1.034 1.035L6.16 8.518l2.035-1.035zm5.536 8.974l-5.18-5.177 1.035-1.034 5.178 5.177-1.033 1.034zm1.036-1.035l-1.619-1.619 4.602-4.6 1.619 1.619-4.602 4.6z" /></svg>;
const TrelloIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M21 0H3C1.343 0 0 1.343 0 3v18c0 1.656 1.343 3 3 3h18c1.656 0 3-1.344 3-3V3c0-1.657-1.344-3-3-3zm-11.5 17c0 .828-.672 1.5-1.5 1.5H5c-.829 0-1.5-.672-1.5-1.5V5c0-.829.671-1.5 1.5-1.5h3c.828 0 1.5.671 1.5 1.5v12zm10 -6c0 .828-.672 1.5-1.5 1.5H15c-.828 0-1.5-.672-1.5-1.5V5c0-.829.672-1.5 1.5-1.5h3c.828 0 1.5.671 1.5 1.5v6z" /></svg>;
const HubSpotIcon = ({ className }: any) => <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M18.164 7.93V5.084a2.198 2.198 0 0 0 1.266-1.978V3.04a2.199 2.199 0 0 0-2.198-2.198h-.066a2.199 2.199 0 0 0-2.198 2.198v.066a2.199 2.199 0 0 0 1.266 1.978V7.93a6.232 6.232 0 0 0-2.963 1.302L4.3 4.066a2.45 2.45 0 1 0-1.285 1.465l10.765 5.126a6.236 6.236 0 0 0-.838 3.144 6.236 6.236 0 0 0 3.144 5.413l-1.52 2.89a1.98 1.98 0 1 0 1.74.91l1.52-2.89a6.272 6.272 0 0 0 2.41.48A6.272 6.272 0 0 0 26 13.8a6.272 6.272 0 0 0-7.836-6.07zm.977 9.8a3.492 3.492 0 1 1 0-6.984 3.492 3.492 0 0 1 0 6.984z" transform="scale(0.92) translate(-0.2, 0)" /></svg>;

// Verb-only lookup — icon is ALWAYS resolved by resolveAgentIcon (8 premium icons)
// No Lucide icons stored here — just past-tense display labels
const VERB_MAP: Record<string, string> = {
  'Running command':         'Ran',
  'Running project command': 'Ran',
  'Reading file':            'Read',
  'Scanning directory':      'Listed',
  'Editing file':            'Edited',
  'Writing artifact':        'Created',
  'Searching codebase':      'Searched',
  'Researching':             'Web searched',
  'Reading source':          'Scraped',
  'Deep researching':        'Researched',
  'Analyzing code':          'Analyzed',
  'Refactoring code':        'Refactored',
  'Analyzing workspace':     'Analyzed',
  'Analyzing files':         'Analyzed',
  'Verifying code':          'Verified',
  'Verifying output':        'Verified',
  'Scaffolding project':     'Scaffolded',
  'Git operation':           'Git',
  'Spawning sub-agents':     'Spawned',
  'Decomposing task':        'Decomposed',
  'Loading skill':           'Loaded',
  'API request':             'Called API',
  'API call':                'Called API',
  'Network operation':       'Network',
  'Reading PDF':             'Read PDF',
  'Generating document':     'Generated',
  'Generating image':        'Generated',
  'Generating docs':         'Generated docs',
  'Generating chart':        'Generated',
  'Generating speech':       'Generated',
  'Capturing screen':        'Captured',
  'Evaluating logic':        'Evaluated',
  'Monitoring system':       'Monitored',
  'Managing email':          'Email',
  'Comparing files':         'Compared',
  'Transforming data':       'Transformed',
  'Compressing files':       'Compressed',
  'Database query':          'Queried',
  'Calculating':             'Calculated',
  'Analyzing data':          'Analyzed',
  'Clipboard':               'Clipboard',
  'Extracting transcript':   'Extracted',
  'Reading RSS feed':        'Read feed',
  'WhatsApp':                'WhatsApp',
  'Telegram':                'Telegram',
  'Slack':                   'Slack',
  'Sending Slack':           'Slack',
  'Slack message':           'Slack',
  'GitHub':                  'GitHub',
  'GitHub push':             'Pushed',
  'GitHub PR':               'Pull Request',
  'GitHub issue':            'Issue',
  'Notion':                  'Notion',
  'Notion page':             'Notion',
  'Linear':                  'Linear',
  'Linear issue':            'Linear',
  'Jira':                    'Jira',
  'Jira issue':              'Jira',
  'Figma':                   'Figma',
  'Discord':                 'Discord',
  'Discord message':         'Discord',
  'Stripe':                  'Stripe',
  'Vercel':                  'Vercel',
  'Airtable':                'Airtable',
  'Postman':                 'Postman',
  'Trello':                  'Trello',
  'HubSpot':                 'HubSpot',
  'Safety check':            'Checked',
  'Context operation':       'Context',
  'Saving progress':         'Saved',
  'Background task':         'Background',
  'Creating tool':           'Created tool',
  'Converting markdown':     'Converted',
  'System automation':       'Automated',
  'Managing process':        'Process',
  'HTTP server':             'Server',
  'Processing text':         'Processed',
  'Notifying':               'Notified',
  'Running macro':           'Ran macro',
  'Executing chain':         'Executed',
  'Self-improving':          'Improved',
  'Watching files':          'Watching',
  'Vault operation':         'Vault',
  'Managing environment':    'Env',
  'Scheduled task':          'Scheduled',
};

// getToolMeta — verb extraction only; icon is always resolved by resolveAgentIcon
const getToolMeta = (text: string, type: string, _iconName?: string) => {
  const normalizedText = /\bsync/i.test(text || '') && /\bnetwork\b/i.test(text || '')
    ? 'Network operation'
    : text;
  const verb = VERB_MAP[normalizedText] || normalizedText || 'Action';
  return { icon: null, verb, color: '#E8E6E3' };
};

const TERMINAL_ACTION_PATTERN = /\b(?:shell|terminal|command|exec|run|process|server|watch|powershell|pwsh|cmd(?:\.exe)?|bash|zsh|sh|git|npm|npx|pnpm|yarn|bun|node|python|py|pip|pytest|tsx|tsc|eslint|prettier|docker|cargo|go\s+(?:test|build|run|vet)|mvn|gradle|java|dotnet|php|ruby|rails|uv|poetry|rg|grep|curl|wget)\b/i;

const shouldUseTerminalIcon = (log: any, subtitle = '', preview?: any) => {
  const text = String(log?.text || '');
  const secondary = String(log?.secondary || subtitle || '');
  const command = String(log?.command || preview?.command || '');
  const iconCategory = String(log?.iconCategory || '').toLowerCase();
  const combined = `${text} ${secondary} ${command}`;

  if (log?.type === 'file_edit' || preview?.type === 'file_preview') return false;
  if (iconCategory === 'terminal') return true;
  if (preview?.type === 'console_output') return true;
  if (log?.type === 'console_output') return true;
  if (['system_shell', 'workspace_run_command', 'terminal_access', 'process_manager'].includes(String(log?.tool || log?.name || ''))) return true;
  return TERMINAL_ACTION_PATTERN.test(combined);
};

const displayedTextRegistry = new Map<string, number>();

// No typewriter — show full text immediately for zero-latency reading
const useTypewriter = (targetText: string, _isActive: boolean) => {
  return { displayedText: targetText };
};

// Live-second counter. Prefer trace timestamps so a finished thought never keeps counting.
const asTimestamp = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const LIVE_THOUGHT_FRESH_MS = 2400;
const LIVE_ACTION_SETTLE_MS = 1400;

const getLogUpdatedAt = (log: any) =>
  asTimestamp(log?.endTime) ?? asTimestamp(log?.updatedAt) ?? asTimestamp(log?.timestamp) ?? asTimestamp(log?.startTime);

const isLiveThoughtFresh = (log: any, now = Date.now()) => {
  if (!log || (log.type !== 'thought_stream' && log.type !== 'work_note')) return false;
  const updatedAt = getLogUpdatedAt(log);
  return updatedAt === null || now - updatedAt <= LIVE_THOUGHT_FRESH_MS;
};

const useThinkTimer = (isLive: boolean, startedAt?: number, updatedAt?: number) => {
  const [secs, setSecs] = useState(0);
  const fallbackStartRef = useRef<number | null>(null);
  const frozenRef = useRef<number | null>(null);
  const startMs = asTimestamp(startedAt);
  const updateMs = asTimestamp(updatedAt);

  useEffect(() => {
    const elapsedFrom = (endMs: number) => {
      const origin = startMs ?? fallbackStartRef.current ?? endMs;
      return Math.max(0, Math.floor((endMs - origin) / 1000));
    };
    const frozenElapsedFrom = (endMs: number) => {
      const origin = startMs ?? fallbackStartRef.current ?? endMs;
      return Math.max(1, Math.ceil(Math.max(0, endMs - origin) / 1000));
    };

    if (isLive) {
      if (fallbackStartRef.current === null) fallbackStartRef.current = startMs ?? Date.now();
      frozenRef.current = null;
      setSecs(elapsedFrom(Date.now()));
      const id = setInterval(() => {
        setSecs(elapsedFrom(Date.now()));
      }, 1000);
      return () => clearInterval(id);
    }

    const frozen = startMs !== null && updateMs !== null
      ? frozenElapsedFrom(updateMs)
      : fallbackStartRef.current !== null
        ? frozenElapsedFrom(Date.now())
        : 0;
    frozenRef.current = frozen;
    fallbackStartRef.current = null;
    setSecs(frozen);
  }, [isLive, startMs, updateMs]);

  // Always return the frozen value if available (never re-tick after done)
  return frozenRef.current !== null ? frozenRef.current : secs;
};

export const ProfessionalThought = ({ text, isLatest, isThinking, variant = 'thought', suffix, startedAt, updatedAt }: { text: string, isLatest: boolean, isThinking: boolean, variant?: 'thought' | 'answer' | 'note', suffix?: React.ReactNode, startedAt?: number, updatedAt?: number }) => {
  const [open, setOpen] = useState(false);
  const [thoughtCanScroll, setThoughtCanScroll] = useState(false);
  const thoughtScrollRef = useRef<HTMLDivElement>(null);
  const thoughtAutoScrollRef = useRef(true);
  const requestedLive = isLatest && isThinking;
  const lastUpdateMs = asTimestamp(updatedAt);
  const [isFresh, setIsFresh] = useState(false);

  useEffect(() => {
    if (!requestedLive) {
      setIsFresh(false);
      return;
    }

    if (lastUpdateMs === null) {
      setIsFresh(true);
      return;
    }

    const age = Date.now() - lastUpdateMs;
    if (age >= LIVE_THOUGHT_FRESH_MS) {
      setIsFresh(false);
      return;
    }

    setIsFresh(true);
    const timeout = window.setTimeout(() => setIsFresh(false), LIVE_THOUGHT_FRESH_MS - age);
    return () => window.clearTimeout(timeout);
  }, [requestedLive, lastUpdateMs, text]);

  const isLive = requestedLive && isFresh;
  const secs = useThinkTimer(isLive, startedAt, updatedAt);

  const renderText = useMemo(() => {
    if (!text) return '';
    let f = text.replace(/!\[.*?\]\(\/absolute.*?\.png\)/gi, '').replace(/<\/?thought>/gi, '');
    f = f.replace(/([^\n])(#{1,6}\s)/g, '$1\n\n$2').replace(/([.!?:])(\s*\n)(#{1,6}\s)/g, '$1\n\n$3');
    return normalizeMarkdownForRendering(f.trim());
  }, [text]);

  const scrollThoughtToBottom = () => {
    const el = thoughtScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  const handleThoughtScroll = () => {
    const el = thoughtScrollRef.current;
    if (!el) return;
    thoughtAutoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 28;
  };

  const syncThoughtOverflow = () => {
    const el = thoughtScrollRef.current;
    if (!el) {
      setThoughtCanScroll(false);
      return;
    }
    setThoughtCanScroll(el.scrollHeight > el.clientHeight + 1);
  };

  useEffect(() => {
    if (!open) {
      setThoughtCanScroll(false);
      return;
    }
    thoughtAutoScrollRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      syncThoughtOverflow();
      scrollThoughtToBottom();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      syncThoughtOverflow();
      if (thoughtAutoScrollRef.current) scrollThoughtToBottom();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, renderText]);

  // "Thinking... 4s" while live → "Thought for 4s" when done
  const thinkLabel = isLive
    ? `Thinking... ${secs}s`
    : secs > 0
      ? `Thought for ${secs}s`
      : 'Thought';
  const isNote = variant === 'note';
  const revealEnabled = variant === 'answer'
    ? isLatest && isThinking
    : isNote && isLatest && isThinking;
  const revealSpeed = isNote ? TEXT_REVEAL_SPEEDS.workNote : TEXT_REVEAL_SPEEDS.answer;
  const progressive = useProgressiveMarkdown(renderText, revealEnabled, revealSpeed);
  const markdownText = revealEnabled ? progressive.text : renderText;
  const showAnswerWriter = variant === 'answer' && (progressive.isRevealing || (isLatest && isThinking));
  const professionalMarkdownComponents = useMemo(() => ({
    ...markdownComponents,
    p: ({ node, ...props }: any) => <p className={`mb-1.5 last:mb-0 break-words tracking-normal ${ isNote ? 'leading-[1.62] text-[#B6B2AB]' : 'leading-[1.78] text-[#C4C1BC]' }`} {...props} />,
    h1: ({ node, ...props }: any) => <h1 className="mt-0 mb-4 text-[24px] font-bold leading-tight text-[#C4C1BC]" {...props} />,
    h2: ({ node, ...props }: any) => <h2 className="mt-0 mb-3 text-[20px] font-bold leading-tight text-[#C4C1BC]" {...props} />,
    h3: ({ node, ...props }: any) => <h3 className="mt-0 mb-3 text-[17px] font-bold leading-tight text-[#C4C1BC]" {...props} />,
    h4: ({ node, ...props }: any) => <h4 className="mt-0 mb-2 text-[15px] font-semibold leading-tight text-[#C4C1BC]" {...props} />,
    h5: ({ node, ...props }: any) => <h5 className="mt-0 mb-2 text-[14px] font-semibold leading-tight text-[#B0ADA9]" {...props} />,
    h6: ({ node, ...props }: any) => <h6 className="mt-0 mb-2 text-[13px] font-semibold leading-tight text-[#9C9893]" {...props} />,
    strong: ({ node, ...props }: any) => <strong className="font-semibold text-[#D0CDC7]" {...props} />,
    a: ({ node, ...props }: any) => <a className="text-[#E2765A] hover:underline" target="_blank" rel="noopener" {...props} />,
  }), [isNote]);
  const professionalGhostMarkdownComponents = useMemo(() => ({
    ...professionalMarkdownComponents,
    code: GhostCodeBlock,
    img: GhostImage,
  }), [professionalMarkdownComponents]);

  const renderProfessionalMarkdown = (value: string, withWriter = false, ghost = false) => (
    <>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={ghost ? professionalGhostMarkdownComponents : professionalMarkdownComponents}
      >
        {value}
      </ReactMarkdown>
      {withWriter && <AnswerWriterCursor />}
    </>
  );

  if (variant === 'thought') {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className="professional-thought eterx-thought-block w-full"
      >
        <div className={`eterx-thought-card overflow-hidden rounded-[14px] border bg-[#161616]/82 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_2px_12px_rgba(0,0,0,0.18)] transition-colors ${ open ? 'border-white/[0.14]' : 'border-white/[0.08] hover:border-white/[0.14]' }`}>
          <button
            onClick={() => setOpen(!open)}
            className="eterx-thought-toggle flex min-h-[42px] w-full items-center gap-2.5 px-3.5 py-1.5 text-left transition-colors hover:bg-white/[0.03] group"
          >
            <span className={`flex-1 text-[14.5px] font-semibold ${ isLive ? 'text-[#A0A0A0] eterx-live-text eterx-live-text--thought' : 'text-[#6B6966]' }`}>
              {thinkLabel}
            </span>
            <ChevronRight className={`h-4 w-4 text-[#5E5A55] group-hover:text-[#A3A19E] transition-all ${ open ? 'rotate-90' : '' }`} />
          </button>
          <AnimatePresence initial={false}>
            {open && renderText && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="overflow-hidden"
              >
                <div ref={thoughtScrollRef} onScroll={handleThoughtScroll} className={`eterx-thought-expanded ${ thoughtCanScroll ? 'eterx-scrollbar overflow-y-auto' : 'overflow-y-hidden' } pl-[59px] pr-5 pb-5 pt-1 text-[14px] leading-[1.72] text-[#A8A5A0]`} style={{ maxHeight: 'min(52vh, 520px)' }}>
                  <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={{
                    ...markdownComponents,
                    p: ({ node, ...props }: any) => <p className="mb-3.5 last:mb-0 break-words leading-[1.72] text-[#A8A5A0]" {...props} />,
                    ol: ({ node, ...props }: any) => <ol className="my-3.5 list-decimal space-y-3 pl-6 text-[#A8A5A0]" {...props} />,
                    ul: ({ node, ...props }: any) => <ul className="my-3.5 list-disc space-y-3 pl-6 text-[#A8A5A0]" {...props} />,
                    li: ({ node, ...props }: any) => <li className="pl-2 leading-[1.7] marker:text-[#807D78]" {...props} />,
                    strong: ({ node, ...props }: any) => <strong className="font-semibold text-[#C4C1BC]" {...props} />,
                    a: ({ node, ...props }: any) => <a className="text-[#E2765A] hover:underline" target="_blank" rel="noopener" {...props} />,
                  }}>{renderText}</ReactMarkdown>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      layout={isNote ? 'position' : false}
      initial={isNote ? { opacity: 0, y: 4 } : false}
      animate={isNote ? { opacity: 1, y: 0 } : undefined}
      transition={isNote ? { duration: 0.2, ease: [0.22, 1, 0.36, 1] } : undefined}
      className={`professional-thought eterx-professional-thought relative w-full max-w-full font-sans font-normal selection:bg-[#E2765A]/20 select-text tracking-normal ${ progressive.isRevealing ? 'eterx-reveal-active' : '' } ${ isNote ? 'eterx-professional-note py-1 text-[15.5px] leading-[1.62] text-[#B6B2AB]' : 'eterx-professional-answer text-[15.5px] leading-[1.78] text-[#C4C1BC]' }`}
    >
      {revealEnabled ? (
        <div className="eterx-progressive-markdown">
          <div className="eterx-progressive-markdown-ghost" aria-hidden="true">
            {renderProfessionalMarkdown(renderText, false, true)}
          </div>
          <div className="eterx-progressive-markdown-live">
            {renderProfessionalMarkdown(markdownText, showAnswerWriter)}
          </div>
        </div>
      ) : (
        renderProfessionalMarkdown(markdownText, showAnswerWriter)
      )}
      {suffix}
      <style>{`
        .professional-thought > :first-child { margin-top: 0 !important; }
        .professional-thought > p:last-child { display: inline; }
      `}</style>
    </motion.div>
  );
};

// VS Code GitHub Dark — clean single-pass syntax highlighter
const highlightSyntax = (code: string): string => {
  if (!code) return '';
  const KW_FLOW = new Set(['if', 'else', 'elif', 'for', 'while', 'switch', 'case', 'break', 'continue', 'return', 'try', 'catch', 'finally', 'throw', 'raise', 'with', 'match', 'do']);
  const KW_DECL = new Set(['const', 'let', 'var', 'function', 'class', 'async', 'await', 'import', 'export', 'from', 'as', 'type', 'interface', 'enum', 'extends', 'implements', 'static', 'abstract', 'override', 'def', 'lambda', 'pass', 'yield', 'del', 'require', 'fn', 'pub', 'use', 'struct']);
  const KW_VAL = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'NaN', 'Infinity', 'void']);
  const KW_THIS = new Set(['this', 'self', 'super', 'new', 'typeof', 'instanceof', 'in', 'of', 'is', 'not', 'and', 'or', 'delete', 'readonly', 'keyof', 'number', 'string', 'boolean', 'object', 'any', 'never']);
  const e = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const TOKEN = /(\/\/[^\n]*|#[^!\n][^\n]*|\/\*[\s\S]*?\*\/)|(["'`])(?:(?!\2)[^\\]|\\.)*\2|(0x[0-9A-Fa-f]+|\b\d+\.?\d*(?:e[+-]?\d+)?\b)|([A-Z][a-zA-Z0-9_]*)|([a-z_][a-zA-Z0-9_]*)|(--?[a-zA-Z][a-zA-Z0-9-]*)/g;
  let out = '', last = 0;
  for (const m of e.matchAll(TOKEN)) {
    const [full, cmt, , num, pascal, ident, flag] = m;
    out += e.slice(last, m.index!); last = m.index! + full.length;
    if (cmt) out += `<span style="color:#6E7681;font-style:italic">${ full }</span>`;
    else if (m[2]) out += `<span style="color:#A5D6FF">${ full }</span>`;
    else if (num) out += `<span style="color:#79B8FF">${ full }</span>`;
    else if (pascal) out += `<span style="color:#FFA657">${ full }</span>`;
    else if (ident) {
      if (KW_FLOW.has(ident)) out += `<span style="color:#FF7B72">${ full }</span>`;
      else if (KW_DECL.has(ident)) out += `<span style="color:#FF7B72;font-weight:600">${ full }</span>`;
      else if (KW_VAL.has(ident)) out += `<span style="color:#79C0FF">${ full }</span>`;
      else if (KW_THIS.has(ident)) out += `<span style="color:#79C0FF">${ full }</span>`;
      else out += e.slice(last).trimStart().startsWith('(') ? `<span style="color:#D2A8FF">${ full }</span>` : full;
    }
    else if (flag) out += `<span style="color:#56D364">${ full }</span>`;
    else out += full;
  }
  return out + e.slice(last);
};

const FullScreenModal = ({ onClose, children, title }: { onClose: () => void, children: React.ReactNode, title?: string }) => {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', h, true); document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', h, true); document.body.style.overflow = ''; };
  }, [onClose]);
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-[99999] flex flex-col bg-[#060606]/98 backdrop-blur-xl"
    >
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5"><span className="text-[13px] font-mono text-[#8C8A88] font-bold uppercase tracking-widest">{title || 'Preview'}</span><button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-white/5 text-[#8C8A88] hover:text-white transition-all text-xl">×</button></div>
      <div className="flex-1 overflow-hidden">{children}</div>
    </motion.div>, document.body
  );
};

const IconCopyButton = ({ content, label = 'Copy content' }: { content: string, label?: string }) => {
  const [copied, setCopied] = useState(false);
  const handle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(content || '');
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = content || '';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };
  return (
    <button
      type="button"
      onClick={handle}
      aria-label={copied ? 'Copied' : label}
      className="eterx-action-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border border-white/[0.065] bg-white/[0.035] text-[#9F9991] transition-colors hover:bg-white/[0.07] hover:text-white"
    >
      {copied ? <CheckCircle className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
};

// Converts ANSI escape codes to styled HTML spans
const ansiToHtml = (text: string): string => {
  if (!text) return '';
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ANSI: Record<string, string> = {
    '0': '', '1': 'font-weight:700', '31': 'color:#f85149', '32': 'color:#3fb950',
    '33': 'color:#d29922', '34': 'color:#58a6ff', '35': 'color:#bc8cff',
    '36': 'color:#56d364', '37': 'color:#e6edf3', '90': 'color:#8b949e',
    '91': 'color:#ffa198', '92': 'color:#56d364', '93': 'color:#e3b341',
    '94': 'color:#79c0ff', '95': 'color:#d2a8ff', '96': 'color:#76e3ea',
  };
  return esc.replace(/\x1B\[([0-9;]*)m/g, (_, p) => {
    const style = p.split(';').map((c: string) => ANSI[c] || '').filter(Boolean).join(';');
    return style ? `<span style="${ style }">` : '</span>';
  });
};

const InlineConsole = ({ command, content, exitCode, durationMs }: { command: string, content: string, exitCode?: number, durationMs?: number }) => {
  const [full, setFull] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowOutputRef = useRef(exitCode === undefined);
  const previousContentLengthRef = useRef((content || '').length);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    const el = scrollRef.current;
    const nextLength = (content || '').length;
    const grew = nextLength > previousContentLengthRef.current;
    previousContentLengthRef.current = nextLength;
    if (!el || exitCode !== undefined || !grew || !shouldFollowOutputRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [content, exitCode]);
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    shouldFollowOutputRef.current = nearBottom;
    if (nearBottom !== atBottomRef.current) {
      atBottomRef.current = nearBottom;
      setAtBottom(nearBottom);
    }
  };
  const copyOutput = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(content || '');
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = content || '';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setCopiedOutput(true);
      setTimeout(() => setCopiedOutput(false), 1800);
    } catch (err) {
      console.error('Failed to copy terminal output:', err);
    }
  };
  const lines = content ? content.split(/\r?\n/) : [];
  const lineCount = lines.length;
  const success = exitCode === 0 || exitCode === undefined;
  const durationLabel = durationMs === undefined ? null : durationMs < 1000 ? `${ durationMs }ms` : `${ (durationMs / 1000).toFixed(1) }s`;
  const consolePanel = (
    <div className={`flex flex-col bg-[#1F1F1F] font-mono text-[#DCD7CE] shadow-[0_10px_26px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.035)] ${ full ? 'h-full rounded-none border-0' : 'mx-3 mt-1.5 mb-2 overflow-hidden rounded-[13px] border border-white/[0.085]' }`}>
      <div className="flex items-center justify-between gap-3 px-3 py-1 bg-[#232323]">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="text-[10.5px] font-semibold text-[#AFA9A0]">Shell</span>
          {lineCount > 0 && <span className="hidden sm:inline text-[10.5px] text-[#77716A]">{lineCount} lines</span>}
          {durationLabel && <span className="hidden sm:inline text-[10.5px] text-[#6D6861]">{durationLabel}</span>}
        </div>
        {!full && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setFull(true);
            }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border border-white/[0.065] bg-white/[0.035] text-[#9F9991] transition-colors hover:bg-white/[0.07] hover:text-white"
            aria-label="Open shell output full screen"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="flex items-start gap-2.5 border-y border-white/[0.055] bg-[#202020] px-3 py-2">
        <span className="select-none text-[16px] leading-5 font-semibold text-[#D8D4CC]">$</span>
        <span className="min-w-0 flex-1 break-words text-[12.5px] leading-5 font-medium text-[#E7E2D9]">{command}</span>
        <button
          onClick={copyOutput}
          className="mt-[-2px] flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border border-white/[0.065] bg-white/[0.035] text-[#9F9991] transition-colors hover:bg-white/[0.07] hover:text-white"
          aria-label={copiedOutput ? 'Copied shell output' : 'Copy shell output'}
        >
          {copiedOutput ? <CheckCircle className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className={`relative min-h-0 ${ full ? 'flex-1' : '' }`}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={`eterx-scrollbar overflow-auto px-3 py-2.5 text-[12px] leading-[1.55] text-[#CFCAC2] ${ full ? 'h-full' : 'max-h-[260px] min-h-[74px]' }`}
        >
          <div className="min-w-max whitespace-pre pr-4">
            {content
              ? <span dangerouslySetInnerHTML={{ __html: ansiToHtml(content) }} />
              : <span className="text-[#8A857D] italic">(no output)</span>
            }
          </div>
        </div>
        {!atBottom && lineCount > 8 && (
          <button onClick={(e) => { e.stopPropagation(); const el = scrollRef.current; if (!el) return; shouldFollowOutputRef.current = true; el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }} className="absolute bottom-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.10] bg-[#2E2E2E]/95 text-[#BFB9B0] shadow-[0_8px_22px_rgba(0,0,0,0.35)] transition-colors hover:bg-[#3A3A3A] hover:text-white">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-white/[0.055] bg-[#202020] px-3 py-1.5 text-[11.5px] font-medium text-[#AFA9A0]">
        <span className={`inline-flex items-center gap-1.5 ${ success ? 'text-[#BDB8AF]' : 'text-red-300' }`}>
          {success ? <CheckCircle className="h-3.5 w-3.5 text-[#BDB8AF]" /> : <CornerDownLeft className="h-3.5 w-3.5 text-red-300" />}
          {success ? 'Success' : `Exit ${ exitCode }`}
        </span>
      </div>
    </div>
  );
  return <>{full ? <FullScreenModal onClose={() => setFull(false)} title="Shell">{consolePanel}</FullScreenModal> : <motion.div layout initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}>{consolePanel}</motion.div>}</>;
};

const InlineDiffView = ({ filename, diffLines }: { filename: string, diffLines: any[] }) => {
  const [full, setFull] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(false);
  const [atBottom, setAtBottom] = useState(false);
  const added = diffLines.filter(l => l.type === 'added').length;
  const removed = diffLines.filter(l => l.type === 'removed').length;
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    if (nearBottom !== atBottomRef.current) {
      atBottomRef.current = nearBottom;
      setAtBottom(nearBottom);
    }
  };
  const diffPanel = (
    <div className={`eterx-inline-diff-panel flex flex-col bg-[#1F1F1F] font-mono text-[#DCD7CE] shadow-[0_10px_26px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.035)] ${ full ? 'h-full rounded-none border-0' : 'mx-3 mt-1.5 mb-2 overflow-hidden rounded-[13px] border border-white/[0.085]' }`}>
      {/* Header */}
      <div className="eterx-inline-diff-header flex items-center justify-between gap-3 bg-[#232323] px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="eterx-inline-diff-filename min-w-0 truncate text-[12px] font-semibold text-[#D7D2C9]">{filename}</span>
          <span className="eterx-inline-diff-label shrink-0 text-[10.5px] font-semibold text-[#77716A]">Diff</span>
          {(added > 0 || removed > 0) && (
            <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] font-semibold tabular-nums">
              <span className="text-[#3FB950]">+{added}</span>
              <span className="text-[#FF7B72]">-{removed}</span>
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <IconCopyButton content={diffLines.filter(l => l.type !== 'removed').map(l => l.content).join('\n')} label="Copy diff output" />
          {!full && <button onClick={(e) => { e.stopPropagation(); setFull(true); }} className="eterx-action-icon-button flex h-7 w-7 items-center justify-center rounded-[9px] border border-white/[0.06] bg-white/[0.03] text-[#918B83] transition-colors hover:bg-white/[0.07] hover:text-white" aria-label="Expand diff"><Maximize2 className="h-3.5 w-3.5" /></button>}
        </div>
      </div>
      {/* Single unified scroll container — horizontal + vertical together */}
      <div className={`relative min-h-0 ${ full ? 'flex-1' : '' }`}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={`eterx-inline-diff-scroll eterx-scrollbar overflow-auto text-[12px] leading-[1.55] ${ full ? 'h-full' : 'max-h-[300px] min-h-[74px]' }`}
        >
          {/* Inner container expands to content width — all lines share same horizontal scroll */}
          <div style={{ minWidth: 'max-content' }}>
            {diffLines.map((l, i) => {
              const isAdd = l.type === 'added';
              const isDel = l.type === 'removed';
              return (
                <div key={i} className={`eterx-inline-diff-row flex items-stretch ${ isAdd ? 'eterx-inline-diff-row-added bg-[#143118]/42' : isDel ? 'eterx-inline-diff-row-removed bg-[#361818]/42' : 'eterx-inline-diff-row-context hover:bg-white/[0.025]'
                  }`}>
                  {/* Left colored bar */}
                  <div className={`eterx-inline-diff-bar w-[3px] shrink-0 ${ isAdd ? 'bg-emerald-500' : isDel ? 'bg-red-500' : 'bg-transparent'
                    }`} />
                  {/* Line number */}
                  <div className="eterx-inline-diff-line-number w-[42px] shrink-0 select-none border-r border-white/[0.055] py-[3px] pr-3 text-right text-[10.5px] text-[#6F6962]">{l.newLine || (isDel ? l.oldLine : '')}</div>
                  {/* +/- glyph */}
                  <div className={`eterx-inline-diff-glyph w-[20px] shrink-0 text-center py-[3px] font-bold ${ isAdd ? 'text-emerald-400' : isDel ? 'text-red-400' : 'text-transparent'
                    }`}>{isAdd ? '+' : isDel ? '-' : ' '}</div>
                  {/* Content — no overflow, parent scrolls */}
                  <div
                    className={`eterx-inline-diff-content px-3 py-[3px] whitespace-pre ${ isAdd ? 'text-[#B7EFC0]' : isDel ? 'text-[#F0B0AA]' : 'text-[#BDB7AE]'
                      }`}
                    dangerouslySetInnerHTML={{ __html: highlightSyntax(l.content) }}
                  />
                </div>
              );
            })}
          </div>
        </div>
        {!atBottom && diffLines.length > 10 && (
          <button
            onClick={(e) => { e.stopPropagation(); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}
            className="absolute bottom-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.10] bg-[#2E2E2E]/95 text-[#BFB9B0] shadow-[0_8px_22px_rgba(0,0,0,0.35)] transition-colors hover:bg-[#3A3A3A] hover:text-white"
          ><ChevronDown className="h-3.5 w-3.5" /></button>
        )}
      </div>
    </div>
  );
  return <>{full ? <FullScreenModal onClose={() => setFull(false)} title={`Diff: ${ filename }`}>{diffPanel}</FullScreenModal> : <motion.div layout initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}>{diffPanel}</motion.div>}</>;
};

const InlineCodeView = ({ filename, content }: { filename: string, content: string }) => {
  const [full, setFull] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(false);
  const [atBottom, setAtBottom] = useState(false);
  const lines = useMemo(() => (content || '').split('\n'), [content]);
  const lineCount = lines.length;
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    if (nearBottom !== atBottomRef.current) {
      atBottomRef.current = nearBottom;
      setAtBottom(nearBottom);
    }
  };
  const codePanel = (
    <div className={`flex flex-col bg-[#1F1F1F] font-mono text-[#DCD7CE] shadow-[0_10px_26px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.035)] ${ full ? 'h-full rounded-none border-0' : 'mx-3 mt-1.5 mb-2 overflow-hidden rounded-[13px] border border-white/[0.085]' }`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 bg-[#232323] px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="min-w-0 truncate text-[12px] font-semibold text-[#D7D2C9]">{filename}</span>
          <span className="shrink-0 text-[10.5px] font-semibold text-[#77716A]">{lineCount} lines</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <IconCopyButton content={content} label="Copy file content" />
          {!full && <button onClick={(e) => { e.stopPropagation(); setFull(true); }} className="eterx-action-icon-button flex h-7 w-7 items-center justify-center rounded-[9px] border border-white/[0.06] bg-white/[0.03] text-[#918B83] transition-colors hover:bg-white/[0.07] hover:text-white" aria-label="Expand file"><Maximize2 className="h-3.5 w-3.5" /></button>}
        </div>
      </div>
      {/* Single unified scroll container */}
      <div className={`relative min-h-0 ${ full ? 'flex-1' : '' }`}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={`eterx-scrollbar overflow-auto text-[12px] leading-[1.55] ${ full ? 'h-full' : 'max-h-[300px] min-h-[74px]' }`}
        >
          {/* Inner div expands to content width — all lines share the same horizontal scroll */}
          <div style={{ minWidth: 'max-content' }}>
            {lines.map((l, i) => (
              <div key={i} className="flex items-stretch hover:bg-white/[0.025] group">
                {/* Line number — sticky left via position (plain div, no overflow) */}
                <div className="w-[42px] shrink-0 select-none border-r border-white/[0.055] py-[3px] pr-3 text-right text-[10.5px] text-[#6F6962] transition-colors group-hover:text-[#9B948B]">{i + 1}</div>
                {/* Content — whitespace-pre, no per-line overflow */}
                <div
                  className="px-3 py-[3px] whitespace-pre text-[#CFCAC2]"
                  dangerouslySetInnerHTML={{ __html: highlightSyntax(l) }}
                />
              </div>
            ))}
          </div>
        </div>
        {!atBottom && lineCount > 10 && (
          <button
            onClick={(e) => { e.stopPropagation(); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}
            className="absolute bottom-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.10] bg-[#2E2E2E]/95 text-[#BFB9B0] shadow-[0_8px_22px_rgba(0,0,0,0.35)] transition-colors hover:bg-[#3A3A3A] hover:text-white"
          ><ChevronDown className="h-3.5 w-3.5" /></button>
        )}
      </div>
    </div>
  );
  return <>{full ? <FullScreenModal onClose={() => setFull(false)} title={`File: ${ filename }`}>{codePanel}</FullScreenModal> : <motion.div layout initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}>{codePanel}</motion.div>}</>;
};

// ─── Single row inside a tool card ──────────────────────────────────────────
const numberFrom = (...values: any[]) => {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
};

const getDiffStats = (preview: any, log: any) => {
  let added = numberFrom(log.added, log.additions, log.insertions, log.linesAdded);
  let removed = numberFrom(log.removed, log.deleted, log.deletions, log.linesRemoved);
  if (preview?.diffLines?.length) {
    added = preview.diffLines.filter((line: any) => line.type === 'added').length;
    removed = preview.diffLines.filter((line: any) => line.type === 'removed').length;
  } else if (preview) {
    added = numberFrom(preview.added, preview.additions, preview.insertions, preview.linesAdded, added);
    removed = numberFrom(preview.removed, preview.deleted, preview.deletions, preview.linesRemoved, removed);
    if (!preview.isEdit && preview.content && added === 0 && removed === 0) {
      added = String(preview.content).split('\n').length;
    }
  }
  if (added === 0 && removed === 0) return null;
  return { added, removed };
};

const getLineContext = (subtitle: string, fileName: string) => {
  const text = String(subtitle || '').trim();
  if (!text) return '';
  const lineMatch = text.match(/#?L\d+(?:[-:]\d+)?/i);
  if (lineMatch) {
    const value = lineMatch[0].replace(/^#?/, '#');
    return value.replace(/:/g, '-');
  }
  const normalizedFile = fileName.toLowerCase();
  if (normalizedFile && text.toLowerCase().includes(normalizedFile)) {
    const afterFile = text.slice(text.toLowerCase().lastIndexOf(normalizedFile) + normalizedFile.length).trim();
    if (afterFile && afterFile.length <= 32) return afterFile;
  }
  return text.length <= 42 ? text : '';
};

const ACTION_CARD_CLASS = "eterx-action-card w-full overflow-hidden rounded-[14px] border border-white/[0.10] bg-[#111111]/76 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_4px_16px_rgba(0,0,0,0.20)]";
const ACTION_ROW_DIVIDER_CLASS = "eterx-action-row-divider border-t border-white/[0.07]";

const findLatestConsoleOutput = (logs: any[], commandSnippet: string) => {
  if (!commandSnippet) return null;
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const candidate = logs[i];
    if (candidate?.type === 'console_output' && String(candidate.command || '').includes(commandSnippet)) {
      return candidate;
    }
  }
  return null;
};

const ActionChip = ({
  log, isLastChip, isActiveGroup, allLogs,
  isNested = false, inCard = false
}: {
  log: any, isLastChip: boolean, isActiveGroup: boolean, allLogs: any[],
  isNested?: boolean, inCard?: boolean
}) => {
  const isLiveChip = isActiveGroup && isLastChip;
  const isEdit = log.type === 'file_edit';
  const { openPanel } = useFilePanelActions();
  // Determine the filename to show as a blue link
  const rawPath = log.filename && log.filename !== 'system' ? log.filename : '';
  const fileName = rawPath.split(/[\\/]/).pop() || '';
  const hasFile = !!fileName && fileName !== 'system';
  // Subtitle: the secondary arg (command string, URL, query, etc.)
  const subtitle = log.secondary && log.secondary !== log.filename ? String(log.secondary).substring(0, 120) : '';
  const preview = useMemo(() => {
    const myIdx = allLogs.indexOf(log);
    const searchLogs = myIdx !== -1 ? allLogs.slice(myIdx) : allLogs;
    if (log.type === 'command') {
      const cmd = String(log.secondary || '').trim();
      return findLatestConsoleOutput(searchLogs, cmd.substring(0, 20));
    }
    if (isEdit) {
      return searchLogs.find((l: any) => l.type === 'file_preview' && String(l.filename || '').includes(fileName))
        || allLogs.find((l: any) => l.type === 'file_preview' && String(l.filename || '').includes(fileName))
        || null;
    }
    if (log.type === 'exploration' && (log.text === 'Reading file' || log.text?.toLowerCase().includes('read'))) {
      return searchLogs.find((l: any) => l.type === 'file_preview' && String(l.filename || '').includes(fileName))
        || allLogs.find((l: any) => l.type === 'file_preview' && String(l.filename || '').includes(fileName))
        || null;
    }
    return null;
  }, [allLogs, isEdit, log, fileName]);
  const [isExpanded, setIsExpanded] = useState(false);
  // Resolve the full path for IDE link
  const fullPath = rawPath || preview?.filepath || '';
  const fullPathLabel = fullPath || rawPath || fileName;
  const lineContext = hasFile ? getLineContext(subtitle, fileName) : '';
  const diffStats = isEdit ? getDiffStats(preview, log) : null;
  const fileActionLabel = isEdit ? 'Open diff' : 'Open file';
  // Past-tense verb for display; live overrides to present tense below
  const meta = useMemo(() => {
    if (isEdit) {
      const lowerText = String(log.text || '').toLowerCase();
      const lowerIcon = String(log.iconCategory || '').toLowerCase();
      const isDelete = /delete|remove|unlink/.test(lowerText);
      const isRefactor = /refactor|restructure|rework|cleanup|clean up|dedupe|extract|rename|move/.test(lowerText);
      const isScaffold = /scaffold/.test(lowerText);
      const isGenerate = /generat|artifact|compose|draft/.test(lowerText);
      const isCreate = lowerIcon.includes('create') || lowerText.includes('created') || lowerText.includes('writing') || lowerText.includes('artifact') || lowerText.includes('generating') || lowerText.includes('scaffolding');
      if (isDelete) return { icon: null, verbDone: 'Deleted', verbLive: 'Deleting', color: '#E8E6E3' };
      if (isRefactor) return { icon: null, verbDone: 'Refactored', verbLive: 'Refactoring', color: '#E8E6E3' };
      if (isScaffold) return { icon: null, verbDone: 'Scaffolded', verbLive: 'Scaffolding', color: '#E8E6E3' };
      if (preview) return {
        icon: null,
        verbDone: preview.isEdit ? 'Edited' : isGenerate ? 'Generated' : 'Created',
        verbLive: preview.isEdit ? 'Editing' : isGenerate ? 'Generating' : 'Creating',
        color: '#E8E6E3',
      };
      return { icon: null, verbDone: isCreate ? 'Created' : 'Edited', verbLive: isCreate ? 'Creating' : 'Editing', color: '#E8E6E3' };
    }
    const base = getToolMeta(log.text, log.type, log.icon);
    // Map past-tense verbs → live present-tense
    const LIVE_VERBS: Record<string, string> = {
      'Ran': 'Running', 'Read': 'Reading', 'Listed': 'Listing',
      'Edited': 'Editing', 'Created': 'Creating', 'Searched': 'Searching',
      'Web searched': 'Web searching', 'Scraped': 'Scraping',
      'Researched': 'Researching', 'Analyzed': 'Analyzing',
      'Refactored': 'Refactoring', 'Verified': 'Verifying',
      'Scaffolded': 'Scaffolding', 'Loaded': 'Loading',
      'Called API': 'Calling API', 'Generated': 'Generating',
      'Queried': 'Querying', 'Comparing': 'Compared',
    };
    return { ...base, verbDone: base.verb, verbLive: LIVE_VERBS[base.verb] || base.verb };
  }, [isEdit, log.text, log.type, log.icon, log.iconCategory, preview]);
  const displayVerb = isLiveChip ? (meta.verbLive || meta.verbDone) : (meta.verbDone || (meta as any).verb);
  // Open a file into the IDE panel
  const openInIde = (e: React.MouseEvent, mode?: 'preview' | 'code' | 'diff') => {
    e.stopPropagation();
    if (!fullPath) return;
    const preferredMode = mode || (isEdit ? 'diff' : 'code');
    openPanel({
      filename: fileName,
      filepath: fullPath,
      content: typeof preview?.content === 'string' ? preview.content : undefined,
      diffLines: preview?.diffLines,
      isEdit: preview?.isEdit || isEdit,
      linesAdded: preview?.linesAdded ?? preview?.added ?? log.linesAdded ?? log.added,
      linesRemoved: preview?.linesRemoved ?? preview?.removed ?? log.linesRemoved ?? log.removed,
      added: preview?.added ?? preview?.linesAdded ?? log.added ?? log.linesAdded,
      removed: preview?.removed ?? preview?.linesRemoved ?? log.removed ?? log.linesRemoved,
      lineCount: preview?.lineCount,
      totalLines: preview?.totalLines ?? preview?.lineCount,
      loadedLines: preview?.loadedLines,
      startLine: preview?.startLine,
      endLine: preview?.endLine,
      truncated: preview?.truncated,
      size: preview?.size,
      activeTabMode: preferredMode,
    });
  };

  // Think chips: no icon, just label
  const isThinkChip = log.text === 'Think' || log.type === 'think';

  return (
    <div className="w-full">
      <div
        onClick={(e) => {
          e.stopPropagation();
          if (preview) setIsExpanded((open) => !open);
        }}
        className={`eterx-action-chip flex min-h-[42px] items-center gap-2.5 px-2.5 py-1.5 transition-colors group ${ inCard ? 'rounded-none border-0 bg-transparent hover:bg-white/[0.035]' : preview ? `${ACTION_CARD_CLASS} cursor-pointer hover:bg-[#151515]/92 hover:border-white/[0.16]` : `${ACTION_CARD_CLASS} cursor-default hover:bg-[#151515]/72` } ${ preview ? 'cursor-pointer' : 'cursor-default' }`}
      >
        {inCard ? <div className="w-0 shrink-0" /> : <div className="w-1 shrink-0" />}
        {!isThinkChip && (() => {
          // Terminal-style traces can arrive with custom text and older computer categories.
          const iconCategory = shouldUseTerminalIcon(log, subtitle, preview) ? 'terminal' : log.iconCategory;
          const agentEntry = resolveAgentIcon(displayVerb, log.text, iconCategory);
          const { Icon: AI, color: ac } = agentEntry;
          return <span className="eterx-action-icon flex h-7 w-7 items-center justify-center shrink-0"><AI isLive={isLiveChip} size={18} color={isLiveChip ? ac : '#DAD6CF'} /></span>;
        })()}
        {isThinkChip && <div className="w-1 shrink-0" />}
        <span className={`eterx-action-verb shrink-0 truncate text-[14px] font-semibold leading-tight tracking-normal ${isLiveChip ? 'eterx-live-text eterx-live-text--chip' : 'text-[#C9C5BE]'}`}>{displayVerb}</span>
        {hasFile && (
          <span className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              onClick={(e) => openInIde(e, 'code')}
              className="eterx-action-file-link min-w-0 truncate text-left text-[14px] font-semibold leading-tight text-[#8BD3FF] transition-colors duration-150 hover:text-[#B9E7FF] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8BD3FF]/25"
              aria-label={`Open file: ${fileName}`}
            >
              {fileName}
            </button>
            {diffStats && (
              <button
                type="button"
                onClick={(e) => openInIde(e, 'diff')}
                className="eterx-action-diff-chip group/diff relative -my-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 font-mono text-[12.5px] font-bold tabular-nums leading-none text-[#C9C5BE] transition-all duration-150 hover:bg-white/[0.075] hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12),0_8px_20px_rgba(0,0,0,0.20)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                aria-label={`${fileActionLabel}: ${fileName}`}
              >
                  <span className="eterx-action-diff-added text-[#3EE06F]">+{diffStats.added}</span>
                  <span className="eterx-action-diff-removed text-[#FF6D63]">-{diffStats.removed}</span>
                  <span className="eterx-action-diff-tooltip pointer-events-none absolute -top-8 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-full border border-white/[0.10] bg-[#242424]/96 px-2.5 py-1 text-[11px] font-semibold text-[#E8E6E3] opacity-0 shadow-[0_10px_28px_rgba(0,0,0,0.35)] backdrop-blur-xl transition-all duration-150 group-hover/diff:-top-9 group-hover/diff:opacity-100">
                    Open diff
                  </span>
              </button>
            )}
            {lineContext && (
              <span className="shrink-0 font-mono text-[12px] font-medium leading-tight text-[#817C74]">
                {lineContext}
              </span>
            )}
          </span>
        )}
        {!hasFile && subtitle && (
          <span className="min-w-0 truncate font-mono text-[13px] leading-tight text-[#8D887F]">{subtitle}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center justify-end gap-2 pl-3">
          {preview && (
            <ChevronRight className={`h-4 w-4 shrink-0 transition-all ${isExpanded ? 'rotate-90 text-[#C9C5BE]' : 'text-[#8F897F]'} group-hover:translate-x-0.5 group-hover:text-[#C9C5BE]`} />
          )}
          {hasFile && fullPath.toLowerCase().match(/\.(html|htm)$/) && (
            <button
              onClick={(e) => { e.stopPropagation(); openPanel({ filename: fileName, filepath: fullPath, content: typeof preview?.content === 'string' ? preview.content : undefined, lineCount: preview?.lineCount, totalLines: preview?.totalLines ?? preview?.lineCount, truncated: preview?.truncated, activeTabMode: 'preview' }); }}
              className="flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.045] px-2 py-0.5 text-[10px] font-bold uppercase text-[#C8C6C3] transition-all hover:border-[#4FC1FF]/25 hover:bg-[#4FC1FF]/10 hover:text-[#4FC1FF] shrink-0"
            ><Monitor className="w-2.5 h-2.5" /> Preview</button>
          )}
        </span>
      </div>
      <AnimatePresence>{isExpanded && preview && (
        <div className="w-full">
          {preview.type === 'console_output'
            ? <InlineConsole command={preview.command || subtitle} content={preview.output || preview.content} exitCode={preview.exitCode} durationMs={preview.durationMs} />
            : preview.type === 'file_preview' && preview.isEdit
              ? <InlineDiffView filename={preview.filename || fileName} diffLines={preview.diffLines} />
              : preview.type === 'file_preview'
                ? <InlineCodeView filename={preview.filename || fileName} content={preview.content} />
                : null}
        </div>
      )}</AnimatePresence>
    </div>
  );
};

// Sub-agent card — professional with status indicator
const SubAgentCard = ({ log, onOpenAgentTeam }: { log: any; onOpenAgentTeam?: (name?: string) => void }) => {
  const [open, setOpen] = useState(false);
  const agentName = log.agentName || log.subAgent || log.secondary || 'Sub-agent';
  const isComplete = log.type === 'sub_agent_complete' || log.agentStatus === 'completed' || log.status === 'done';
  const isFailed = log.type === 'sub_agent_error' || log.agentStatus === 'failed' || log.status === 'error';
  const isWorking = !isComplete && !isFailed && (log.type === 'sub_agent_action' || log.agentStatus === 'running');
  const durationLabel = log.durationMs ? `${Math.round(log.durationMs / 1000)}s` : null;
  const stepLabel = log.stepCount ? `${log.stepCount} steps` : null;
  const metaText = [durationLabel, stepLabel].filter(Boolean).join(' · ') || (isWorking ? 'Working...' : 'Parallel worker');
  const displayText = log.taskSummary || log.result || log.content || log.text || '';

  const statusRing = isComplete ? 'ring-emerald-500/25' : isFailed ? 'ring-red-500/25' : isWorking ? 'ring-amber-500/25' : 'ring-violet-500/20';
  const statusDot = isComplete ? 'bg-emerald-400' : isFailed ? 'bg-red-400' : isWorking ? 'bg-amber-400 animate-pulse' : '';
  const statusBadge = isComplete
    ? { bg: 'bg-emerald-500/8 border-emerald-500/15', text: 'text-emerald-400', label: 'Done' }
    : isFailed
    ? { bg: 'bg-red-500/8 border-red-500/15', text: 'text-red-400', label: 'Error' }
    : isWorking
    ? { bg: 'bg-amber-500/8 border-amber-500/15', text: 'text-amber-400', label: 'Working' }
    : { bg: 'bg-violet-500/8 border-violet-500/15', text: 'text-violet-400', label: 'Agent' };

  return (
    <div className="my-1.5 overflow-hidden">
      <button onClick={() => setOpen(!open)} onDoubleClick={() => (onOpenAgentTeam as any)?.(agentName)} className={`w-full flex min-h-[52px] items-center gap-3 rounded-[14px] px-3.5 py-2.5 transition-all border ${open ? 'bg-[#110F1A] border-violet-500/15' : 'bg-white/[0.015] border-white/[0.04] hover:bg-white/[0.025] hover:border-white/[0.06]'}`}>
        {/* Avatar */}
        <span className={`relative flex h-9 w-9 items-center justify-center shrink-0 rounded-full bg-[#1a1a1a] ring-2 ${statusRing}`}>
          <span className="text-[13px] font-bold text-[#D4D0CB]">{agentName.charAt(0)}</span>
          {statusDot && <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ${statusDot} border-[1.5px] border-[#0F0F0F]`} />}
        </span>

        {/* Info */}
        <span className="min-w-0 flex-1 text-left">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold tracking-normal text-[#E0DCD6]">{agentName}</span>
            <span className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${statusBadge.bg} ${statusBadge.text}`}>
              {isWorking && <span className="relative flex h-2 w-2"><span className="absolute inset-0 rounded-full border border-white/10" /><span className="absolute inset-0 rounded-full border border-transparent border-t-amber-400 animate-[spin_1.1s_linear_infinite]" /></span>}
              {statusBadge.label}
            </span>
          </span>
          <span className="block truncate text-[11px] font-medium text-[#6B6660] mt-0.5">{metaText}</span>
        </span>

        <ChevronRight className={`h-3.5 w-3.5 text-[#3A3835] transition-all ${ open ? 'rotate-90 text-violet-400/60' : '' }`} />
      </button>
      <AnimatePresence>
        {open && displayText && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="ml-7 border-l-2 border-violet-500/10 pl-4 pb-3 pt-2 text-[12px] text-[#8B8580] leading-relaxed whitespace-pre-wrap font-mono max-h-[350px] overflow-y-auto eterx-scrollbar">
              {displayText}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// Sub-agent spawn card — shows when agents are launched
const SubAgentSpawnCard = ({ log, onOpenAgentTeam }: { log: any; onOpenAgentTeam?: (name?: string) => void }) => {
  const agents = log.agentDetails || log.spawnedAgents || [];
  const agentList = Array.isArray(agents)
    ? agents.map((a: any) => typeof a === 'string' ? a : a.name).filter(Boolean)
    : [];
  const nameStr = agentList.length > 0 ? agentList.join(' · ') : String(log.secondary || log.text || '');
  const taskText = log.task || log.text || 'Spawning sub-agents';

  return (
    <div className="my-1.5 overflow-hidden">
      <div onClick={() => (onOpenAgentTeam as any)?.('all')} className={`w-full flex min-h-[48px] items-center gap-3 rounded-[14px] px-3.5 py-2.5 bg-violet-500/[0.03] border border-violet-500/10 cursor-pointer hover:bg-violet-500/[0.05] transition-colors ${ACTION_CARD_CLASS}`}>
        <span className="flex h-9 w-9 items-center justify-center shrink-0 rounded-[10px] bg-gradient-to-br from-violet-500/15 to-indigo-500/15 border border-violet-500/15">
          <AgentAssetIcon size={18} color="#A78BFA" />
        </span>
        <span className="min-w-0 flex-1 text-left">
          <span className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-violet-200/90">Team Spawned</span>
            <span className="text-[10px] text-violet-400/60 font-mono">{agentList.length > 0 ? `${agentList.length} agents` : ''}</span>
          </span>
          <span className="block truncate text-[11px] text-[#6B6660] mt-0.5">{nameStr || taskText}</span>
        </span>
      </div>
    </div>
  );
};


// Inter-agent communication card — shows messages between agents
const InterAgentCommCard = ({ log, onOpenAgentTeam }: { log: any; onOpenAgentTeam?: (name?: string) => void }) => {
  const fromAgent = log.from || log.agentName || 'Agent';
  const toAgent = log.to || log.secondary || 'Main';
  const msgType = log.messageType || log.commType || 'info_share';
  const subject = log.subject || log.text || '';
  const body = log.body || log.content || '';

  const typeEmoji: Record<string, string> = {
    info_share: '💡', question: '❓', answer: '✅', alert: '🚨',
    coordination: '🤝', discovery: '🔍', progress: '📊', handoff: '📋',
  };

  return (
    <div className="my-1.5 overflow-hidden">
      <div className={`flex min-h-[44px] items-center gap-3 rounded-[14px] px-3.5 py-2.5 bg-indigo-500/[0.02] border border-indigo-500/10 ${ACTION_CARD_CLASS}`}>
        <span className="text-[16px] shrink-0">{typeEmoji[msgType] || '📩'}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[12px] font-bold text-indigo-300/80">{fromAgent}</span>
            <svg className="w-3 h-3 text-[#3A3835]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            <span className="text-[12px] font-bold text-indigo-300/80">{toAgent === '*' ? 'All' : toAgent}</span>
            <span className="px-1.5 py-0.5 rounded-full bg-indigo-500/8 border border-indigo-500/10 text-[8px] font-bold text-indigo-400/60 uppercase tracking-wider">{msgType.replace('_', ' ')}</span>
          </span>
          {subject && <span className="block text-[11px] text-[#8B8580] mt-0.5 truncate">{subject}</span>}
        </span>
      </div>
    </div>
  );
};

// Sub-agent error card
const SubAgentErrorCard = ({ log }: { log: any }) => {
  const agentName = log.agentName || log.subAgent || 'Agent';
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`my-1.5 flex min-h-[48px] items-center gap-3 rounded-[14px] px-3 py-2.5 ${ACTION_CARD_CLASS}`}
    >
      <span className="flex h-9 w-9 items-center justify-center shrink-0 rounded-[10px] bg-red-500/[0.08] border border-red-500/15">
        <AgentAssetIcon size={18} color="#F87171" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold text-[#E8B4B4]">{agentName} {log.errorType === 'cancelled' ? 'stopped' : 'encountered an error'}</span>
        <span className="block text-[12px] font-medium text-[#8B6B6B] mt-0.5 truncate">{log.secondary || ''}</span>
      </span>
    </motion.div>
  );
};

// Safety warning banner
const SafetyBanner = ({ log }: { log: any }) => (
  <div className="flex items-start gap-2.5 px-3 py-2.5 my-1 rounded-lg bg-red-500/5 border border-red-500/20">
    <ShieldHalf className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
    <div>
      <span className="text-[11px] font-bold text-red-400 uppercase tracking-widest block mb-0.5">Safety Warning</span>
      <span className="text-[12.5px] text-[#f5b5b5]">{log.text || log.secondary}</span>
    </div>
  </div>
);

// ─── Card containing one or more tool rows ────────────────────────────────────
const AskUserTimelineCard = ({ log, isLive }: { log: any; isLive: boolean }) => {
  const [open, setOpen] = useState(false);
  const answered = Boolean(log.answeredWith);
  const questions = Array.isArray(log.questions) ? log.questions.filter((item: any) => String(item?.question || '').trim()) : [];
  const question = String(log.question || log.secondary || log.text || 'Waiting for user input');
  const questionLabel = questions.length > 1 ? `${questions.length} questions` : question;
  const answer = String(log.answeredWith || '');

  return (
    <div className="my-1.5 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className={`${ACTION_CARD_CLASS} flex min-h-[46px] items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.035]`}
      >
        <span className="eterx-action-icon flex h-7 w-7 shrink-0 items-center justify-center">
          {answered ? (
            <Check className="h-4 w-4 text-[#DAD6CF]" />
          ) : (
            <AgentAssetIcon size={18} color="#DAD6CF" />
          )}
        </span>
        <span className={`shrink-0 truncate text-[14px] font-semibold leading-tight tracking-normal ${!answered && isLive ? 'eterx-live-text eterx-live-text--chip' : 'text-[#C9C5BE]'}`}>
          {answered ? 'Asked user' : `Asking user${isLive ? '...' : ''}`}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-[#8D887F]">
          {questionLabel}
        </span>
        <ChevronRight className={`h-4 w-4 shrink-0 text-[#8F897F] transition-transform ${open ? 'rotate-90 text-[#C9C5BE]' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="mx-3 mb-2 mt-1.5 rounded-[12px] border border-white/[0.08] bg-white/[0.025] p-3 text-[12.5px] leading-relaxed text-[#BDB8B0]">
              <div className="font-semibold text-[#E2DED7]">Question</div>
              <div className="mt-1 whitespace-pre-wrap">{question}</div>
              {questions.length > 1 && (
                <div className="mt-2 space-y-1.5">
                  {questions.map((item: any, index: number) => (
                    <div key={item.id || index} className="rounded-[8px] border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
                      <span className="text-[#8D887F]">{index + 1}.</span>{' '}
                      <span>{String(item.question || '')}</span>
                    </div>
                  ))}
                </div>
              )}
              {answered && (
                <>
                  <div className="mt-3 font-semibold text-[#E2DED7]">Answer</div>
                  <div className="mt-1 whitespace-pre-wrap">{answer}</div>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const CollapsibleActionGroup = ({
  logs, isActiveGroup, isLast, allLogs
}: {
  logs: any[], isActiveGroup: boolean, isLast: boolean, allLogs: any[]
}) => {
  const visibleLogs = logs.filter(Boolean);
  if (visibleLogs.length === 0) return null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className={ACTION_CARD_CLASS}
    >
      {visibleLogs.map((log, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.18, delay: i * 0.06, ease: 'easeOut' }}
          className={i > 0 ? ACTION_ROW_DIVIDER_CLASS : ''}
        >
          <ActionChip
            log={log}
            isLastChip={isLast && i === visibleLogs.length - 1}
            isActiveGroup={isActiveGroup}
            allLogs={allLogs}
            isNested={i > 0}
            inCard
          />
        </motion.div>
      ))}
    </motion.div>
  );
};

// Live working indicator — real-time log-state-connected
// 3 modes: thinking (thought_stream/work_note last), acting (real action last), idle (between)

const THINKING_PHRASES = [
  { text: 'Starting', dur: 0 },
];

const IDLE_PHRASES = [
  { text: 'Working', dur: 0 },
];

const DEFAULT_LIVE_PHRASE = { text: 'Working', dur: 0 };

function makeShuffledQueue<T>(arr: T[], exclude?: T): T[] {
  const source = arr.length > 0 ? arr : [DEFAULT_LIVE_PHRASE as T];
  const filtered = exclude !== undefined ? source.filter(x => x !== exclude) : [...source];
  const pool = filtered.length > 0 ? filtered : [...source];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

const LiveWorkingIndicator = ({ logs }: { logs: any[] }) => {
  // Derive real-time state from the last log
  const getLogState = (ls: any[]): { mode: 'thinking' | 'acting' | 'idle'; label: string | null } => {
    if (ls.length === 0) return { mode: 'thinking', label: 'Starting' };
    const last = ls[ls.length - 1];
    if (last.type === 'thought_stream' || last.type === 'work_note') {
      return isLiveThoughtFresh(last)
        ? { mode: 'thinking', label: 'Working' }
        : { mode: 'idle', label: 'Working' };
    }
    if (['command', 'exploration', 'file_edit', 'communication', 'progress', 'browser'].includes(last.type)) {
      const meta = getToolMeta(last.text, last.type, last.icon);
      const fileName = (last.filename || '').split(/[\\/]/).pop() || '';
      const LIVE_VERBS: Record<string, string> = {
        Ran: 'Running',
        Read: 'Reading',
        Listed: 'Listing',
        Edited: 'Editing',
        Created: 'Creating',
        Searched: 'Searching',
        Analyzed: 'Analyzing',
        Refactored: 'Refactoring',
        Verified: 'Verifying',
        Generated: 'Generating',
      };
      const verb = LIVE_VERBS[meta.verb] || meta.verb || 'Working';
      const label = fileName ? `${ verb } ${ fileName }` : verb;
      return { mode: 'acting', label: 'Working' };
    }
    return { mode: 'idle', label: 'Working' };
  };

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeRef = useRef<'thinking' | 'acting' | 'idle'>('idle');
  const queueRef = useRef<{ text: string; dur: number }[]>([]);
  const lastLabelRef = useRef<string>('');
  const [statusTick, setStatusTick] = useState(0);
  const logSignature = useMemo(() => {
    const last = logs[logs.length - 1];
    if (!last) return 'empty';
    return [
      logs.length,
      last.type,
      last._traceIdx ?? '',
      last.text ? String(last.text).length : 0,
      last.endTime ?? '',
      last.startTime ?? '',
      last.filename ?? '',
      last.secondary ?? '',
    ].join(':');
  }, [logs]);

  const [label, setLabel] = useState<string>(() => {
    const s = getLogState(logs);
    return s.label || (s.mode === 'thinking' ? THINKING_PHRASES[0].text : IDLE_PHRASES[0].text);
  });
  const [flip, setFlip] = useState(false);

  const doTransition = (nextText: string, nextDur: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setFlip(true);
    setTimeout(() => {
      setLabel(nextText);
      lastLabelRef.current = nextText;
      setFlip(false);
    }, 260);
    if (nextDur > 0) timerRef.current = setTimeout(() => advancePhrase(modeRef.current), nextDur);
  };

  const advancePhrase = (mode: 'thinking' | 'acting' | 'idle') => {
    const pool = mode === 'thinking' ? THINKING_PHRASES : IDLE_PHRASES;
    if (queueRef.current.length === 0) {
      queueRef.current = makeShuffledQueue(pool, pool.find(p => p.text === lastLabelRef.current));
    }
    const next = queueRef.current.shift() || pool[0] || DEFAULT_LIVE_PHRASE;
    doTransition(next.text, next.dur);
  };

  // Mount: start with current state
  useEffect(() => {
    const { mode, label: ctxLabel } = getLogState(logs);
    modeRef.current = mode;
    if (mode === 'acting' && ctxLabel) {
      doTransition(ctxLabel, 4000);
    } else {
      const pool = mode === 'thinking' ? THINKING_PHRASES : IDLE_PHRASES;
      queueRef.current = makeShuffledQueue(pool);
      const first = queueRef.current.shift() || pool[0] || DEFAULT_LIVE_PHRASE;
      doTransition(first.text, first.dur);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  // React to log changes — immediately reflect mode/action
  useEffect(() => {
    const last = logs[logs.length - 1];
    if (!last || (last.type !== 'thought_stream' && last.type !== 'work_note')) return;
    if (!isLiveThoughtFresh(last)) return;
    const updatedAt = getLogUpdatedAt(last);
    if (updatedAt === null) return;
    const delay = Math.max(120, LIVE_THOUGHT_FRESH_MS - (Date.now() - updatedAt) + 10);
    const timeout = window.setTimeout(() => setStatusTick(t => t + 1), delay);
    return () => window.clearTimeout(timeout);
  }, [logSignature, logs, statusTick]);

  const prevSignatureRef = useRef(logSignature);
  useEffect(() => {
    const signatureChanged = logSignature !== prevSignatureRef.current;
    if (!signatureChanged && statusTick === 0) return;
    prevSignatureRef.current = logSignature;
    const { mode, label: ctxLabel } = getLogState(logs);
    const prevMode = modeRef.current;
    modeRef.current = mode;

    if (ctxLabel && ctxLabel !== lastLabelRef.current) {
      // New real action — show it immediately
      queueRef.current = [];
      doTransition(ctxLabel, 0);
    } else if (mode === 'thinking' && prevMode !== 'thinking') {
      // Just entered thinking mode
      queueRef.current = makeShuffledQueue(THINKING_PHRASES);
      const next = queueRef.current.shift() || THINKING_PHRASES[0] || DEFAULT_LIVE_PHRASE;
      doTransition(next.text, next.dur);
    } else if (mode === 'idle' && prevMode !== 'idle') {
      // Just entered idle mode
      queueRef.current = makeShuffledQueue(IDLE_PHRASES);
      const next = queueRef.current.shift() || IDLE_PHRASES[0] || DEFAULT_LIVE_PHRASE;
      doTransition(next.text, next.dur);
    }
    // Same mode: let the current timer naturally advance
  }, [logSignature, statusTick, logs]);

  const latestLog = logs[logs.length - 1];
  const signatureSeenAtRef = useRef({ signature: logSignature, at: Date.now() });
  if (signatureSeenAtRef.current.signature !== logSignature) {
    signatureSeenAtRef.current = { signature: logSignature, at: Date.now() };
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => setStatusTick(t => t + 1), LIVE_ACTION_SETTLE_MS + 24);
    return () => window.clearTimeout(timeout);
  }, [logSignature]);

  const hideDuringFreshThought = !!latestLog
    && (latestLog.type === 'thought_stream' || latestLog.type === 'work_note')
    && isLiveThoughtFresh(latestLog);
  const isRecentAction = !!latestLog
    && !hideDuringFreshThought
    && logs.length > 0
    && Date.now() - signatureSeenAtRef.current.at <= LIVE_ACTION_SETTLE_MS;
  const shouldHideLiveStatus = hideDuringFreshThought || isRecentAction;

  return (
    <AnimatePresence initial={false}>
      {!shouldHideLiveStatus && (
        <motion.div
          key={label}
          layout
          initial={{ opacity: 0, x: -14, scale: 0.98 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: -12, scale: 0.98, transition: { duration: 0.18, ease: 'easeInOut' } }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          className="mt-1 mb-2 flex min-h-[42px] w-fit max-w-full items-center gap-2 overflow-visible py-0.5"
        >
          <AgentFace
            size="work"
            mode={modeRef.current === 'acting' ? 'working' : modeRef.current === 'thinking' ? 'thinking' : 'idle'}
            actionKey={label}
            interactive
            syncWithController={false}
            ariaLabel="EterX active agent face"
          />
          <motion.span
            key={`label-${label}`}
            initial={{ opacity: 0, x: -7 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -7 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="eterx-live-text eterx-live-text--ambient min-w-0 truncate pb-[2px] text-[14px] font-semibold leading-[1.35] tracking-normal"
          >
            {label}
          </motion.span>
        </motion.div>
      )}
    </AnimatePresence>
  );
};


// Elapsed time hook
const useElapsed = (active: boolean) => {
  const [t, setT] = useState(0);
  const start = useRef(Date.now());
  useEffect(() => {
    if (!active) return;
    start.current = Date.now();
    const iv = setInterval(() => setT(Math.floor((Date.now() - start.current) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [active]);
  if (!active) return null;
  const m = Math.floor(t / 60), s = t % 60;
  return m > 0 ? `${ m }m ${ s }s` : `${ s }s`;
};


// ═══════════════════════════════════════════════════════════════════
// SteeringCard — rendered when the user sends a live steering message
// while the agent is running. Shows immediately in the timeline.
// ═══════════════════════════════════════════════════════════════════
const SteeringCard = ({ log }: { log: any }) => {
  return (
    <motion.div
      initial={{ opacity: 0, x: 20, y: 10, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 450, damping: 24 }}
      className="flex justify-end w-full my-3.5 relative z-10 group/steer"
    >
      <div className="bg-[#242424] text-white px-5 py-3.5 rounded-[22px] rounded-tr-[6px] ml-auto text-[15.5px] shadow-[0_2px_12px_rgba(0,0,0,0.28)] leading-relaxed whitespace-pre-wrap relative border border-white/[0.07] select-text flex flex-row items-end gap-3.5 max-w-[84%]">
        <span className="block w-full text-left break-words [word-break:break-word] [overflow-wrap:anywhere]">{log.text}</span>
        
        {/* CornerDownLeft arrow representing steering entry */}
        <div className="shrink-0 mb-1 select-none text-[#8C8A88]">
          <CornerDownLeft className="w-[18px] h-[18px]" strokeWidth={2.5} />
        </div>
      </div>
    </motion.div>
  );
};


// ═══════════════════════════════════════════════════════════════════
// HtmlPreviewCard — Renders visual UI previews with browser chrome,
// device frames, copy/open buttons, refresh, and inline console logging.
// ═══════════════════════════════════════════════════════════════════
const HtmlPreviewCard = ({ log }: { log: any }) => {
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [consoleLogs, setConsoleLogs] = useState<{ type: 'info' | 'warn' | 'error'; text: string }[]>([]);
  const [showConsole, setShowConsole] = useState(false);
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const title = log.title || 'Live UI Preview';
  const rawHtml = log.content || '';

  // Intercept logs inside the iframe srcdoc
  const wrappedHtml = useMemo(() => {
    let content = rawHtml;

    // Inject tailwind if not present
    if (!content.includes('tailwindcss') && !content.includes('tailwind.css') && content.includes('<head>')) {
      content = content.replace(
        '<head>',
        `<head>\n  <script src="https://cdn.tailwindcss.com"></script>`
      );
    }

    const interceptor = `
<script>
  (function() {
    const _log = console.log;
    const _error = console.error;
    const _warn = console.warn;

    function send(level, args) {
      window.parent.postMessage({
        type: 'iframe-console-log',
        level: level,
        args: Array.from(args).map(x => {
          try {
            return typeof x === 'object' ? JSON.stringify(x) : String(x);
          } catch(e) {
            return String(x);
          }
        })
      }, '*');
    }

    console.log = function() { send('info', arguments); _log.apply(console, arguments); };
    console.error = function() { send('error', arguments); _error.apply(console, arguments); };
    console.warn = function() { send('warn', arguments); _warn.apply(console, arguments); };

    window.onerror = function(message, source, lineno, colno, error) {
      send('error', [message + ' (at ' + lineno + ':' + colno + ')']);
    };
  })();
</script>
`;
    // Inject interceptor at the top of head
    if (content.includes('<head>')) {
      content = content.replace('<head>', `<head>${interceptor}`);
    } else {
      content = interceptor + content;
    }
    return content;
  }, [rawHtml]);

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'iframe-console-log') {
        const level = e.data.level;
        const text = e.data.args.join(' ');
        setConsoleLogs(prev => [...prev.slice(-49), { type: level, text }]);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleRefresh = () => {
    if (iframeRef.current) {
      iframeRef.current.srcdoc = wrappedHtml;
    }
  };

  const handleOpenExternal = () => {
    try {
      const blob = new Blob([rawHtml], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } catch (e) {
      console.error(e);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(rawHtml);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const deviceWidths = {
    desktop: '100%',
    tablet: '768px',
    mobile: '395px'
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full my-2.5 overflow-hidden rounded-[16px] border border-white/[0.08] bg-[#121212]/90 shadow-[0_12px_40px_rgba(0,0,0,0.3)] backdrop-blur-md"
    >
      <div className="flex h-[44px] items-center justify-between px-4 border-b border-white/[0.06] bg-white/[0.02]">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex gap-1.5 shrink-0">
            <div className="w-2.5 h-2.5 rounded-full bg-[#FF5F57] opacity-80" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#FEBC2E] opacity-80" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#28C840] opacity-80" />
          </div>
          <span className="text-[12px] font-semibold text-[#D4D0CB] truncate max-w-[180px] sm:max-w-[280px]">
            {title}
          </span>
        </div>

        <div className="hidden md:flex items-center p-0.5 rounded-lg bg-black/40 border border-white/[0.05]">
          <button
            onClick={() => setDevice('desktop')}
            className={`p-1.5 rounded-md transition-all ${device === 'desktop' ? 'bg-[#F3F0EA] text-[#111]' : 'text-white/40 hover:text-white/80'}`}
            title="Desktop"
          >
            <Monitor className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setDevice('tablet')}
            className={`p-1.5 rounded-md transition-all ${device === 'tablet' ? 'bg-[#F3F0EA] text-[#111]' : 'text-white/40 hover:text-white/80'}`}
            title="Tablet"
          >
            <Tablet className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setDevice('mobile')}
            className={`p-1.5 rounded-md transition-all ${device === 'mobile' ? 'bg-[#F3F0EA] text-[#111]' : 'text-white/40 hover:text-white/80'}`}
            title="Mobile"
          >
            <Smartphone className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={handleCopy}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[10.5px] font-bold transition-all ${copied ? 'text-emerald-400 bg-emerald-500/10' : 'text-[#8E8A84] hover:text-white hover:bg-white/[0.04]'}`}
            title="Copy HTML"
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            <span className="hidden sm:inline">{copied ? 'COPIED' : 'COPY'}</span>
          </button>
          <button
            onClick={handleRefresh}
            className="p-1.5 rounded-md text-[#8E8A84] hover:text-white hover:bg-white/[0.04] transition-all"
            title="Refresh Preview"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleOpenExternal}
            className="p-1.5 rounded-md text-[#8E8A84] hover:text-white hover:bg-white/[0.04] transition-all"
            title="Open in new window"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setShowConsole(!showConsole)}
            className={`p-1.5 rounded-md transition-all relative ${showConsole ? 'text-emerald-400 bg-emerald-500/10' : 'text-[#8E8A84] hover:text-white hover:bg-white/[0.04]'}`}
            title="Toggle Iframe Console"
          >
            <Terminal className="w-3.5 h-3.5" />
            {consoleLogs.length > 0 && !showConsole && (
              <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-rose-500" />
            )}
          </button>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-1.5 rounded-md text-[#8E8A84] hover:text-white hover:bg-white/[0.04] transition-all"
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`} />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className="flex flex-col bg-[#161616]"
          >
            <div className="flex h-[32px] items-center px-4 bg-black/20 border-b border-white/[0.04]">
              <div className="flex items-center gap-2 px-3 py-1 rounded-md bg-black/30 border border-white/[0.04] w-full max-w-[320px] mx-auto text-[11px] font-mono text-white/40">
                <Globe className="w-3 h-3 shrink-0" />
                <span className="truncate">eterx://live-preview</span>
              </div>
            </div>

            <div className="p-4 flex justify-center bg-zinc-950 overflow-hidden">
              <motion.div
                animate={{ width: deviceWidths[device] }}
                transition={{ type: 'spring', damping: 28, stiffness: 220 }}
                className="overflow-hidden rounded-lg bg-white shadow-2xl border border-white/5 relative"
                style={{
                  height: device === 'mobile' ? '640px' : device === 'tablet' ? '540px' : '480px',
                  maxHeight: '70vh'
                }}
              >
                <iframe
                  ref={iframeRef}
                  srcDoc={wrappedHtml}
                  className="w-full h-full border-0 bg-white"
                  sandbox="allow-scripts allow-same-origin allow-modals allow-forms"
                  title={title}
                />
              </motion.div>
            </div>

            <AnimatePresence>
              {showConsole && (
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: 160 }}
                  exit={{ height: 0 }}
                  className="flex flex-col border-t border-white/[0.08] bg-[#0c0c0d] font-mono text-[11.5px] overflow-hidden"
                >
                  <div className="flex h-8 shrink-0 items-center justify-between px-4 bg-white/[0.02] border-b border-white/[0.04]">
                    <div className="flex items-center gap-1.5 font-bold text-white/50">
                      <Terminal className="w-3.5 h-3.5 text-white/40" />
                      Console Output ({consoleLogs.length})
                    </div>
                    <button
                      onClick={() => setConsoleLogs([])}
                      className="text-[10px] text-white/40 hover:text-white transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-3 space-y-1 eterx-scrollbar">
                    {consoleLogs.map((log, index) => (
                      <div
                        key={index}
                        className={`flex gap-2 px-2 py-0.5 rounded ${log.type === 'error' ? 'bg-red-500/5 text-red-400' : log.type === 'warn' ? 'bg-amber-500/5 text-amber-400' : 'text-zinc-300'}`}
                      >
                        <span className="text-white/20">[{log.type.toUpperCase()}]</span>
                        <span className="whitespace-pre-wrap break-all">{log.text}</span>
                      </div>
                    ))}
                    {consoleLogs.length === 0 && (
                      <div className="text-white/20 italic text-center py-8">
                        No console logs captured
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};


export const ThinkingProcess = ({ logs, liveLogs = [], isThinking, isLast, showLiveIndicator = false, onOpenAgentTeam }: { logs: any[], liveLogs?: any[], isThinking: boolean, isLast: boolean, showLiveIndicator?: boolean, onOpenAgentTeam?: (agentName?: string) => void }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const NOISE_PATTERN = /reconnect|retrying|stalled|stream interrupted|model error|fallback|cancelled/i;
  const isFlowLog = (l: any) =>
    ['thought_stream', 'work_note', 'command', 'exploration', 'file_edit', 'progress', 'browser', 'safety_warning', 'communication', 'sub_agent_answer', 'sub_agent_result', 'sub_agent_spawn', 'sub_agent_action', 'sub_agent_complete', 'sub_agent_error', 'inter_agent_comm', 'file_preview', 'console_output', 'html_preview', 'ask_user'].includes(l.type) &&
    !(['progress', 'command', 'exploration'].includes(l.type) && /analyz(?:e|ing) task complexity/i.test(String(l.text || ''))) &&
    !(l.type === 'progress' && NOISE_PATTERN.test(String(l.text || '')));
  const flowLogs = logs.filter(isFlowLog);
  const liveFlowLogs = liveLogs.filter(isFlowLog);
  const statusLogs = [...flowLogs, ...liveFlowLogs];
  const hasExternalLiveWork = liveFlowLogs.length > 0;
  const segs: any[] = []; let aBuf: any[] = [];
  const SPEC = new Set(['file_preview', 'console_output', 'sub_agent_answer', 'sub_agent_result', 'sub_agent_spawn', 'sub_agent_action', 'sub_agent_complete', 'sub_agent_error', 'inter_agent_comm', 'safety_warning']);
  const flush = (idx: number) => {
    if (aBuf.length > 0) {
      const unique: any[] = [];
      aBuf.forEach((log, i) => {
        if (i > 0) {
          const prev = unique[unique.length - 1];
          if (log.type === prev.type && log.text === prev.text && log.secondary === prev.secondary) {
            unique[unique.length - 1] = { ...prev, ...log }; return;
          }
        }
        unique.push(log);
      });
      segs.push({ kind: 'action_group', logs: unique, lastIdx: idx });
      aBuf = [];
    }
  };
  flowLogs.forEach((log, idx) => {
    if (log.type === 'thought_stream') { flush(idx - 1); segs.push({ kind: 'thought', log, idx }); }
    else if (log.type === 'work_note') { flush(idx - 1); segs.push({ kind: 'note', log, idx }); }
    else if (log.type === 'safety_warning') { flush(idx - 1); segs.push({ kind: 'safety', log, idx }); }
    else if (log.type === 'steering_received') { flush(idx - 1); segs.push({ kind: 'steering', log, idx }); }
    else if (log.type === 'sub_agent_answer' || log.type === 'sub_agent_result' || log.type === 'sub_agent_complete') { flush(idx - 1); segs.push({ kind: 'subagent', log, idx }); }
    else if (log.type === 'sub_agent_spawn') { flush(idx - 1); segs.push({ kind: 'subagent_spawn', log, idx }); }
    else if (log.type === 'sub_agent_error') { flush(idx - 1); segs.push({ kind: 'subagent_error', log, idx }); }
    else if (log.type === 'sub_agent_action') { aBuf.push({ ...log, type: 'command' }); }
    else if (log.type === 'html_preview') { flush(idx - 1); segs.push({ kind: 'html_preview', log, idx }); }
    else if (log.type === 'ask_user') { flush(idx - 1); segs.push({ kind: 'ask_user', log, idx }); }
    else if (SPEC.has(log.type)) { flush(idx - 1); }
    else { aBuf.push(log); }
  });
  flush(flowLogs.length - 1);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current && isThinking) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [segs.length, isThinking]);
  return (
    <div ref={containerRef} className="eterx-thinking-process-stack w-full flex flex-col gap-1 py-0">
      {segs.map((seg, i) => {
        if (seg.kind === 'thought') return <ProfessionalThought key={`t-${ seg.idx }`} text={seg.log.text} isLatest={isLast && i === segs.length - 1 && !hasExternalLiveWork} isThinking={isThinking} startedAt={seg.log.startTime} updatedAt={seg.log.endTime} />;
        if (seg.kind === 'note') return <ProfessionalThought key={`n-${ seg.idx }`} text={seg.log.text} isLatest={isLast && i === segs.length - 1 && !hasExternalLiveWork} isThinking={isThinking} variant="note" />;
        if (seg.kind === 'safety') return <SafetyBanner key={`sf-${ seg.idx }`} log={seg.log} />;
        if (seg.kind === 'steering') return <SteeringCard key={`steer-${ seg.idx }`} log={seg.log} />;
        if (seg.kind === 'subagent') return <SubAgentCard key={`sa-${ seg.idx }`} log={seg.log} onOpenAgentTeam={onOpenAgentTeam} />;
        if (seg.kind === 'comm') return <InterAgentCommCard key={`comm-${ seg.idx }`} log={seg.log} onOpenAgentTeam={onOpenAgentTeam} />;
        if (seg.kind === 'subagent_spawn') return <SubAgentSpawnCard key={`ss-${ seg.idx }`} log={seg.log} />;
        if (seg.kind === 'subagent_error') return <SubAgentErrorCard key={`se-${ seg.idx }`} log={seg.log} />;
        if (seg.kind === 'html_preview') return <HtmlPreviewCard key={`hp-${ seg.idx }`} log={seg.log} />;
        if (seg.kind === 'ask_user') return <AskUserTimelineCard key={`ask-tl-${ seg.idx }`} log={seg.log} isLive={isThinking && isLast && i === segs.length - 1 && !seg.log.answeredWith} />;
        
        // Unpack single action chip — wrap in card so it sits inside the container
        if (seg.logs.length === 1) {
          return (
            <div key={`g-${ seg.lastIdx }`} className={ACTION_CARD_CLASS}>
              <ActionChip
                log={seg.logs[0]}
                isLastChip={isLast && i === segs.length - 1}
                isActiveGroup={isThinking && isLast && i === segs.length - 1 && !hasExternalLiveWork}
                allLogs={flowLogs}
                isNested={false}
                inCard={true}
              />
            </div>
          );
        }
        return <CollapsibleActionGroup key={`g-${ seg.lastIdx }`} logs={seg.logs} isActiveGroup={isThinking && isLast && i === segs.length - 1 && !hasExternalLiveWork} isLast={isLast} allLogs={flowLogs} />;
      })}
      <AnimatePresence>
        {showLiveIndicator && isThinking && isLast && <LiveWorkingIndicator key="live-working" logs={statusLogs} />}
      </AnimatePresence>
    </div>
  );
};
