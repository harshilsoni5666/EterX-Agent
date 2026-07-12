import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import { useFilePanelActions } from '../../contexts/FilePanelContext';
// Only the Lucide icons actually rendered in JSX (not icon-map/TOOL_META)
import {
  ChevronRight, ChevronDown, Monitor, ShieldHalf, Copy, CheckCircle, Maximize2, CornerDownLeft,
  RefreshCw, ExternalLink, Check, Globe, Smartphone, Tablet, Terminal, ArrowRight,
  Search, FileText, Calculator, Database, Hash, Cpu, FolderOpen, AlertTriangle, MessageSquare
} from 'lucide-react';
// @ts-ignore
import ReactMarkdown from 'react-markdown';
import { markdownComponents, normalizeMarkdownForRendering, remarkPlugins, rehypePlugins } from './markdown-renderer';
import { LocalFileIcon, LocalFileLinkChip, decodeLocalFileHref, isLocalFilePath } from './local-file-link';
import { AGENT_ICONS, resolveAgentIcon, AgentAssetIcon, SubAgentIdentityIcon } from './agent-icons';
import { AgentFace } from './agent-face';


type RevealSpeed = {
  baseDelayMs: number;
  lineDelayMs: number;
  tableDelayMs: number;
  punctuationDelayMs: number;
  burst: number;
  maxDurationMs: number;
  adaptive?: boolean;
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
    baseDelayMs: 10,
    lineDelayMs: 15,
    tableDelayMs: 18,
    punctuationDelayMs: 18,
    burst: 3,
    maxDurationMs: 1800,
    adaptive: true,
  },
} satisfies Record<'workNote' | 'answer', RevealSpeed>;

const markdownRevealChunkPattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
const fenceStartPattern = /^ {0,3}(`{3,}|~{3,})/;

const splitWordsWithSpacing = (value: string) => {
  const matches = value.match(/\S+\s*/g);
  return matches && matches.length > 0 ? matches : value ? [value] : [];
};

const getReactNodeText = (value: React.ReactNode): string => {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(getReactNodeText).join('');
  if (React.isValidElement(value)) return getReactNodeText((value.props as any)?.children);
  return '';
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
  const pattern = new RegExp(`^ {0,3}${ escaped }{${ openingFence.length },}\\s*$`);
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
        chunks.push(block);
        if (!closed) break;
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
        chunks.push(block);
        if (!closed) break;
        continue;
      }

      if (isTableLine(line) && isTableSeparatorLine(nextLine)) {
        chunks.push(line + nextLine);
        i += 1;
        continue;
      }

      if (isTableLine(line) && (isTableSeparatorLine(line) || isTableLine(lines[i - 1] || '') || isTableSeparatorLine(lines[i - 1] || ''))) {
        chunks.push(line);
        continue;
      }

      if (isTableLine(line)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('|') || trimmed.endsWith('|')) {
          if (!isCompleteLine && i === lines.length - 1) break;
          pushProseRevealChunks(line, chunks, isCompleteLine);
          continue;
        }
      }

      if (isHeadingLine(line) || isListLine(line) || isBlockquoteLine(line) || isRuleLine(line)) {
        if (!isCompleteLine && i !== lines.length - 1) break;
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
  const effectiveSpeed = useMemo(() => {
    if (!speed.adaptive) return speed;
    const charCount = value.length;
    const chunkCount = chunks.length;
    const scale = Math.min(4.5, Math.max(1, Math.max(charCount / 1600, chunkCount / 90)));
    return {
      ...speed,
      baseDelayMs: Math.max(3, Math.round(speed.baseDelayMs / scale)),
      lineDelayMs: Math.max(5, Math.round(speed.lineDelayMs / scale)),
      tableDelayMs: Math.max(7, Math.round(speed.tableDelayMs / scale)),
      punctuationDelayMs: Math.max(6, Math.round(speed.punctuationDelayMs / scale)),
      burst: Math.max(speed.burst, Math.ceil(scale * speed.burst)),
      maxDurationMs: Math.max(650, Math.round(speed.maxDurationMs / Math.min(scale, 2.8))),
    };
  }, [chunks.length, speed, value.length]);
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
    const durationBurst = Math.ceil((chunks.length * effectiveSpeed.baseDelayMs) / Math.max(effectiveSpeed.maxDurationMs, 1));
    const isStructuralChunk = isTableLine(chunk) || chunk.includes('\n');
    const burst = isStructuralChunk ? 1 : Math.max(effectiveSpeed.burst, durationBurst);
    const timeout = window.setTimeout(() => {
      setVisibleCount(current => Math.min(chunks.length, current + burst));
    }, getRevealDelay(chunk, effectiveSpeed));

    return () => window.clearTimeout(timeout);
  }, [chunks, effectiveSpeed, enabled, reducedMotion, visibleCount]);

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
  const content = String(children).replace(/\n$/, '');

  if (inline) {
    if (isLocalFilePath(content)) return <LocalFileLinkChip filePath={content.trim()} compact />;
    return <code className="eterx-progressive-ghost-inline-code" {...props}>{children}</code>;
  }

  const lineCount = Math.max(1, content.split(/\r?\n/).length);
  const language = /language-([^\s]+)/.exec(className || '')?.[1]?.toLowerCase() || '';
  const diagramLike = language === 'mermaid' || language === 'mmd' || /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|timeline|mindmap)\b/i.test(content.trim());
  const minHeight = diagramLike
    ? Math.max(20, lineCount * 1.45 + 6)
    : lineCount * 1.7 + 2.6;
  return (
    <pre
      className="eterx-progressive-ghost-code"
      style={{ minHeight: `${ minHeight }em` }}
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
  'Running command': 'Ran',
  'Running project command': 'Ran',
  'Reading file': 'Read',
  'Scanning directory': 'Listed',
  'Editing file': 'Edited',
  'Writing artifact': 'Created',
  'Searching codebase': 'Searched',
  'Researching': 'Web searched',
  'Reading source': 'Scraped',
  'Deep researching': 'Researched',
  'Analyzing code': 'Analyzed',
  'Refactoring code': 'Refactored',
  'Analyzing workspace': 'Analyzed',
  'Analyzing files': 'Analyzed',
  'Verifying code': 'Verified',
  'Verifying output': 'Verified',
  'Scaffolding project': 'Scaffolded',
  'Git operation': 'Git',
  'Spawning sub-agents': 'Spawned',
  'Decomposing task': 'Decomposed',
  'Loading skill': 'Loaded',
  'API request': 'Called API',
  'API call': 'Called API',
  'Network operation': 'Network',
  'Reading PDF': 'Read PDF',
  'Generating document': 'Generated',
  'Generating image': 'Generated',
  'Generating docs': 'Generated docs',
  'Generating chart': 'Generated',
  'Generating speech': 'Generated',
  'Capturing screen': 'Captured',
  'Evaluating logic': 'Evaluated',
  'Monitoring system': 'Monitored',
  'Managing email': 'Email',
  'Comparing files': 'Compared',
  'Patching files': 'Patched',
  'Transforming data': 'Transformed',
  'Compressing files': 'Compressed',
  'Database query': 'Queried',
  'Calculating': 'Calculated',
  'Analyzing data': 'Analyzed',
  'Clipboard': 'Clipboard',
  'Extracting transcript': 'Extracted',
  'Reading RSS feed': 'Read feed',
  'WhatsApp': 'WhatsApp',
  'Telegram': 'Telegram',
  'Slack': 'Slack',
  'Sending Slack': 'Slack',
  'Slack message': 'Slack',
  'GitHub': 'GitHub',
  'GitHub push': 'Pushed',
  'GitHub PR': 'Pull Request',
  'GitHub issue': 'Issue',
  'Notion': 'Notion',
  'Notion page': 'Notion',
  'Linear': 'Linear',
  'Linear issue': 'Linear',
  'Jira': 'Jira',
  'Jira issue': 'Jira',
  'Figma': 'Figma',
  'Discord': 'Discord',
  'Discord message': 'Discord',
  'Stripe': 'Stripe',
  'Vercel': 'Vercel',
  'Airtable': 'Airtable',
  'Postman': 'Postman',
  'Trello': 'Trello',
  'HubSpot': 'HubSpot',
  'Safety check': 'Checked',
  'Context operation': 'Context',
  'Saving progress': 'Saved',
  'Background task': 'Background',
  'Creating tool': 'Created tool',
  'Converting markdown': 'Converted',
  'System automation': 'Automated',
  'Managing process': 'Process',
  'HTTP server': 'Server',
  'Processing text': 'Processed',
  'Notifying': 'Notified',
  'Running macro': 'Ran macro',
  'Executing chain': 'Executed',
  'Self-improving': 'Improved',
  'Watching files': 'Watching',
  'Vault operation': 'Vault',
  'Managing environment': 'Env',
  'Scheduled task': 'Scheduled',
};

// getToolMeta — verb extraction only; icon is always resolved by resolveAgentIcon
const getToolMeta = (text: string, type: string, _iconName?: string) => {
  const normalizedText = /\bsync/i.test(text || '') && /\bnetwork\b/i.test(text || '')
    ? 'Network operation'
    : text;
  const verb = VERB_MAP[normalizedText] || normalizedText || 'Action';
  return { icon: null, verb, color: '#E8E6E3' };
};

const stripTrailingFileName = (value: string, fileName: string) => {
  if (!value || !fileName) return value;
  const escapedFileName = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = value.replace(new RegExp(`\\s+(?:file\\s+)?${ escapedFileName }$`, 'i'), '').trim();
  return stripped || value;
};

const TERMINAL_ACTION_PATTERN = /\b(?:shell|terminal|command|exec|run|process|server|watch|powershell|pwsh|cmd(?:\.exe)?|bash|zsh|sh|git|npm|npx|pnpm|yarn|bun|node|python|py|pip|pytest|tsx|tsc|eslint|prettier|docker|cargo|go\s+(?:test|build|run|vet)|mvn|gradle|java|dotnet|php|ruby|rails|uv|poetry|rg|grep|curl|wget)\b/i;

const shouldUseTerminalIcon = (log: any, subtitle = '', preview?: any) => {
  const text = String(log?.text || '');
  const secondary = String(log?.secondary || subtitle || '');
  const command = String(log?.command || preview?.command || '');
  const iconCategory = String(log?.iconCategory || '').toLowerCase();
  const combined = `${ text } ${ secondary } ${ command }`;

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
const LIVE_FACE_REGULAR_DELAY_MS = 8500;
const LIVE_FACE_DEEP_WORK_DELAY_MS = 2400;
const THOUGHT_ELAPSED_TICK_MS = 1000;

const getLogUpdatedAt = (log: any) =>
  asTimestamp(log?.endTime) ?? asTimestamp(log?.updatedAt) ?? asTimestamp(log?.timestamp) ?? asTimestamp(log?.startTime);

const isLiveThoughtFresh = (log: any, now = Date.now()) => {
  if (!log || (log.type !== 'thought_stream' && log.type !== 'work_note')) return false;
  const updatedAt = getLogUpdatedAt(log);
  return updatedAt === null || now - updatedAt <= LIVE_THOUGHT_FRESH_MS;
};

const isDeepWorkLog = (log: any) => {
  if (!log) return false;
  if (['command', 'file_edit', 'file_preview', 'console_output', 'browser'].includes(log.type)) return true;
  const raw = [
    log.type,
    log.text,
    log.secondary,
    log.filename,
    log.command,
    log.cmd,
    log.tool,
    log.name,
  ].filter(Boolean).join(' ').toLowerCase();

  return /\b(code|coding|write|writing|file|edit|patch|apply|create|generat|render|build|compile|lint|test|terminal|command|execute|run|npm|npx|tsx|tsc|python|powershell|analyz|inspect|read|understand|refactor)\b/.test(raw);
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
      }, THOUGHT_ELAPSED_TICK_MS);
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

const formatThoughtElapsed = (seconds: number) => {
  if (seconds <= 0) return '';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${ minutes }m ${ rest }s` : `${ rest }s`;
};

export const ProfessionalThought = ({ text, isLatest, isThinking, variant = 'thought', suffix, startedAt, updatedAt, reveal = false }: { text: string, isLatest: boolean, isThinking: boolean, variant?: 'thought' | 'answer' | 'note', suffix?: React.ReactNode, startedAt?: number, updatedAt?: number, reveal?: boolean }) => {
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

  useEffect(() => {
    if (variant !== 'thought') return;
    if (isLatest && isThinking) return;
    setOpen(false);
  }, [variant, isLatest, isThinking, text]);

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
  const elapsedLabel = formatThoughtElapsed(secs);
  const thinkLabel = isLive
    ? `Thinking${ elapsedLabel ? `... ${ elapsedLabel }` : '' }`
    : elapsedLabel
      ? `Thought for ${ elapsedLabel }`
      : 'Thought';
  const isNote = variant === 'note';
  const revealEnabled = variant === 'answer'
    ? isLatest && (isThinking || reveal)
    : false; // notes use worknote merge — no progressive reveal to avoid double-animation
  const revealSpeed = isNote ? TEXT_REVEAL_SPEEDS.workNote : TEXT_REVEAL_SPEEDS.answer;
  const progressive = useProgressiveMarkdown(renderText, revealEnabled, revealSpeed);
  const markdownText = revealEnabled ? progressive.text : renderText;
  const showAnswerWriter = variant === 'answer' && (progressive.isRevealing || (isLatest && isThinking));
  const professionalMarkdownComponents = useMemo(() => ({
    ...markdownComponents,
    p: ({ node, ...props }: any) => <p className={`eterx-answer-paragraph mb-2.5 last:mb-0 break-words tracking-normal ${ isNote ? 'leading-[1.58]' : 'leading-[1.72]' }`} {...props} />,
    h1: ({ node, ...props }: any) => <h1 className="eterx-answer-heading mt-6 first:mt-0 mb-3.5 text-[22px] font-semibold leading-tight" {...props} />,
    h2: ({ node, ...props }: any) => <h2 className="eterx-answer-heading mt-5 first:mt-0 mb-3 text-[18.5px] font-semibold leading-tight" {...props} />,
    h3: ({ node, ...props }: any) => <h3 className="eterx-answer-heading mt-[18px] first:mt-0 mb-2.5 text-[16.5px] font-semibold leading-tight" {...props} />,
    h4: ({ node, ...props }: any) => <h4 className="eterx-answer-heading mt-4 first:mt-0 mb-2 text-[15px] font-semibold leading-tight" {...props} />,
    h5: ({ node, ...props }: any) => <h5 className="eterx-answer-heading eterx-answer-heading-muted mt-4 first:mt-0 mb-2 text-[14px] font-semibold leading-tight" {...props} />,
    h6: ({ node, ...props }: any) => <h6 className="eterx-answer-heading eterx-answer-heading-muted mt-3 first:mt-0 mb-2 text-[13px] font-semibold leading-tight" {...props} />,
    ul: ({ node, ...props }: any) => <ul className="eterx-answer-list my-3 list-disc space-y-1.5 pl-6" {...props} />,
    ol: ({ node, ...props }: any) => <ol className="eterx-answer-list my-3 list-decimal space-y-1.5 pl-6" {...props} />,
    li: ({ node, ...props }: any) => <li className="eterx-answer-list-item pl-1.5 leading-[1.68]" {...props} />,
    strong: ({ node, ...props }: any) => <strong className="eterx-answer-strong font-bold" {...props} />,
    em: ({ node, ...props }: any) => <em className="eterx-answer-em italic" {...props} />,
    a: ({ node, href, children, ...props }: any) => {
      const localPath = decodeLocalFileHref(href);
      if (localPath) return <LocalFileLinkChip filePath={localPath} label={getReactNodeText(children)} compact={isNote} />;
      return <a className="eterx-answer-link hover:underline" target="_blank" rel="noopener" href={href} {...props}>{children}</a>;
    },
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
        <div className={`eterx-thought-card overflow-hidden rounded-[12px] border bg-[#151514]/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.028),0_2px_10px_rgba(0,0,0,0.14)] transition-colors ${ open ? 'border-white/[0.12]' : 'border-white/[0.065] hover:border-white/[0.11]' }`}>
          <button
            type="button"
            onClick={() => setOpen(value => !value)}
            aria-expanded={open}
            className="eterx-thought-toggle flex min-h-[33px] w-full items-center gap-2.5 px-3 py-1 text-left transition-colors hover:bg-white/[0.026] group"
          >
            <span className={`flex-1 text-[13.5px] font-medium ${ isLive ? 'eterx-text-shimmer eterx-text-shimmer-working' : 'text-[#7C776F]' }`}>
              {thinkLabel}
            </span>
            <ChevronRight className={`h-4 w-4 text-[#625C54] group-hover:text-[#A8A198] transition-all ${ open ? 'rotate-90' : '' }`} />
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
                <div ref={thoughtScrollRef} onScroll={handleThoughtScroll} className={`eterx-thought-expanded ${ thoughtCanScroll ? 'eterx-scrollbar overflow-y-auto' : 'overflow-y-hidden' } pl-[54px] pr-[18px] pb-4 pt-0.5 text-[13.5px] leading-[1.56] text-[#D5D3CE]`} style={{ maxHeight: 'min(52vh, 520px)' }}>
                  <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={{
                    ...markdownComponents,
                    p: ({ node, ...props }: any) => <p className="mb-3 last:mb-0 break-words leading-[1.68] text-[#D5D3CE]" {...props} />,
                    ol: ({ node, ...props }: any) => <ol className="my-3 list-decimal space-y-2 pl-6 text-[#D5D3CE]" {...props} />,
                    ul: ({ node, ...props }: any) => <ul className="my-3 list-disc space-y-2 pl-6 text-[#D5D3CE]" {...props} />,
                    li: ({ node, ...props }: any) => <li className="pl-1.5 leading-[1.66] marker:text-[#827C73]" {...props} />,
                    strong: ({ node, ...props }: any) => <strong className="font-bold text-[#F3F2EF]" {...props} />,
                    a: ({ node, href, children, ...props }: any) => {
                      const localPath = decodeLocalFileHref(href);
                      if (localPath) return <LocalFileLinkChip filePath={localPath} label={getReactNodeText(children)} compact />;
                      return <a className="text-[#E2765A] hover:underline" target="_blank" rel="noopener" href={href} {...props}>{children}</a>;
                    },
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
      layout={false}
      initial={isNote ? { opacity: 0, y: 3 } : false}
      animate={isNote ? { opacity: 1, y: 0 } : undefined}
      transition={isNote ? { duration: 0.18, ease: [0.22, 1, 0.36, 1] } : undefined}
      className={`professional-thought eterx-professional-thought relative w-full max-w-full font-sans font-normal selection:bg-[#D98B6A]/20 select-text tracking-normal ${ progressive.isRevealing ? 'eterx-reveal-active' : '' } ${ isNote ? 'eterx-professional-note py-0.5 text-[13.5px] leading-[1.5] text-[#D2CECA]' : 'eterx-professional-answer text-[13.5px] leading-[1.56] text-[#F2F0EC]' }`}
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
const WorkNoteBlock = ({ text, isActive = false }: { text: string; isActive?: boolean }) => {
  const note = useMemo(() => String(text || '').trim(), [text]);
  if (!note) return null;

  return (
    <div className="eterx-work-note-block w-full px-1 py-0">
      <ProfessionalThought
        text={note}
        isLatest={isActive}
        isThinking={isActive}
        variant="note"
        reveal={isActive}
      />
    </div>
  );
};

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
    const previousOverflow = document.body.style.overflow;
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', h, true);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', h, true);
      document.body.style.overflow = previousOverflow;
    };
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
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5"><span className="text-[13px] font-mono text-[#8C8A88] font-bold uppercase tracking-widest">{title || 'Preview'}</span><button type="button" onClick={onClose} aria-label="Close preview" className="w-8 h-8 rounded-lg hover:bg-white/5 text-[#8C8A88] hover:text-white transition-all text-xl">X</button></div>
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
      className="eterx-action-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-white/[0.06] bg-white/[0.028] text-[#9A9389] transition-colors hover:border-white/[0.10] hover:bg-white/[0.05] hover:text-[#DAD4CA]"
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
    '0': '', '1': 'font-weight:700',
    '31': 'color:var(--terminal-red, #f85149)',
    '32': 'color:var(--terminal-green, #3fb950)',
    '33': 'color:var(--terminal-yellow, #d29922)',
    '34': 'color:var(--terminal-blue, #58a6ff)',
    '35': 'color:var(--terminal-magenta, #bc8cff)',
    '36': 'color:var(--terminal-cyan, #56d364)',
    '37': 'color:var(--terminal-white, #e6edf3)',
    '90': 'color:var(--terminal-gray, #8b949e)',
    '91': 'color:var(--terminal-light-red, #ffa198)',
    '92': 'color:var(--terminal-light-green, #56d364)',
    '93': 'color:var(--terminal-light-yellow, #e3b341)',
    '94': 'color:var(--terminal-light-blue, #79c0ff)',
    '95': 'color:var(--terminal-light-magenta, #d2a8ff)',
    '96': 'color:var(--terminal-light-cyan, #76e3ea)',
  };
  return esc.replace(/\x1B\[([0-9;]*)m/g, (_, p) => {
    const style = p.split(';').map((c: string) => ANSI[c] || '').filter(Boolean).join(';');
    return style ? `<span style="${ style }">` : '</span>';
  });
};

const InlineConsole = ({ command, content, exitCode, durationMs }: { command: string, content: string, exitCode?: number, durationMs?: number }) => {
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
    let frameId: number;
    frameId = window.requestAnimationFrame(() => {
      if (shouldFollowOutputRef.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
      }
    });
    return () => window.cancelAnimationFrame(frameId);
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
  const lines = content ? content.split(/\r?\n/) : [];
  const lineCount = lines.length;
  const isRunning = exitCode === undefined;
  const success = exitCode === 0 || isRunning;
  const consolePanel = (
    <div className="eterx-terminal-console mx-3 mt-1.5 mb-2 flex flex-col overflow-hidden rounded-[12px] border border-white/[0.07] bg-[#1B1B1A] font-mono text-[#D8D1C8] shadow-[0_6px_18px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.026)]">
      <div className="relative min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="eterx-terminal-console-output eterx-scrollbar max-h-[292px] min-h-[104px] overflow-auto px-3 py-2.5 text-[12.25px] leading-[1.58] text-[#CDC5BB]"
        >
          <div className="min-w-max pr-4">
            <div className="eterx-terminal-console-header mb-4 text-[11.5px] font-medium leading-none text-[#A9A196]">Shell</div>
            <div className="eterx-terminal-console-command flex items-start gap-2.5 whitespace-pre-wrap text-[#E4DDD3]">
              <span className="select-none text-[15px] leading-5 font-medium text-[#CFC8BD]">$</span>
              <span className="min-w-0 flex-1 text-[12.75px] font-medium leading-5">{command}</span>
            </div>
            <div className="eterx-terminal-console-body mt-4 whitespace-pre text-[#CDC5BB]">
              {content
                ? <span dangerouslySetInnerHTML={{ __html: ansiToHtml(content) }} />
                : <span className="text-[#8D867C] italic">{isRunning ? 'Waiting for output...' : '(no output)'}</span>
              }
            </div>
          </div>
        </div>
        {!atBottom && lineCount > 8 && (
          <button onClick={(e) => { e.stopPropagation(); const el = scrollRef.current; if (!el) return; shouldFollowOutputRef.current = true; el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }} className="absolute bottom-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.08] bg-[#2A2A29]/95 text-[#BDB5AA] shadow-[0_6px_18px_rgba(0,0,0,0.26)] transition-colors hover:bg-[#333331] hover:text-[#F0EAE0]">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="eterx-terminal-console-footer flex items-center justify-end gap-2 bg-[#1D1D1C] px-3 pb-2 pt-1 text-[11.5px] font-medium text-[#A9A196]">
        <span className={`inline-flex items-center gap-1.5 ${ success ? 'text-[#BDB8AF]' : 'text-red-300' }`}>
          {isRunning ? (
            <span className="h-2 w-2 rounded-full bg-[#BDB8AF]/85 shadow-[0_0_10px_rgba(189,184,175,0.28)]" />
          ) : success ? (
            <CheckCircle className="h-3.5 w-3.5 text-[#BDB8AF]" />
          ) : (
            <CornerDownLeft className="h-3.5 w-3.5 text-red-300" />
          )}
          {isRunning ? 'Running' : success ? 'Success' : `Exit ${ exitCode }`}
        </span>
      </div>
    </div>
  );
  return <motion.div layout initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}>{consolePanel}</motion.div>;
};

// ─── Patch Summary Panel — shown for workspace_apply_patch results ────────────
const PatchSummaryPanel = ({
  filesModified = [],
  filesCreated = [],
  filesDeleted = [],
  errors = [],
  flush = false,
}: {
  filesModified?: string[];
  filesCreated?: string[];
  filesDeleted?: string[];
  errors?: string[];
  flush?: boolean;
}) => {
  const [expanded, setExpanded] = useState(false);
  const totalFiles = filesModified.length + filesCreated.length + filesDeleted.length;
  const hasErrors = errors.length > 0;
  const success = totalFiles > 0 && !hasErrors;

  type FileEntry = { path: string; kind: 'modified' | 'created' | 'deleted' };
  const allFiles: FileEntry[] = [
    ...filesCreated.map(p => ({ path: p, kind: 'created' as const })),
    ...filesModified.map(p => ({ path: p, kind: 'modified' as const })),
    ...filesDeleted.map(p => ({ path: p, kind: 'deleted' as const })),
  ];

  const kindStyle = {
    created: { pill: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25', bar: 'bg-emerald-500', label: '+new' },
    modified: { pill: 'bg-sky-500/15 text-sky-300 border-sky-500/25', bar: 'bg-sky-400', label: 'edited' },
    deleted: { pill: 'bg-red-500/15 text-red-300 border-red-500/25', bar: 'bg-red-500', label: 'deleted' },
  };

  return (
    <motion.div layout initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}>
      <div className={`eterx-patch-summary-panel flex flex-col bg-[#1B1B1A] font-mono shadow-[0_6px_18px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.026)] ${ flush ? 'mt-1 mb-2' : 'mx-3 mt-1.5 mb-2' } overflow-hidden rounded-[12px] border border-white/[0.07]`}>
        {/* Header */}
        <div className="flex items-center justify-between gap-3 bg-[#20201F] px-3 py-1.5">
          <div className="flex items-center gap-2.5">
            <span className={`h-2 w-2 rounded-full flex-shrink-0 ${ success ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]' : hasErrors ? 'bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.5)]' : 'bg-amber-400' }`} />
            <span className="text-[12px] font-semibold text-[#C8C2BB]">
              {success ? `Patch applied · ${ totalFiles } file${ totalFiles !== 1 ? 's' : '' }` : hasErrors ? `Patch errors · ${ errors.length }` : 'No changes'}
            </span>
            {/* Stat pills */}
            <div className="flex items-center gap-1.5">
              {filesCreated.length > 0 && (
                <span className="rounded-[5px] border px-1.5 py-[1px] text-[10.5px] font-semibold bg-emerald-500/15 text-emerald-300 border-emerald-500/25">+{filesCreated.length} new</span>
              )}
              {filesModified.length > 0 && (
                <span className="rounded-[5px] border px-1.5 py-[1px] text-[10.5px] font-semibold bg-sky-500/15 text-sky-300 border-sky-500/25">~{filesModified.length} edited</span>
              )}
              {filesDeleted.length > 0 && (
                <span className="rounded-[5px] border px-1.5 py-[1px] text-[10.5px] font-semibold bg-red-500/15 text-red-300 border-red-500/25">−{filesDeleted.length} deleted</span>
              )}
            </div>
          </div>
          {(allFiles.length > 0 || hasErrors) && (
            <button
              type="button"
              onClick={() => setExpanded(v => !v)}
              className="eterx-action-icon-button flex h-6 w-6 items-center justify-center rounded-[6px] border border-white/[0.06] bg-white/[0.028] text-[#9A9389] transition-colors hover:border-white/[0.10] hover:bg-white/[0.05] hover:text-[#DAD4CA]"
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${ expanded ? 'rotate-90' : '' }`} />
            </button>
          )}
        </div>

        {/* Expandable file list */}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="patch-files"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              {allFiles.map((f, i) => {
                const style = kindStyle[f.kind];
                const name = f.path.replace(/\\/g, '/').split('/').pop() || f.path;
                return (
                  <div key={i} className="flex items-center gap-0 border-t border-white/[0.045] first:border-t-0">
                    <div className={`w-[3px] self-stretch shrink-0 ${ style.bar }`} />
                    <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-[5px]">
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[#94C7E0]" title={f.path}>{name}</span>
                      <span className={`shrink-0 rounded-[4px] border px-1.5 py-[1px] text-[10px] font-semibold ${ style.pill }`}>{style.label}</span>
                    </div>
                  </div>
                );
              })}
              {hasErrors && errors.map((err, i) => (
                <div key={`err-${ i }`} className="flex items-start gap-0 border-t border-white/[0.045]">
                  <div className="w-[3px] self-stretch shrink-0 bg-red-500" />
                  <div className="flex min-w-0 flex-1 items-start gap-2 px-3 py-[5px]">
                    <span className="shrink-0 rounded-[4px] border border-red-500/25 bg-red-500/15 px-1.5 py-[1px] text-[10px] font-semibold text-red-300">error</span>
                    <span className="min-w-0 flex-1 break-words text-[11.5px] leading-[1.45] text-[#E6AAA4]">{err}</span>
                  </div>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
};


// ─── Shared card shell — defined OUTSIDE ToolResultPreview so React never remounts ───
const TrpCard = React.memo(({ icon, title, badge, children }: {
  icon?: React.ReactNode;
  title?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <div className="eterx-trp-card mx-3 mt-1.5 mb-2 overflow-hidden rounded-[11px] border border-white/[0.07] bg-[#191918] text-[#D0C8C0] shadow-[0_4px_16px_rgba(0,0,0,0.24)]">
    {title && (
      <div className="eterx-trp-card-header flex items-center gap-2 border-b border-white/[0.055] px-3.5 py-2.5">
        {icon && <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[#6A6460]">{icon}</span>}
        <span className="eterx-trp-card-title flex-1 text-[11.5px] font-semibold text-[#B0A9A1] tracking-[-0.01em]">{title}</span>
        {badge && <span className="shrink-0">{badge}</span>}
      </div>
    )}
    <div className="px-3.5 py-3">{children}</div>
  </div>
));
TrpCard.displayName = 'TrpCard';


// ─── Domain extractor for clean source display ─────────────────────────────
function extractDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

// ─── Source list used by multiple views ────────────────────────────────────
const TrpSources = React.memo(({ sources }: { sources: string[] }) => {
  if (!sources.length) return null;
  return (
    <div className="mt-3 border-t border-white/[0.055] pt-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-[#5E5A55]">{sources.length} sources</div>
      <div className="flex flex-col gap-1 max-h-[130px] overflow-y-auto eterx-scrollbar">
        {sources.map((src, i) => (
          <a key={i} href={src} target="_blank" rel="noopener noreferrer"
            className="group flex items-center gap-2 rounded-[6px] px-2 py-1 text-[11.5px] hover:bg-white/[0.035] transition-colors">
            <ExternalLink className="w-2.5 h-2.5 shrink-0 text-[#545148] group-hover:text-[#94C7E0] transition-colors" />
            <span className="truncate font-medium text-[#7E9BAD] group-hover:text-[#94C7E0] transition-colors">{extractDomain(src)}</span>
            <span className="ml-auto shrink-0 truncate text-[10px] text-[#47443F] max-w-[180px] hidden sm:block">{src}</span>
          </a>
        ))}
      </div>
    </div>
  );
});
TrpSources.displayName = 'TrpSources';

// ─── Memoized markdown renderer ────────────────────────────────────────────
const TrpMarkdown = React.memo(({ content }: { content: string }) => (
  <div className="
    text-[12.5px] leading-[1.7] text-[#C8C0B8]
    [&_h1]:text-[15px] [&_h1]:font-bold [&_h1]:text-[#E6E0D8] [&_h1]:mt-0 [&_h1]:mb-3 [&_h1]:leading-tight
    [&_h2]:text-[13.5px] [&_h2]:font-semibold [&_h2]:text-[#D8D0C8] [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:leading-tight
    [&_h3]:text-[12.5px] [&_h3]:font-semibold [&_h3]:text-[#C8C0B8] [&_h3]:mt-3 [&_h3]:mb-1.5
    [&_p]:mb-3 [&_p]:last:mb-0 [&_p]:leading-[1.7]
    [&_ul]:pl-4 [&_ul]:mb-3 [&_ul]:space-y-1
    [&_ol]:pl-4 [&_ol]:mb-3 [&_ol]:space-y-1
    [&_li]:text-[#BEB7AE] [&_li]:leading-[1.6]
    [&_strong]:text-[#E6E0D8] [&_strong]:font-semibold
    [&_em]:text-[#B8B0A8] [&_em]:italic
    [&_a]:text-[#6B9AB8] [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-white/20 [&_a]:hover:text-[#94C7E0]
    [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-[#B8A878] [&_code]:bg-white/[0.055] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded-[4px]
    [&_blockquote]:pl-3 [&_blockquote]:border-l-2 [&_blockquote]:border-white/[0.12] [&_blockquote]:text-[#908880] [&_blockquote]:italic
    [&_hr]:border-white/[0.07] [&_hr]:my-4
    [&_table]:w-full [&_table]:text-[11px] [&_table]:border-collapse
    [&_th]:bg-white/[0.04] [&_th]:text-[#9A9388] [&_th]:font-semibold [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:border [&_th]:border-white/[0.06]
    [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:border [&_td]:border-white/[0.045] [&_td]:text-[#C0B8B0]
  ">
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>{content}</ReactMarkdown>
  </div>
));
TrpMarkdown.displayName = 'TrpMarkdown';

const ObjectCard = React.memo(({ item, primaryKey, secondaryKey, metaKeys }: {
  item: any;
  primaryKey: string;
  secondaryKey: string;
  metaKeys: string[];
}) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-[7px] bg-white/[0.02] border border-white/[0.04] px-2.5 py-2 hover:border-white/[0.08] transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {primaryKey && item[primaryKey] != null && (
            <div className="text-[12px] font-semibold text-[#C0B8B0] leading-tight mb-0.5 truncate select-all">{String(item[primaryKey])}</div>
          )}
          {secondaryKey && item[secondaryKey] != null && (
            <div className="text-[11.5px] text-[#7A7470] leading-snug line-clamp-2 select-text">{String(item[secondaryKey])}</div>
          )}
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 text-[10px] font-medium text-[#6B9AB8] hover:text-[#94C7E0] hover:bg-white/[0.04] transition-all px-1.5 py-0.5 rounded border border-white/[0.06] shadow-[0_1px_3px_rgba(0,0,0,0.1)]"
        >
          {expanded ? 'Hide Details' : 'Show Details'}
        </button>
      </div>

      {metaKeys.length > 0 && !expanded && (
        <div className="mt-1.5 flex gap-x-2.5 gap-y-0.5 flex-wrap">
          {metaKeys.map(mk => item[mk] != null && (
            <span key={mk} className="text-[10px] font-mono text-[#5E5A55] select-text">
              <span className="text-[#4E4A46] font-medium">{mk}:</span> {String(item[mk])}
            </span>
          ))}
        </div>
      )}

      {expanded && (
        <div className="mt-2.5 rounded-[5px] bg-black/35 border border-white/[0.05] p-2 max-h-[200px] overflow-auto eterx-scrollbar font-mono text-[10.5px] leading-[1.5] text-[#9A9288] whitespace-pre select-text">
          {JSON.stringify(item, null, 2)}
        </div>
      )}
    </div>
  );
});
ObjectCard.displayName = 'ObjectCard';

// ─── Main component ────────────────────────────────────────────────────────
const ToolResultPreview = React.memo(({ toolName, args, result }: { toolName: string; args: any; result: any }) => {

  // ── 1. deep_research ──────────────────────────────────────────────────────
  if (toolName === 'deep_research' || toolName === 'research_report') {
    const report: string = result?.report || result?.content || result?.text || '';
    const sources: string[] = Array.isArray(result?.sources) ? result.sources : [];
    const topic: string = args?.topic || args?.query || '';
    const isOk = result?.success !== false;
    return (
      <TrpCard>
        {topic && (
          <div className="mb-3 text-[11px] text-[#5E5A55]">
            <span className="font-medium text-[#7A7470]">Topic — </span>{topic}
          </div>
        )}
        {report ? (
          <div className="max-h-[380px] overflow-y-auto overflow-x-hidden eterx-scrollbar -mr-1 pr-1">
            <TrpMarkdown content={report} />
          </div>
        ) : (
          <div className="py-6 text-center text-[12px] text-[#4E4A46] italic">No report generated.</div>
        )}
        <TrpSources sources={sources} />
      </TrpCard>
    );
  }

  // ── 2. verify_* / realtime_verify / check_* ───────────────────────────────
  const isVerifyTool = toolName.includes('verify') || toolName.startsWith('check_') || toolName === 'realtime_verify';
  if (isVerifyTool && result && typeof result === 'object') {
    const passed = result.passed === true || result.success === true || result.exists === true;
    const failed = result.passed === false || result.success === false || result.exists === false;
    const mode: string = String(result.mode || result.type || '').replace(/_/g, ' ');
    const details: string = String(result.details || result.message || result.info || '');
    const evidence: string = String(result.evidence || result.output || '');
    const items: any[] = Array.isArray(result.items) ? result.items : Array.isArray(result.checks) ? result.checks : [];
    const status = passed ? 'passed' : failed ? 'failed' : 'unknown';
    const badgeCls = status === 'passed' ? 'text-emerald-400/90 bg-emerald-500/10' : status === 'failed' ? 'text-red-400/90 bg-red-500/10' : 'text-amber-400/90 bg-amber-500/10';
    const detailsCls = status === 'passed' ? 'bg-emerald-500/8 border-emerald-500/15 text-emerald-300/90' : status === 'failed' ? 'bg-red-500/8 border-red-500/15 text-red-300/90' : 'bg-amber-500/8 border-amber-500/15 text-amber-300/90';
    return (
      <TrpCard>
        {mode && <div className="mb-2 text-[11px] text-[#5E5A55]"><span className="font-medium text-[#7A7470]">Mode — </span>{mode}</div>}
        {details && (
          <div className={`mb-2.5 rounded-[8px] border px-3 py-2 text-[12px] leading-[1.5] ${ detailsCls }`}>{details}</div>
        )}
        {evidence && (
          <div className="mb-2.5 rounded-[7px] bg-black/25 border border-white/[0.05] px-3 py-2 font-mono text-[11px] text-[#9A9288] leading-snug select-all">{evidence}</div>
        )}
        {items.length > 0 && (
          <div className="flex flex-col gap-1 max-h-[160px] overflow-y-auto eterx-scrollbar">
            {items.map((item: any, i: number) => {
              const ok = item.passed === true || item.result === true || item.success === true;
              const fail = item.passed === false || item.result === false || item.success === false;
              const name: string = item.name || item.check || item.label || `Check ${ i + 1 }`;
              const msg: string = item.message || item.details || item.error || '';
              return (
                <div key={i} className="flex items-start gap-2.5 rounded-[7px] bg-white/[0.025] px-2.5 py-1.5">
                  <span className={`mt-0.5 text-[11px] font-bold shrink-0 ${ ok ? 'text-emerald-400' : fail ? 'text-red-400' : 'text-amber-400' }`}>{ok ? '✓' : fail ? '✗' : '·'}</span>
                  <div>
                    <div className="text-[12px] font-medium text-[#C0B8B0]">{name}</div>
                    {msg && <div className="text-[11px] text-[#5E5A55] mt-0.5">{msg}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </TrpCard>
    );
  }

  // ── 3. web_search ────────────────────────────────────────────────────────
  if (toolName === 'web_search' || toolName === 'deep_search') {
    const summary: string = result?.ai_summary || result?.answer || result?.summary || '';
    const items: any[] = Array.isArray(result?.results) ? result.results : Array.isArray(result) ? result : [];
    const images: any[] = Array.isArray(result?.images) ? result.images : [];
    return (
      <TrpCard>
        {summary && (
          <div className="mb-3 rounded-[8px] bg-white/[0.025] border border-white/[0.05] p-2.5 text-[12.5px] leading-[1.65] text-[#C0B8B0]">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-[#4E4A46] mb-1.5">Summary</div>
            {summary}
          </div>
        )}
        {items.length > 0 ? (
          <div className="flex flex-col gap-1.5 max-h-[300px] overflow-y-auto pr-0.5 eterx-scrollbar">
            {items.map((item: any, idx: number) => (
              <div key={idx} className="rounded-[8px] bg-white/[0.02] border border-white/[0.045] p-2.5 hover:border-white/[0.09] transition-colors">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <a href={item.url} target="_blank" rel="noopener noreferrer"
                    className="text-[12.5px] font-semibold text-[#6B9AB8] hover:text-[#94C7E0] hover:underline flex items-center gap-1.5 min-w-0 transition-colors">
                    <span className="truncate">{item.title || extractDomain(item.url)}</span>
                    <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-50" />
                  </a>
                  {item.score !== undefined && (
                    <span className="shrink-0 text-[9.5px] font-mono text-[#4E4A46]">{(item.score * 100).toFixed(0)}%</span>
                  )}
                </div>
                {item.content && <p className="text-[11.5px] leading-[1.5] text-[#7A7470] line-clamp-2">{item.content}</p>}
                <span className="mt-1 block text-[10px] text-[#3E3A36] font-mono truncate">{item.url}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-6 text-center text-[12px] text-[#4E4A46] italic">No results returned.</div>
        )}
        {images.length > 0 && (
          <div className="mt-3 pt-2.5 border-t border-white/[0.05]">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-[#4E4A46]">Images</div>
            <div className="flex gap-2 overflow-x-auto pb-1 eterx-scrollbar">
              {images.slice(0, 8).map((img: any, i: number) => (
                <a key={i} href={img.url} target="_blank" rel="noopener noreferrer"
                  className="shrink-0 w-18 h-18 rounded-[7px] overflow-hidden border border-white/[0.06] hover:border-white/[0.14] transition-colors">
                  <img src={img.url} alt="" className="w-full h-full object-cover" />
                </a>
              ))}
            </div>
          </div>
        )}
      </TrpCard>
    );
  }

  // ── 4. web_scraper / pdf_parser / youtube_transcript / rss_feed ───────────
  if (['web_scraper', 'pdf_parser', 'youtube_transcript', 'rss_feed'].includes(toolName)) {
    const contentText: string = typeof result === 'string' ? result : result?.content || result?.text || result?.transcript || '';
    const wordCount = contentText.split(/\s+/).filter(Boolean).length;
    const source: string = args?.url || args?.filename || args?.path || '';
    const labels: Record<string, string> = { web_scraper: 'Scraped Page', pdf_parser: 'PDF', youtube_transcript: 'Transcript', rss_feed: 'RSS Feed' };
    return (
      <TrpCard>
        {source && <div className="mb-2 text-[10.5px] font-mono text-[#4E4A46] truncate select-all">{source}</div>}
        <div className="max-h-[260px] overflow-y-auto eterx-scrollbar rounded-[7px] bg-black/25 border border-white/[0.05] p-2.5">
          <p className="font-mono text-[11.5px] leading-[1.6] text-[#9A9288] whitespace-pre-wrap break-words select-text">{contentText || '(empty)'}</p>
        </div>
      </TrpCard>
    );
  }

  // ── 5. calculator ────────────────────────────────────────────────────────
  if (toolName === 'calculator') {
    const expr: string = args?.expression || '';
    const val = typeof result === 'object' ? (result?.result ?? result?.output ?? result?.value ?? JSON.stringify(result)) : String(result);
    return (
      <TrpCard>
        <div className="flex items-center gap-3 font-mono">
          {expr && <div className="flex-1 text-[12.5px] text-[#5E5A55] truncate">{expr}</div>}
          <div className="flex items-center gap-2">
            <span className="text-[#3E3A36]">=</span>
            <span className="text-[15px] font-bold text-[#E0D8D0] bg-white/[0.05] border border-white/[0.08] rounded-[7px] px-3 py-0.5 select-all">{String(val)}</span>
          </div>
        </div>
      </TrpCard>
    );
  }

  // ── 6. database / db_query ────────────────────────────────────────────────
  if (toolName === 'database' || toolName === 'db_query') {
    const query: string = args?.query || args?.sql || '';
    const rows: any[] | null = Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : null;
    const isError = !!(result?.error || result?.success === false);
    const errorMsg = String(result?.message || result?.error || '');
    return (
      <TrpCard>
        {query && (
          <div className="mb-2.5 rounded-[7px] bg-black/25 border border-white/[0.05] px-2.5 py-2 font-mono text-[11px] text-[#D0C8C0] whitespace-pre-wrap">{query}</div>
        )}
        {isError ? (
          <div className="rounded-[7px] bg-red-500/8 border border-red-500/15 p-2.5 text-[11.5px] font-mono text-red-300/80">Error: {errorMsg}</div>
        ) : rows && rows.length > 0 ? (
          <div className="overflow-x-auto eterx-scrollbar max-h-[200px] rounded-[7px] border border-white/[0.05]">
            <table className="w-full text-left text-[11px] border-collapse">
              <thead>
                <tr className="bg-white/[0.025] text-[#6A6460]">
                  {Object.keys(rows[0]).map((k, i) => <th key={i} className="px-2.5 py-1.5 font-semibold border-b border-white/[0.06] border-r last:border-r-0 whitespace-nowrap">{k}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row: any, ri: number) => (
                  <tr key={ri} className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02]">
                    {Object.values(row).map((v: any, vi: number) => (
                      <td key={vi} className="px-2.5 py-1.5 border-r border-white/[0.03] last:border-r-0 max-w-[180px] truncate select-all text-[#A0988E]" title={String(v)}>
                        {v === null ? <span className="text-white/20 italic">null</span> : String(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : rows ? (
          <div className="py-4 text-center text-[11px] text-[#4E4A46] italic">Empty result set.</div>
        ) : null}
      </TrpCard>
    );
  }

  // ── 7. workspace_list_directory ───────────────────────────────────────────
  if (toolName === 'workspace_list_directory' || toolName === 'list_directory') {
    const list: any[] = Array.isArray(result) ? result : Array.isArray(result?.entries) ? result.entries : Array.isArray(result?.files) ? result.files : [];
    const dirPath: string = args?.directory || args?.dir || args?.path || '';
    return (
      <TrpCard>
        {dirPath && <div className="mb-2 text-[10.5px] font-mono text-[#4E4A46] truncate select-all">{dirPath}</div>}
        <div className="flex flex-col max-h-[240px] overflow-y-auto eterx-scrollbar">
          {list.length > 0 ? list.map((item: any, i: number) => {
            const name: string = typeof item === 'string' ? item : (item.name || item.relative || item.path || item.filename || '');
            const isDir = typeof item === 'string' ? false : !!(item.isDir || item.isDirectory || item.type === 'directory');
            const size: string = typeof item === 'string'
              ? ''
              : typeof item.size === 'number'
                ? item.size >= 1048576 ? `${ (item.size / 1048576).toFixed(1) }M` : `${ (item.size / 1024).toFixed(1) }K`
                : '';
            return (
              <div key={i} className="flex items-center gap-2 py-[3px] px-1 rounded-[4px] hover:bg-white/[0.025] font-mono text-[11.5px]">
                <span className={`shrink-0 text-[9px] ${ isDir ? 'text-amber-500/70' : 'text-[#3E3A36]' }`}>{isDir ? '▸' : '·'}</span>
                <span className="truncate select-all text-[#9A9288]">{name}</span>
                {!isDir && size && <span className="ml-auto shrink-0 text-[10px] text-[#3E3A36]">{size}</span>}
              </div>
            );
          }) : <div className="py-4 text-center text-[11px] text-[#4E4A46] italic">Empty directory.</div>}
        </div>
      </TrpCard>
    );
  }

  // ── 8. workspace_search_text / workspace_find_files ───────────────────────
  if (['workspace_search_text', 'workspace_find_files', 'search_files'].includes(toolName)) {
    const list: any[] = Array.isArray(result) ? result : Array.isArray(result?.matches) ? result.matches : Array.isArray(result?.files) ? result.files : [];
    const pattern: string = args?.pattern || args?.query || args?.glob || args?.search || '';
    return (
      <TrpCard
        icon={<Search className="w-3.5 h-3.5" />}
        title="Code Search"
        badge={<span className="text-[10px] font-medium text-[#5E5A55]">{list.length} match{list.length !== 1 ? 'es' : ''}</span>}
      >
        {pattern && <div className="mb-2 text-[11px] font-mono text-[#4E4A46]">Pattern: <span className="text-[#9A9288] select-all">{pattern}</span></div>}
        <div className="flex flex-col gap-1 max-h-[240px] overflow-y-auto eterx-scrollbar">
          {list.length > 0 ? list.map((item: any, i: number) => {
            const file: string = typeof item === 'string' ? item : item.file || item.filename || item.path || '';
            const line = item.line || item.lineNumber;
            const rawContent = item.content ?? item.lineContent ?? item.match ?? '';
            const content: string = typeof rawContent === 'string'
              ? rawContent
              : (typeof rawContent === 'object' && rawContent !== null
                ? JSON.stringify(rawContent)
                : String(rawContent));
            return (
              <div key={i} className="rounded-[7px] bg-white/[0.02] border border-white/[0.04] p-2 hover:border-white/[0.07] transition-colors">
                <div className="flex items-center gap-2 text-[10.5px] mb-1">
                  <span className="text-[#6B9AB8] font-mono truncate select-all flex-1">{file}</span>
                  {line && <span className="shrink-0 text-[#4E4A46] font-mono">:{line}</span>}
                </div>
                {content && <div className="font-mono text-[10.5px] text-[#9A9288] pl-2 border-l border-white/[0.07] whitespace-pre-wrap break-words select-all">{content.trim()}</div>}
              </div>
            );
          }) : <div className="py-4 text-center text-[11px] text-[#4E4A46] italic">No matches found.</div>}
        </div>
      </TrpCard>
    );
  }

  // ── 9. api_caller / http_request ──────────────────────────────────────────
  if (toolName === 'api_caller' || toolName === 'http_request') {
    const url: string = args?.url || '';
    const method: string = String(args?.method || 'GET').toUpperCase();
    const status = Number(result?.status || result?.statusCode || 0);
    const isErr = !!(result?.error) || status >= 400;
    const body = result?.data || result?.body || result?.response;
    const bodyStr: string = typeof body === 'object' ? JSON.stringify(body, null, 2) : String(body || result || '');
    return (
      <TrpCard>
        <div className="flex items-center gap-2 font-mono text-[11.5px] mb-2.5">
          <span className="shrink-0 font-bold text-[#6B9AB8] bg-white/[0.04] border border-white/[0.07] px-2 py-0.5 rounded-[5px]">{method}</span>
          <span className="text-[#5E5A55] truncate select-all">{url}</span>
        </div>
        <div className="max-h-[200px] overflow-auto eterx-scrollbar rounded-[7px] bg-black/25 border border-white/[0.05] p-2.5 font-mono text-[10.5px] leading-[1.5] text-[#9A9288] whitespace-pre select-text">{bodyStr}</div>
      </TrpCard>
    );
  }

  // ── 10. Universal smart renderer ──────────────────────────────────────────
  // Detects the shape of ANY tool result and renders it properly.
  // No tool name matching — purely data-driven.

  // ── Helpers ────────────────────────────────────────────────────────────────
  const IMG_EXT = /\.(jpe?g|png|gif|webp|svg|avif|bmp)(\?.*)?$/i;
  const isImgSrc = (v: string) => IMG_EXT.test(v) || v.startsWith('data:image/') || /\/(image|photo|img|thumb|asset)s?\//i.test(v);
  const isUrl = (v: string) => /^https?:\/\//i.test(v);
  const isFilePath = (v: string) => /^[A-Za-z]:[\\\/]/.test(v) || v.startsWith('/') || v.startsWith('./');
  const hasImgExt = (v: string) => IMG_EXT.test(v);

  // Flatten: result can be an object or array
  const rootArr: any[] | null = Array.isArray(result) ? result : null;
  const obj: Record<string, any> = typeof result === 'object' && result !== null && !Array.isArray(result) ? result : {};

  // Primary message/text
  const getPrimaryText = () => {
    if (typeof result === 'string') return result;
    const candidates = ['message', 'content', 'text', 'output', 'stdout', 'stderr', 'logs', 'response', 'result', 'summary', 'answer', 'report'];
    for (const key of candidates) {
      if (typeof obj[key] === 'string' && obj[key].trim().length > 0) {
        return obj[key];
      }
    }
    return '';
  };
  const primaryText = getPrimaryText();
  const hasPrimaryText = primaryText.trim().length > 0;
  const primaryIsMd = hasPrimaryText && /^#{1,3}\s|\*\*|\n#{1,3}\s|\[.+?\]\(.+?\)/.test(primaryText);

  // Collect ALL arrays in the result
  const SKIP_ARRAY_KEYS = new Set(['sources', 'urls', 'links', 'checks']);
  const arrayFields: Array<{ key: string; items: any[] }> = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length > 0 && !SKIP_ARRAY_KEYS.has(k)) {
      arrayFields.push({ key: k, items: v });
    }
  }
  if (rootArr && rootArr.length > 0) arrayFields.push({ key: '', items: rootArr });

  // Scalar fields to show as key-value tiles
  const SKIP_SCALAR = new Set([
    'success', 'passed', 'ok', 'error', 'message', 'content', 'text',
    'output', 'stdout', 'stderr', 'logs', 'response', 'result', 'summary',
    'answer', 'report', '_cached', '_traceIdx', 'timestamp', 'data'
  ]);
  const scalarFields: [string, any][] = Object.entries(obj).filter(
    ([k, v]) => !SKIP_SCALAR.has(k) && !Array.isArray(v) && typeof v !== 'object' && v !== null && v !== undefined && String(v).trim().length > 0
  );

  // Source links
  const linkSources: string[] = Array.isArray(obj.sources) ? obj.sources
    : Array.isArray(obj.urls) ? obj.urls
      : Array.isArray(obj.links) ? obj.links : [];

  // Detect image assets in arrays
  const findImageAssets = (items: any[]): any[] => {
    return items.filter((item: any) => {
      if (typeof item === 'string') return hasImgExt(item) || (isUrl(item) && isImgSrc(item));
      if (typeof item === 'object' && item !== null) {
        const imgFields = ['publicPath', 'url', 'src', 'localPath', 'filepath', 'path', 'thumbnail', 'imageUrl'];
        return imgFields.some(f => item[f] && (isImgSrc(String(item[f])) || hasImgExt(String(item[f]))));
      }
      return false;
    });
  };
  const getImgSrc = (item: any): string => {
    if (typeof item === 'string') return item;
    return item.url || item.src || item.publicPath || item.thumbnail || item.imageUrl || item.localPath || item.filepath || item.path || '';
  };
  const getItemLabel = (item: any): string => {
    if (typeof item === 'string') return item.split(/[\\/]/).pop() || item;
    return item.filename || item.name || item.title || item.alt || '';
  };

  // Classify arrays
  const classifyArray = (items: any[]): 'images' | 'files' | 'urls' | 'objects' | 'strings' => {
    if (items.length === 0) return 'strings';
    const first = items[0];
    if (typeof first === 'string') {
      if (findImageAssets(items).length > items.length * 0.4) return 'images';
      if (items.every(v => isUrl(String(v)))) return 'urls';
      if (items.every(v => isFilePath(String(v)))) return 'files';
      return 'strings';
    }
    if (typeof first === 'object' && first !== null) {
      if (findImageAssets(items).length > items.length * 0.4) return 'images';
      return 'objects';
    }
    return 'strings';
  };

  const hasAnyContent = hasPrimaryText || arrayFields.length > 0 || scalarFields.length > 0;

  return (
    <TrpCard>
      {/* Error banner */}
      {obj.error && (
        <div className="mb-3 rounded-[7px] bg-red-500/8 border border-red-500/15 px-3 py-2 text-[11.5px] font-mono text-red-300/80">
          {String(obj.error)}
        </div>
      )}

      {/* Primary text/markdown */}
      {hasPrimaryText && (
        <div className="mb-3 max-h-[280px] overflow-y-auto overflow-x-hidden eterx-scrollbar">
          {primaryIsMd ? (
            <TrpMarkdown content={primaryText} />
          ) : primaryText.includes('\n') || primaryText.length > 80 ? (
            <pre className="font-mono text-[11px] leading-[1.6] text-[#9A9288] whitespace-pre-wrap break-words select-text rounded-[7px] bg-black/20 border border-white/[0.04] p-2.5 max-h-[240px] overflow-y-auto eterx-scrollbar">{primaryText}</pre>
          ) : (
            <p className="text-[12.5px] leading-[1.7] text-[#C0B8B0] whitespace-pre-wrap break-words select-text">{primaryText}</p>
          )}
        </div>
      )}

      {/* Smart array renderers */}
      {arrayFields.map(({ key, items }) => {
        const kind = classifyArray(items);
        const imgAssets = kind === 'images' ? findImageAssets(items) : [];
        const sectionLabel = key ? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null;

        // ── Image gallery ──────────────────────────────────────────────────
        if (kind === 'images') {
          return (
            <div key={key} className={hasPrimaryText && key ? 'mt-3 pt-2.5 border-t border-white/[0.05]' : ''}>
              {sectionLabel && (
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-[#4E4A46]">{sectionLabel}</span>
                  <span className="text-[10px] text-[#4E4A46]">{imgAssets.length} item{imgAssets.length !== 1 ? 's' : ''}</span>
                </div>
              )}
              <div className="grid grid-cols-3 gap-1.5">
                {imgAssets.slice(0, 12).map((item: any, i: number) => {
                  const src = getImgSrc(item);
                  const label = getItemLabel(item);
                  const role = typeof item === 'object' ? (item.visualRole || item.role || item.category || '') : '';
                  return (
                    <div key={i} className="relative group overflow-hidden rounded-[7px] border border-white/[0.06] bg-white/[0.02] aspect-square">
                      <img
                        src={src}
                        alt={label}
                        className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                        onError={e => { (e.target as HTMLImageElement).parentElement!.innerHTML = `<div class="w-full h-full flex items-center justify-center text-[#3E3A36] text-[9px] font-mono px-1 text-center break-all">${ label || src.split('/').pop() || '?' }</div>`; }}
                      />
                      {(label || role) && (
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent pt-4 pb-1.5 px-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          {label && <div className="text-[9.5px] font-medium text-white/85 truncate leading-tight">{label}</div>}
                          {role && <div className="text-[8.5px] text-white/45 capitalize">{role}</div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {imgAssets.length > 12 && (
                <div className="mt-1.5 text-center text-[10px] text-[#4E4A46]">+{imgAssets.length - 12} more</div>
              )}
            </div>
          );
        }

        // ── URL list ────────────────────────────────────────────────────────
        if (kind === 'urls') {
          return (
            <div key={key} className={hasPrimaryText && key ? 'mt-3 pt-2.5 border-t border-white/[0.05]' : ''}>
              {sectionLabel && <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-[#4E4A46]">{sectionLabel}</div>}
              <div className="flex flex-col gap-1 max-h-[160px] overflow-y-auto eterx-scrollbar">
                {items.map((url: string, i: number) => (
                  <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                    className="group flex items-center gap-2 rounded-[6px] px-2 py-1 text-[11.5px] hover:bg-white/[0.035] transition-colors">
                    <ExternalLink className="w-2.5 h-2.5 shrink-0 text-[#4E4A46] group-hover:text-[#94C7E0] transition-colors" />
                    <span className="font-medium text-[#6B9AB8] group-hover:text-[#94C7E0] transition-colors truncate">{extractDomain(url)}</span>
                    <span className="ml-auto shrink-0 text-[9.5px] text-[#3E3A36] truncate max-w-[160px] hidden sm:block">{url}</span>
                  </a>
                ))}
              </div>
            </div>
          );
        }

        // ── File path list ───────────────────────────────────────────────────
        if (kind === 'files') {
          return (
            <div key={key} className={hasPrimaryText && key ? 'mt-3 pt-2.5 border-t border-white/[0.05]' : ''}>
              {sectionLabel && <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-[#4E4A46]">{sectionLabel}</div>}
              <div className="flex flex-col gap-0.5 max-h-[160px] overflow-y-auto eterx-scrollbar">
                {items.map((f: string, i: number) => (
                  <div key={i} className="flex items-center gap-2 py-[3px] px-1 rounded-[4px] hover:bg-white/[0.02] font-mono text-[11px] text-[#9A9288]">
                    <span className="text-[9px] text-[#3E3A36]">·</span>
                    <span className="truncate select-all">{f}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        }

        // ── String chip list ─────────────────────────────────────────────────
        if (kind === 'strings') {
          return (
            <div key={key} className={hasPrimaryText && key ? 'mt-3 pt-2.5 border-t border-white/[0.05]' : ''}>
              {sectionLabel && <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-[#4E4A46]">{sectionLabel}</div>}
              <div className="flex flex-wrap gap-1.5">
                {items.map((s: any, i: number) => (
                  <span key={i} className="inline-flex items-center rounded-[5px] bg-white/[0.035] border border-white/[0.06] px-2 py-0.5 text-[11.5px] text-[#9A9288] font-mono select-all">{String(s)}</span>
                ))}
              </div>
            </div>
          );
        }

        // ── Object cards ─────────────────────────────────────────────────────
        if (kind === 'objects') {
          const cardKeys = items.length > 0
            ? Object.keys(items[0]).filter(k => typeof items[0][k] !== 'object' && !Array.isArray(items[0][k])).slice(0, 4)
            : [];
          const primaryKey = cardKeys.find(k => /title|name|label|filename|query|subject/i.test(k)) || cardKeys[0] || '';
          const secondaryKey = cardKeys.find(k => k !== primaryKey && /content|description|text|message|value|status/i.test(k)) || cardKeys[1] || '';
          const metaKeys = cardKeys.filter(k => k !== primaryKey && k !== secondaryKey).slice(0, 2);
          return (
            <div key={key} className={hasPrimaryText && key ? 'mt-3 pt-2.5 border-t border-white/[0.05]' : ''}>
              {sectionLabel && (
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-[#4E4A46]">{sectionLabel}</span>
                  <span className="text-[10px] text-[#4E4A46]">{items.length} item{items.length !== 1 ? 's' : ''}</span>
                </div>
              )}
              <div className="flex flex-col gap-1.5 max-h-[280px] overflow-y-auto eterx-scrollbar">
                {items.map((item: any, i: number) => (
                  <ObjectCard key={i} item={item} primaryKey={primaryKey} secondaryKey={secondaryKey} metaKeys={metaKeys} />
                ))}
              </div>
            </div>
          );
        }

        return null;
      })}

      {/* Scalar key-value tiles (only if there IS some structured data above or no arrays at all) */}
      {scalarFields.length > 0 && (
        <div className={`grid grid-cols-2 gap-1.5 ${ hasPrimaryText || arrayFields.length > 0 ? 'mt-3 pt-2.5 border-t border-white/[0.05]' : '' }`}>
          {scalarFields.map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5 rounded-[6px] bg-white/[0.02] border border-white/[0.04] px-2 py-1.5">
              <span className="text-[9.5px] font-semibold uppercase tracking-widest text-[#4E4A46]">{k.replace(/_/g, ' ')}</span>
              <span className="text-[12px] font-medium text-[#C0B8B0] select-all break-all">{String(v)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Absolute last resort: raw JSON if nothing was rendered */}
      {!hasAnyContent && (
        <div className="max-h-[200px] overflow-auto eterx-scrollbar rounded-[7px] bg-black/25 border border-white/[0.05] p-2.5 font-mono text-[10.5px] leading-[1.5] text-[#7A7470] whitespace-pre select-text">
          {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
        </div>
      )}

      <TrpSources sources={linkSources} />
    </TrpCard>
  );
});
ToolResultPreview.displayName = 'ToolResultPreview';

const InlineDiffView = ({ filename, diffLines, showExpand = true, flush = false }: { filename: string, diffLines: any[], showExpand?: boolean, flush?: boolean }) => {
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
    <div className={`eterx-inline-diff-panel flex flex-col bg-[#1B1B1A] font-mono text-[#D8D1C8] shadow-[0_6px_18px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.026)] ${ full ? 'h-full rounded-none border-0' : `${ flush ? 'mt-1 mb-2' : 'mx-3 mt-1.5 mb-2' } overflow-hidden rounded-[12px] border border-white/[0.07]` }`}>
      {/* Header */}
      <div className="eterx-inline-diff-header flex items-center justify-between gap-3 bg-[#20201F] px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="eterx-inline-diff-filename min-w-0 break-words text-[12px] font-medium text-[#94C7E0] underline-offset-[3px] hover:underline">{filename}</span>
          <ChangeStats
            stats={{ added, removed }}
            className="flex shrink-0 items-center gap-1 font-mono text-[11px] font-semibold tabular-nums"
            addedClassName="eterx-file-change-added text-[#3FB950]"
            removedClassName="eterx-file-change-removed text-[#FF7B72]"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <IconCopyButton content={diffLines.filter(l => l.type !== 'removed').map(l => l.content).join('\n')} label="Copy diff output" />
          {showExpand && !full && <button onClick={(e) => { e.stopPropagation(); setFull(true); }} className="eterx-action-icon-button flex h-7 w-7 items-center justify-center rounded-[8px] border border-white/[0.06] bg-white/[0.028] text-[#9A9389] transition-colors hover:border-white/[0.10] hover:bg-white/[0.05] hover:text-[#DAD4CA]" aria-label="Expand diff"><Maximize2 className="h-3.5 w-3.5" /></button>}
        </div>
      </div>
      {/* Single unified scroll container — horizontal + vertical together */}
      <div className={`relative min-h-0 ${ full ? 'flex-1' : '' }`}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={`eterx-inline-diff-scroll eterx-scrollbar overflow-auto text-[12px] leading-[1.5] ${ full ? 'h-full' : 'max-h-[300px] min-h-[74px]' }`}
        >
          {/* Inner container expands to content width — all lines share same horizontal scroll */}
          <div style={{ minWidth: 'max-content' }}>
            {diffLines.map((l, i) => {
              const isAdd = l.type === 'added';
              const isDel = l.type === 'removed';
              return (
                <div key={i} className={`eterx-inline-diff-row flex items-stretch ${ isAdd ? 'eterx-inline-diff-row-added bg-[#18301D]/35' : isDel ? 'eterx-inline-diff-row-removed bg-[#321B1A]/35' : 'eterx-inline-diff-row-context hover:bg-white/[0.022]'
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
                    className={`eterx-inline-diff-content px-3 py-[3px] whitespace-pre ${ isAdd ? 'text-[#B9E7C0]' : isDel ? 'text-[#E6AAA4]' : 'text-[#BDB5AA]'
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
            className="absolute bottom-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.08] bg-[#2A2A29]/95 text-[#BDB5AA] shadow-[0_6px_18px_rgba(0,0,0,0.26)] transition-colors hover:bg-[#333331] hover:text-[#F0EAE0]"
          ><ChevronDown className="h-3.5 w-3.5" /></button>
        )}
      </div>
    </div>
  );
  return <>{full ? <FullScreenModal onClose={() => setFull(false)} title={`Diff: ${ filename }`}>{diffPanel}</FullScreenModal> : <motion.div layout initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}>{diffPanel}</motion.div>}</>;
};

const InlineCodeView = ({
  filename,
  content,
  stats,
  showExpand = true,
  filepath = '',
  fetchFull = false,
  created = false,
  flush = false,
}: {
  filename: string;
  content: string;
  stats?: { added: number; removed: number } | null;
  showExpand?: boolean;
  filepath?: string;
  fetchFull?: boolean;
  created?: boolean;
  flush?: boolean;
}) => {
  const [full, setFull] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(false);
  const [atBottom, setAtBottom] = useState(false);
  const [loadedContent, setLoadedContent] = useState(content || '');
  useEffect(() => {
    setLoadedContent(content || '');
  }, [content, filename]);
  useEffect(() => {
    if (!fetchFull || !filepath) return;
    let cancelled = false;
    const simpleNameOnly = filepath === filename && !/[\\/]/.test(filepath);
    const candidates = Array.from(new Set([
      filepath,
      simpleNameOnly ? `.workspaces/sandbox/${ filename }` : '',
      simpleNameOnly ? `.workspaces\\sandbox\\${ filename }` : '',
    ].filter(Boolean)));
    (async () => {
      for (const candidate of candidates) {
        try {
          const res = await fetch('/api/code/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: candidate }),
          });
          if (!res.ok) continue;
          const data = await res.json();
          if (!cancelled && typeof data?.content === 'string') {
            setLoadedContent(data.content);
            return;
          }
        } catch {
          // Try the next candidate path.
        }
      }
    })();
    return () => { cancelled = true; };
  }, [fetchFull, filepath, filename]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
    el.scrollLeft = 0;
    atBottomRef.current = false;
    setAtBottom(false);
  }, [loadedContent, filename]);
  const effectiveContent = loadedContent || content || '';
  const lines = useMemo(() => (effectiveContent || '').split('\n'), [effectiveContent]);
  const lineCount = lines.length;
  const displayStats = created && effectiveContent
    ? { added: lineCount, removed: stats?.removed ?? 0 }
    : stats;
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    if (nearBottom !== atBottomRef.current) {
      atBottomRef.current = nearBottom;
      setAtBottom(nearBottom);
    }
  };
  const codePanel = (
    <div className={`eterx-inline-code-panel ${ created ? 'eterx-inline-code-panel-created' : '' } flex flex-col bg-[#1B1B1A] font-mono text-[#D8D1C8] shadow-[0_6px_18px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.026)] ${ full ? 'h-full rounded-none border-0' : `${ flush ? 'mt-1 mb-2' : 'mx-3 mt-1.5 mb-2' } overflow-hidden rounded-[12px] border border-white/[0.07]` }`}>
      {/* Header */}
      <div className="eterx-inline-code-header flex items-center justify-between gap-3 bg-[#20201F] px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="eterx-inline-code-filename min-w-0 break-words text-[12px] font-medium text-[#94C7E0] underline-offset-[3px] hover:underline">{filename}</span>
          {hasVisibleChangeStats(displayStats) ? (
            <ChangeStats
              stats={displayStats}
              className="flex shrink-0 items-center gap-1 font-mono text-[11px] font-semibold tabular-nums"
              addedClassName="eterx-file-change-added text-[#3FB950]"
              removedClassName="eterx-file-change-removed text-[#FF7B72]"
            />
          ) : (
            <span className="eterx-inline-code-label shrink-0 text-[10.5px] font-medium text-[#817A70]">{lineCount} lines</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <IconCopyButton content={effectiveContent} label="Copy file content" />
          {showExpand && !full && <button onClick={(e) => { e.stopPropagation(); setFull(true); }} className="eterx-action-icon-button flex h-7 w-7 items-center justify-center rounded-[8px] border border-white/[0.06] bg-white/[0.028] text-[#9A9389] transition-colors hover:border-white/[0.10] hover:bg-white/[0.05] hover:text-[#DAD4CA]" aria-label="Expand file"><Maximize2 className="h-3.5 w-3.5" /></button>}
        </div>
      </div>
      {/* Single unified scroll container */}
      <div className={`relative min-h-0 ${ full ? 'flex-1' : '' }`}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={`eterx-inline-code-scroll eterx-scrollbar overflow-auto text-[12px] leading-[1.5] ${ full ? 'h-full' : 'max-h-[300px] min-h-[74px]' }`}
        >
          {/* Inner div expands to content width — all lines share the same horizontal scroll */}
          <div style={{ minWidth: 'max-content' }}>
            {lines.map((l, i) => (
              <div key={i} className={`eterx-inline-code-row ${ created ? 'eterx-inline-code-row-created' : '' } flex items-stretch hover:bg-white/[0.022] group`}>
                {/* Line number — sticky left via position (plain div, no overflow) */}
                <div className="eterx-inline-code-line-number w-[42px] shrink-0 select-none border-r border-white/[0.045] py-[3px] pr-3 text-right text-[10.5px] text-[#756E64] transition-colors group-hover:text-[#9B948B]">{i + 1}</div>
                {/* Content — whitespace-pre, no per-line overflow */}
                <div
                  className={`eterx-inline-code-content ${ created ? 'eterx-inline-code-content-created text-[#B9E7C0]' : 'text-[#CDC5BB]' } px-3 py-[3px] whitespace-pre`}
                  dangerouslySetInnerHTML={{ __html: highlightSyntax(l) }}
                />
              </div>
            ))}
          </div>
        </div>
        {!atBottom && lineCount > 10 && (
          <button
            onClick={(e) => { e.stopPropagation(); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}
            className="absolute bottom-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.08] bg-[#2A2A29]/95 text-[#BDB5AA] shadow-[0_6px_18px_rgba(0,0,0,0.26)] transition-colors hover:bg-[#333331] hover:text-[#F0EAE0]"
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

const getPreviewContent = (preview: any) => {
  if (typeof preview?.content === 'string') return preview.content;
  if (typeof preview?.contentPreview === 'string') return preview.contentPreview;
  return '';
};

const getDiffStats = (preview: any, log: any) => {
  let added = 0;
  let removed = 0;
  if (preview?.diffLines?.length) {
    added = preview.diffLines.filter((line: any) => line.type === 'added').length;
    removed = preview.diffLines.filter((line: any) => line.type === 'removed').length;
  } else if (preview) {
    added = numberFrom(preview.added, preview.additions, preview.insertions, preview.linesAdded);
    removed = numberFrom(preview.removed, preview.deleted, preview.deletions, preview.linesRemoved);
    const previewContent = getPreviewContent(preview);
    if (!preview.isEdit && added === 0 && removed === 0) {
      const createdLineCount = numberFrom(preview.linesAdded, preview.lineCount, preview.totalLines);
      if (createdLineCount > 0) {
        added = createdLineCount;
      } else if (previewContent) {
        added = previewContent.split('\n').length;
      }
    }
  }

  // Fallback: extract stats from log tool arguments
  const args = log?.toolArgs || log?.args;
  const toolName = log?.tool || log?.name || '';
  if (added === 0 && removed === 0 && args && toolName) {
    if (toolName === 'workspace_str_replace') {
      const oldStr = String(args.old_string || '');
      const newStr = String(args.new_string || '');
      if (oldStr || newStr) {
        removed = oldStr ? oldStr.split(/\r?\n/).length : 0;
        added = newStr ? newStr.split(/\r?\n/).length : 0;
      }
    } else if (toolName === 'replace_file_content') {
      const targetContent = String(args.TargetContent || '');
      const replacementContent = String(args.ReplacementContent || '');
      if (targetContent || replacementContent) {
        removed = targetContent ? targetContent.split(/\r?\n/).length : 0;
        added = replacementContent ? replacementContent.split(/\r?\n/).length : 0;
      }
    } else if (toolName === 'multi_replace_file_content') {
      const chunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : [];
      chunks.forEach((chunk: any) => {
        const targetContent = String(chunk.TargetContent || '');
        const replacementContent = String(chunk.ReplacementContent || '');
        removed += targetContent ? targetContent.split(/\r?\n/).length : 0;
        added += replacementContent ? replacementContent.split(/\r?\n/).length : 0;
      });
    } else if (toolName === 'workspace_write_file' || toolName === 'write_to_file') {
      const content = String(args.content || args.CodeContent || '');
      if (content) {
        added = content.split(/\r?\n/).length;
        removed = 0;
      }
    } else if (toolName === 'workspace_edit_many_files') {
      const edits = Array.isArray(args.edits) ? args.edits : [];
      edits.forEach((edit: any) => {
        const searchStr = String(edit.search || '');
        const replaceStr = String(edit.replace || '');
        if (edit.startLine !== undefined && edit.endLine !== undefined) {
          removed += Math.max(0, edit.endLine - edit.startLine + 1);
        } else if (searchStr) {
          removed += searchStr.split(/\r?\n/).length;
        }
        added += replaceStr.split(/\r?\n/).length;
      });
    }
  }

  // Secondary fallback: check log root properties
  if (added === 0 && removed === 0 && log) {
    added = numberFrom(log.added, log.additions, log.insertions, log.linesAdded, log.add);
    removed = numberFrom(log.removed, log.deleted, log.deletions, log.linesRemoved, log.remove);
  }

  if (added === 0 && removed === 0) return null;
  return { added, removed };
};

const normalizeChangeCount = (value: unknown) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
};

const hasVisibleChangeStats = (stats?: { added: number; removed: number } | null) =>
  normalizeChangeCount(stats?.added) > 0 || normalizeChangeCount(stats?.removed) > 0;

const ChangeStats = ({
  stats,
  className = 'flex shrink-0 items-center gap-1 font-mono text-[12.5px] font-semibold tabular-nums leading-tight',
  addedClassName = 'eterx-file-change-added text-[#3EE06F]',
  removedClassName = 'eterx-file-change-removed text-[#FF6D63]',
}: {
  stats?: { added: number; removed: number } | null;
  className?: string;
  addedClassName?: string;
  removedClassName?: string;
}) => {
  const added = normalizeChangeCount(stats?.added);
  const removed = normalizeChangeCount(stats?.removed);
  if (added === 0 && removed === 0) return null;
  return (
    <span className={className}>
      {added > 0 && <span className={addedClassName}>+{added}</span>}
      {removed > 0 && <span className={removedClassName}>-{removed}</span>}
    </span>
  );
};

type FileTraceTarget = {
  filename: string;
  filepath: string;
};

const summarizeFileTraceTargets = (targets: FileTraceTarget[], fallbackCount = 0) => {
  const names = Array.from(new Set(targets.map(target => target.filename).filter(Boolean).map(name => name.trim())));
  if (names.length === 0) return `${ fallbackCount || 'Multiple' } files`;
  if (names.length <= 3) return names.join(', ');
  return `${ names.slice(0, 3).join(', ') } +${ names.length - 3 }`;
};

const dedupeFileTraceTargetsForDisplay = (targets: FileTraceTarget[]) => {
  const deduped: FileTraceTarget[] = [];
  const seen = new Map<string, number>();

  targets.forEach((target) => {
    const key = target.filename.trim().toLowerCase();
    if (!key) return;
    const existingIndex = seen.get(key);
    if (existingIndex === undefined) {
      seen.set(key, deduped.length);
      deduped.push(target);
      return;
    }

    const existing = deduped[existingIndex];
    if (!/[\\/]/.test(existing.filepath) && /[\\/]/.test(target.filepath)) {
      deduped[existingIndex] = target;
    }
  });

  return deduped;
};

const cleanFileTargetString = (value: unknown) =>
  String(value ?? '')
    .trim()
    .replace(/^["'`]+|["'`,;]+$/g, '')
    .trim();

const parsePatchFileTargets = (value: string) => {
  const found: string[] = [];
  value.split(/\r?\n/).forEach((line) => {
    const text = line.trim();
    const patchMatch = text.match(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/i);
    const legacyMatch = text.match(/^File:\s+(.+)$/i);
    const gitMatch = text.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/i);
    const plusMatch = text.match(/^\+\+\+\s+(?:b\/)?(.+)$/i);
    if (patchMatch?.[1]) found.push(patchMatch[1]);
    else if (legacyMatch?.[1]) found.push(legacyMatch[1]);
    else if (gitMatch?.[2]) found.push(gitMatch[2]);
    else if (plusMatch?.[1] && plusMatch[1] !== '/dev/null') found.push(plusMatch[1]);
  });
  return found;
};

const COMMON_EXTENSIONLESS_FILES = new Set([
  'dockerfile', 'makefile', 'license', 'rakefile', 'gemfile', 'procfile',
  'readme', 'authors', 'copying', 'install', 'todo', 'changelog'
]);

const toFileTraceTarget = (candidate: unknown): FileTraceTarget | null => {
  const cleaned = cleanFileTargetString(candidate);
  if (!cleaned) return null;
  if (cleaned.includes('\n')) return null;
  if (cleaned.length > 280) return null;
  if (/^(?:system|true|false|null|undefined)$/i.test(cleaned)) return null;
  if (/^(?:https?:|data:|blob:)/i.test(cleaned)) return null;

  // Strict check: reject code, parameters, or command fragments
  if (
    cleaned.includes('"') ||
    cleaned.includes("'") ||
    cleaned.includes('=') ||
    cleaned.includes('{') ||
    cleaned.includes('}') ||
    cleaned.includes('(') ||
    cleaned.includes(')') ||
    cleaned.includes(';') ||
    cleaned.includes('<') ||
    cleaned.includes('>') ||
    cleaned.includes('[') ||
    cleaned.includes(']') ||
    /\s{2,}/.test(cleaned)
  ) {
    return null;
  }

  // Colons are only allowed for Windows drive letters (e.g. C:\)
  const colonIdx = cleaned.indexOf(':');
  if (colonIdx >= 0 && colonIdx !== 1) {
    return null;
  }

  const normalized = cleaned.replace(/^\.?[\\/]+/, '');
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  const filename = segments[segments.length - 1] || normalized;
  if (!filename || filename.length > 160) return null;
  if (!/[A-Za-z0-9_.-]/.test(filename)) return null;
  const lowerFilename = filename.toLowerCase();
  const looksPathLike =
    /[\\/]/.test(normalized) ||
    /\.[A-Za-z0-9]{1,16}$/.test(filename) ||
    filename.startsWith('.') ||
    COMMON_EXTENSIONLESS_FILES.has(lowerFilename);
  if (!looksPathLike) return null;
  return { filename, filepath: cleaned };
};

const appendFileTarget = (targets: FileTraceTarget[], seen: Set<string>, candidate: unknown) => {
  const target = toFileTraceTarget(candidate);
  if (!target) return;
  const key = target.filepath.toLowerCase();
  const filenameKey = target.filename.toLowerCase();
  const duplicateIdx = targets.findIndex(existing => {
    const existingPath = existing.filepath.toLowerCase();
    const existingName = existing.filename.toLowerCase();
    return existingPath === key ||
      (existingName === filenameKey && (existingPath === filenameKey || key === filenameKey));
  });
  if (duplicateIdx >= 0) {
    if (!/[\\/]/.test(targets[duplicateIdx].filepath) && /[\\/]/.test(target.filepath)) {
      targets[duplicateIdx] = target;
    }
    seen.add(key);
    seen.add(filenameKey);
    return;
  }
  if (seen.has(key)) return;
  seen.add(key);
  seen.add(filenameKey);
  targets.push(target);
};

const collectFileTargetCandidates = (value: unknown, targets: FileTraceTarget[], seen: Set<string>, depth = 0) => {
  if (targets.length >= 12 || depth > 2 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.slice(0, 24).forEach(item => collectFileTargetCandidates(item, targets, seen, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    ['filepath', 'filePath', 'filename', 'fileName', 'path', 'file', 'target', 'targetPath', 'outputFile', 'files'].forEach((key) => {
      if (key in record) collectFileTargetCandidates(record[key], targets, seen, depth + 1);
    });
    Object.entries(record).slice(0, 32).forEach(([key, item]) => {
      if (/^(?:content|oldContent|newContent|replacement|patch|stdout|stderr|output|result|command|cmd)$/i.test(key)) return;
      if (/[\\/]/.test(key) || /\.[A-Za-z0-9]{1,16}$/.test(key)) appendFileTarget(targets, seen, key);
      collectFileTargetCandidates(item, targets, seen, depth + 1);
    });
    return;
  }
  const text = cleanFileTargetString(value);
  if (!text) return;
  if (text.includes('\n')) {
    parsePatchFileTargets(text).forEach(path => appendFileTarget(targets, seen, path));
    return;
  }
  if ((text.startsWith('[') || text.startsWith('{')) && text.length < 5000) {
    try {
      collectFileTargetCandidates(JSON.parse(text), targets, seen, depth + 1);
      return;
    } catch {
      // Fall through to direct parsing.
    }
  }
  const commaParts = text.split(/\s*,\s*/).filter(Boolean);
  if (commaParts.length > 1 && commaParts.length <= 12 && commaParts.every(part => Boolean(toFileTraceTarget(part)))) {
    commaParts.forEach(part => appendFileTarget(targets, seen, part));
    return;
  }
  appendFileTarget(targets, seen, text);
};

const collectFileTargets = (log: any, preview?: any): FileTraceTarget[] => {
  const targets: FileTraceTarget[] = [];
  const seen = new Set<string>();
  collectFileTargetCandidates(preview?.filepath || preview?.filename, targets, seen);
  collectFileTargetCandidates(log?.filepath || log?.filePath, targets, seen);
  collectFileTargetCandidates(log?.filename || log?.fileName || log?.file, targets, seen);
  collectFileTargetCandidates(log?.files, targets, seen);
  collectFileTargetCandidates(log?.targetPath || log?.path, targets, seen);
  collectFileTargetCandidates(log?.secondary, targets, seen);
  return targets;
};

const filePreviewMatchesTargets = (previewLog: any, targets: FileTraceTarget[]) => {
  if (previewLog?.type !== 'file_preview') return false;
  if (targets.length === 0) return true;
  const previewPath = cleanFileTargetString(previewLog.filepath || previewLog.filename).toLowerCase();
  const previewName = cleanFileTargetString(previewLog.filename || previewPath.split(/[\\/]/).pop()).toLowerCase();
  return targets.some((target) => {
    const path = target.filepath.toLowerCase();
    const name = target.filename.toLowerCase();
    return previewPath === path || previewPath.endsWith(`\\${ name }`) || previewPath.endsWith(`/${ name }`) || previewName === name;
  });
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
  const normalizedText = text.toLowerCase().replace(/\\/g, '/');

  // If the subtitle text is just the filename or a path ending in the filename (without line ranges),
  // then displaying it again next to the file link is redundant.
  const isFilePathOnly = normalizedText === normalizedFile ||
    normalizedText.endsWith('/' + normalizedFile) ||
    normalizedText.startsWith('./' + normalizedFile);
  if (isFilePathOnly) {
    return '';
  }

  if (normalizedFile && text.toLowerCase().includes(normalizedFile)) {
    const afterFile = text.slice(text.toLowerCase().lastIndexOf(normalizedFile) + normalizedFile.length).trim();
    if (afterFile && afterFile.length <= 32) return afterFile;
  }

  // If the subtitle looks like a path (contains slashes) but has no line number match,
  // it is redundant because we already display the basename of the file.
  if (text.includes('/') || text.includes('\\')) {
    return '';
  }

  return text.length <= 42 ? text : '';
};

const compactActionKeyPart = (value: unknown) =>
  String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 96);

const normalizeActionTypeForKey = (type: unknown) => {
  const value = String(type || '');
  return value === 'sub_agent_action' ? 'command' : value;
};

const getActionIdentity = (log: any, fallbackIndex: number) => {
  const primary = log?._traceIdx ?? log?.traceId ?? log?.id ?? log?.timestamp ?? log?.startTime ?? fallbackIndex;
  return [
    primary,
    normalizeActionTypeForKey(log?.type),
    compactActionKeyPart(log?.text),
    compactActionKeyPart(log?.secondary),
    compactActionKeyPart(log?.command),
    compactActionKeyPart(log?.filename),
    compactActionKeyPart(log?.responseKey),
  ].join('|');
};

const getActionLookupIdentity = (log: any) => [
  normalizeActionTypeForKey(log?.type),
  compactActionKeyPart(log?.text),
  compactActionKeyPart(log?.secondary),
  compactActionKeyPart(log?.command),
  compactActionKeyPart(log?.filename),
].join('|');

const getStableActionEventId = (log: any) => {
  const value = log?.traceId ?? log?.id ?? log?._traceIdx ?? null;
  return value === null || value === undefined ? '' : String(value);
};

const ACTION_CARD_CLASS = "eterx-action-card w-full overflow-hidden rounded-[12px] border border-white/[0.075] bg-[#151514]/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.028),0_2px_10px_rgba(0,0,0,0.14)]";
const ACTION_ROW_DIVIDER_CLASS = "eterx-action-row-divider border-t border-white/[0.052]";

const getTerminalCommandText = (log: any, preview?: any, fallback = '') => {
  return String(
    preview?.command ||
    log?.command ||
    log?.secondary ||
    log?.cmd ||
    fallback ||
    ''
  ).trim();
};

const isTerminalActionLike = (log: any, preview?: any) => {
  const subtitle = String(log?.secondary || log?.command || log?.cmd || '');
  if (log?.type === 'console_output') return true;
  return log?.type === 'command' && shouldUseTerminalIcon(log, subtitle, preview);
};

const ACTION_CONTEXT_TYPES = new Set([
  'command',
  'exploration',
  'file_edit',
  'progress',
  'browser',
  'console_output',
  'file_preview',
  'ask_user',
  'sub_agent_spawn',
  'sub_agent_action',
  'sub_agent_complete',
  'sub_agent_error',
  'sub_agent_result',
  'inter_agent_comm',
]);

const normalizeTimelineText = (value: unknown) =>
  String(value || '')
    .replace(/<\/?(?:thought|work_note)>/gi, '')
    .replace(/[ \t]+/g, ' ')   // collapse horizontal whitespace only (preserve newlines)
    .replace(/\n{3,}/g, '\n\n') // max 2 consecutive newlines
    .trim();

const isActionContextLog = (log: any) =>
  Boolean(log && (ACTION_CONTEXT_TYPES.has(String(log.type || '')) || isTerminalActionLike(log)));

const shouldRenderThoughtSegment = (log: any, flowLogs: any[], idx: number) => {
  const text = normalizeTimelineText(log?.text);
  if (!text) return false;

  const hasActions = flowLogs.some(isActionContextLog);
  if (hasActions) return false;
  return true;
};

const formatTerminalMetaDuration = (durationMs?: number) => {
  if (durationMs === undefined || durationMs === null || !Number.isFinite(durationMs)) return '';
  return durationMs < 1000 ? `${ Math.round(durationMs) }ms` : `${ (durationMs / 1000).toFixed(1) }s`;
};

const findLatestConsoleOutput = (logs: any[], commandSnippet: string) => {
  if (!commandSnippet) {
    // No command snippet — return last console_output if any
    for (let i = logs.length - 1; i >= 0; i -= 1) {
      if (logs[i]?.type === 'console_output') return logs[i];
    }
    return null;
  }
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const candidate = logs[i];
    if (candidate?.type === 'console_output' && (
      String(candidate.command || '').includes(commandSnippet) ||
      commandSnippet.includes(String(candidate.command || '').substring(0, 20))
    )) {
      return candidate;
    }
  }
  return null;
};

const TerminalTraceCard = ({
  log,
  preview,
  isLiveChip,
  subtitle = '',
  inCard = false,
}: {
  log: any;
  preview?: any;
  isLiveChip: boolean;
  subtitle?: string;
  inCard?: boolean;
}) => {
  const command = getTerminalCommandText(log, preview, subtitle) || 'terminal command';
  const output = String(preview?.output ?? preview?.content ?? log?.output ?? log?.content ?? '');
  const exitCode = typeof preview?.exitCode === 'number'
    ? preview.exitCode
    : typeof log?.exitCode === 'number'
      ? log.exitCode
      : undefined;
  const durationMs = typeof preview?.durationMs === 'number'
    ? preview.durationMs
    : typeof log?.durationMs === 'number'
      ? log.durationMs
      : undefined;
  const isStreaming = Boolean(preview?.isStreaming || log?.isStreaming || (isLiveChip && exitCode === undefined));
  const isFailed = exitCode !== undefined && exitCode !== 0;
  const durationLabel = formatTerminalMetaDuration(durationMs);
  const hasOutput = output.trim().length > 0;
  const [isExpanded, setIsExpanded] = useState(() => isStreaming);
  const commandIdentity = [
    log?._traceIdx ?? '',
    log?.traceId ?? '',
    log?.id ?? '',
    command,
  ].join('|');

  const lastCommandIdentityRef = useRef(commandIdentity);

  useEffect(() => {
    if (commandIdentity !== lastCommandIdentityRef.current) {
      lastCommandIdentityRef.current = commandIdentity;
      setIsExpanded(isStreaming);
    } else if (isStreaming) {
      setIsExpanded(true);
    }
  }, [commandIdentity, isStreaming]);

  const title = inCard
    ? isStreaming ? 'Running' : isFailed ? 'Failed' : 'Ran'
    : isStreaming ? 'Running command' : isFailed ? 'Command failed' : 'Ran command';
  const headerLabel = durationLabel && !isStreaming ? `${ title } · ${ durationLabel }` : title;
  const rowGridClass = isExpanded
    ? 'grid-cols-[24px_1fr_auto]'   // title fills space → chevron stays at far right
    : 'grid-cols-[24px_auto_minmax(0,1fr)_auto]';

  return (
    <div className={`eterx-terminal-trace w-full ${ inCard ? '' : 'my-1.5' }`}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsExpanded(open => !open);
        }}
        aria-expanded={isExpanded}
        className={`eterx-terminal-trace-row group grid min-h-[33px] w-full ${ rowGridClass } items-center gap-2 px-1.5 py-1 text-left transition-colors outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0 ${ inCard ? 'hover:bg-white/[0.024]' : 'rounded-[9px] hover:bg-white/[0.024]' }`}
      >
        <span className="eterx-action-icon eterx-terminal-icon flex h-6 w-6 shrink-0 items-center justify-center text-[#A39B91]">
          <Terminal className="h-[15px] w-[15px]" strokeWidth={2.1} />
        </span>
        <span className={`min-w-0 truncate text-[13.5px] font-medium leading-tight tracking-normal ${ isStreaming ? 'eterx-text-shimmer eterx-text-shimmer-active' : 'text-[#C8C1B8]' }`}>
          {headerLabel}
        </span>
        {!isExpanded && (
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] leading-tight text-[#857E73] select-all">
            {command || '(no command)'}
          </span>
        )}
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[#898176] transition-transform ${ isExpanded ? 'rotate-90 text-[#C8C1B8]' : '' }`} />
      </button>
      <AnimatePresence initial={false}>
        {isExpanded && (
          <InlineConsole
            command={command}
            content={output}
            exitCode={isStreaming ? undefined : exitCode}
            durationMs={durationMs}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

const FileChangeTraceCard = ({
  log,
  preview,
  isLiveChip,
  displayVerb,
  fileTargets,
  diffStats,
  inCard = false,
}: {
  log: any;
  preview?: any;
  isLiveChip: boolean;
  displayVerb: string;
  fileTargets: FileTraceTarget[];
  diffStats: { added: number; removed: number } | null;
  inCard?: boolean;
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const { openPanel } = useFilePanelActions();
  const displayFileTargets = useMemo(() => dedupeFileTraceTargetsForDisplay(fileTargets), [fileTargets]);
  const primaryTarget = displayFileTargets[0] || fileTargets[0];
  const explicitCount = numberFrom(log.fileCount, log.filesCount, log.count);
  const fileCount = Math.max(displayFileTargets.length, explicitCount || 0);
  const multiFile = fileCount > 1 || /\bfiles\b/i.test(String(log.text || ''));
  const normalizedVerb = displayVerb.replace(/\s+files?$/i, '').trim() || (isLiveChip ? 'Editing' : 'Edited');
  const title = `${ normalizedVerb } ${ multiFile ? 'files' : 'file' }`;
  const filename = preview?.filename || primaryTarget?.filename || (multiFile ? `${ fileCount || 'Multiple' } files` : '');
  const rawTargetLabel = multiFile
    ? summarizeFileTraceTargets(displayFileTargets, fileCount)
    : filename;
  const targetLabel = /^(?:file|files?)$/i.test(rawTargetLabel) ? '' : rawTargetLabel;
  const previewFilePath = preview?.filepath || primaryTarget?.filepath || '';
  const previewContent = getPreviewContent(preview);
  const hasDiffPreview = Array.isArray(preview?.diffLines) && preview.diffLines.length > 0;
  const isEditPreview = preview?.type === 'file_preview' && Boolean(preview?.isEdit);
  const isCreateAction = /^(?:creat|generat|scaffold|writ)/i.test(displayVerb);
  const canPreview = preview?.type === 'file_preview' && (
    (isEditPreview && (hasDiffPreview || previewContent.length > 0 || Boolean(previewFilePath))) ||
    (!isEditPreview && (previewContent.length > 0 || Boolean(previewFilePath)))
  );
  const showDiff = Boolean(isEditPreview && hasDiffPreview);
  // Allow fetching if we have a filepath, even for non-create actions (covers edit with no diff)
  const canFetchCreatedFile = !multiFile && !canPreview && Boolean(previewFilePath || primaryTarget?.filepath);
  const canShowFileList = !canPreview && (multiFile || !canFetchCreatedFile) && displayFileTargets.length > 0;

  // Patch result — extract from log.result or log (apply_patch returns filesModified/Created/Deleted)
  const isPatch = /patch/i.test(String(displayVerb || '')) || /patch/i.test(String(log?.text || ''));
  const patchResult = useMemo(() => {
    const src = preview?.patchResult ?? log?.result ?? log;
    const hasData = Array.isArray(src?.filesModified) || Array.isArray(src?.filesCreated) || Array.isArray(src?.filesDeleted);
    if (!hasData) return null;
    return {
      filesModified: (src?.filesModified ?? []) as string[],
      filesCreated: (src?.filesCreated ?? []) as string[],
      filesDeleted: (src?.filesDeleted ?? []) as string[],
      errors: (src?.errors ?? []) as string[],
    };
  }, [log, preview]);
  const isPatchWithResult = Boolean(isPatch && patchResult);

  const canExpand = isPatchWithResult || canPreview || canFetchCreatedFile || canShowFileList;
  const canOpenSingleFile = !multiFile && Boolean(previewFilePath || primaryTarget?.filepath);
  const agentEntry = resolveAgentIcon(displayVerb, log.text, log.iconCategory);
  const { Icon: AI, color: ac } = agentEntry;

  const activate = (event: React.MouseEvent | React.KeyboardEvent) => {
    event.stopPropagation();
    if (canExpand) {
      setIsExpanded(open => !open);
    }
  };

  const openSingleFile = (event: React.MouseEvent) => {
    event.stopPropagation();
    const filepath = previewFilePath || primaryTarget?.filepath || '';
    if (!filepath) return;
    openPanel({
      filename,
      filepath,
      content: previewContent || undefined,
      diffLines: preview?.diffLines,
      isEdit: true,
      linesAdded: diffStats?.added,
      linesRemoved: diffStats?.removed,
      added: diffStats?.added,
      removed: diffStats?.removed,
      lineCount: preview?.lineCount,
      totalLines: preview?.totalLines ?? preview?.lineCount,
      truncated: preview?.truncated,
      activeTabMode: hasDiffPreview ? 'diff' : 'code',
    });
  };

  const previewPanel = isPatchWithResult && patchResult ? (
    <PatchSummaryPanel
      filesModified={patchResult.filesModified}
      filesCreated={patchResult.filesCreated}
      filesDeleted={patchResult.filesDeleted}
      errors={patchResult.errors}
      flush
    />
  ) : canFetchCreatedFile ? (
    <InlineCodeView
      filename={filename}
      content=""
      stats={diffStats}
      showExpand={false}
      filepath={previewFilePath || primaryTarget?.filepath || ''}
      fetchFull
      created={isCreateAction}
      flush
    />
  ) : canShowFileList ? (
    <div className="eterx-file-change-list-panel mx-3 mt-1.5 mb-2 overflow-hidden rounded-[12px] border border-white/[0.07] bg-[#1B1B1A] text-[12.5px] text-[#CDC5BB] shadow-[0_6px_18px_rgba(0,0,0,0.18)]">
      {displayFileTargets.slice(0, 10).map((target) => (
        <div key={target.filepath} className="eterx-file-change-list-row flex min-h-[36px] items-center gap-2.5 border-t border-white/[0.045] px-3 py-2 first:border-t-0">
          <LocalFileIcon fileName={target.filename} size="sm" />
          <span className="eterx-file-change-list-name min-w-0 flex-1 break-words font-medium leading-[1.35] text-[#E2DFDA]">{target.filename}</span>
          {displayFileTargets.length === 1 && (
            <ChangeStats
              stats={diffStats}
              className="flex shrink-0 items-center gap-1 font-mono text-[11.5px] font-semibold tabular-nums"
            />
          )}
        </div>
      ))}
    </div>
  ) : showDiff ? (
    <InlineDiffView filename={filename} diffLines={preview.diffLines} showExpand={false} flush />
  ) : (
    <InlineCodeView
      filename={filename}
      content={previewContent}
      stats={diffStats}
      showExpand={false}
      filepath={previewFilePath}
      fetchFull
      created={isCreateAction}
      flush
    />
  );

  if (isExpanded && canExpand) {
    return (
      <div className={`eterx-file-change-trace eterx-file-change-trace-expanded w-full ${ inCard ? '' : 'my-1.5' }`}>
        <button
          type="button"
          aria-expanded="true"
          onClick={activate}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            activate(event);
          }}
          className="eterx-file-change-expanded-header inline-flex min-h-[28px] items-center gap-1.5 px-0.5 py-1 text-left text-[14px] font-normal leading-tight text-[#918A80] transition-colors hover:text-[#D8D1C8]"
        >
          <span className="eterx-file-change-expanded-title">{title}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#8F897F]" />
        </button>
        <AnimatePresence initial={false}>
          <motion.div
            key="file-preview"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="eterx-file-change-preview w-full overflow-hidden"
          >
            {previewPanel}
          </motion.div>
        </AnimatePresence>
      </div>
    );
  }

  const collapsedRowClass = inCard
    ? `eterx-file-change-row eterx-file-change-row--embedded group grid min-h-[33px] w-full grid-cols-[24px_auto_minmax(0,1fr)_auto] items-center gap-2 px-1.5 py-1 text-left transition-colors hover:bg-white/[0.024] ${ canExpand ? 'cursor-pointer' : 'cursor-default' }`
    : `eterx-file-change-row eterx-file-change-row--standalone group grid min-h-[38px] w-full grid-cols-[24px_auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-1 text-left transition-colors ${ ACTION_CARD_CLASS } ${ canExpand ? 'cursor-pointer hover:border-white/[0.13] hover:bg-[#181817]/80' : 'cursor-default' }`;

  return (
    <div className={`eterx-file-change-trace w-full ${ inCard ? '' : 'my-1.5' }`}>
      <div
        role={canExpand ? 'button' : undefined}
        tabIndex={canExpand ? 0 : undefined}
        aria-expanded={canExpand ? isExpanded : undefined}
        onClick={activate}
        onKeyDown={(event) => {
          if (!canExpand) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          activate(event);
        }}
        className={collapsedRowClass}
      >
        <span className="eterx-action-icon eterx-file-change-icon flex h-6 w-6 shrink-0 items-center justify-center">
          <AI isLive={isLiveChip} size={15} color={isLiveChip ? ac : '#DAD6CF'} />
        </span>
        <span className={`eterx-file-change-title min-w-max whitespace-nowrap text-[13.5px] font-medium leading-tight tracking-normal ${ isLiveChip ? 'eterx-text-shimmer eterx-text-shimmer-active' : 'text-[#C8C1B8]' }`}>
          {title}
        </span>
        <span className="eterx-file-change-detail flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 overflow-visible">
          {targetLabel ? (
            <span className="inline-flex min-w-0 max-w-full items-center gap-2">
              <LocalFileIcon fileName={filename || targetLabel} size="sm" />
              {canOpenSingleFile ? (
                <button
                  type="button"
                  onClick={openSingleFile}
                  className="eterx-file-change-filename min-w-0 overflow-wrap-anywhere break-words text-left text-[13px] font-semibold leading-[1.25] text-[#DDEAF1] decoration-transparent underline-offset-[3px] transition-colors hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#94C7E0]/22"
                  aria-label={`Open file: ${ filename }`}
                >
                  {targetLabel}
                </button>
              ) : (
                <span className="eterx-file-change-filename min-w-0 overflow-wrap-anywhere break-words text-[13px] font-semibold leading-[1.25] text-[#DDEAF1] decoration-transparent underline-offset-[3px] transition-colors group-hover:underline">{targetLabel}</span>
              )}
            </span>
          ) : null}
          <ChangeStats stats={diffStats} />
        </span>
        {canExpand ? (
          <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[#8F897F] transition-transform ${ isExpanded ? 'rotate-90 text-[#C9C5BE]' : '' }`} />
        ) : (
          <span className="h-3.5 w-3.5 shrink-0" />
        )}
      </div>
    </div>
  );
};

const ActionChip = ({
  log, isLastChip, isActiveGroup, allLogs,
  isNested = false, inCard = false
}: {
  log: any, isLastChip: boolean, isActiveGroup: boolean, allLogs: any[],
  isNested?: boolean, inCard?: boolean
}) => {
  const isLiveChip = isActiveGroup && isLastChip;
  const isEdit = log.type === 'file_edit' ||
    ['workspace_write_file', 'workspace_edit_file', 'workspace_str_replace', 'workspace_apply_patch', 'workspace_edit_many_files', 'replace_file_content', 'multi_replace_file_content', 'write_to_file'].includes(log.tool || log.name);
  // workspace_apply_patch logs come in as file_edit with text 'Patching files'
  const isPatch = isEdit && /patch/i.test(String(log.text || ''));
  const { openPanel } = useFilePanelActions();
  const logFileTargets = useMemo(() => collectFileTargets(log), [log]);
  // Subtitle: the secondary arg (command string, URL, query, etc.)
  const subtitle = log.secondary && log.secondary !== log.filename ? String(log.secondary).substring(0, 120) : '';
  const preview = useMemo(() => {
    if (log.toolResult !== undefined && log.toolResult !== null) {
      const EXCLUDED_PREVIEW_TOOLS = new Set([
        'skill_loader', 'screenshot_capture', 'system_automation', 'self_improve',
        'memory_v2', 'api_hub', 'api_key_vault', 'env_manager', 'desktop_control',
        'browser_control', 'checkpoint', 'computer', 'screen_agent'
      ]);
      const toolName = log.tool || log.name || '';
      if (!EXCLUDED_PREVIEW_TOOLS.has(toolName) && !['workspace_read_file', 'workspace_write_file', 'workspace_edit_file', 'system_shell', 'workspace_run_command'].includes(toolName)) {
        return {
          id: `inline_result_${ log.id }`,
          type: 'tool_result_preview',
          toolName,
          toolArgs: log.toolArgs || log.args || {},
          result: log.toolResult,
          ownerTraceId: log.id,
        };
      }
    }

    const directIdx = allLogs.indexOf(log);
    const exactIdentity = log?._traceIdx ?? log?.traceId ?? log?.id ?? null;
    const ownerIdentities = [log?.traceId, log?.id, log?._traceIdx]
      .filter(value => value !== null && value !== undefined)
      .map(value => String(value));
    const lookupIdentity = getActionLookupIdentity(log);
    const myIdx = directIdx !== -1
      ? directIdx
      : allLogs.findIndex((candidate: any) => {
        if (exactIdentity !== null && exactIdentity !== undefined) {
          return (candidate?._traceIdx ?? candidate?.traceId ?? candidate?.id ?? null) === exactIdentity;
        }
        return getActionLookupIdentity(candidate) === lookupIdentity;
      });
    const searchLogs = myIdx !== -1 ? allLogs.slice(myIdx) : allLogs;
    const findOwnerPreview = (items: any[]) => items.find((l: any) =>
      (l?.type === 'file_preview' || l?.type === 'tool_result_preview') &&
      ownerIdentities.length > 0 &&
      ownerIdentities.includes(String(l.ownerTraceId || ''))
    );
    const ownerPreview = findOwnerPreview(searchLogs) || findOwnerPreview(allLogs);
    if (ownerPreview) return ownerPreview;
    if (log.type === 'command') {
      const cmd = getTerminalCommandText(log, undefined, String(log.secondary || ''));
      // Search forward from this log first
      const forwardResult = findLatestConsoleOutput(searchLogs, cmd.substring(0, 20));
      if (forwardResult) return forwardResult;
      // Fallback: search all logs only if command index was not found (handles reordered or late-arriving console_output)
      if (myIdx === -1) {
        return findLatestConsoleOutput(allLogs, cmd.substring(0, 20));
      }
      return null;
    }
    if (isEdit) {
      const scopedPreview = searchLogs.find((l: any) => filePreviewMatchesTargets(l, logFileTargets));
      if (scopedPreview) return scopedPreview;
      return logFileTargets.length > 0
        ? allLogs.find((l: any) => filePreviewMatchesTargets(l, logFileTargets)) || null
        : null;
    }
    if (log.type === 'exploration' && (log.text === 'Reading file' || log.text?.toLowerCase().includes('read'))) {
      const scopedPreview = searchLogs.find((l: any) => filePreviewMatchesTargets(l, logFileTargets));
      if (scopedPreview) return scopedPreview;
      return logFileTargets.length > 0
        ? allLogs.find((l: any) => filePreviewMatchesTargets(l, logFileTargets)) || null
        : null;
    }
    return null;
  }, [allLogs, isEdit, log, logFileTargets]);
  const [isExpanded, setIsExpanded] = useState(false);
  const actionIdentity = `${ getStableActionEventId(log) }|${ getActionLookupIdentity(log) }`;
  useEffect(() => {
    setIsExpanded(false);
  }, [actionIdentity]);
  const fileTargets = useMemo(() => collectFileTargets(log, preview), [log, preview]);
  const primaryTarget = fileTargets[0] || null;
  const rawPath = primaryTarget?.filepath || '';
  const fileName = primaryTarget?.filename || '';
  const hasFile = !!fileName && !/^(?:system|file|files?)$/i.test(fileName);
  // Resolve the full path for IDE link
  const fullPath = rawPath || preview?.filepath || preview?.filename || '';
  const getLineContextRange = () => {
    const start = log.toolArgs?.startLine ?? log.args?.startLine ?? preview?.startLine;
    const end = log.toolArgs?.endLine ?? log.args?.endLine ?? preview?.endLine;
    if (start !== undefined && end !== undefined) {
      return `#L${ start }-${ end }`;
    }
    return hasFile ? getLineContext(subtitle, fileName) : '';
  };
  const lineContext = getLineContextRange();
  const diffStats = isEdit ? getDiffStats(preview, log) : null;
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
      'Patched': 'Patching',
      'Called API': 'Calling API', 'Generated': 'Generating',
      'Queried': 'Querying', 'Compared': 'Comparing',
    };
    return { ...base, verbDone: base.verb, verbLive: LIVE_VERBS[base.verb] || base.verb };
  }, [isEdit, log.text, log.type, log.icon, log.iconCategory, preview]);
  const displayVerb = isLiveChip ? (meta.verbLive || meta.verbDone) : (meta.verbDone || (meta as any).verb);
  const cleanVerb = displayVerb.replace(/\s+files?$/i, '').trim();
  const displayVerbLabel = hasFile ? stripTrailingFileName(cleanVerb, fileName) : cleanVerb;
  const isTerminalAction = isTerminalActionLike(log, preview);
  if (isTerminalAction) {
    return (
      <TerminalTraceCard
        log={log}
        preview={preview || (log.type === 'console_output' ? log : undefined)}
        isLiveChip={isLiveChip}
        subtitle={subtitle}
        inCard={inCard}
      />
    );
  }
  // Open a file into the IDE panel
  const openInIde = (e: React.SyntheticEvent, mode?: 'preview' | 'code' | 'diff') => {
    e.stopPropagation();
    if (!fullPath) return;
    const preferredMode = mode || (isEdit ? 'diff' : 'code');
    openPanel({
      filename: fileName,
      filepath: fullPath,
      content: typeof preview?.content === 'string' ? preview.content : undefined,
      diffLines: preview?.diffLines,
      isEdit: preview?.isEdit || isEdit,
      linesAdded: preview?.linesAdded ?? preview?.added,
      linesRemoved: preview?.linesRemoved ?? preview?.removed,
      added: preview?.added ?? preview?.linesAdded,
      removed: preview?.removed ?? preview?.linesRemoved,
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

  if (isEdit) {
    return (
      <FileChangeTraceCard
        log={log}
        preview={preview}
        isLiveChip={isLiveChip}
        displayVerb={displayVerbLabel}
        fileTargets={fileTargets}
        diffStats={diffStats}
        inCard={inCard}
      />
    );
  }

  // Think chips: no icon, just label
  const isThinkChip = log.text === 'Think' || log.type === 'think';
  const handleTogglePreview = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    if (preview) setIsExpanded(open => !open);
  };

  return (
    <div className="w-full">
      <div
        role={preview ? 'button' : undefined}
        tabIndex={preview ? 0 : undefined}
        aria-expanded={preview ? isExpanded : undefined}
        onClick={handleTogglePreview}
        onKeyDown={(e) => {
          if (!preview || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          handleTogglePreview(e);
        }}
        className={`eterx-action-chip grid min-h-[33px] w-full grid-cols-[24px_auto_minmax(0,1fr)_auto] items-center gap-2 px-1.5 py-1 transition-colors group ${ inCard ? 'rounded-none border-0 bg-transparent hover:bg-white/[0.026]' : preview ? `${ ACTION_CARD_CLASS } cursor-pointer hover:border-white/[0.13] hover:bg-[#181817]/80` : `${ ACTION_CARD_CLASS } cursor-default hover:bg-[#171716]/70` } ${ preview ? 'cursor-pointer' : 'cursor-default' }`}
      >
        {!isThinkChip && (() => {
          // Terminal-style traces can arrive with custom text and older computer categories.
          const iconCategory = shouldUseTerminalIcon(log, subtitle, preview) ? 'terminal' : log.iconCategory;
          const agentEntry = resolveAgentIcon(displayVerbLabel, log.text, iconCategory);
          const { Icon: AI, color: ac } = agentEntry;
          return <span className="eterx-action-icon flex h-6 w-6 items-center justify-center shrink-0"><AI isLive={isLiveChip} size={15} color={isLiveChip ? ac : '#DAD6CF'} /></span>;
        })()}
        {isThinkChip && <span className="h-6 w-6 shrink-0" />}
        <span className={`eterx-action-verb shrink-0 truncate text-[13.5px] font-medium leading-tight tracking-normal ${ isLiveChip ? 'eterx-text-shimmer eterx-text-shimmer-active' : 'text-[#C8C1B8]' }`}>{displayVerbLabel}</span>
        {hasFile && (
          <span className="flex min-w-0 items-center gap-2">
            <LocalFileIcon fileName={fileName} size="sm" />
            <button
              type="button"
              onClick={(e) => openInIde(e, 'code')}
              className="eterx-action-file-link min-w-0 truncate text-left text-[13.5px] font-semibold leading-tight text-[#DDEAF1] transition-colors duration-150 hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#94C7E0]/22"
              aria-label={`Open file: ${ fileName }`}
            >
              {fileName}
            </button>
            {hasVisibleChangeStats(diffStats) && (
              <button
                type="button"
                onClick={(e) => openInIde(e, 'diff')}
                className="eterx-action-diff-chip group/diff relative -my-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 font-mono text-[12px] font-semibold tabular-nums leading-none text-[#C8C1B8] transition-colors duration-150 hover:bg-white/[0.052] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/18"
                aria-label={`Open file: ${ fileName }`}
              >
                <ChangeStats
                  stats={diffStats}
                  className="inline-flex shrink-0 items-center gap-1"
                  addedClassName="eterx-action-diff-added text-[#3EE06F]"
                  removedClassName="eterx-action-diff-removed text-[#FF6D63]"
                />
                <span className="eterx-action-diff-tooltip pointer-events-none absolute -top-8 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-full border border-white/[0.08] bg-[#222220]/96 px-2.5 py-1 text-[11px] font-medium text-[#E6DED4] opacity-0 shadow-[0_8px_22px_rgba(0,0,0,0.28)] backdrop-blur-xl transition-opacity duration-150 group-hover/diff:opacity-100">
                  Open diff
                </span>
              </button>
            )}
            {lineContext && (
              <span className="shrink-0 font-mono text-[12px] font-medium leading-tight text-[#857E73]">
                {lineContext}
              </span>
            )}
          </span>
        )}
        {!hasFile && subtitle && (
          <span className="min-w-0 truncate font-mono text-[12.5px] leading-tight text-[#918A80]">{subtitle}</span>
        )}
        {!hasFile && !subtitle && <span className="min-w-0" />}
        <span className="flex shrink-0 items-center justify-end gap-2 justify-self-end">
          {preview && (
            <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-all ${ isExpanded ? 'rotate-90 text-[#C8C1B8]' : 'text-[#898176]' } group-hover:text-[#C8C1B8]`} />
          )}
          {hasFile && fullPath.toLowerCase().match(/\.(html|htm)$/) && (
            <button
              onClick={(e) => { e.stopPropagation(); openPanel({ filename: fileName, filepath: fullPath, content: typeof preview?.content === 'string' ? preview.content : undefined, lineCount: preview?.lineCount, totalLines: preview?.totalLines ?? preview?.lineCount, truncated: preview?.truncated, activeTabMode: 'preview' }); }}
              className="flex items-center gap-1 rounded-[7px] border border-white/[0.07] bg-white/[0.035] px-2 py-0.5 text-[10px] font-semibold uppercase text-[#C8C1B8] transition-colors hover:border-[#94C7E0]/25 hover:bg-white/[0.055] hover:text-[#B9DCEB] shrink-0"
            ><Monitor className="w-2.5 h-2.5" /> Preview</button>
          )}
        </span>
      </div>
      <AnimatePresence initial={false}>
        {isExpanded && preview && (
          <motion.div
            key="action-chip-preview"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="w-full overflow-hidden"
          >
            {preview.type === 'console_output'
              ? <InlineConsole command={preview.command || subtitle} content={preview.output || preview.content} exitCode={preview.exitCode} durationMs={preview.durationMs} />
              : preview.type === 'file_preview' && preview.isEdit && Array.isArray(preview.diffLines) && preview.diffLines.length > 0
                ? <InlineDiffView filename={preview.filename || fileName} diffLines={preview.diffLines} />
                : preview.type === 'file_preview'
                  ? <InlineCodeView filename={preview.filename || fileName} content={getPreviewContent(preview)} filepath={preview.filepath || fullPath} fetchFull={Boolean(preview.filepath || fullPath)} />
                  : preview.type === 'tool_result_preview'
                    ? <ToolResultPreview toolName={preview.toolName} args={preview.toolArgs} result={preview.result} />
                    : null}
          </motion.div>
        )}
      </AnimatePresence>
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
  const identityStatus = isComplete ? 'completed' : isFailed ? 'error' : isWorking ? 'working' : 'idle';
  const durationLabel = log.durationMs ? `${ Math.round(log.durationMs / 1000) }s` : null;
  const stepLabel = log.stepCount ? `${ log.stepCount } steps` : null;
  const metaText = [durationLabel, stepLabel].filter(Boolean).join(' · ') || (isWorking ? 'Working...' : 'Parallel worker');
  const displayText = log.taskSummary || log.result || log.content || log.text || '';

  const statusBadge = isComplete
    ? { bg: 'bg-emerald-500/8 border-emerald-500/15', text: 'text-emerald-400', label: 'Done' }
    : isFailed
      ? { bg: 'bg-red-500/8 border-red-500/15', text: 'text-red-400', label: 'Error' }
      : isWorking
        ? { bg: 'bg-amber-500/8 border-amber-500/15', text: 'text-amber-400', label: 'Working' }
        : { bg: 'bg-white/[0.035] border-white/[0.07]', text: 'text-[#AFA79C]', label: 'Agent' };
  return (
    <div className="my-1.5 overflow-hidden">
      <div className={`w-full flex min-h-[50px] items-center gap-2 rounded-[12px] px-3 py-2.5 transition-colors border ${ open ? 'bg-[#181817]/80 border-white/[0.10]' : 'bg-white/[0.012] border-white/[0.045] hover:bg-white/[0.024] hover:border-white/[0.075]' }`}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(value => !value)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/16"
        >
          <SubAgentIdentityIcon name={agentName} status={identityStatus} size={34} />

          {/* Info */}
          <span className="min-w-0 flex-1 text-left">
            <span className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium tracking-normal text-[#D8D1C8]">{agentName}</span>
              <span className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ${ statusBadge.bg } ${ statusBadge.text }`}>
                {isWorking && <span className="eterx-agent-live-rail !h-[6px] !w-[22px]" aria-hidden="true" />}
                {statusBadge.label}
              </span>
            </span>
            <span className={`mt-0.5 block truncate text-[11px] font-medium ${ isWorking ? 'text-[#BDB5AA]' : 'text-[#7E766C]' }`}>{metaText}</span>
          </span>

          <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[#6F685F] transition-all ${ open ? 'rotate-90 text-[#B6AEA3]' : '' }`} />
        </button>
        {onOpenAgentTeam && (
          <button
            type="button"
            onClick={() => onOpenAgentTeam(agentName)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-[#756D63] transition-colors hover:bg-white/[0.045] hover:text-[#CFC8BD] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/16"
            aria-label={`Open ${ agentName } in agent team`}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <AnimatePresence>
        {open && displayText && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="ml-7 border-l border-white/[0.075] pl-4 pb-3 pt-2 text-[12px] text-[#918A80] leading-relaxed whitespace-pre-wrap font-mono max-h-[350px] overflow-y-auto eterx-scrollbar">
              {displayText}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// Agent created card — minimal, enterprise-grade card shown when sub-agents are created
const AgentCreatedCard = ({ log, onOpenAgentTeam }: { log: any; onOpenAgentTeam?: (name?: string) => void }) => {
  const agents = log.agentDetails || log.spawnedAgents || [];
  const agentList = Array.isArray(agents)
    ? agents.map((a: any) => typeof a === 'string' ? a : a.name).filter(Boolean)
    : [];
  // If single agent spawn (from spawnAgent), use the direct name
  const singleName = log.agentName || log.subAgent || '';
  const displayList = agentList.length > 0 ? agentList : (singleName ? [singleName] : ['Agent']);

  // Known sub-agent names that have profile images
  const SUB_AGENT_NAMES = [
    'einstein', 'heisenberg', 'sam', 'dario', 'elon',
    'tesla', 'newton', 'turing', 'ada', 'curie',
    'feynman', 'darwin', 'hawking', 'galileo', 'davinci',
    'aristotle', 'oppenheimer', 'gates', 'jobs', 'pascal'
  ];

  return (
    <>
      {displayList.map((name: string) => {
        const lowerName = String(name).toLowerCase().trim();
        const hasImage = SUB_AGENT_NAMES.includes(lowerName);
        return (
          <div key={name} className="my-1">
            <button
              type="button"
              onClick={() => onOpenAgentTeam?.(name)}
              className={`w-full flex min-h-[33px] items-center gap-2.5 rounded-[9px] px-3 py-1 bg-white/[0.015] border border-white/[0.045] text-left transition-all hover:bg-white/[0.024] hover:border-white/[0.075] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/16 cursor-pointer group ${ ACTION_CARD_CLASS }`}
              aria-label={`View agent ${ name }`}
            >
              {hasImage ? (
                <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/[0.08] bg-black/10 shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
                  <img
                    src={`/icons/sub-agents/${ lowerName }.png`}
                    alt={name}
                    className="w-full h-full object-cover select-none"
                  />
                </span>
              ) : (
                <SubAgentIdentityIcon name={name} status="spawning" size={22} />
              )}
              <span className="text-[11.5px] font-medium text-[#C8C1B8] group-hover:text-[#E0DAD2] transition-colors">
                Created <span className="text-[#E0DAD2]">{name}</span>
              </span>
            </button>
          </div>
        );
      })}
    </>
  );
};


// Inter-agent communication card — shows messages between agents
const SubAgentActionCard = ({ log }: { log: any }) => {
  const agentName = log.agentName || log.subAgent || 'Sub-agent';
  const actionText = String(log.text || log.currentAction || log.secondary || 'Working').trim();
  const detailText = String(log.secondary && log.secondary !== actionText ? log.secondary : log.task || '').trim();
  const stepLabel = log.agentStep ? `Step ${ log.agentStep }` : 'Delegated step';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className={`my-1.5 flex min-h-[46px] items-center gap-3 px-3 py-2.5 ${ ACTION_CARD_CLASS }`}
    >
      <SubAgentIdentityIcon name={agentName} status="working" size={32} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[12px] font-medium text-[#D8D1C8]">{agentName}</span>
          <span className="shrink-0 rounded-full border border-white/[0.07] bg-white/[0.028] px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.08em] text-[#8F877C]">
            {stepLabel}
          </span>
          <span className="eterx-agent-live-rail shrink-0" aria-hidden="true" />
        </span>
        <span className="mt-0.5 block min-w-0 truncate text-[13px] font-medium leading-5 text-[#C8C1B8]">
          {actionText}
        </span>
        {detailText && (
          <span className="mt-0.5 block truncate text-[11px] text-[#7E766C]">{detailText}</span>
        )}
      </span>
    </motion.div>
  );
};

const InterAgentCommCard = ({ log, onOpenAgentTeam }: { log: any; onOpenAgentTeam?: (name?: string) => void }) => {
  const fromAgent = log.from || log.agentName || 'Agent';
  const toAgent = log.to || log.secondary || 'Main';
  const msgType = log.messageType || log.commType || 'info_share';
  const subject = log.subject || log.text || '';
  const body = log.body || log.content || '';
  const deliveryMode = log.deliveryMode || 'defer';
  const priority = log.priority || 'normal';
  const preview = body && body !== subject ? body : '';
  const deliverAfter = Number(log.deliverAfter || 0) || undefined;
  const isScheduled = log.scheduled === true || (deliverAfter ? deliverAfter > Date.now() : false);
  const focusAgent = fromAgent === 'Main'
    ? (toAgent && toAgent !== '*' ? toAgent : undefined)
    : fromAgent;

  const typeIcon: Record<string, React.ReactNode> = {
    info_share: <Hash className="h-3.5 w-3.5" />,
    question: <MessageSquare className="h-3.5 w-3.5" />,
    answer: <CheckCircle className="h-3.5 w-3.5" />,
    alert: <AlertTriangle className="h-3.5 w-3.5" />,
    coordination: <ArrowRight className="h-3.5 w-3.5" />,
    discovery: <Search className="h-3.5 w-3.5" />,
    progress: <Monitor className="h-3.5 w-3.5" />,
    handoff: <CornerDownLeft className="h-3.5 w-3.5" />,
  };
  const priorityClass = priority === 'critical'
    ? 'border-red-400/20 bg-red-500/[0.08] text-red-200'
    : priority === 'high'
      ? 'border-amber-300/18 bg-amber-400/[0.06] text-amber-100'
      : 'border-white/[0.075] bg-white/[0.026] text-[#AFA79D]';

  return (
    <div className="my-1.5 overflow-hidden">
      <button
        type="button"
        onClick={() => onOpenAgentTeam?.(focusAgent)}
        className={`eterx-agent-comm-card flex min-h-[58px] w-full items-start gap-3 rounded-[8px] px-3 py-2.5 bg-white/[0.012] border border-white/[0.07] text-left transition-colors hover:bg-white/[0.024] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/16 ${ ACTION_CARD_CLASS }`}
        aria-label={`Open ${ focusAgent || 'agent team' } in agent team`}
      >
        <span className="eterx-agent-comm-identities mt-0.5 flex shrink-0 items-center gap-1.5">
          <SubAgentIdentityIcon name={fromAgent} status="working" size={28} />
          <ArrowRight className="h-3.5 w-3.5 text-[#6F685F]" />
          <SubAgentIdentityIcon name={toAgent === '*' ? 'All agents' : toAgent} status="idle" size={28} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="text-[12px] font-semibold text-[#D8D1C7]">{fromAgent}</span>
            <ArrowRight className="h-3 w-3 text-[#6F685F]" />
            <span className="text-[12px] font-semibold text-[#D8D1C7]">{toAgent === '*' ? 'All agents' : toAgent}</span>
            <span className="inline-flex items-center gap-1 rounded-[6px] border border-white/[0.075] bg-white/[0.026] px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.08em] text-[#9C948B]">
              {typeIcon[msgType] || <MessageSquare className="h-3.5 w-3.5" />}
              {msgType.replace('_', ' ')}
            </span>
            <span className={`rounded-[6px] border px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.08em] ${ priorityClass }`}>{priority}</span>
            <span className="rounded-[6px] border border-white/[0.065] bg-black/10 px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.08em] text-[#827A70]">{deliveryMode}</span>
            {isScheduled && (
              <span className="rounded-[6px] border border-sky-300/16 bg-sky-400/[0.055] px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.08em] text-sky-100/85">
                scheduled
              </span>
            )}
          </span>
          {subject && <span className="mt-1 block truncate text-[12px] font-medium text-[#BDB5AB]">{subject}</span>}
          {preview && <span className="mt-0.5 block truncate text-[11px] text-[#817970]">{preview}</span>}
        </span>
      </button>
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
      className={`my-1.5 flex min-h-[46px] items-center gap-3 rounded-[12px] px-3 py-2.5 ${ ACTION_CARD_CLASS }`}
    >
      <SubAgentIdentityIcon name={agentName} status="error" size={36} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium text-[#E5B2AD]">{agentName} {log.errorType === 'cancelled' ? 'stopped' : 'encountered an error'}</span>
        <span className="block text-[12px] font-medium text-[#A07B76] mt-0.5 truncate">{log.secondary || ''}</span>
      </span>
    </motion.div>
  );
};

// Safety warning banner
const SafetyBanner = ({ log }: { log: any }) => (
  <div className="flex items-start gap-2.5 px-3 py-2.5 my-1 rounded-[10px] bg-red-500/[0.045] border border-red-500/15">
    <ShieldHalf className="w-4 h-4 text-red-300 shrink-0 mt-0.5" />
    <div>
      <span className="text-[10.5px] font-semibold text-red-300 uppercase tracking-[0.08em] block mb-0.5">Safety Warning</span>
      <span className="text-[12.5px] text-[#EAB8B3]">{log.text || log.secondary}</span>
    </div>
  </div>
);

// ─── Card containing one or more tool rows ────────────────────────────────────
const AskUserTimelineCard = ({ log, isLive }: { log: any; isLive: boolean }) => {
  const [open, setOpen] = useState(false);
  const answered = Boolean(log.answeredWith);
  const questions = Array.isArray(log.questions) ? log.questions.filter((item: any) => String(item?.question || '').trim()) : [];
  const question = String(log.question || log.secondary || log.text || 'Waiting for user input');
  const questionLabel = questions.length > 1 ? `${ questions.length } questions` : question;
  const answer = String(log.answeredWith || '');

  return (
    <div className="my-1.5 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className={`${ ACTION_CARD_CLASS } flex min-h-[44px] items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-white/[0.028]`}
      >
        <span className="eterx-action-icon flex h-7 w-7 shrink-0 items-center justify-center text-[#D8D1C8]">
          {answered ? (
            <Check className="h-4 w-4 text-[#DAD6CF]" />
          ) : (
            <AgentAssetIcon size={18} color="#DAD6CF" />
          )}
        </span>
        <span className={`shrink-0 truncate text-[13.5px] font-medium leading-tight tracking-normal ${ !answered && isLive ? 'eterx-text-shimmer eterx-text-shimmer-active' : 'text-[#C8C1B8]' }`}>
          {answered ? 'Asked user' : `Asking user${ isLive ? '...' : '' }`}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.75px] text-[#918A80]">
          {questionLabel}
        </span>
        <ChevronRight className={`h-4 w-4 shrink-0 text-[#898176] transition-transform ${ open ? 'rotate-90 text-[#C8C1B8]' : '' }`} />
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
            <div className="mx-3 mb-2 mt-1.5 rounded-[11px] border border-white/[0.07] bg-white/[0.022] p-3 text-[12.5px] leading-relaxed text-[#BDB5AA]">
              <div className="font-medium text-[#DED6CC]">Question</div>
              <div className="mt-1 whitespace-pre-wrap">{question}</div>
              {questions.length > 1 && (
                <div className="mt-2 space-y-1.5">
                  {questions.map((item: any, index: number) => (
                    <div key={item.id || index} className="rounded-[8px] border border-white/[0.055] bg-white/[0.018] px-2.5 py-2">
                      <span className="text-[#918A80]">{index + 1}.</span>{' '}
                      <span>{String(item.question || '')}</span>
                    </div>
                  ))}
                </div>
              )}
              {answered && (
                <>
                  <div className="mt-3 font-medium text-[#DED6CC]">Answer</div>
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
  const terminalOnly = visibleLogs.length === 1 && isTerminalActionLike(visibleLogs[0]);
  const fileChangeOnly = visibleLogs.length === 1 && visibleLogs[0]?.type === 'file_edit';
  const useStandaloneRows = terminalOnly || fileChangeOnly;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className={useStandaloneRows ? 'w-full' : ACTION_CARD_CLASS}
    >
      {visibleLogs.map((log, i) => (
        <motion.div
          key={getActionIdentity(log, i)}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.18, delay: i * 0.03, ease: 'easeOut' }}
          className={i > 0 ? ACTION_ROW_DIVIDER_CLASS : ''}
        >
          <ActionChip
            log={log}
            isLastChip={isLast && i === visibleLogs.length - 1}
            isActiveGroup={isActiveGroup}
            allLogs={allLogs}
            isNested={i > 0}
            inCard={!useStandaloneRows}
          />
        </motion.div>
      ))}
    </motion.div>
  );
};

// Live working indicator — real-time log-state-connected
// 3 modes: thinking (visible note last), acting (real action last), idle (between)

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
      return { mode: 'acting', label };
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
  const [faceReady, setFaceReady] = useState(false);
  const mountedAtRef = useRef(Date.now());
  const hasDeepWork = useMemo(() => logs.some(isDeepWorkLog), [logs]);

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

  useEffect(() => {
    if (faceReady) return;
    const delay = hasDeepWork ? LIVE_FACE_DEEP_WORK_DELAY_MS : LIVE_FACE_REGULAR_DELAY_MS;
    const remaining = Math.max(0, delay - (Date.now() - mountedAtRef.current));
    const timeout = window.setTimeout(() => setFaceReady(true), remaining);
    return () => window.clearTimeout(timeout);
  }, [faceReady, hasDeepWork]);

  const hideDuringFreshThought = !!latestLog
    && (latestLog.type === 'thought_stream' || latestLog.type === 'work_note')
    && isLiveThoughtFresh(latestLog);
  const isRecentAction = !!latestLog
    && !hideDuringFreshThought
    && logs.length > 0
    && Date.now() - signatureSeenAtRef.current.at <= LIVE_ACTION_SETTLE_MS;
  const shouldUseNeutralLabel = hideDuringFreshThought || isRecentAction;
  const faceMode = modeRef.current === 'acting' ? 'working' : modeRef.current === 'thinking' ? 'thinking' : 'idle';
  const displayLabel = shouldUseNeutralLabel
    ? faceMode === 'working' ? 'Working' : 'Thinking'
    : label;

  if (!faceReady) return null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -6, y: 2, scale: 0.99, filter: 'blur(3px)' }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, x: -4, y: 2, scale: 0.99, filter: 'blur(3px)', transition: { duration: 0.26, ease: 'easeInOut' } }}
      transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
      className="mt-1 mb-2 flex min-h-[38px] w-fit max-w-full items-center gap-2 overflow-visible py-0.5"
    >
      <AgentFace
        size="work"
        mode={faceMode}
        actionKey={`live-${ faceMode }`}
        interactive
        syncWithController={false}
        ariaLabel="EterX active agent face"
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={`label-${ displayLabel }`}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -4 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="eterx-text-shimmer eterx-text-shimmer-ambient min-w-0 truncate pb-[2px] text-[13.5px] font-medium leading-[1.35] tracking-normal"
        >
          {displayLabel}
        </motion.span>
      </AnimatePresence>
    </motion.div>
  );
};


// Elapsed time hook
const useElapsed = (active: boolean) => {
  const [t, setT] = useState(0);
  const start = useRef(Date.now());
  useEffect(() => {
    if (!active) return;
    start.current = Date.now();
    const iv = setInterval(() => setT(Math.floor((Date.now() - start.current) / 1000)), THOUGHT_ELAPSED_TICK_MS);
    return () => clearInterval(iv);
  }, [active]);
  if (!active) return null;
  return formatThoughtElapsed(t) || '0s';
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
      className="flex justify-end w-full my-3 relative z-10 group/steer"
    >
      <div className="bg-[#20201F] px-4 py-3 rounded-[18px] rounded-tr-[6px] ml-auto text-[13.5px] text-[#F4F2EE] shadow-[0_4px_16px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.025)] leading-[1.56] whitespace-pre-wrap relative border border-white/[0.06] select-text flex flex-row items-end gap-3 max-w-[84%]">
        <span className="block w-full text-left break-words [word-break:break-word] [overflow-wrap:anywhere]">{log.text}</span>

        {/* CornerDownLeft arrow representing steering entry */}
        <div className="shrink-0 mb-1 select-none text-[#8F887E]">
          <CornerDownLeft className="w-[17px] h-[17px]" strokeWidth={2.25} />
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

  const title = log.title || 'Preview';
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
      content = content.replace('<head>', `<head>${ interceptor }`);
    } else {
      content = interceptor + content;
    }
    return content;
  }, [rawHtml]);

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
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
      window.open(url, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(rawHtml);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = rawHtml;
        textArea.setAttribute('readonly', '');
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy HTML:', e);
    }
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
      className="w-full my-2.5 overflow-hidden rounded-[14px] border border-white/[0.07] bg-[#151514]/80 shadow-[0_8px_26px_rgba(0,0,0,0.22)] backdrop-blur-md"
    >
      <div className="flex h-[42px] items-center justify-between px-4 border-b border-white/[0.052] bg-white/[0.018]">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex gap-1.5 shrink-0">
            <div className="w-2.5 h-2.5 rounded-full bg-[#FF5F57] opacity-80" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#FEBC2E] opacity-80" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#28C840] opacity-80" />
          </div>
          <span className="text-[12px] font-medium text-[#D4CDC3] truncate max-w-[180px] sm:max-w-[280px]">
            {title}
          </span>
        </div>

        <div className="hidden md:flex items-center p-0.5 rounded-[8px] bg-black/30 border border-white/[0.05]">
          <button
            onClick={() => setDevice('desktop')}
            className={`p-1.5 rounded-[7px] transition-colors ${ device === 'desktop' ? 'bg-[#DCD6CC] text-[#161514]' : 'text-white/40 hover:bg-white/[0.04] hover:text-white/80' }`}
            title="Desktop"
          >
            <Monitor className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setDevice('tablet')}
            className={`p-1.5 rounded-[7px] transition-colors ${ device === 'tablet' ? 'bg-[#DCD6CC] text-[#161514]' : 'text-white/40 hover:bg-white/[0.04] hover:text-white/80' }`}
            title="Tablet"
          >
            <Tablet className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setDevice('mobile')}
            className={`p-1.5 rounded-[7px] transition-colors ${ device === 'mobile' ? 'bg-[#DCD6CC] text-[#161514]' : 'text-white/40 hover:bg-white/[0.04] hover:text-white/80' }`}
            title="Mobile"
          >
            <Smartphone className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={handleCopy}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-[7px] text-[10.5px] font-semibold transition-colors ${ copied ? 'text-emerald-300 bg-emerald-500/10' : 'text-[#928B81] hover:text-[#E8E1D7] hover:bg-white/[0.04]' }`}
            title="Copy HTML"
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            <span className="hidden sm:inline">{copied ? 'COPIED' : 'COPY'}</span>
          </button>
          <button
            onClick={handleRefresh}
            className="p-1.5 rounded-[7px] text-[#928B81] hover:text-[#E8E1D7] hover:bg-white/[0.04] transition-colors"
            title="Refresh Preview"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleOpenExternal}
            className="p-1.5 rounded-[7px] text-[#928B81] hover:text-[#E8E1D7] hover:bg-white/[0.04] transition-colors"
            title="Open in new window"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setShowConsole(value => !value)}
            className={`p-1.5 rounded-[7px] transition-colors relative ${ showConsole ? 'text-emerald-300 bg-emerald-500/10' : 'text-[#928B81] hover:text-[#E8E1D7] hover:bg-white/[0.04]' }`}
            title="Toggle Iframe Console"
          >
            <Terminal className="w-3.5 h-3.5" />
            {consoleLogs.length > 0 && !showConsole && (
              <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-rose-500" />
            )}
          </button>
          <button
            onClick={() => setCollapsed(value => !value)}
            className="p-1.5 rounded-[7px] text-[#928B81] hover:text-[#E8E1D7] hover:bg-white/[0.04] transition-colors"
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${ collapsed ? '-rotate-90' : '' }`} />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className="flex flex-col bg-[#171716]"
          >
            <div className="flex h-[32px] items-center px-4 bg-black/20 border-b border-white/[0.04]">
              <div className="flex items-center gap-2 px-3 py-1 rounded-[7px] bg-black/25 border border-white/[0.04] w-full max-w-[320px] mx-auto text-[11px] font-mono text-white/40">
                <Globe className="w-3 h-3 shrink-0" />
                <span className="truncate">eterx://preview</span>
              </div>
            </div>

            <div className="p-4 flex justify-center bg-[#101010] overflow-hidden">
              <motion.div
                animate={{ width: deviceWidths[device] }}
                transition={{ type: 'spring', damping: 28, stiffness: 220 }}
                className="overflow-hidden rounded-[10px] bg-white shadow-[0_10px_28px_rgba(0,0,0,0.28)] border border-white/5 relative"
                style={{
                  height: device === 'mobile' ? '640px' : device === 'tablet' ? '540px' : '480px',
                  maxHeight: '70vh'
                }}
              >
                <iframe
                  ref={iframeRef}
                  srcDoc={wrappedHtml}
                  className="w-full h-full border-0 bg-white"
                  sandbox="allow-scripts allow-modals allow-forms"
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
                  className="flex flex-col border-t border-white/[0.07] bg-[#101010] font-mono text-[11.5px] overflow-hidden"
                >
                  <div className="flex h-8 shrink-0 items-center justify-between px-4 bg-white/[0.018] border-b border-white/[0.04]">
                    <div className="flex items-center gap-1.5 font-semibold text-white/50">
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
                        className={`flex gap-2 px-2 py-0.5 rounded ${ log.type === 'error' ? 'bg-red-500/5 text-red-400' : log.type === 'warn' ? 'bg-amber-500/5 text-amber-400' : 'text-zinc-300' }`}
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


export const ThinkingProcess = ({ logs, liveLogs = [], isThinking, isLast, showLiveIndicator = false, onOpenAgentTeam, isSubAgentTab = false }: { logs: any[], liveLogs?: any[], isThinking: boolean, isLast: boolean, showLiveIndicator?: boolean, onOpenAgentTeam?: (agentName?: string) => void, isSubAgentTab?: boolean }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const NOISE_PATTERN = /reconnect|retrying|stalled|stream interrupted|model error|fallback|cancelled/i;
  const isFlowLog = (l: any) =>
    ['thought_stream', 'work_note', 'command', 'exploration', 'file_edit', 'progress', 'browser', 'safety_warning', 'communication', 'sub_agent_answer', 'sub_agent_result', 'sub_agent_spawn', 'sub_agent_action', 'sub_agent_complete', 'sub_agent_error', 'inter_agent_comm', 'file_preview', 'console_output', 'ask_user', 'tool_result_preview'].includes(l.type) &&
    !(['progress', 'command', 'exploration'].includes(l.type) && /analyz(?:e|ing) task complexity/i.test(String(l.text || ''))) &&
    !(l.type === 'progress' && NOISE_PATTERN.test(String(l.text || ''))) &&
    // Filter out spawning announcement commands that have spawnedAgents (shown separately as agent cards)
    !(l.spawnedAgents && Array.isArray(l.spawnedAgents) && l.spawnedAgents.length > 0 && l.type === 'command');
  const flowLogs = logs.filter(isFlowLog);
  const liveFlowLogs = liveLogs.filter(isFlowLog);
  const timelineLogs = [...flowLogs, ...liveFlowLogs];
  const statusLogs = timelineLogs;
  const segs: any[] = []; let aBuf: any[] = []; let aBufFirstIdx = -1;
  const SPEC = new Set(['file_preview', 'console_output', 'sub_agent_answer', 'sub_agent_result', 'sub_agent_spawn', 'sub_agent_action', 'sub_agent_complete', 'sub_agent_error', 'inter_agent_comm', 'safety_warning', 'tool_result_preview']);
  const flush = (idx: number) => {
    if (aBuf.length > 0) {
      const unique: any[] = [];
      aBuf.forEach((log, i) => {
        if (i > 0) {
          const prev = unique[unique.length - 1];
          const logEventId = getStableActionEventId(log);
          const prevEventId = getStableActionEventId(prev);
          const isSameEvent = logEventId && prevEventId
            ? logEventId === prevEventId
            : getActionLookupIdentity(log) === getActionLookupIdentity(prev);
          if (isSameEvent) {
            unique[unique.length - 1] = {
              ...prev,
              ...log,
              occurrenceCount: Math.max(1, Number(prev.occurrenceCount || 1)) + Math.max(1, Number(log.occurrenceCount || 1)),
            };
            return;
          }
        }
        unique.push({ ...log, occurrenceCount: Math.max(1, Number(log.occurrenceCount || 1)) });
      });
      segs.push({ kind: 'action_group', logs: unique, firstIdx: aBufFirstIdx === -1 ? idx : aBufFirstIdx, lastIdx: idx });
      aBuf = [];
      aBufFirstIdx = -1;
    }
  };
  const pushActionLog = (log: any, idx: number) => {
    if (aBuf.length === 0) aBufFirstIdx = idx;
    aBuf.push(log);
  };
  // Build set of agent names already covered by team-spawn events so individual
  // spawn logs for those same agents are not rendered a second time.
  const teamSpawnedNames = new Set<string>();
  timelineLogs.forEach((log: any) => {
    if (log.type === 'sub_agent_spawn' && Array.isArray(log.spawnedAgents) && log.spawnedAgents.length > 1) {
      const details = log.agentDetails || log.spawnedAgents || [];
      const names: string[] = Array.isArray(details)
        ? details.map((a: any) => typeof a === 'string' ? a : a.name).filter(Boolean)
        : [];
      names.forEach(n => teamSpawnedNames.add(String(n).toLowerCase().trim()));
    }
  });

  timelineLogs.forEach((log, idx) => {
    if (log.type === 'thought_stream') {
      if (shouldRenderThoughtSegment(log, timelineLogs, idx)) {
        flush(idx - 1);
        segs.push({ kind: 'thought', log, idx });
      }
    }
    else if (log.type === 'work_note') {
      // Skip streaming-cancelled placeholders that were never replaced by a final note
      if (log._streamingCancelled) { /* intentionally omitted */ }
      else { flush(idx - 1); segs.push({ kind: 'note', log, idx }); }
    }

    else if (log.type === 'safety_warning') { flush(idx - 1); segs.push({ kind: 'safety', log, idx }); }
    else if (log.type === 'steering_received') { flush(idx - 1); segs.push({ kind: 'steering', log, idx }); }
    else if (log.type === 'sub_agent_answer' || log.type === 'sub_agent_result') { /* hidden */ }
    else if (log.type === 'sub_agent_complete') {
      if (isSubAgentTab) {
        flush(idx - 1);
        segs.push({ kind: 'subagent_complete', log, idx });
      }
    }
    else if (log.type === 'sub_agent_spawn') {
      // Skip individual single-agent spawn events whose name was already covered by a team spawn
      const singleName = String(log.agentName || log.subAgent || '').toLowerCase().trim();
      const isTeamEvent = Array.isArray(log.spawnedAgents) && log.spawnedAgents.length > 1;
      const isDuplicate = !isTeamEvent && singleName && teamSpawnedNames.has(singleName);
      if (!isDuplicate) {
        flush(idx - 1);
        segs.push({ kind: 'subagent_spawn', log, idx });
      }
    }
    else if (log.type === 'sub_agent_error') {
      if (isSubAgentTab) {
        flush(idx - 1);
        segs.push({ kind: 'subagent_error', log, idx });
      }
    }
    else if (log.type === 'sub_agent_action') {
      if (isSubAgentTab) {
        pushActionLog(log, idx);
      }
    }
    else if (log.type === 'inter_agent_comm') {
      if (isSubAgentTab) {
        flush(idx - 1);
        segs.push({ kind: 'comm', log, idx });
      }
    }
    else if (log.type === 'ask_user') { flush(idx - 1); segs.push({ kind: 'ask_user', log, idx }); }
    else if (log.type === 'console_output') {
      const commandSnippet = String(log.command || '').trim().substring(0, 20);
      const hasCommandOwner = Boolean(commandSnippet) && timelineLogs
        .slice(0, idx)
        .some((candidate: any) =>
          candidate?.type === 'command' &&
          getTerminalCommandText(candidate, undefined, String(candidate.secondary || '')).includes(commandSnippet)
        );
      if (!hasCommandOwner) {
        flush(idx - 1);
        segs.push({ kind: 'console', log, idx });
      }
    }
    else if (SPEC.has(log.type)) { flush(idx - 1); }
    else { pushActionLog(log, idx); }
  });
  flush(timelineLogs.length - 1);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Only auto-scroll if user hasn't scrolled up manually
    const chatContainer = document.getElementById('chat-container');
    if (!chatContainer) return;
    const distFromBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
    if (isThinking && distFromBottom <= 80) {
      const frame = window.requestAnimationFrame(() => {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [segs.length, isThinking]);
  return (
    <div ref={containerRef} className="eterx-thinking-process-stack w-full flex flex-col gap-1 py-0">
      {segs.map((seg, i) => {
        const nextSeg = segs[i + 1];
        const prevSeg = segs[i - 1];
        const phaseIsLastVisible = i === segs.length - 1 || (seg.kind === 'note' && nextSeg?.kind === 'action_group' && i + 1 === segs.length - 1);
        const phaseIsActive = isThinking && isLast && phaseIsLastVisible;

        if (seg.kind === 'thought') return <ProfessionalThought key={`t-${ seg.idx }`} text={seg.log.text} isLatest={isLast && i === segs.length - 1} isThinking={isThinking} startedAt={seg.log.startTime} updatedAt={seg.log.endTime} />;
        if (seg.kind === 'note' && nextSeg?.kind === 'action_group') {
          const firstIdx = nextSeg.firstIdx ?? nextSeg.lastIdx ?? i;
          const groupKey = `phase-g-${ firstIdx }-${ getActionIdentity(nextSeg.logs[0], firstIdx) }`;
          return (
            <motion.div
              key={`phase-${ seg.idx }-${ groupKey }`}
              layout={false}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.14, ease: 'easeOut' }}
              className="eterx-phase-block w-full"
            >
              <WorkNoteBlock text={seg.log.text} isActive={phaseIsActive} />
              <div className="mt-1">
                <CollapsibleActionGroup
                  logs={nextSeg.logs}
                  isActiveGroup={phaseIsActive}
                  isLast={isLast}
                  allLogs={timelineLogs}
                />
              </div>
            </motion.div>
          );
        }
        if (seg.kind === 'note') return <WorkNoteBlock key={`n-${ seg.idx }`} text={seg.log.text} isActive={isThinking && isLast && i === segs.length - 1} />;
        if (seg.kind === 'safety') return <SafetyBanner key={`sf-${ seg.idx }`} log={seg.log} />;
        if (seg.kind === 'steering') return <SteeringCard key={`steer-${ seg.idx }`} log={seg.log} />;
        if (seg.kind === 'subagent') return null;
        if (seg.kind === 'comm') {
          return isSubAgentTab ? <InterAgentCommCard key={`comm-${ seg.idx }`} log={seg.log} onOpenAgentTeam={onOpenAgentTeam} /> : null;
        }
        if (seg.kind === 'subagent_action') return null;
        if (seg.kind === 'subagent_spawn') return <AgentCreatedCard key={`ss-${ seg.idx }`} log={seg.log} onOpenAgentTeam={onOpenAgentTeam} />;
        if (seg.kind === 'subagent_complete') {
          return isSubAgentTab ? <SubAgentCard key={`sc-${ seg.idx }`} log={seg.log} onOpenAgentTeam={onOpenAgentTeam} /> : null;
        }
        if (seg.kind === 'subagent_error') {
          return isSubAgentTab ? <SubAgentErrorCard key={`se-${ seg.idx }`} log={seg.log} /> : null;
        }
        if (seg.kind === 'ask_user') return <AskUserTimelineCard key={`ask-tl-${ seg.idx }`} log={seg.log} isLive={isThinking && isLast && i === segs.length - 1 && !seg.log.answeredWith} />;
        if (seg.kind === 'console') return <TerminalTraceCard key={`console-${ seg.idx }`} log={seg.log} preview={seg.log} isLiveChip={isThinking && isLast && i === segs.length - 1} />;
        if (seg.kind === 'action_group' && prevSeg?.kind === 'note') return null;

        const firstIdx = seg.firstIdx ?? seg.lastIdx ?? i;
        const groupKey = `g-${ firstIdx }-${ getActionIdentity(seg.logs[0], firstIdx) }`;
        return <CollapsibleActionGroup key={groupKey} logs={seg.logs} isActiveGroup={isThinking && isLast && i === segs.length - 1} isLast={isLast} allLogs={timelineLogs} />;
      })}
      <AnimatePresence>
        {showLiveIndicator && isThinking && isLast && <LiveWorkingIndicator key="live-working" logs={statusLogs} />}
      </AnimatePresence>
    </div>
  );
};
