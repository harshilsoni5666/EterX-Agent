import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import { useFilePanelActions } from '../../contexts/FilePanelContext';
// Only the Lucide icons actually rendered in JSX (not icon-map/TOOL_META)
import {
  ChevronRight, ChevronDown, Monitor, ShieldHalf, Copy, CheckCircle, Maximize2, CornerDownLeft,
  RefreshCw, ExternalLink, Check, Globe, Smartphone, Tablet, Terminal, ArrowRight,
  Search, FileText, Hash, FolderOpen, Folder, AlertTriangle, MessageSquare,
  Key, Clock, Timer
} from 'lucide-react';
// @ts-ignore
import ReactMarkdown from 'react-markdown';
import { markdownComponents, normalizeMarkdownForRendering, remarkPlugins, rehypePlugins, WebsiteLink } from './markdown-renderer';
import { LocalFileIcon, LocalFileLinkChip, decodeLocalFileHref, isLocalFilePath } from './local-file-link';
import { AGENT_ICONS, resolveAgentIcon, AgentAssetIcon, SubAgentIdentityIcon, ConnectorIcon, getConnectorId, isConnectorTrace } from './agent-icons';
import { Shimmer } from '../ui/shimmer';
import { safeCopyTextToClipboard } from '../ui/copy-button';
import { isThoughtStreamOpen, shouldRenderThoughtStream } from '../../lib/thought-stream-lifecycle';
import { shouldRenderProgressTrace } from '../../lib/chat-feed-lifecycle';
import { getToolDisplayLabel, normalizeToolTraceName, normalizeToolTraceText } from '../../lib/agent/tool-trace';
import { isTerminalTraceStreaming } from '../../lib/terminal-lifecycle';

type SubAgentAssetIndexes = Record<string, number>;

const getSubAgentAssetIndex = (assetIndexes: SubAgentAssetIndexes | undefined, name?: string) => {
  const cleanName = String(name || '').trim();
  if (!assetIndexes || !cleanName) return undefined;
  return assetIndexes[cleanName] ?? assetIndexes[cleanName.toLowerCase()];
};


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

const markdownRevealChunkPattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~|\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$)/g;
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
  const lastInlineMathOpen = value.lastIndexOf('\\(');
  const lastInlineMathClose = value.lastIndexOf('\\)');
  if (lastInlineMathOpen > lastInlineMathClose) return true;

  const sanitized = value.replace(/\\./g, '');
  const backticks = sanitized.match(/`/g)?.length || 0;
  if (backticks % 2 === 1) return true;

  const dollars = sanitized.match(/\$/g)?.length || 0;
  if (dollars % 2 === 1) return true;

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

    if (/^\${1,2}/.test(part)) {
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
        if (!closed) break;
        chunks.push(block);
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
        if (!closed) break;
        chunks.push(block);
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
  const chunksRef = useRef(chunks);
  const effectiveSpeedRef = useRef(effectiveSpeed);
  chunksRef.current = chunks;
  effectiveSpeedRef.current = effectiveSpeed;

  useEffect(() => {
    if (!enabled || reducedMotion) {
      previousValueRef.current = value;
      setVisibleCount(chunks.length);
      return;
    }

    setVisibleCount((current) => {
      const previousValue = previousValueRef.current;
      previousValueRef.current = value;
      // If new value is a continuation (starts with previous), keep existing progress
      if (!previousValue || value.startsWith(previousValue)) return Math.min(current, chunks.length);
      // Genuinely new/different content — but never jump backward for completed answers
      // Only reset to 0 if current > chunks.length (chunks shrank due to edit)
      if (current > chunks.length) return chunks.length;
      return current;
    });
  }, [chunks.length, enabled, reducedMotion, value]);

  useEffect(() => {
    if (!enabled || reducedMotion) return;

    // Keep one stable clock while tokens arrive. Recreating a timeout for every
    // server chunk can continuously postpone the reveal on a fast stream.
    const interval = window.setInterval(() => {
      setVisibleCount(current => {
        const latestChunks = chunksRef.current;
        const total = latestChunks.length;
        if (current >= total) return current;

        const currentChunk = latestChunks[current] || '';
        const currentSpeed = effectiveSpeedRef.current;
        const backlog = total - current;
        const durationBurst = Math.ceil((total * currentSpeed.baseDelayMs) / Math.max(currentSpeed.maxDurationMs, 1));
        const catchUpBurst = Math.ceil(backlog / 5);
        const isStructuralChunk = isTableLine(currentChunk) || currentChunk.includes('\n');
        const burst = isStructuralChunk
          ? 1
          : Math.max(currentSpeed.burst, durationBurst, catchUpBurst);
        return Math.min(total, current + burst);
      });
    // 20 fps is visually continuous for progressive text and cuts React
    // markdown reconciliation by more than a third versus the old 31 fps
    // timer. Incoming content is still accepted immediately.
    }, 50);

    return () => window.clearInterval(interval);
  }, [enabled, reducedMotion]);

  const visibleText = useMemo(() => chunks.slice(0, visibleCount).join(''), [chunks, visibleCount]);

  return {
    text: enabled && !reducedMotion ? visibleText : value,
    isRevealing: enabled && !reducedMotion && visibleCount < chunks.length,
  };
};


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
  'Reading files': 'Read',
  'Scanning directory': 'Listed',
  'Listing directory': 'Listed',
  'Finding files': 'Found',
  'Outlining file': 'Outlined',
  'Editing file': 'Edited',
  'Editing files': 'Edited',
  'Creating file': 'Created',
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
  'Planning agent work': 'Planned agent work',
  'Starting agents': 'Started agents',
  'Checking agent status': 'Checked agent status',
  'Collecting agent results': 'Collected agent results',
  'Clearing agent history': 'Cleared agent history',
  'Running agent consensus': 'Ran agent consensus',
  'Running agent debate': 'Ran agent debate',
  'Running specialist agent': 'Ran specialist agent',
  'Pausing agent': 'Paused agent',
  'Resuming agent': 'Resumed agent',
  'Closing agent': 'Closed agent',
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

  // Connector traces can contain words such as "run", "server", or
  // "request" in their action/arguments. They are external-service activity,
  // not shell activity, and must stay on the connector visual path.
  if (isConnectorTrace(log)) return false;
  if (log?.type === 'file_edit' || preview?.type === 'file_preview') return false;
  if (iconCategory === 'terminal') return true;
  if (preview?.type === 'console_output') return true;
  if (log?.type === 'console_output') return true;
  const toolName = normalizeToolTraceName(log?.tool || log?.name);
  if (['workspace_run_command', 'terminal_access'].includes(toolName)) return true;
  return TERMINAL_ACTION_PATTERN.test(combined);
};

const displayedTextRegistry = new Map<string, number>();

// No typewriter — show full text immediately for zero-latency reading
const useTypewriter = (targetText: string, _isActive: boolean) => {
  return { displayedText: targetText };
};

// Live-second counter. Prefer trace timestamps so a finished thought never keeps counting.
const asTimestamp = (value: unknown) => {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  let timestamp = raw < 10_000_000_000 ? raw * 1000 : raw;
  while (timestamp > 10_000_000_000_000) timestamp /= 1000;
  const now = Date.now();
  if (timestamp < Date.UTC(2020, 0, 1) || timestamp > now + 60_000) return null;
  return timestamp;
};

const THOUGHT_ELAPSED_TICK_MS = 1000;

const isLiveThoughtFresh = (log: any) => {
  if (!log || (log.type !== 'thought_stream' && log.type !== 'work_note')) return false;
  if (log.type === 'thought_stream') return isThoughtStreamOpen(log);
  if (log.isStreaming === false || log.isLiveTyping === false || log.streamState === 'closed') return false;
  return log.isStreaming === true || log.isLiveTyping === true || log.streamState === 'open';
};

const useThinkTimer = (isLive: boolean, startedAt?: number, updatedAt?: number) => {
  const [secs, setSecs] = useState(0);
  const fallbackStartRef = useRef<number | null>(null);
  const latestUpdateRef = useRef<number | null>(null);
  const frozenRef = useRef<number | null>(null);
  const lastElapsedRef = useRef(0);
  const startMs = asTimestamp(startedAt);
  const updateMs = asTimestamp(updatedAt);

  useEffect(() => {
    latestUpdateRef.current = updateMs;
  }, [updateMs]);

  useEffect(() => {
    if (startMs !== null) {
      fallbackStartRef.current = fallbackStartRef.current === null
        ? startMs
        : Math.min(fallbackStartRef.current, startMs);
    }

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
      const updateElapsed = () => {
        const elapsed = Math.max(lastElapsedRef.current, elapsedFrom(Date.now()));
        lastElapsedRef.current = elapsed;
        setSecs(elapsed);
      };
      updateElapsed();
      const id = setInterval(() => {
        updateElapsed();
      }, THOUGHT_ELAPSED_TICK_MS);
      return () => clearInterval(id);
    }

    const measured = (startMs !== null || fallbackStartRef.current !== null) && latestUpdateRef.current !== null
      ? frozenElapsedFrom(latestUpdateRef.current)
      : fallbackStartRef.current !== null
        ? frozenElapsedFrom(Date.now())
        : 0;
    // A late/fallback close event must never make a counter jump backwards
    // (for example, "Thinking... 3s" becoming "Thought for 1s").
    const frozen = Math.max(measured, lastElapsedRef.current);
    frozenRef.current = frozen;
    lastElapsedRef.current = frozen;
    fallbackStartRef.current = null;
    setSecs(frozen);
  }, [isLive, startMs]);

  // Always return the frozen value if available (never re-tick after done)
  return frozenRef.current !== null ? frozenRef.current : secs;
};

const formatThoughtElapsed = (seconds: number) => {
  if (seconds <= 0) return '';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${ minutes }m ${ rest }s` : `${ rest }s`;
};

export const ProfessionalThought = React.memo(({ text, isLatest, isThinking, variant = 'thought', suffix, startedAt, updatedAt, reveal = false }: { text: string, isLatest: boolean, isThinking: boolean, variant?: 'thought' | 'answer' | 'note', suffix?: React.ReactNode, startedAt?: number, updatedAt?: number, reveal?: boolean }) => {
  const [open, setOpen] = useState(false);
  const [thoughtCanScroll, setThoughtCanScroll] = useState(false);
  const thoughtScrollRef = useRef<HTMLDivElement>(null);
  const thoughtAutoScrollRef = useRef(true);
  const requestedLive = isLatest && isThinking;
  const isLive = requestedLive;
  const secs = useThinkTimer(isLive, startedAt, updatedAt);

  const renderText = useMemo(() => {
    if (!text) return '';
    let f = text.replace(/!\[.*?\]\(\/absolute.*?\.png\)/gi, '');
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
    thoughtAutoScrollRef.current = isLive;
    const frame = window.requestAnimationFrame(() => {
      syncThoughtOverflow();
      const el = thoughtScrollRef.current;
      if (!el) return;
      if (isLive) scrollThoughtToBottom();
      else el.scrollTop = 0;
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
  const professionalMarkdownComponents = useMemo(() => ({
    ...markdownComponents,
    p: ({ node, ...props }: any) => <p className="eterx-answer-paragraph mb-2 last:mb-0 break-words leading-[1.62] tracking-normal" {...props} />,
    ul: ({ node, ...props }: any) => <ul className="eterx-answer-list my-2.5 list-disc space-y-1.5 pl-5" {...props} />,
    ol: ({ node, ...props }: any) => <ol className="eterx-answer-list my-2.5 list-decimal space-y-1.5 pl-5" {...props} />,
    li: ({ node, ...props }: any) => <li className="eterx-answer-list-item pl-1 leading-[1.58]" {...props} />,
    strong: ({ node, ...props }: any) => <strong className="eterx-answer-strong font-bold" {...props} />,
    em: ({ node, ...props }: any) => <em className="eterx-answer-em italic" {...props} />,
    a: ({ node, href, children, ...props }: any) => {
      const localPath = decodeLocalFileHref(href);
      // File references are inline answer content. Always use the compact
      // chip so a long filename cannot create a 36px line box or overlap the
      // surrounding sentence/list item.
      if (localPath) return <LocalFileLinkChip filePath={localPath} label={getReactNodeText(children)} compact />;
      return <WebsiteLink href={href} {...props}>{children}</WebsiteLink>;
    },
  }), [isNote]);
  const renderProfessionalMarkdown = (value: string) => (
    <>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={professionalMarkdownComponents}
      >
        {value}
      </ReactMarkdown>
    </>
  );

  if (variant === 'thought') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className="professional-thought eterx-thought-block w-full"
      >
        <div className={`eterx-thought-card overflow-hidden rounded-[10px] border bg-[#151514]/42 shadow-none transition-colors ${ open ? 'border-white/[0.11]' : 'border-white/[0.06] hover:border-white/[0.095]' }`}>
          <button
            type="button"
            onClick={() => setOpen(value => !value)}
            aria-expanded={open}
            className="eterx-thought-toggle flex min-h-[30px] w-full items-center gap-2 px-2.5 py-0.5 text-left transition-colors hover:bg-white/[0.024] group"
          >
            <Shimmer
              active={isLive}
              durationMs={2600}
              angle={12}
              spread="2.4ch"
              baseColor="var(--eterx-ui-working-text)"
              color="var(--eterx-ui-working-highlight)"
              surfaceColor="var(--background)"
              textColor="var(--eterx-ui-working-text)"
              className="eterx-thinking-shimmer flex-1 text-[15.5px] font-normal tracking-[0.005em] text-[var(--eterx-ui-working-text)]"
            >
              {thinkLabel}
            </Shimmer>
            <ChevronRight className={`h-3.5 w-3.5 text-[#625C54] group-hover:text-[#A8A198] transition-all ${ open ? 'rotate-90' : '' }`} />
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
                <div ref={thoughtScrollRef} onScroll={handleThoughtScroll} className={`eterx-thought-expanded ${ thoughtCanScroll ? 'eterx-scrollbar overflow-y-auto' : 'overflow-y-hidden' } pl-[42px] pr-3 pb-3 pt-0.5 text-[12.5px] leading-[1.5] text-[#D5D3CE]`} style={{ maxHeight: 'min(46vh, 420px)' }}>
                  <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={{
                    ...markdownComponents,
                    p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0 break-words leading-[1.54] text-[#D5D3CE]" {...props} />,
                    ol: ({ node, ...props }: any) => <ol className="my-2 list-decimal space-y-1.5 pl-5 text-[#D5D3CE]" {...props} />,
                    ul: ({ node, ...props }: any) => <ul className="my-2 list-disc space-y-1.5 pl-5 text-[#D5D3CE]" {...props} />,
                    li: ({ node, ...props }: any) => <li className="pl-1 leading-[1.52] marker:text-[#827C73]" {...props} />,
                    strong: ({ node, ...props }: any) => <strong className="font-bold text-[#F3F2EF]" {...props} />,
                    a: ({ node, href, children, ...props }: any) => {
                      const localPath = decodeLocalFileHref(href);
                      if (localPath) return <LocalFileLinkChip filePath={localPath} label={getReactNodeText(children)} compact />;
                      return <WebsiteLink href={href} {...props}>{children}</WebsiteLink>;
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
    <div
      className={`professional-thought eterx-professional-thought relative w-full max-w-full font-sans font-normal selection:bg-[#D98B6A]/20 select-text tracking-normal ${ progressive.isRevealing ? 'eterx-reveal-active' : '' } ${ isNote ? 'eterx-professional-note text-[13.5px] leading-[1.56] text-[#F2F0EC]' : 'eterx-professional-answer text-[13.5px] leading-[1.56] text-[#F2F0EC]' }`}
    >
      {revealEnabled ? (
        <div className="eterx-progressive-markdown eterx-progressive-markdown--direct">
          {renderProfessionalMarkdown(markdownText)}
        </div>
      ) : (
        renderProfessionalMarkdown(markdownText)
      )}
      {suffix}
    </div>
  );
});

// VS Code GitHub Dark — clean single-pass syntax highlighter
const ProxyStatusDivider = ({ text, isActive = false }: { text: string; isActive?: boolean }) => {
  const note = useMemo(() => String(text || '').trim(), [text]);
  if (!note) return null;
  const interventionMatch = note.match(/^(Proxy intervention set to\s+)(minimal|normal|high)([.!]?)$/i);

  return (
    <div
      className={`eterx-proxy-status-divider w-full px-1 py-1.5 ${ isActive ? 'eterx-proxy-status-divider-active' : '' }`}
      role="status"
      aria-live={isActive ? 'polite' : undefined}
    >
      <span className="eterx-proxy-status-divider-line" aria-hidden="true" />
      <span className="eterx-proxy-status-divider-label">
        <span className="min-w-0 break-words text-center">
          {interventionMatch ? (
            <>
              {interventionMatch[1]}
              <span className={`eterx-proxy-intervention-level eterx-proxy-intervention-level-${ interventionMatch[2].toLowerCase() }`}>
                {interventionMatch[2]}
              </span>
              {interventionMatch[3]}
            </>
          ) : note}
        </span>
      </span>
      <span className="eterx-proxy-status-divider-line" aria-hidden="true" />
    </div>
  );
};

const WorkNoteBlock = ({ text, isActive = false, isProxyStatus = false }: { text: string; isActive?: boolean; isProxyStatus?: boolean }) => {
  const note = useMemo(() => String(text || '').trim(), [text]);
  if (!note) return null;

  if (isProxyStatus) return <ProxyStatusDivider text={note} isActive={isActive} />;

  return (
    <div className="eterx-work-note-block w-full px-0 py-0">
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
    if (cmt) out += `<span class="eterx-syntax-comment">${ full }</span>`;
    else if (m[2]) out += `<span class="eterx-syntax-string">${ full }</span>`;
    else if (num) out += `<span class="eterx-syntax-number">${ full }</span>`;
    else if (pascal) out += `<span class="eterx-syntax-type">${ full }</span>`;
    else if (ident) {
      if (KW_FLOW.has(ident)) out += `<span class="eterx-syntax-keyword">${ full }</span>`;
      else if (KW_DECL.has(ident)) out += `<span class="eterx-syntax-keyword eterx-syntax-declaration">${ full }</span>`;
      else if (KW_VAL.has(ident)) out += `<span class="eterx-syntax-value">${ full }</span>`;
      else if (KW_THIS.has(ident)) out += `<span class="eterx-syntax-value">${ full }</span>`;
      else out += e.slice(last).trimStart().startsWith('(') ? `<span class="eterx-syntax-function">${ full }</span>` : full;
    }
    else if (flag) out += `<span class="eterx-syntax-flag">${ full }</span>`;
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
    const ok = await safeCopyTextToClipboard(content || '');
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <button
      type="button"
      onClick={handle}
      aria-label={copied ? 'Copied' : label}
      className="eterx-action-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-white/[0.06] bg-white/[0.028] text-[#9A9389] transition-colors hover:border-white/[0.10] hover:bg-white/[0.05] hover:text-[#DAD4CA]"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
};

// Converts ANSI escape codes to styled HTML spans
const ansiToHtml = (text: string): string => {
  if (!text) return '';
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ANSI_COLORS: Record<string, string> = {
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
  let bold = false;
  let color = '';
  let spanOpen = false;
  const converted = esc.replace(/\x1B\[([0-9;]*)m/g, (_, params) => {
    const codes = String(params || '0').split(';');
    for (const code of codes) {
      if (code === '0') {
        bold = false;
        color = '';
      } else if (code === '1') {
        bold = true;
      } else if (code === '22') {
        bold = false;
      } else if (code === '39') {
        color = '';
      } else if (ANSI_COLORS[code]) {
        color = ANSI_COLORS[code];
      }
    }

    const close = spanOpen ? '</span>' : '';
    const style = [bold ? 'font-weight:700' : '', color].filter(Boolean).join(';');
    spanOpen = Boolean(style);
    return `${ close }${ style ? `<span style="${ style }">` : '' }`;
  });
  return `${ converted }${ spanOpen ? '</span>' : '' }`;
};

const applyTerminalBackspaces = (value: string): string => value
  .split('\n')
  .map(line => {
    if (!line.includes('\b')) return line;
    const characters: string[] = [];
    for (const character of line) {
      if (character === '\b') characters.pop();
      else characters.push(character);
    }
    return characters.join('');
  })
  .join('\n');

const normalizeTerminalOutputForDisplay = (value: unknown): string => {
  let output = applyTerminalBackspaces(String(value ?? '').replace(/\r\n/g, '\n'))
    // OSC/DCS sequences control terminal windows and links, not transcript
    // content. Remove them consistently across PowerShell, zsh, and bash.
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    .replace(/\x1BP[\s\S]*?\x1B\\/g, '')
    // Keep SGR color codes for ansiToHtml; discard cursor/erase controls that
    // otherwise render as visible garbage in a browser.
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, sequence => sequence.endsWith('m') ? sequence : '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g, '');

  // CLI progress reporters rewrite one physical line with carriage returns.
  // The transcript should show the newest state once, not every overwritten
  // frame as another line or an embedded control character.
  output = output
    .split('\n')
    .map(line => line.includes('\r') ? line.split('\r').slice(-1)[0] || '' : line)
    .join('\n');

  return output;
};

const InlineConsole = ({ command, content, exitCode, durationMs, cwd, shell, pid, flush = false }: { command: string, content: string, exitCode?: number, durationMs?: number, cwd?: string, shell?: string, pid?: number, flush?: boolean }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowOutputRef = useRef(exitCode === undefined);
  const previousContentLengthRef = useRef(0);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    const nextLength = (content || '').length;
    const grew = nextLength > previousContentLengthRef.current;
    previousContentLengthRef.current = nextLength;
    if (!el) return;
    const frameId = window.requestAnimationFrame(() => {
      if (exitCode === undefined && grew && shouldFollowOutputRef.current) {
        el.scrollTop = el.scrollHeight;
      }
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      if (nearBottom !== atBottomRef.current) {
        atBottomRef.current = nearBottom;
        setAtBottom(nearBottom);
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
  const displayContent = useMemo(() => normalizeTerminalOutputForDisplay(content), [content]);
  const renderedOutput = useMemo(() => ansiToHtml(displayContent), [displayContent]);
  const hasManyLines = useMemo(() => {
    let newlineCount = 0;
    for (let index = 0; index < displayContent.length && newlineCount < 8; index += 1) {
      if (displayContent.charCodeAt(index) === 10) newlineCount += 1;
    }
    return newlineCount >= 8;
  }, [displayContent]);
  const isRunning = exitCode === undefined;
  const success = exitCode === 0 || isRunning;
  const shellLabel = String(shell || '').split(/[\\/]/).pop()?.replace(/\.exe$/i, '') || '';
  const executionLabel = [shellLabel, cwd, isRunning && pid ? `PID ${ pid }` : ''].filter(Boolean).join(' · ');

  const consolePanel = (
    <div className={`eterx-terminal-console flex flex-col font-mono text-[#D8D1C8] ${ flush ? 'border-t border-white/[0.052] bg-transparent rounded-none' : 'overflow-hidden rounded-[10px] border border-white/[0.07] bg-[#141413]/80 shadow-none' }`}>
      {/* Liquid Glass Command Container with Floating Overlapping Copy Button */}
      <div className="eterx-terminal-console-command-card relative mx-2 mt-1.5 mb-1 overflow-hidden rounded-[8px] border border-white/[0.065] bg-white/[0.022] shadow-none p-2">
        {/* Floating Overlapping Copy Button */}
        <div className="absolute right-1.5 top-1.5 z-10">
          <IconCopyButton content={command} label="Copy command" />
        </div>
        {/* Full width command block till end right of container, max-h-[84px], INVISIBLE scrollbar */}
        <div className="eterx-scrollbar-hidden max-h-[68px] w-full overflow-y-auto pr-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="eterx-terminal-console-command flex items-start gap-1.5 text-[#E4DDD3]">
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11.5px] font-medium leading-[1.4] text-[#F0EAE0] select-all">{command}</span>
          </div>
        </div>
      </div>

      {/* Output scroll body */}
      <div className="relative min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="eterx-terminal-console-output eterx-scrollbar max-h-[220px] min-h-[56px] overflow-auto px-2.5 py-2 text-[11.5px] leading-[1.48] text-[#CDC5BB]"
        >
          <div className="min-w-0 pr-1">
            <div className="eterx-terminal-console-body whitespace-pre-wrap break-words text-[#CDC5BB]">
              {displayContent
                ? <span dangerouslySetInnerHTML={{ __html: renderedOutput }} />
                : <span className="text-[#8D867C] italic">{isRunning ? 'Waiting for output...' : '(no output)'}</span>
              }
            </div>
          </div>
        </div>
        {!atBottom && hasManyLines && (
          <button type="button" aria-label="Scroll output to bottom" onClick={(e) => { e.stopPropagation(); const el = scrollRef.current; if (!el) return; shouldFollowOutputRef.current = true; el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }} className="absolute bottom-2 right-2 flex h-6 w-6 items-center justify-center rounded-full border border-white/[0.08] bg-[#2A2A29]/95 text-[#BDB5AA] shadow-none transition-colors hover:bg-[#333331] hover:text-[#F0EAE0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20">
            <ChevronDown className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Terminal footer status bar */}
      <div className="eterx-terminal-console-footer flex items-center justify-between gap-2 border-t border-white/[0.045] bg-white/[0.012] px-2.5 py-1 text-[10.5px] font-medium text-[#A9A196]">
        <span className="min-w-0 truncate text-[#777168]" title={executionLabel || undefined}>{executionLabel}</span>
        <div className="flex items-center gap-2.5">
          {durationMs !== undefined && durationMs > 0 && (
            <span className="text-[#807970]">{durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`}</span>
          )}
          <span className={`inline-flex items-center gap-1.5 ${ success ? 'text-[#BDB8AF]' : 'text-red-300' }`}>
            {isRunning ? (
              <Terminal className="h-3.5 w-3.5 text-[#67C58A]" />
            ) : success ? (
              <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <CornerDownLeft className="h-3.5 w-3.5 text-red-300" />
            )}
            {isRunning ? 'Running' : success ? 'Success' : `Exit ${ exitCode }`}
          </span>
        </div>
      </div>
    </div>
  );
  return <div>{consolePanel}</div>;
};

// ─── File operation summary for workspace_edit_file results ──────────────────
type FileChangeDetail = {
  path: string;
  action: 'modified' | 'created' | 'deleted';
  additions?: number;
  deletions?: number;
  hunks?: number;
  diff?: string;
  diffLines?: Array<{
    type: 'added' | 'removed' | 'context' | 'unchanged';
    content: string;
    oldLine?: number;
    newLine?: number;
    isGap?: boolean;
  }>;
  readback?: string;
};

const fileDiffLines = (diff = '') => diff
  .split('\n')
  .map(line => line.startsWith('@@')
    ? { type: 'context' as const, content: line.replace(/^@@\s*|\s*@@$/g, '') || 'Next change', isGap: true }
    : {
      type: line.startsWith('+') ? 'added' as const : line.startsWith('-') ? 'removed' as const : 'unchanged' as const,
      content: /^[+\- ]/.test(line) ? line.slice(1) : line,
    });

const FileOperationSummaryPanel = ({
  filesModified = [],
  filesCreated = [],
  filesDeleted = [],
  errors = [],
  changes = [],
  rolledBack = false,
  flush = false,
}: {
  filesModified?: string[];
  filesCreated?: string[];
  filesDeleted?: string[];
  errors?: string[];
  changes?: FileChangeDetail[];
  rolledBack?: boolean;
  flush?: boolean;
}) => {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const totalFiles = filesModified.length + filesCreated.length + filesDeleted.length;
  const hasErrors = errors.length > 0;
  const success = totalFiles > 0 && !hasErrors;

  type FileEntry = { path: string; kind: 'modified' | 'created' | 'deleted'; detail?: FileChangeDetail };
  const detailByPath = new Map(changes.map(change => [change.path.replace(/\\/g, '/').toLowerCase(), change]));
  const withDetail = (filePath: string, kind: FileEntry['kind']): FileEntry => ({
    path: filePath,
    kind,
    detail: detailByPath.get(filePath.replace(/\\/g, '/').toLowerCase()),
  });
  const allFiles: FileEntry[] = [
    ...filesCreated.map(p => withDetail(p, 'created')),
    ...filesModified.map(p => withDetail(p, 'modified')),
    ...filesDeleted.map(p => withDetail(p, 'deleted')),
  ];

  const getDiffLines = (file: FileEntry) => Array.isArray(file.detail?.diffLines)
    ? file.detail.diffLines
    : file.detail?.diff
      ? fileDiffLines(file.detail.diff)
      : [];

  const toggleFile = (filePath: string) => {
    setExpandedPaths(current => {
      const next = new Set(current);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const kindStyle = {
    created: { bar: 'bg-emerald-400', verb: 'Created', text: 'text-emerald-300/80' },
    modified: { bar: 'bg-sky-400', verb: 'Edited', text: 'text-sky-300/80' },
    deleted: { bar: 'bg-red-400', verb: 'Deleted', text: 'text-red-300/80' },
  };

  if (success && allFiles.length === 1) {
    const file = allFiles[0];
    const filename = file.path.replace(/\\/g, '/').split('/').pop() || file.path;
    const diffLines = getDiffLines(file);
    if (diffLines.length > 0) {
      return (
        <InlineDiffView
          filename={filename}
          filepath={file.path}
          diffLines={diffLines}
          showExpand={false}
          flush
        />
      );
    }
    if (file.kind === 'deleted' && !file.detail?.readback) {
      return (
        <InlineMissingDiffView
          filename={filename}
          filepath={file.path}
          stats={{ added: Number(file.detail?.additions || 0), removed: Number(file.detail?.deletions || 0) }}
          flush
        />
      );
    }
    return (
      <InlineCodeView
        filename={filename}
        content={file.detail?.readback || ''}
        filepath={file.path}
        stats={{ added: Number(file.detail?.additions || 0), removed: Number(file.detail?.deletions || 0) }}
        showExpand={false}
        fetchFull
        created={file.kind === 'created'}
        flush
      />
    );
  }

  return (
    <div className={`eterx-patch-summary-panel flex flex-col overflow-hidden shadow-none ${ flush ? 'border-t border-white/[0.052] bg-transparent' : 'mx-3 mt-1.5 mb-2 rounded-[12px] border border-white/[0.07] bg-[#151514]' }`}>
      {allFiles.map((file) => {
        const style = kindStyle[file.kind];
        const pathParts = file.path.replace(/\\/g, '/').split('/');
        const name = pathParts.pop() || file.path;
        const parentPath = pathParts.slice(-3).join('/');
        const diffLines = getDiffLines(file);
        const canOpen = file.kind !== 'deleted' || diffLines.length > 0 || Boolean(file.detail?.readback);
        const isExpanded = canOpen && expandedPaths.has(file.path);
        return (
          <React.Fragment key={`${ file.kind }-${ file.path }`}>
            <button
              type="button"
              className={`group flex w-full items-stretch border-t border-white/[0.045] text-left first:border-t-0 transition-colors ${ canOpen ? 'cursor-pointer hover:bg-white/[0.025]' : 'cursor-default' } ${ isExpanded ? 'bg-white/[0.028]' : '' }`}
              onClick={() => { if (canOpen) toggleFile(file.path); }}
              aria-expanded={canOpen ? isExpanded : undefined}
              title={canOpen ? `${ isExpanded ? 'Hide' : 'Show' } ${ name }` : file.path}
            >
              <span className={`w-[2px] shrink-0 ${ style.bar }`} />
              <span className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/[0.035] text-[#A9A198] ring-1 ring-inset ring-white/[0.045]">
                  <LocalFileIcon fileName={name} size="sm" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
                  <span className="truncate text-[12px] font-medium text-[#C7DDEA]">{name}</span>
                  <span className="flex min-w-0 items-center gap-1.5 text-[9.5px]">
                    <span className={`shrink-0 ${ style.text }`}>{style.verb}</span>
                    {parentPath ? (
                      <>
                        <span className="text-[#4F4A45]">·</span>
                        <span className="truncate text-[#716B64]">{parentPath}</span>
                      </>
                    ) : null}
                  </span>
                </span>
                {file.detail && (file.detail.additions || file.detail.deletions) ? (
                  <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums">
                    <span className="text-emerald-300">+{file.detail.additions || 0}</span>
                    <span className="text-red-300">−{file.detail.deletions || 0}</span>
                  </span>
                ) : null}
                {canOpen ? (
                  <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[#716B64] transition-transform duration-150 ${ isExpanded ? 'rotate-90 text-[#C0B8AE]' : 'group-hover:text-[#9A938B]' }`} />
                ) : null}
              </span>
            </button>
            <AnimatePresence initial={false}>
              {isExpanded ? (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden border-t border-white/[0.052] bg-black/[0.08]"
                >
                  {diffLines.length > 0 ? (
                    <InlineDiffView
                      filename={name}
                      filepath={file.path}
                      diffLines={diffLines}
                      showExpand={false}
                      flush
                    />
                  ) : (
                    <InlineCodeView
                      filename={name}
                      content={file.detail?.readback || ''}
                      filepath={file.path}
                      stats={{ added: Number(file.detail?.additions || 0), removed: Number(file.detail?.deletions || 0) }}
                      showExpand={false}
                      fetchFull
                      created={file.kind === 'created'}
                      flush
                    />
                  )}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </React.Fragment>
        );
      })}
      {hasErrors && errors.map((err, i) => (
        <div key={`err-${ i }`} className="flex items-start gap-0 border-t border-white/[0.045]">
          <div className="w-[3px] self-stretch shrink-0 bg-red-500" />
          <div className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2">
            <span className="shrink-0 text-[11px] font-medium text-red-300">{rolledBack ? 'Rolled back' : 'Error'}</span>
            <span className="min-w-0 flex-1 break-words text-[11.5px] leading-[1.45] text-[#E6AAA4]">{err}</span>
          </div>
        </div>
      ))}
    </div>
  );
};


// ─── Shared card shell — defined OUTSIDE ToolResultPreview so React never remounts ───
const TrpCard = React.memo(({ icon, title, badge, children, flush = false }: {
  icon?: React.ReactNode;
  title?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  flush?: boolean;
}) => (
  <div className={`eterx-trp-card ${ flush ? 'border-t border-white/[0.052] bg-transparent rounded-none text-[#D0C8C0]' : 'mx-3 mt-1.5 mb-2 overflow-hidden rounded-[11px] border border-white/[0.07] bg-[#151514] text-[#D0C8C0] shadow-none' }`}>
    {title && (
      <div className="eterx-trp-card-header flex items-center gap-2 border-b border-white/[0.045] bg-white/[0.02] px-3.5 py-2">
        {icon && <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[#6A6460]">{icon}</span>}
        <span className="eterx-trp-card-title flex-1 text-[11.5px] font-semibold text-[#B0A9A1] tracking-[-0.01em]">{title}</span>
        {badge && <span className="shrink-0">{badge}</span>}
      </div>
    )}
    <div className={flush ? "px-3 py-2.5" : "px-3.5 py-3"}>{children}</div>
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
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={markdownComponents}
    >
      {normalizeMarkdownForRendering(content)}
    </ReactMarkdown>
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
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 text-[10px] font-medium text-[#6B9AB8] hover:text-[#94C7E0] hover:bg-white/[0.04] transition-all px-1.5 py-0.5 rounded border border-white/[0.06] shadow-none"
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
const ToolResultPreview = React.memo(({ toolName, args, result, flush = false }: { toolName: string; args: any; result: any; flush?: boolean }) => {

  // Skill guidelines are long-form documents, not scalar metadata. Rendering
  // them through the generic key/value fallback puts the whole document in a
  // two-column tile, which makes it narrow and lets it run behind the composer.
  // Keep the document full width and bound it to the viewport with its own
  // scroll surface so the chat feed remains usable while reading it.
  if (toolName === 'get_skill_guidelines' || toolName === 'skill_loader') {
    const guidelines = typeof result === 'string'
      ? result
      : String(result?.guidelines ?? result?.output?.guidelines ?? result?.content ?? result?.output ?? result?.text ?? result?.message ?? '');
    const skillName = String(args?.skill_name ?? args?.skillId ?? args?.skill ?? '').trim();

    return (
      <TrpCard flush={flush}>
        <div className="eterx-guidelines-preview min-w-0">
          <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6A6460]">
              Guidelines
            </span>
            {skillName && (
              <span className="min-w-0 truncate font-mono text-[10px] text-[#817A70]" title={skillName}>
                {skillName}
              </span>
            )}
          </div>
          {guidelines ? (
            <div className="eterx-guidelines-scroll max-h-[min(58vh,560px)] min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain pr-2 eterx-scrollbar [scrollbar-gutter:stable]">
              <TrpMarkdown content={guidelines} />
            </div>
          ) : (
            <div className="py-5 text-center text-[12px] text-[#817A70] italic">No guidelines returned.</div>
          )}
        </div>
      </TrpCard>
    );
  }

  // ── web_search ────────────────────────────────────────────────────────────
  if (toolName === 'web_search') {
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


  // ── Universal smart renderer ──────────────────────────────────────────────
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
    const candidates = ['message', 'content', 'guidelines', 'text', 'output', 'stdout', 'stderr', 'logs', 'response', 'result', 'summary', 'answer', 'report'];
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
    'success', 'passed', 'ok', 'error', 'message', 'content', 'guidelines', 'text',
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

const InlineMissingDiffView = ({
  filename,
  filepath = '',
  stats,
  flush = false,
}: {
  filename: string;
  filepath?: string;
  stats?: { added: number; removed: number } | null;
  flush?: boolean;
}) => {
  const parentPath = filepath ? filepath.replace(/\\/g, '/').split('/').slice(0, -1).slice(-3).join('/') : '';
  return (
    <div>
      <div className={`overflow-hidden ${ flush ? 'border-t border-amber-400/[0.10] bg-transparent rounded-none' : 'mx-3 mb-2 mt-1.5 rounded-[12px] border border-amber-400/[0.12] bg-[#151514] shadow-none' }`}>
        {!flush && (
          <div className="flex items-center justify-between gap-3 bg-white/[0.02] border-b border-white/[0.045] px-3 py-2">
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate font-mono text-[12px] font-semibold text-[#A9D2E5]">{filename}</span>
              {parentPath ? <span className="mt-0.5 truncate font-mono text-[9.5px] text-[#6D6861]">{parentPath}</span> : null}
            </span>
            <ChangeStats stats={stats} className="flex shrink-0 items-center gap-1 text-[11px] font-semibold tabular-nums" />
          </div>
        )}
        <div className={`flex items-start gap-2.5 text-[11.5px] leading-relaxed text-[#AAA298] ${ flush ? 'px-3 py-2.5' : 'px-3 py-3 border-t border-white/[0.045]' }`}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300/80" />
          <div>
            <div className="font-semibold text-[#D3CCC2]">Detailed diff was not saved for this earlier edit.</div>
            <div className="mt-0.5 text-[#7F786F]">The full file is intentionally hidden. New edits show only exact red and green change hunks.</div>
          </div>
        </div>
      </div>
    </div>
  );
};

const InlineDiffView = ({ filename, filepath = '', diffLines, showExpand = true, flush = false }: { filename: string, filepath?: string, diffLines: any[], showExpand?: boolean, flush?: boolean }) => {
  const [full, setFull] = useState(false);
  const { openPanel } = useFilePanelActions();
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(false);
  const [atBottom, setAtBottom] = useState(false);
  const added = diffLines.filter(l => l.type === 'added').length;
  const removed = diffLines.filter(l => l.type === 'removed').length;
  const parentPath = filepath
    ? filepath.replace(/\\/g, '/').split('/').slice(0, -1).slice(-3).join('/')
    : '';
  const openFileDiff = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!filepath) return;
    openPanel({
      filename,
      filepath,
      diffLines,
      isEdit: true,
      linesAdded: added,
      linesRemoved: removed,
      added,
      removed,
      activeTabMode: 'diff',
    });
  };
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    if (nearBottom !== atBottomRef.current) {
      atBottomRef.current = nearBottom;
      setAtBottom(nearBottom);
    }
  };
  const diffPanel = (
    <div className={`eterx-inline-diff-panel flex flex-col font-mono text-[#D8D1C8] ${ full ? 'h-full rounded-none border-0 bg-[#151514]' : `${ flush ? 'border-t border-white/[0.052] bg-transparent rounded-none' : 'mx-3 mt-1.5 mb-2 overflow-hidden rounded-[12px] border border-white/[0.07] bg-[#151514] shadow-none' }` }`}>
      {/* Header (hidden when flush embedded in card) */}
      {!flush && (
        <div className="eterx-inline-diff-header flex items-center justify-between gap-3 bg-white/[0.02] border-b border-white/[0.045] px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <button type="button" onClick={openFileDiff} disabled={!filepath} className="flex min-w-0 flex-col text-left leading-tight disabled:cursor-default">
              <span className="eterx-inline-diff-filename truncate text-[12px] font-semibold text-[#A9D2E5]">{filename}</span>
              {parentPath ? <span className="mt-0.5 truncate text-[9.5px] text-[#6D6861]">{parentPath}</span> : null}
            </button>
            <ChangeStats
              stats={{ added, removed }}
              className="flex shrink-0 items-center gap-1 text-[11px] font-semibold tabular-nums"
              addedClassName="eterx-file-change-added text-[#3FB950]"
              removedClassName="eterx-file-change-removed text-[#FF7B72]"
            />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <IconCopyButton
              content={diffLines.map(line => line.isGap
                ? `@@ ${ line.content || `${ line.skipped || 0 } lines hidden` } @@`
                : `${ line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ' }${ line.content }`
              ).join('\n')}
              label="Copy visible diff"
            />
          </div>
        </div>
      )}
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
              if (l.isGap) {
                return (
                  <div key={`gap-${ i }`} className="eterx-inline-diff-gap flex min-h-[30px] items-center border-y border-white/[0.045] bg-[#171716] text-[10px] text-[#716B63]">
                    <div className="w-[45px] shrink-0 border-r border-white/[0.045] py-2 text-center text-[#514D48]">•••</div>
                    <div className="px-4 py-2 italic">{l.skipped ? `${ l.skipped } unchanged line${ l.skipped === 1 ? '' : 's' } hidden` : l.content || 'Next change'}</div>
                  </div>
                );
              }
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
            type="button"
            aria-label="Scroll diff to bottom"
            onClick={(e) => { e.stopPropagation(); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}
            className="absolute bottom-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.08] bg-[#2A2A29]/95 text-[#BDB5AA] shadow-none transition-colors hover:bg-[#333331] hover:text-[#F0EAE0]"
          ><ChevronDown className="h-3.5 w-3.5" /></button>
        )}
      </div>
    </div>
  );
  return <>{full ? <FullScreenModal onClose={() => setFull(false)} title={`Diff: ${ filename }`}>{diffPanel}</FullScreenModal> : <div>{diffPanel}</div>}</>;
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
  startLine,
  endLine,
}: {
  filename: string;
  content: string;
  stats?: { added: number; removed: number } | null;
  showExpand?: boolean;
  filepath?: string;
  fetchFull?: boolean;
  created?: boolean;
  flush?: boolean;
  startLine?: number;
  endLine?: number;
}) => {
  const [full, setFull] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(false);
  const [atBottom, setAtBottom] = useState(false);
  const [loadedContent, setLoadedContent] = useState(content || '');
  const [isLoading, setIsLoading] = useState(Boolean(fetchFull && filepath && !content));

  useEffect(() => {
    setLoadedContent(content || '');
    if (content) setIsLoading(false);
  }, [content, filename]);

  useEffect(() => {
    if (!fetchFull || !filepath) return;
    let cancelled = false;
    if (!content) setIsLoading(true);
    const simpleNameOnly = filepath === filename && !/[\\/]/.test(filepath);
    const candidates = Array.from(new Set([
      filepath,
      simpleNameOnly ? `.workspaces/sandbox/${ filename }` : '',
      simpleNameOnly ? `.workspaces\\sandbox\\${ filename }` : '',
    ].filter(Boolean)));
    (async () => {
      try {
        for (const candidate of candidates) {
          const res = await fetch('/api/code/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: candidate }),
          });
          if (!res.ok) continue;
          const data = await res.json();
          if (!cancelled && typeof data?.content === 'string') {
            setLoadedContent(data.content);
            setIsLoading(false);
            return;
          }
        }
      } catch {
        // Fail silently
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fetchFull, filepath, filename, content]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
    el.scrollLeft = 0;
    atBottomRef.current = false;
    setAtBottom(false);
  }, [loadedContent, filename]);

  const effectiveContent = loadedContent || content || '';
  
  // Extract line range (#L315-325 or L315-325 or 315-325) if present in filename, filepath, or content string
  const rangeMatch = useMemo(() => {
    const combined = `${filename} ${filepath} ${(content || '').slice(0, 120)}`;
    const match = combined.match(/(?:#?L|lines?\s*|range\s*|^|\s)#?L?(\d+)[-:]L?(\d+)/i);
    return match ? { start: parseInt(match[1], 10), end: parseInt(match[2], 10) } : null;
  }, [filename, filepath, content]);

  const finalStartLine = startLine ?? rangeMatch?.start;
  const finalEndLine = endLine ?? rangeMatch?.end;

  const { displayLines, startLineOffset } = useMemo(() => {
    const allLines = (effectiveContent || '').split('\n');
    if (!effectiveContent && isLoading) {
      return { displayLines: [], startLineOffset: 1 };
    }
    if (finalStartLine && finalStartLine > 0) {
      if (allLines.length >= finalStartLine) {
        const end = finalEndLine && finalEndLine >= finalStartLine ? finalEndLine : allLines.length;
        return {
          displayLines: allLines.slice(finalStartLine - 1, end),
          startLineOffset: finalStartLine,
        };
      }
      return {
        displayLines: allLines,
        startLineOffset: finalStartLine,
      };
    }
    return { displayLines: allLines, startLineOffset: 1 };
  }, [effectiveContent, finalStartLine, finalEndLine, isLoading]);

  const lineCount = displayLines.length;
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
    <div className={`eterx-inline-code-panel ${ created ? 'eterx-inline-code-panel-created' : '' } flex flex-col font-mono text-[#D8D1C8] ${ full ? 'h-full rounded-none border-0 bg-[#151514]' : `${ flush ? 'border-t border-white/[0.052] bg-transparent rounded-none' : 'mx-3 mt-1.5 mb-2 overflow-hidden rounded-[12px] border border-white/[0.07] bg-[#151514] shadow-none' }` }`}>
      {/* Header (hidden when flush embedded in card) */}
      {!flush && (
        <div className="eterx-inline-code-header flex items-center justify-between gap-3 bg-white/[0.02] border-b border-white/[0.045] px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="eterx-inline-code-filename min-w-0 break-words text-[12px] font-medium text-[#94C7E0] underline-offset-[3px] hover:underline">{filename}</span>
            {hasVisibleChangeStats(displayStats) ? (
              <ChangeStats
                stats={displayStats}
                className="flex shrink-0 items-center gap-1 text-[11px] font-semibold tabular-nums"
                addedClassName="eterx-file-change-added text-[#3FB950]"
                removedClassName="eterx-file-change-removed text-[#FF7B72]"
              />
            ) : (
              <span className="eterx-inline-code-label shrink-0 text-[10.5px] font-medium text-[#817A70]">{lineCount} lines</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <IconCopyButton content={effectiveContent} label="Copy file content" />
          </div>
        </div>
      )}
      {/* Single unified scroll container */}
      <div className={`relative min-h-0 ${ full ? 'flex-1' : '' }`}>
        {isLoading ? (
          <div className="flex min-h-[96px] w-full items-center justify-center px-4 py-6">
            <span className="h-5 w-5 rounded-full border-[2.2px] border-black/20 dark:border-white/20 border-t-[#3EE06F] animate-spin shrink-0" />
          </div>
        ) : (
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className={`eterx-inline-code-scroll eterx-scrollbar overflow-auto text-[12px] leading-[1.5] ${ full ? 'h-full' : 'max-h-[300px] min-h-[74px]' }`}
          >
            {/* Inner div expands to content width — all lines share the same horizontal scroll */}
            <div style={{ minWidth: 'max-content' }}>
              {displayLines.map((l, i) => (
                <div key={i} className={`eterx-inline-code-row ${ created ? 'eterx-inline-code-row-created' : '' } flex items-stretch hover:bg-white/[0.022] group`}>
                  {/* Line number — sticky left via position (plain div, no overflow) */}
                  <div className="eterx-inline-code-line-number w-[42px] shrink-0 select-none border-r border-white/[0.045] py-[3px] pr-3 text-right text-[10.5px] text-[#756E64] transition-colors group-hover:text-[#9B948B]">
                    {startLineOffset + i}
                  </div>
                  {/* Content — whitespace-pre, no per-line overflow */}
                  <div
                    className={`eterx-inline-code-content ${ created ? 'eterx-inline-code-content-created text-[#B9E7C0]' : 'text-[#CDC5BB]' } px-3 py-[3px] whitespace-pre`}
                    dangerouslySetInnerHTML={{ __html: highlightSyntax(l) }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
        {!atBottom && lineCount > 10 && (
          <button
            type="button"
            aria-label="Scroll file to bottom"
            onClick={(e) => { e.stopPropagation(); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}
            className="absolute bottom-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.08] bg-[#2A2A29]/95 text-[#BDB5AA] shadow-none transition-colors hover:bg-[#333331] hover:text-[#F0EAE0]"
          ><ChevronDown className="h-3.5 w-3.5" /></button>
        )}
      </div>
    </div>
  );
  return <>{full ? <FullScreenModal onClose={() => setFull(false)} title={`File: ${ filename }`}>{codePanel}</FullScreenModal> : <div>{codePanel}</div>}</>;
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
  const toolName = normalizeToolTraceName(log?.tool || log?.name);
  if (added === 0 && removed === 0 && args && toolName === 'workspace_edit_file') {
    const targets = Array.isArray(args.files) ? args.files : [args];
    targets.forEach((target: any) => {
      if (target?.delete === true) return;
      const edits = Array.isArray(target?.edits) ? target.edits : [];
      edits.forEach((edit: any) => {
        const searchText = typeof edit?.search === 'string' ? edit.search : '';
        const replacementText = typeof edit?.replace === 'string' ? edit.replace : '';
        if (edit?.startLine !== undefined && edit?.endLine !== undefined) {
          removed += Math.max(0, Number(edit.endLine) - Number(edit.startLine) + 1);
        } else if (searchText) {
          removed += searchText.split(/\r?\n/).length;
        }
        if (replacementText) added += replacementText.split(/\r?\n/).length;
      });
    });
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
  className = 'flex shrink-0 items-center gap-1 text-[12.5px] font-semibold tabular-nums leading-tight',
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
  return value === 'sub_agent_action' || value === 'tool_call' ? 'command' : value;
};

const getActionIdentity = (log: any, fallbackIndex: number) => {
  const stableId = getStableActionEventId(log);
  const scope = compactActionKeyPart(log?.runId || log?.turnId || log?.ownerChatId || log?.chatId || 'current');
  const actionType = normalizeActionTypeForKey(log?.type);
  // A row key must not contain streamed/mutable presentation fields. When an
  // event has transport identity, keep that identity for its entire lifecycle
  // so React updates the existing card and preserves expansion state.
  if (stableId) return `${ scope }|${ actionType }|${ stableId }`;
  const timeAnchor = log?.startTime ?? log?.timestamp ?? log?.endTime ?? fallbackIndex;
  return [
    scope,
    actionType,
    timeAnchor,
    compactActionKeyPart(log?.text),
    compactActionKeyPart(log?.secondary),
    compactActionKeyPart(log?.command),
    compactActionKeyPart(log?.filename),
    compactActionKeyPart(log?.responseKey),
    compactActionKeyPart(getConnectorId(log)),
  ].join('|');
};

const getActionLookupIdentity = (log: any) => [
  normalizeActionTypeForKey(log?.type),
  compactActionKeyPart(log?.text),
  compactActionKeyPart(log?.secondary),
  compactActionKeyPart(log?.command),
  compactActionKeyPart(log?.filename),
  compactActionKeyPart(getConnectorId(log)),
].join('|');

const getStableActionEventId = (log: any) => {
  // Tool/stream ownership survives the optimistic-to-persisted handoff while
  // transport trace ids can change. Prefer that semantic identity so an open
  // terminal or file detail does not remount and collapse mid-update.
  const value = log?.toolCallId ?? log?.streamId ?? log?.taskId ?? log?.backgroundTaskId ?? log?.traceId ?? log?.id ?? log?._traceIdx ?? null;
  return value === null || value === undefined ? '' : String(value);
};

const ACTION_EVENT_TYPES = new Set([
  'command', 'tool_call', 'exploration', 'file_edit', 'progress', 'browser',
  'communication', 'sub_agent_action',
]);

const isLiveActionEvent = (log: any) => Boolean(
  log?.isLive === true ||
  log?.isStreaming === true ||
  log?.isLiveTyping === true ||
  log?.streamState === 'open' ||
  ['running', 'working', 'pending'].includes(String(log?.status || '').toLowerCase())
);

const BROWSER_ACTIVITY_TOOL_NAMES = new Set([
  'browser',
  'browser_control',
  'browser_use',
  'computer',
  'computer_control',
  'computer_use',
  'screen_agent',
  'screenshot_capture',
]);

const isBrowserActivityAction = (log: any) => {
  if (!log) return false;
  if (log.type === 'browser') return true;
  const toolName = String(normalizeToolTraceName(log.tool || log.toolName || log.name || ''))
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return BROWSER_ACTIVITY_TOOL_NAMES.has(toolName);
};

const isExplicitlySettledAction = (log: any) => Boolean(
  log && (
    log.isStreaming === false ||
    log.streamState === 'closed' ||
    log.done === true ||
    log.final === true ||
    ['completed', 'done', 'success', 'failed', 'error', 'stopped', 'closed'].includes(
      String(log.phase || log.status || '').toLowerCase(),
    )
  )
);

/**
 * Live polling and the settled transcript briefly overlap during hand-off.
 * Build several transport identities so the UI can replace that overlap in
 * place without collapsing two genuine repeated actions.
 */
const getActionEventIdentityKeys = (log: any): string[] => {
  if (!ACTION_EVENT_TYPES.has(String(log?.type || ''))) return [];

  const scope = compactActionKeyPart(
    log?.runId || log?.turnId || log?.ownerChatId || log?.chatId || 'current',
  );
  const actionType = normalizeActionTypeForKey(log?.type);
  const keys = new Set<string>();
  const addEventKey = (value: unknown) => {
    const normalized = compactActionKeyPart(value);
    if (normalized) keys.add(`${ scope }:${ actionType }:event:${ normalized }`);
  };

  addEventKey(log?.traceId);
  addEventKey(log?.id);
  addEventKey(log?.toolCallId);
  addEventKey(log?.streamId);
  addEventKey(log?.taskId);
  addEventKey(log?.backgroundTaskId);
  addEventKey(log?._liveCommitKey);

  if (log?._traceIdx !== undefined && log?._traceIdx !== null) {
    keys.add(`${ scope }:${ actionType }:trace:${ String(log._traceIdx) }`);
  }

  const semanticIdentity = getActionLookupIdentity(log);
  const timeAnchor = log?.startTime ?? log?.timestamp ?? log?.endTime;
  if (timeAnchor !== undefined && timeAnchor !== null && String(timeAnchor).trim()) {
    keys.add(`${ scope }:semantic:${ semanticIdentity }:${ String(timeAnchor) }`);
  }
  if (keys.size === 0) keys.add(`${ scope }:semantic:${ semanticIdentity }`);

  return Array.from(keys);
};

const reconcileLiveActionLogs = (settledLogs: any[], liveLogs: any[]): any[] => {
  const reconciled = [...settledLogs];
  const identityIndexes = new Map<string, number>();

  reconciled.forEach((log, index) => {
    getActionEventIdentityKeys(log).forEach(key => identityIndexes.set(key, index));
  });

  liveLogs.forEach((liveLog) => {
    const keys = getActionEventIdentityKeys(liveLog);
    const existingIndex = keys.reduce<number | undefined>(
      (found, key) => found ?? identityIndexes.get(key),
      undefined,
    );

    if (existingIndex === undefined) {
      const nextIndex = reconciled.length;
      reconciled.push(liveLog);
      keys.forEach(key => identityIndexes.set(key, nextIndex));
      return;
    }

    const existing = reconciled[existingIndex];
    // A settled trace is authoritative over the final live-poll snapshot. If
    // both are still live, keep the newest payload in the same visible row.
    if (!isLiveActionEvent(existing) && isLiveActionEvent(liveLog)) return;
    reconciled[existingIndex] = {
      ...existing,
      ...liveLog,
      startTime: existing?.startTime ?? liveLog?.startTime,
    };
    getActionEventIdentityKeys(reconciled[existingIndex]).forEach(key => identityIndexes.set(key, existingIndex));
  });

  return reconciled;
};

const getStreamRowIdentity = (log: any, fallbackIndex: number) => {
  const scope = compactActionKeyPart(log?.runId || log?.turnId || log?.ownerChatId || log?.chatId || 'current');
  const owner = compactActionKeyPart(log?.subAgentChatId || log?.subAgentId || log?.subAgent || log?.agentName || 'main');
  const eventId = String(log?.traceId ?? log?.id ?? log?._traceIdx ?? '').trim();
  const streamId = String(log?.thoughtId || log?.noteId || log?.streamId || '').trim();
  const streamType = ['thought_stream', 'work_note'].includes(String(log?.type || ''))
    ? 'narrative'
    : String(log?.type || 'stream');
  // Prefer immutable transport/stream identity. Timestamps are filled in at
  // different stages of a live hand-off and must not remount an existing row
  // just because the settled snapshot added startTime or timestamp later.
  if (streamId) return `${ scope }:${ owner }:${ streamType }:stream:${ streamId }`;
  if (eventId) return `${ scope }:${ owner }:${ String(log?.type || 'stream') }:event:${ eventId }`;
  const anchor = log?.streamStartedAt ?? log?.startTime ?? log?.timestamp ?? fallbackIndex;
  return `${ scope }:${ owner }:${ String(log?.type || 'stream') }:time:${ String(anchor) }`;
};

const getTimelineRowIdentity = (log: any, fallbackIndex: number) => {
  const scope = compactActionKeyPart(log?.runId || log?.turnId || log?.ownerChatId || log?.chatId || 'current');
  const eventId = String(
    log?.traceId ?? log?.id ?? log?._traceIdx ?? log?.responseKey ??
    log?.subAgentChatId ?? log?.subAgentId ?? log?.agentId ?? ''
  ).trim();
  if (eventId) return `${ scope }:${ String(log?.type || 'event') }:${ eventId }`;
  const anchor = log?.startTime ?? log?.timestamp ?? log?.endTime ?? fallbackIndex;
  return `${ scope }:${ String(log?.type || 'event') }:${ String(anchor) }`;
};

const ACTION_CARD_CLASS = "eterx-action-card w-full overflow-hidden rounded-[10px] border border-white/[0.07] bg-[#151514]/34 shadow-none";
const ACTION_ROW_DIVIDER_CLASS = "eterx-action-row-divider border-t border-white/[0.052]";

const formatTerminalSourcePreview = (value: unknown) => {
  const source = String(value || '').trim();
  if (!source) return '';
  const lines = source.split(/\r?\n/);
  const meaningfulIndex = lines.findIndex(line => {
    const clean = line.trim();
    if (!clean || /^(?:#|\/\/|import\s|from\s+\S+\s+import\s)/.test(clean)) return false;
    if (/^(?:path|dataset_path|file_path|csv_path|csv_file|data_path|df)\s*=/i.test(clean)) return false;
    return true;
  });
  const opening = lines.slice(0, Math.min(4, lines.length));
  const meaningful = meaningfulIndex > 4
    ? ['', '# ...', ...lines.slice(meaningfulIndex, meaningfulIndex + 8)]
    : lines.slice(4, 12);
  const preview = [...opening, ...meaningful].join('\n').slice(0, 1200).trim();
  return preview.length < source.length ? `${ preview }\n...` : preview;
};

const getTerminalSourceValue = (log: any, preview?: any) => {
  const toolArgs = log?.toolArgs || log?.args || preview?.toolArgs || {};
  return [toolArgs.script, toolArgs.code, toolArgs.source]
    .find(value => String(value || '').trim().length > 0);
};

const getCollapsedTerminalCode = (log: any, preview: any, fallback: string) => {
  const source = String(getTerminalSourceValue(log, preview) || '').trim();
  if (!source) return fallback;
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const meaningful = lines.filter(line =>
    !/^(?:#|\/\/|import\s|from\s+\S+\s+import\s)/.test(line) &&
    !/^(?:path|dataset_path|file_path|csv_path|csv_file|data_path|df)\s*=/i.test(line)
  );
  const selected = (meaningful.length > 0 ? meaningful : lines).slice(0, 3);
  const actualCode = selected.join('  |  ').slice(0, 520).trim();
  return actualCode || fallback;
};

const getTerminalCommandText = (log: any, preview?: any, fallback = '') => {
  const toolArgs = log?.toolArgs || log?.args || preview?.toolArgs || {};
  const resultObject = preview?.result && typeof preview.result === 'object' ? preview.result : null;
  const sourceCandidate = [
    toolArgs.script,
    toolArgs.code,
    toolArgs.source,
    toolArgs.command,
    resultObject?.commandUsed,
    preview?.command,
    log?.command,
    log?.secondary,
    log?.cmd,
    fallback,
  ].find(value => String(value || '').trim().length > 0);
  const sourcePreview = formatTerminalSourcePreview(sourceCandidate);
  if (sourcePreview) return sourcePreview;

  const language = String(toolArgs.language || '').trim();
  return language ? `${ language } inline script` : '';
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
  // Keep the same visibility contract as the primary chat feed. In
  // particular, a closed empty direct-chat shell is not a thought card.
  return shouldRenderThoughtStream(log);
};

const isTimerAction = (log: any, command: string = '') => {
  const toolName = String(log?.tool || log?.name || '').toLowerCase();
  const text = String(log?.text || '').toLowerCase();
  const cmd = String(command || log?.secondary || '').toLowerCase();
  return (
    ['schedule', 'wait_timer', 'sleep', 'timer', 'wait'].includes(toolName) ||
    /^(?:schedule|wait_timer|sleep|timer|wait)\b/i.test(text) ||
    /^(?:schedule|wait_timer|sleep|timer|wait)\b/i.test(cmd) ||
    /\b(?:wait_timer|schedule)\b/i.test(text) ||
    /\b(?:wait_timer|schedule)\b/i.test(cmd)
  );
};

const extractTimerDurationLabel = (log: any, durationMs?: number) => {
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
    const totalSecs = Math.round(durationMs / 1000);
    if (totalSecs < 60) {
      return durationMs < 1000 ? `${ Math.round(durationMs) }ms` : `${ (durationMs / 1000).toFixed(durationMs % 1000 === 0 ? 0 : 1) }s`;
    }
    const mins = Math.floor(totalSecs / 60);
    const remSecs = totalSecs % 60;
    return remSecs > 0 ? `${ mins }m ${ remSecs }s` : `${ mins }m`;
  }

  // Look in toolArgs / args
  const rawSecs = log?.toolArgs?.DurationSeconds ?? log?.args?.DurationSeconds ?? log?.toolArgs?.durationSeconds ?? log?.args?.durationSeconds ?? log?.toolArgs?.seconds ?? log?.args?.seconds;
  if (rawSecs !== undefined && rawSecs !== null) {
    const num = parseFloat(String(rawSecs));
    if (Number.isFinite(num) && num > 0) {
      if (num < 60) return `${ num }s`;
      const mins = Math.floor(num / 60);
      const remSecs = Math.round(num % 60);
      return remSecs > 0 ? `${ mins }m ${ remSecs }s` : `${ mins }m`;
    }
  }

  // Real timestamp difference calculation from trace start/end timestamps
  const startMs = asTimestamp(log?.startTime) ?? asTimestamp(log?.timestamp);
  const endMs = asTimestamp(log?.endTime) ?? asTimestamp(log?.updatedAt);
  if (startMs && endMs && endMs > startMs) {
    const elapsed = endMs - startMs;
    const totalSecs = Math.round(elapsed / 1000);
    if (totalSecs < 60) return `${ (elapsed / 1000).toFixed(1) }s`;
    const mins = Math.floor(totalSecs / 60);
    const remSecs = totalSecs % 60;
    return remSecs > 0 ? `${ mins }m ${ remSecs }s` : `${ mins }m`;
  }

  // Fallback: parse numbers from log.text or log.secondary
  const combined = `${ log?.text || '' } ${ log?.secondary || '' } ${ log?.command || '' }`;
  const secMatch = combined.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i);
  if (secMatch) {
    const num = parseFloat(secMatch[1]);
    if (Number.isFinite(num) && num > 0) {
      if (num < 60) return `${ num }s`;
      const mins = Math.floor(num / 60);
      const remSecs = Math.round(num % 60);
      return remSecs > 0 ? `${ mins }m ${ remSecs }s` : `${ mins }m`;
    }
  }
  
  return '';
};

const formatTerminalMetaDuration = (durationMs?: number) => {
  if (durationMs === undefined || durationMs === null || !Number.isFinite(durationMs)) return '';
  return durationMs < 1000 ? `${ Math.round(durationMs) }ms` : `${ (durationMs / 1000).toFixed(1) }s`;
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
  const connectorId = getConnectorId(log);
  const connectorAction = isConnectorTrace(log);
  const command = getTerminalCommandText(log, preview, subtitle) || 'terminal command';
  const collapsedCommand = getCollapsedTerminalCode(log, preview, command);
  const rawResult = preview?.result ?? log?.toolResult;
  const resultObject = rawResult && typeof rawResult === 'object' ? rawResult : null;
  const stdout = resultObject ? String(resultObject.stdout ?? resultObject.output ?? resultObject.content ?? '') : '';
  const stderr = resultObject ? String(resultObject.stderr ?? resultObject.error ?? '') : '';
  const resultText = typeof rawResult === 'string' ? rawResult : [stdout, stderr].filter(Boolean).join('\n');
  const outputCandidates = [
    preview?.output,
    preview?.content,
    preview?.outputPreview,
    log?.output,
    log?.content,
    log?.outputPreview,
    resultObject?.output,
    resultText,
  ];
  const output = String(
    outputCandidates.find(value => value !== undefined && value !== null && String(value).length > 0)
    ?? outputCandidates.find(value => value !== undefined && value !== null)
    ?? ''
  );
  const exitCode = typeof preview?.exitCode === 'number'
    ? preview.exitCode
    : typeof resultObject?.exitCode === 'number'
      ? resultObject.exitCode
      : typeof resultObject?.code === 'number'
        ? resultObject.code
        : resultObject?.passed === false || resultObject?.success === false
          ? 1
          : resultObject && resultObject.running !== true && resultObject.stillRunning !== true && resultObject.status !== 'running'
            ? 0
            : typeof log?.exitCode === 'number'
              ? log.exitCode
              : undefined;
  const durationMs = typeof preview?.durationMs === 'number'
    ? preview.durationMs
    : typeof log?.durationMs === 'number'
      ? log.durationMs
      : undefined;
  const cwd = String(preview?.cwd ?? resultObject?.cwd ?? log?.cwd ?? log?.toolArgs?.cwd ?? log?.args?.cwd ?? '');
  const shell = String(preview?.shell ?? resultObject?.shell ?? log?.shell ?? '');
  const pidValue = Number(preview?.pid ?? resultObject?.pid ?? log?.pid);
  const pid = Number.isFinite(pidValue) && pidValue > 0 ? pidValue : undefined;
  const isStreaming = isTerminalTraceStreaming({
    preview,
    result: resultObject,
    log,
    isLiveChip,
    exitCode,
    hasResult: rawResult !== undefined && rawResult !== null,
  });
  const displayedExitCode = isStreaming ? undefined : exitCode ?? 0;
  const isFailed = !isStreaming && exitCode !== undefined && exitCode !== 0;
  const durationLabel = formatTerminalMetaDuration(durationMs);
  
  const isTimer = isTimerAction(log, command);
  // Terminal output is always opt-in. Streaming output must never expand the
  // inline console or steal attention from the live action sequence.
  const [isExpanded, setIsExpanded] = useState(false);

  // If this is a timer/schedule log, render an unopenable static status row with seconds/mins
  if (isTimer) {
    const timerLabel = extractTimerDurationLabel(log, durationMs);
    const title = isStreaming ? 'Waiting' : 'Waited';
    const headerLabel = timerLabel ? `${ title } · ${ timerLabel }` : title;
    const timerPrompt = log?.toolArgs?.Prompt ?? log?.args?.Prompt ?? log?.toolArgs?.prompt ?? log?.args?.prompt;
    const displayCollapsed = timerPrompt ? String(timerPrompt) : '';

    return (
      <div className={`eterx-terminal-trace w-full ${ inCard ? '' : ACTION_CARD_CLASS }`}>
        <div className={`eterx-terminal-trace-row flex w-full items-center gap-1.5 py-0.5 text-left ${ inCard ? 'min-h-[29px] px-1' : 'min-h-[34px] px-2.5' }`}>
          <span className="eterx-action-icon eterx-terminal-icon flex h-[22px] w-[22px] shrink-0 items-center justify-center text-[#A39B91]">
            {connectorAction ? <ConnectorIcon connectorId={connectorId} size={17} title={`${ connectorId || 'connected service' } connector`} /> : <Clock className={`h-[16.5px] w-[16.5px] ${ isStreaming ? 'text-[#67C58A]' : 'text-[#A39B91]' }`} strokeWidth={2.1} />}
          </span>
          <Shimmer active={isStreaming} className="min-w-0 truncate text-[12.5px] font-medium leading-tight tracking-normal text-[#C8C1B8]">
            {headerLabel}
          </Shimmer>
          {displayCollapsed && (
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] leading-tight text-[#857E73] select-all">
              {displayCollapsed}
            </span>
          )}
        </div>
      </div>
    );
  }

  const title = inCard
    ? (isStreaming ? 'Running' : isFailed ? 'Failed' : 'Ran')
    : (isStreaming ? 'Running command' : isFailed ? 'Command failed' : 'Ran command');

  const headerLabel = durationLabel && !isStreaming ? `${ title } · ${ durationLabel }` : title;

  const rowGridClass = isExpanded
    ? 'grid-cols-[26px_1fr_auto]'   // title fills space → chevron stays at far right
    : 'grid-cols-[26px_auto_minmax(0,1fr)_auto]';

  return (
    <div className={`eterx-terminal-trace w-full ${ inCard ? '' : ACTION_CARD_CLASS }`}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsExpanded(open => !open);
        }}
        aria-expanded={isExpanded}
        className={`eterx-terminal-trace-row group grid w-full ${ rowGridClass } items-center gap-1.5 py-0.5 text-left transition-colors outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0 ${ inCard ? 'min-h-[29px] px-1 hover:bg-white/[0.024]' : 'min-h-[34px] px-2.5 hover:bg-white/[0.024]' }`}
      >
        <span className="eterx-action-icon eterx-terminal-icon flex h-[22px] w-[22px] shrink-0 items-center justify-center text-[#A39B91]">
          {connectorAction ? <ConnectorIcon connectorId={connectorId} size={17} title={`${ connectorId || 'connected service' } connector`} /> : <Terminal className="h-[16.5px] w-[16.5px]" strokeWidth={2.1} />}
        </span>
        <Shimmer active={isStreaming} className="min-w-0 truncate text-[12.5px] font-medium leading-tight tracking-normal text-[#C8C1B8]">
          {headerLabel}
        </Shimmer>
        {!isExpanded && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] leading-tight text-[#857E73] select-all">
            {collapsedCommand || '(no command)'}
          </span>
        )}
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[#898176] transition-transform ${ isExpanded ? 'rotate-90 text-[#C8C1B8]' : '' }`} />
      </button>
      {isExpanded && (
        <InlineConsole
          command={command}
          content={output}
          exitCode={displayedExitCode}
          durationMs={durationMs}
          cwd={cwd}
          shell={shell}
          pid={pid}
          flush={true}
        />
      )}
    </div>
  );
};

const FileChangeTraceCard = ({
  log,
  preview,
  isLiveChip,
  displayVerb,
  iconCategory,
  lineContext,
  fileTargets,
  diffStats,
  inCard = false,
}: {
  log: any;
  preview?: any;
  isLiveChip: boolean;
  displayVerb: string;
  iconCategory?: string;
  lineContext?: string;
  fileTargets: FileTraceTarget[];
  diffStats: { added: number; removed: number } | null;
  inCard?: boolean;
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const displayFileTargets = useMemo(() => dedupeFileTraceTargetsForDisplay(fileTargets), [fileTargets]);
  const primaryTarget = displayFileTargets[0] || fileTargets[0];
  const explicitCount = numberFrom(log.fileCount, log.filesCount, log.count);
  const fileOperationResult = useMemo(() => {
    const raw = preview?.fileOperationResult ?? preview?.result ?? log?.toolResult ?? log?.result ?? log;
    let src = raw;
    if (typeof raw === 'string') {
      try { src = JSON.parse(raw); } catch { src = {}; }
    }

    const rawChanges = Array.isArray(src?.changes) ? src.changes as FileChangeDetail[] : [];
    const relatedPreviews = [preview, ...(Array.isArray(preview?.relatedFilePreviews) ? preview.relatedFilePreviews : [])]
      .filter((item, index, items) => item?.type === 'file_preview' && items.indexOf(item) === index);
    const normalizePath = (value: unknown) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    const structuredChanges = rawChanges.map(change => {
      const changePath = normalizePath(change.path);
      const matchingPreview = relatedPreviews.find(item => {
        const previewPath = normalizePath(item?.filepath || item?.filename);
        return previewPath && (previewPath === changePath || previewPath.endsWith(`/${ changePath }`) || changePath.endsWith(`/${ previewPath }`));
      });
      if (!matchingPreview) return change;
      return {
        ...change,
        additions: Number.isFinite(Number(matchingPreview.linesAdded)) ? Number(matchingPreview.linesAdded) : change.additions,
        deletions: Number.isFinite(Number(matchingPreview.linesRemoved)) ? Number(matchingPreview.linesRemoved) : change.deletions,
        diffLines: Array.isArray(matchingPreview.diffLines) ? matchingPreview.diffLines : change.diffLines,
        readback: change.readback || getPreviewContent(matchingPreview),
      };
    });
    const filesModified = (src?.filesModified ?? structuredChanges.filter(change => change.action === 'modified').map(change => change.path)) as string[];
    const filesCreated = (src?.filesCreated ?? structuredChanges.filter(change => change.action === 'created').map(change => change.path)) as string[];
    const filesDeleted = (src?.filesDeleted ?? structuredChanges.filter(change => change.action === 'deleted').map(change => change.path)) as string[];
    const errors = (src?.errors ?? []) as string[];
    const hasData = filesModified.length > 0 || filesCreated.length > 0 || filesDeleted.length > 0 || structuredChanges.length > 0 || errors.length > 0 || Boolean(src?.operation);
    if (!hasData) return null;

    const inferredOperation = filesCreated.length > 0 && filesModified.length === 0 && filesDeleted.length === 0
      ? 'created'
      : filesModified.length > 0 && filesCreated.length === 0 && filesDeleted.length === 0
        ? 'edited'
        : filesDeleted.length > 0 && filesCreated.length === 0 && filesModified.length === 0
          ? 'deleted'
          : filesCreated.length + filesModified.length + filesDeleted.length > 0
            ? 'mixed'
            : 'none';

    return {
      operation: ['created', 'edited', 'deleted', 'mixed', 'none'].includes(src?.operation)
        ? src.operation as 'created' | 'edited' | 'deleted' | 'mixed' | 'none'
        : inferredOperation,
      filesModified,
      filesCreated,
      filesDeleted,
      errors,
      changes: structuredChanges,
      rolledBack: Boolean(src?.rolledBack),
    };
  }, [log, preview]);
  const resultFileCount = fileOperationResult
    ? fileOperationResult.filesCreated.length + fileOperationResult.filesModified.length + fileOperationResult.filesDeleted.length
    : 0;
  const fileCount = Math.max(displayFileTargets.length, explicitCount || 0, resultFileCount);
  const multiFile = fileCount > 1 || /\bfiles\b/i.test(String(log.text || ''));
  const resultOperation = fileOperationResult?.operation;
  const resultSaysEdit = preview?.type === 'file_preview' && Boolean(
    preview?.isEdit ||
    (Array.isArray(preview?.diffLines) && preview.diffLines.length > 0) ||
    normalizeChangeCount(diffStats?.removed) > 0 ||
    log?.toolArgs?.overwrite ||
    log?.args?.overwrite
  );
  const baseVerb = displayVerb.replace(/\s+files?$/i, '').trim() || (isLiveChip ? 'Editing' : 'Edited');
  const normalizedVerb = !isLiveChip && resultOperation
    ? resultOperation === 'none' && (fileOperationResult?.errors.length || fileOperationResult?.rolledBack)
      ? 'Failed to update'
      : ({ created: 'Created', edited: 'Edited', deleted: 'Deleted', mixed: 'Updated', none: 'Unchanged' } as const)[resultOperation]
    : !isLiveChip && resultSaysEdit && /^(?:creat|writ|generat)/i.test(baseVerb)
      ? 'Edited'
      : baseVerb;
  const title = `${ normalizedVerb } ${ multiFile ? 'files' : 'file' }`;
  const filename = preview?.filename || primaryTarget?.filename || (multiFile ? `${ fileCount || 'Multiple' } files` : '');
  const rawTargetLabel = multiFile
    ? summarizeFileTraceTargets(displayFileTargets, fileCount)
    : filename;
  const targetLabel = /^(?:file|files?)$/i.test(rawTargetLabel) ? '' : rawTargetLabel;
  const previewFilePath = preview?.filepath || primaryTarget?.filepath || '';
  const previewContent = getPreviewContent(preview);
  const previewStartLine = preview?.startLine
    ?? preview?.lineStart
    ?? log.toolArgs?.startLine
    ?? log.args?.startLine
    ?? log.startLine;
  const previewEndLine = preview?.endLine
    ?? preview?.lineEnd
    ?? log.toolArgs?.endLine
    ?? log.args?.endLine
    ?? log.endLine;
  const hasDiffPreview = Array.isArray(preview?.diffLines) && preview.diffLines.length > 0;
  const isEditPreview = resultSaysEdit;
  const isCreateAction = resultOperation === 'created' || (!resultOperation && /^(?:creat|generat|scaffold|writ)/i.test(displayVerb));
  const canPreview = preview?.type === 'file_preview' && (
    (isEditPreview && (hasDiffPreview || previewContent.length > 0 || Boolean(previewFilePath))) ||
    (!isEditPreview && (previewContent.length > 0 || Boolean(previewFilePath)))
  );
  const showDiff = Boolean(isEditPreview && hasDiffPreview);
  // Allow fetching if we have a filepath, even for non-create actions (covers edit with no diff)
  const canFetchCreatedFile = !multiFile && !canPreview && Boolean(previewFilePath || primaryTarget?.filepath);
  const canShowFileList = !canPreview && (multiFile || !canFetchCreatedFile) && displayFileTargets.length > 0;

  // Structured workspace_edit_file result used for operation labels and real diffs.
  const hasFileOperationResult = Boolean(fileOperationResult);
  const structuredStats = fileOperationResult?.changes.length
    ? fileOperationResult.changes.reduce((total, change) => ({
      added: total.added + (Number(change.additions) || 0),
      removed: total.removed + (Number(change.deletions) || 0),
    }), { added: 0, removed: 0 })
    : null;
  const effectiveStats = structuredStats || diffStats;

  const canExpand = hasFileOperationResult || canPreview || canFetchCreatedFile || canShowFileList;
  const agentEntry = resolveAgentIcon(displayVerb, log.text, iconCategory || log.iconCategory);
  const { Icon: AI, color: ac } = agentEntry;

  const activate = (event: React.MouseEvent | React.KeyboardEvent) => {
    event.stopPropagation();
    if (canExpand) {
      setIsExpanded(open => !open);
    }
  };

  const previewPanel = hasFileOperationResult && fileOperationResult ? (
    <FileOperationSummaryPanel
      filesModified={fileOperationResult.filesModified}
      filesCreated={fileOperationResult.filesCreated}
      filesDeleted={fileOperationResult.filesDeleted}
      errors={fileOperationResult.errors}
      changes={fileOperationResult.changes}
      rolledBack={fileOperationResult.rolledBack}
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
      startLine={previewStartLine}
      endLine={previewEndLine}
      created={isCreateAction}
      flush
    />
  ) : canShowFileList ? (
    <div className="eterx-file-change-list-panel border-t border-white/[0.052] bg-transparent text-[12.5px] text-[#CDC5BB]">
      {displayFileTargets.slice(0, 10).map((target) => (
        <div key={target.filepath} className="eterx-file-change-list-row flex min-h-[36px] items-center gap-2.5 border-t border-white/[0.045] px-3 py-2 first:border-t-0">
          <LocalFileIcon fileName={target.filename} size="sm" />
          <span className="eterx-file-change-list-name min-w-0 flex-1 break-words font-medium leading-[1.35] text-[#E2DFDA]">{target.filename}</span>
          {displayFileTargets.length === 1 && (
            <ChangeStats
              stats={effectiveStats}
              className="flex shrink-0 items-center gap-1 text-[11.5px] font-semibold tabular-nums"
            />
          )}
        </div>
      ))}
    </div>
  ) : showDiff ? (
    <InlineDiffView filename={filename} filepath={previewFilePath} diffLines={preview.diffLines} showExpand={false} flush />
  ) : (previewFilePath || primaryTarget?.filepath || previewContent) ? (
    <InlineCodeView
      filename={filename}
      content={previewContent}
      stats={effectiveStats}
      showExpand={false}
      filepath={previewFilePath || primaryTarget?.filepath || ''}
      fetchFull
      startLine={previewStartLine}
      endLine={previewEndLine}
      created={isCreateAction}
      flush
    />
  ) : (
    <InlineMissingDiffView filename={filename} filepath={previewFilePath} stats={effectiveStats} flush />
  );

  const collapsedRowClass = inCard
    ? `eterx-file-change-row eterx-file-change-row--embedded group grid min-h-[29px] w-full grid-cols-[22px_auto_minmax(0,1fr)_auto] items-center gap-1.5 px-1 py-0.5 text-left transition-colors hover:bg-white/[0.024] ${ canExpand ? 'cursor-pointer' : 'cursor-default' }`
    : `eterx-file-change-row eterx-file-change-row--standalone group grid min-h-[34px] w-full grid-cols-[22px_auto_minmax(0,1fr)_auto] items-center gap-1.5 px-2.5 py-0.5 text-left transition-colors ${ canExpand ? 'cursor-pointer hover:bg-white/[0.025]' : 'cursor-default' }`;

  return (
    <div className={`eterx-file-change-trace w-full ${ inCard ? '' : ACTION_CARD_CLASS }`}>
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
        <span className="eterx-action-icon eterx-file-change-icon flex h-[22px] w-[22px] shrink-0 items-center justify-center">
          <AI isLive={isLiveChip} size={16.5} color={isLiveChip ? ac : '#DAD6CF'} />
        </span>
          <Shimmer active={isLiveChip} className="eterx-file-change-title min-w-max whitespace-nowrap text-[12.5px] font-medium leading-tight tracking-normal text-[#C8C1B8]">
          {title}
        </Shimmer>
        <span className="eterx-file-change-detail flex min-w-0 items-center gap-1.5 overflow-hidden">
          {targetLabel ? (
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
              <LocalFileIcon fileName={filename || targetLabel} size="sm" />
              <span className="eterx-file-change-filename min-w-0 truncate text-[13px] font-semibold leading-[1.25] text-[#DDEAF1] decoration-transparent underline-offset-[3px] transition-colors group-hover:text-white" title={targetLabel}>{targetLabel}</span>
            </span>
          ) : null}
          {lineContext && (
            <span className="eterx-file-change-lines shrink-0 text-[12px] font-medium leading-tight text-[#857E73]">
              {lineContext}
            </span>
          )}
          <ChangeStats stats={effectiveStats} />
        </span>
        {canExpand ? (
          <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[#8F897F] transition-transform duration-200 ${ isExpanded ? 'rotate-90 text-[#C9C5BE]' : '' }`} />
        ) : (
          <span className="h-3.5 w-3.5 shrink-0" />
        )}
      </div>
      <AnimatePresence initial={false}>
        {isExpanded && canExpand && (
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
        )}
      </AnimatePresence>
    </div>
  );
};

const isApiKeyTrace = (text: string) => /^(?:gemini|openai|anthropic|mistral|groq|openrouter)\s+api\s+key/i.test(text);

const ActionChip = ({
  log, isLastChip, isActiveGroup, allLogs,
  isNested = false, inCard = false
}: {
  log: any, isLastChip: boolean, isActiveGroup: boolean, allLogs: any[],
  isNested?: boolean, inCard?: boolean
}) => {
  const isLiveChip = isActiveGroup && isLastChip;
  const displayToolName = normalizeToolTraceName(log.tool || log.name);
  const isEdit = log.type === 'file_edit' || displayToolName === 'workspace_edit_file';
  const isRead = (
    log.type === 'exploration' &&
    /\b(?:read(?:ing)?|view(?:ing)?)\s+files?\b/i.test(String(log.text || ''))
  );
  const { openPanel } = useFilePanelActions();
  const connectorId = useMemo(() => getConnectorId(log), [log]);
  const connectorAction = useMemo(() => isConnectorTrace(log), [log]);
  const logFileTargets = useMemo(() => collectFileTargets(log), [log]);
  // Subtitle: the secondary arg (command string, URL, query, etc.)
  const subtitle = (isEdit || isRead)
    ? ''
    : log.secondary && log.secondary !== log.filename
      ? normalizeToolTraceText(log.secondary).substring(0, 120)
      : '';
  const preview = useMemo(() => {
    if (log.toolResult !== undefined && log.toolResult !== null) {
      const EXCLUDED_PREVIEW_TOOLS = new Set([
        'skill_loader', 'screenshot_capture',
        'browser_control', 'checkpoint', 'computer', 'screen_agent'
      ]);
      const toolName = displayToolName || log.tool || log.name || '';
      if (!EXCLUDED_PREVIEW_TOOLS.has(toolName) && ![
        'workspace_edit_file', 'workspace_run_command',
      ].includes(toolName)) {
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
    const ownerIdentities = [
      log?.traceId,
      log?.id,
      log?._traceIdx,
      log?.toolCallId,
      log?.streamId,
      log?.taskId,
      log?.backgroundTaskId,
    ]
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
    const findOwnerPreview = (items: any[]) => {
      const candidates = items.filter((item: any) => {
        if (item?.type !== 'file_preview' && item?.type !== 'tool_result_preview' && item?.type !== 'console_output') return false;
        const itemIdentities = [
          item?.ownerTraceId,
          item?.toolCallId,
          item?.streamId,
          item?.taskId,
          item?.backgroundTaskId,
        ].filter(value => value !== null && value !== undefined).map(String);
        return ownerIdentities.some(identity => itemIdentities.includes(identity));
      });
      const best = candidates.find((item: any) => item?.type === 'file_preview' && Array.isArray(item?.diffLines) && item.diffLines.length > 0)
        || candidates.find((item: any) => item?.type === 'file_preview' && item?.isEdit)
        || [...candidates].reverse().find((item: any) => item?.type === 'console_output' && (item?.exitCode !== undefined || item?.isStreaming === false))
        || [...candidates].reverse().find((item: any) => item?.type === 'console_output')
        || candidates[0];
      if (best?.type !== 'file_preview') return best;
      return {
        ...best,
        relatedFilePreviews: candidates.filter((item: any) => item?.type === 'file_preview'),
      };
    };
    const ownerPreview = findOwnerPreview(searchLogs) || findOwnerPreview(allLogs);
    if (ownerPreview) return ownerPreview;
    if (log.type === 'command' && !isRead) {
      return null;
    }
    if (isEdit) {
      const chooseBestFilePreview = (items: any[]) => {
        const matches = items.filter((item: any) => filePreviewMatchesTargets(item, logFileTargets));
        return matches.find((item: any) => Array.isArray(item?.diffLines) && item.diffLines.length > 0)
          || matches.find((item: any) => item?.isEdit)
          || matches[0]
          || null;
      };
      const scopedPreview = chooseBestFilePreview(searchLogs);
      if (scopedPreview) return scopedPreview;
      return logFileTargets.length > 0
        ? chooseBestFilePreview(allLogs)
        : null;
    }
    if (isRead) {
      const scopedPreview = searchLogs.find((l: any) => filePreviewMatchesTargets(l, logFileTargets));
      if (scopedPreview) return scopedPreview;
      return logFileTargets.length > 0
        ? allLogs.find((l: any) => filePreviewMatchesTargets(l, logFileTargets)) || null
        : null;
    }
    return null;
  }, [allLogs, displayToolName, isEdit, isRead, log, logFileTargets]);
  const [isExpanded, setIsExpanded] = useState(false);
  const fileTargets = useMemo(() => collectFileTargets(log, preview), [log, preview]);
  const primaryTarget = fileTargets[0] || null;
  const rawPath = primaryTarget?.filepath || '';
  const fileName = primaryTarget?.filename || '';
  const hasFile = !!fileName && !/^(?:system|file|files?)$/i.test(fileName);
  // Resolve the full path for IDE link
  const fullPath = rawPath || preview?.filepath || preview?.filename || '';
  const getLineContextRange = () => {
    const toLineNumber = (value: unknown) => {
      if (value === undefined || value === null || String(value).trim() === '') return null;
      const number = Number(value);
      return Number.isInteger(number) && number > 0 ? number : null;
    };
    const start = log.toolArgs?.startLine
      ?? log.args?.startLine
      ?? log.startLine
      ?? preview?.startLine
      ?? preview?.lineStart;
    const end = log.toolArgs?.endLine
      ?? log.args?.endLine
      ?? log.endLine
      ?? preview?.endLine
      ?? preview?.lineEnd;
    const startNumber = toLineNumber(start);
    const endNumber = toLineNumber(end);
    if (startNumber !== null && endNumber !== null) {
      return `#L${ startNumber }-${ endNumber }`;
    }
    if (startNumber !== null) {
      return `#L${ startNumber }`;
    }
    if (endNumber !== null) {
      return `#L${ endNumber }`;
    }
    return hasFile ? getLineContext(subtitle, fileName) : '';
  };
  const lineContext = getLineContextRange();
  const diffStats = isEdit ? getDiffStats(preview, log) : null;
  const previewHasDiff = preview?.type === 'file_preview' && Array.isArray(preview?.diffLines) && preview.diffLines.length > 0;
  const requestedOverwrite = Boolean(log?.toolArgs?.overwrite ?? log?.args?.overwrite);
  const previewLooksEdited = preview?.type === 'file_preview' && Boolean(
    preview?.isEdit ||
    previewHasDiff ||
    requestedOverwrite ||
    normalizeChangeCount(diffStats?.removed) > 0
  );
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
        verbDone: previewLooksEdited ? 'Edited' : isGenerate ? 'Generated' : 'Created',
        verbLive: previewLooksEdited ? 'Editing' : isGenerate ? 'Generating' : 'Creating',
        color: '#E8E6E3',
      };
      return { icon: null, verbDone: isCreate ? 'Created' : 'Edited', verbLive: isCreate ? 'Creating' : 'Editing', color: '#E8E6E3' };
    }
    const actionText = normalizeToolTraceText(log.text) || getToolDisplayLabel(displayToolName);
    const base = getToolMeta(actionText, log.type, log.icon);
    // Map past-tense verbs → live present-tense
    const LIVE_VERBS: Record<string, string> = {
      'Ran': 'Running', 'Read': 'Reading', 'Listed': 'Listing',
      'Edited': 'Editing', 'Created': 'Creating', 'Searched': 'Searching',
      'Web searched': 'Web searching', 'Scraped': 'Scraping',
      'Researched': 'Researching', 'Analyzed': 'Analyzing',
      'Refactored': 'Refactoring', 'Verified': 'Verifying',
      'Scaffolded': 'Scaffolding', 'Loaded': 'Loading',
  'Patched': 'Patching',
      'Started agents': 'Starting agents',
      'Checked agent status': 'Checking agent status',
      'Collected agent results': 'Collecting agent results',
      'Cleared agent history': 'Clearing agent history',
      'Ran agent consensus': 'Running agent consensus',
      'Ran agent debate': 'Running agent debate',
      'Ran specialist agent': 'Running specialist agent',
      'Paused agent': 'Pausing agent',
      'Resumed agent': 'Resuming agent',
      'Closed agent': 'Closing agent',
      'Called API': 'Calling API', 'Generated': 'Generating',
      'Queried': 'Querying', 'Compared': 'Comparing',
    };
    return { ...base, verbDone: base.verb, verbLive: LIVE_VERBS[base.verb] || base.verb };
  }, [displayToolName, isEdit, log.text, log.type, log.icon, log.iconCategory, preview, previewLooksEdited]);
  const displayVerb = isLiveChip ? (meta.verbLive || meta.verbDone) : (meta.verbDone || (meta as any).verb);
  const cleanVerb = displayVerb.replace(/\s+files?$/i, '').trim();
  const displayVerbLabel = hasFile ? stripTrailingFileName(cleanVerb, fileName) : cleanVerb;
  const fileDisplayVerb = isRead ? (isLiveChip ? 'Reading' : 'Read') : displayVerbLabel;
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
  // Toggle inline expansion inside chat feed
  const openInIde = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    if (preview) {
      setIsExpanded(prev => !prev);
    }
  };

  if (log.type === 'progress') {
    const isKey = isApiKeyTrace(String(log.text || ''));
    return (
      <div className="eterx-worked-summary my-1 flex w-full items-center gap-3 py-1">
        <div className="eterx-worked-summary-line h-px flex-1 bg-white/[0.06]" />
        <span className="eterx-worked-summary-label flex shrink-0 items-center gap-1.5 py-[1px] text-center text-[12px] font-medium leading-[1.35] tracking-normal text-[#8F8B85]">
          {isKey ? (
            <Key className="h-3.5 w-3.5 text-[#E2765A]" />
          ) : (
            <Terminal className="h-3.5 w-3.5 text-[#A9A196]" />
          )}
          {displayVerbLabel}
        </span>
        <div className="eterx-worked-summary-line h-px flex-1 bg-white/[0.06]" />
      </div>
    );
  }

  if (isEdit || isRead) {
    return (
      <FileChangeTraceCard
        log={log}
        preview={preview}
        isLiveChip={isLiveChip}
        displayVerb={fileDisplayVerb}
        iconCategory={isRead ? 'file_read' : undefined}
        lineContext={lineContext}
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
        className={`eterx-action-chip grid w-full grid-cols-[22px_auto_minmax(0,1fr)_auto] items-center gap-1.5 py-0.5 transition-colors group ${ inCard ? 'min-h-[29px] rounded-none border-0 bg-transparent px-1 hover:bg-white/[0.026]' : preview ? `min-h-[34px] px-2.5 ${ ACTION_CARD_CLASS } cursor-pointer hover:border-white/[0.12] hover:bg-[#181817]/70` : `min-h-[34px] px-2.5 ${ ACTION_CARD_CLASS } cursor-default hover:bg-[#171716]/60` } ${ preview ? 'cursor-pointer' : 'cursor-default' }`}
      >
        {!isThinkChip && (() => {
          // Terminal-style traces can arrive with custom text and older computer categories.
          const iconCategory = shouldUseTerminalIcon(log, subtitle, preview) ? 'terminal' : log.iconCategory;
          const agentEntry = resolveAgentIcon(displayVerbLabel, log.text, iconCategory);
          const { Icon: AI, color: ac } = agentEntry;
          return (
            <span
              className={`eterx-action-icon flex h-[22px] w-[22px] items-center justify-center shrink-0 ${ connectorAction ? 'rounded-[6px] border border-white/[0.08] bg-white/[0.035] shadow-none' : '' }`}
              title={connectorAction ? `${ (connectorId || 'connected service').replace(/_/g, ' ') } connector` : undefined}
              data-connector={connectorId || (connectorAction ? 'connected-service' : undefined)}
            >
              {connectorAction
                ? <ConnectorIcon connectorId={connectorId} size={15} title={`${ (connectorId || 'connected service').replace(/_/g, ' ') } connector`} />
                : <AI isLive={isLiveChip} size={15} color={isLiveChip ? ac : '#DAD6CF'} />}
            </span>
          );
        })()}
        {isThinkChip && <span className="h-[22px] w-[22px] shrink-0" />}
        <Shimmer active={isLiveChip} className="eterx-action-verb shrink-0 truncate text-[12.5px] font-medium leading-tight tracking-normal text-[#C8C1B8]">{displayVerbLabel}</Shimmer>
        {hasFile && (
          <span className="flex min-w-0 items-center gap-2">
            <LocalFileIcon fileName={fileName} size="sm" />
            <button
              type="button"
              onClick={openInIde}
              className="eterx-action-file-link min-w-0 truncate text-left text-[12.5px] font-semibold leading-tight text-[#DDEAF1] transition-colors duration-150 hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#94C7E0]/22"
              aria-label={`Open file: ${ fileName }`}
            >
              {fileName}
            </button>
            {hasVisibleChangeStats(diffStats) && (
              <button
                type="button"
                onClick={openInIde}
                className="eterx-action-diff-chip group/diff relative -my-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-semibold tabular-nums leading-none text-[#C8C1B8] transition-colors duration-150 hover:bg-white/[0.052] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/18"
                aria-label={`Open file: ${ fileName }`}
              >
                <ChangeStats
                  stats={diffStats}
                  className="inline-flex shrink-0 items-center gap-1"
                  addedClassName="eterx-action-diff-added text-[#3EE06F]"
                  removedClassName="eterx-action-diff-removed text-[#FF6D63]"
                />
                <span className="eterx-action-diff-tooltip pointer-events-none absolute -top-8 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-full border border-white/[0.08] bg-[#222220]/96 px-2.5 py-1 text-[11px] font-medium text-[#E6DED4] opacity-0 shadow-none backdrop-blur-xl transition-opacity duration-150 group-hover/diff:opacity-100">
                  Open diff
                </span>
              </button>
            )}
            {lineContext && (
              <span className="shrink-0 text-[11px] font-medium leading-tight text-[#857E73]">
                {lineContext}
              </span>
            )}
          </span>
        )}
        {!hasFile && subtitle && (
          <span className="min-w-0 truncate font-mono text-[11.5px] leading-tight text-[#918A80]">{subtitle}</span>
        )}
        {!hasFile && !subtitle && <span className="min-w-0" />}
        <span className="flex shrink-0 items-center justify-end gap-2 justify-self-end">
          {preview && (
            <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-all ${ isExpanded ? 'rotate-90 text-[#C8C1B8]' : 'text-[#898176]' } group-hover:text-[#C8C1B8]`} />
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
              ? <InlineConsole command={preview.command || subtitle} content={preview.output || preview.content} exitCode={preview.exitCode} durationMs={preview.durationMs} flush />
              : preview.type === 'file_preview' && previewHasDiff
                ? <InlineDiffView filename={preview.filename || fileName} filepath={preview.filepath || fullPath} diffLines={preview.diffLines} flush />
                : preview.type === 'file_preview' && (preview.filepath || fullPath || getPreviewContent(preview))
                  ? <InlineCodeView filename={preview.filename || fileName} content={getPreviewContent(preview)} filepath={preview.filepath || fullPath} fetchFull={Boolean(preview.filepath || fullPath)} startLine={preview.startLine ?? preview.lineStart} endLine={preview.endLine ?? preview.lineEnd} stats={diffStats} flush />
                  : preview.type === 'file_preview'
                    ? <InlineMissingDiffView filename={preview.filename || fileName} filepath={preview.filepath || fullPath} stats={diffStats} flush />
                    : preview.type === 'tool_result_preview'
                      ? <ToolResultPreview toolName={preview.toolName} args={preview.toolArgs} result={preview.result} flush />
                      : null}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// Sub-agent card — professional with status indicator
const SubAgentCard = ({ log, onOpenAgentTeam, assetIndexes }: { log: any; onOpenAgentTeam?: (name?: string) => void; assetIndexes?: SubAgentAssetIndexes }) => {
  const agentName = log.agentName || log.subAgent || log.secondary || 'Sub-agent';
  const isComplete = ['sub_agent_complete', 'sub_agent_result', 'sub_agent_answer'].includes(log.type) || log.agentStatus === 'completed' || log.status === 'done';
  const [open, setOpen] = useState(isComplete);
  const isClosed = log.type === 'sub_agent_close' || log.agentStatus === 'closed' || log.status === 'closed';
  const isPaused = log.type === 'sub_agent_pause' || log.agentStatus === 'paused' || log.status === 'paused';
  const isFailed = !isClosed && !isPaused && (log.type === 'sub_agent_error' || log.agentStatus === 'failed' || log.status === 'error');
  const isWorking = !isComplete && !isFailed && !isClosed && !isPaused && (
    log.type === 'sub_agent_action' ||
    log.type === 'sub_agent_resume' ||
    log.agentStatus === 'running' ||
    log.agentStatus === 'working'
  );
  const identityStatus = isComplete ? 'completed' : isFailed ? 'error' : isWorking ? 'working' : 'idle';
  const durationLabel = log.durationMs ? `${ Math.round(log.durationMs / 1000) }s` : null;
  const stepLabel = log.stepCount ? `${ log.stepCount } steps` : null;
  const metaText = isClosed
    ? 'Closed by control'
    : isPaused
      ? 'Paused at a safe boundary'
      : [durationLabel, stepLabel].filter(Boolean).join(' · ') || (isWorking ? 'Working...' : 'Parallel worker');
  const displayText = log.resultSummary || log.result || log.taskSummary || log.content || log.text || '';

  const statusBadge = isComplete
    ? { bg: 'bg-emerald-500/8 border-emerald-500/15', text: 'text-emerald-400', label: 'Done' }
    : isFailed
      ? { bg: 'bg-red-500/8 border-red-500/15', text: 'text-red-400', label: 'Error' }
      : isClosed
        ? { bg: 'bg-white/[0.035] border-white/[0.10]', text: 'text-[#AFA79C]', label: 'Closed' }
        : isPaused
          ? { bg: 'bg-amber-500/8 border-amber-500/15', text: 'text-amber-300', label: 'Paused' }
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
          <SubAgentIdentityIcon name={agentName} status={identityStatus} size={34} assetIndex={getSubAgentAssetIndex(assetIndexes, agentName)} />

          {/* Info */}
          <span className="min-w-0 flex-1 text-left">
            <span className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium tracking-normal text-[#D8D1C8]">{agentName}</span>
              <span className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ${ statusBadge.bg } ${ statusBadge.text }`}>
                {isWorking ? <Shimmer>{statusBadge.label}</Shimmer> : statusBadge.label}
              </span>
            </span>
            <span className={`mt-0.5 block truncate text-[11px] font-medium ${ isWorking ? 'text-[#BDB5AA]' : 'text-[#7E766C]' }`}>
              {metaText}
            </span>
          </span>

          <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[#6F685F] transition-all ${ open ? 'rotate-90 text-[#B6AEA3]' : '' }`} />
        </button>
        {onOpenAgentTeam && (
          <button
            type="button"
            onClick={() => onOpenAgentTeam(log.subAgentChatId || log.subAgentId || agentName)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-[#756D63] transition-colors hover:bg-white/[0.045] hover:text-[#CFC8BD] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/16"
            aria-label={`View ${ agentName }`}
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
const AgentCreatedCard = ({ log, onOpenAgentTeam, assetIndexes }: { log: any; onOpenAgentTeam?: (name?: string) => void; assetIndexes?: SubAgentAssetIndexes }) => {
  const agents = log.agentDetails || log.spawnedAgents || [];
  const agentList = Array.isArray(agents)
    ? agents.map((agent: any) => typeof agent === 'string'
      ? { name: agent, identity: agent }
      : {
          name: agent?.name,
          identity: agent?.subAgentChatId || agent?.subAgentId || agent?.agentId || agent?.name,
        }).filter((agent: any) => agent.name)
    : [];
  // If single agent spawn (from spawnAgent), use the direct name
  const singleName = log.agentName || log.subAgent || '';
  const displayList = agentList.length > 0
    ? agentList
    : [{ name: singleName || 'Agent', identity: log.subAgentChatId || log.subAgentId || log.agentId || singleName || 'Agent' }];

  return (
    <div className="flex w-full flex-col gap-2">
      {displayList.map((agent: { name: string; identity: string }, index: number) => {
        const { name, identity } = agent;
        return (
          <div key={identity}>
            <button
              type="button"
              onClick={() => onOpenAgentTeam?.(identity)}
              className={`w-full flex min-h-[29px] items-center gap-2 rounded-[8px] px-2.5 py-0.5 bg-white/[0.012] border border-white/[0.04] text-left transition-all hover:bg-white/[0.024] hover:border-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/16 cursor-pointer group ${ ACTION_CARD_CLASS }`}
              aria-label={`View agent ${ name }`}
            >
              <SubAgentIdentityIcon name={name} status="spawning" size={21} assetIndex={getSubAgentAssetIndex(assetIndexes, name) ?? index} />
              <span className="text-[11.5px] font-medium text-[#C8C1B8] group-hover:text-[#E0DAD2] transition-colors">
                Created <span className="text-[#E0DAD2]">{name}</span>
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
};


// Inter-agent communication card — shows messages between agents
const SubAgentActionCard = ({ log, assetIndexes }: { log: any; assetIndexes?: SubAgentAssetIndexes }) => {
  const agentName = log.agentName || log.subAgent || 'Sub-agent';
  const actionText = normalizeToolTraceText(log.text || log.currentAction || log.secondary || 'Working');
  const detailText = normalizeToolTraceText(log.secondary && log.secondary !== actionText ? log.secondary : log.task || '');
  const stepLabel = log.agentStep ? `Step ${ log.agentStep }` : 'Delegated step';

  return (
    <div
      className={`flex min-h-[40px] items-center gap-2.5 px-2.5 py-2 ${ ACTION_CARD_CLASS }`}
    >
      <SubAgentIdentityIcon name={agentName} status="working" size={26} assetIndex={getSubAgentAssetIndex(assetIndexes, agentName)} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[11.5px] font-medium text-[#D8D1C8]">{agentName}</span>
          <span className="shrink-0 rounded-full border border-white/[0.07] bg-white/[0.028] px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.08em] text-[#8F877C]">
            {stepLabel}
          </span>
        </span>
          <span className="mt-0.5 block min-w-0 truncate text-[12px] font-medium leading-4 text-[#C8C1B8]">
          {actionText}
        </span>
        {detailText && (
          <span className="mt-0.5 block truncate text-[11px] text-[#7E766C]">{detailText}</span>
        )}
      </span>
    </div>
  );
};

const InterAgentCommCard = ({ log, onOpenAgentTeam, assetIndexes }: { log: any; onOpenAgentTeam?: (name?: string) => void; assetIndexes?: SubAgentAssetIndexes }) => {
  const [open, setOpen] = useState(false);
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
  const isSending = log.optimistic === true;
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
    <div className="overflow-hidden">
      <button
        type="button"
        onClick={() => preview ? setOpen(value => !value) : onOpenAgentTeam?.(log.subAgentChatId || log.subAgentId || focusAgent)}
        aria-expanded={preview ? open : undefined}
         className={`eterx-agent-comm-card flex min-h-[46px] w-full items-start gap-2.5 rounded-[8px] px-2.5 py-2 bg-white/[0.01] border border-white/[0.065] text-left transition-colors hover:bg-white/[0.024] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/16 ${ ACTION_CARD_CLASS }`}
        aria-label={preview ? `${ open ? 'Collapse' : 'Expand' } message from ${ fromAgent }` : `View ${ focusAgent || 'agent activity' }`}
      >
          <span className="eterx-agent-comm-identities mt-0.5 flex shrink-0 items-center gap-1">
           <SubAgentIdentityIcon name={fromAgent} status="working" size={23} assetIndex={getSubAgentAssetIndex(assetIndexes, fromAgent) ?? 0} />
           <ArrowRight className="h-3 w-3 text-[#6F685F]" />
           <SubAgentIdentityIcon name={toAgent === '*' ? 'All agents' : toAgent} status="idle" size={23} assetIndex={getSubAgentAssetIndex(assetIndexes, toAgent === '*' ? 'All agents' : toAgent) ?? 1} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="text-[11.5px] font-semibold text-[#D8D1C7]">{fromAgent}</span>
            <ArrowRight className="h-3 w-3 text-[#6F685F]" />
            <span className="text-[11.5px] font-semibold text-[#D8D1C7]">{toAgent === '*' ? 'All agents' : toAgent}</span>
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
            {isSending && (
              <span className="inline-flex items-center gap-1 rounded-[6px] border border-sky-300/16 bg-sky-400/[0.055] px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.08em] text-sky-100/85">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-200/80" />
                sending
              </span>
            )}
          </span>
          {subject && <span className="mt-0.5 block truncate text-[11.5px] font-medium text-[#BDB5AB]">{subject}</span>}
          {preview && !open && <span className="mt-0.5 block truncate text-[11px] text-[#817970]">{preview}</span>}
        </span>
        {preview && <ChevronRight className={`mt-1 h-3.5 w-3.5 shrink-0 text-[#6F685F] transition-transform ${ open ? 'rotate-90' : '' }`} />}
      </button>
      <AnimatePresence initial={false}>
        {open && preview && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="overflow-hidden"
          >
            <div className="ml-7 max-h-[420px] overflow-y-auto border-l border-white/[0.075] pb-3 pl-4 pt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-[#A79F95] eterx-scrollbar">
              {preview}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// Sub-agent error card
const SubAgentErrorCard = ({ log, assetIndexes }: { log: any; assetIndexes?: SubAgentAssetIndexes }) => {
  const agentName = log.agentName || log.subAgent || 'Agent';
  const detail = normalizeToolTraceText(log.secondary || '');
  return (
    <div
      className={`flex min-h-[40px] items-center gap-2.5 rounded-[10px] px-2.5 py-2 ${ ACTION_CARD_CLASS }`}
    >
      <SubAgentIdentityIcon name={agentName} status="error" size={28} assetIndex={getSubAgentAssetIndex(assetIndexes, agentName)} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium text-[#E5B2AD]">{agentName} {log.errorType === 'cancelled' ? 'stopped' : 'encountered an error'}</span>
        <span className="block text-[12px] font-medium text-[#A07B76] mt-0.5 truncate">{detail}</span>
      </span>
    </div>
  );
};

// Safety warning banner
const SafetyBanner = ({ log }: { log: any }) => (
  <div className="flex items-start gap-2.5 rounded-[10px] border border-red-500/15 bg-red-500/[0.045] px-3 py-2.5">
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
        className={`${ ACTION_CARD_CLASS } flex min-h-[36px] items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.028]`}
      >
        <span className="eterx-action-icon flex h-6 w-6 shrink-0 items-center justify-center text-[#D8D1C8]">
          {answered ? (
            <Check className="h-4 w-4 text-[#DAD6CF]" />
          ) : (
            <AgentAssetIcon size={18} color="#DAD6CF" />
          )}
        </span>
        <Shimmer active={!answered && isLive} className="shrink-0 truncate text-[12.5px] font-medium leading-tight tracking-normal text-[#C8C1B8]">
          {answered ? 'Asked user' : `Asking user${ isLive ? '...' : '' }`}
        </Shimmer>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-[#918A80]">
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

const BrowserActivityGroup = ({
  items,
  isActive,
  allLogs,
}: {
  items: any[];
  isActive: boolean;
  allLogs: any[];
}) => {
  const actionLogs = items.flatMap(item => item.kind === 'browser_action_group' ? item.logs : []);
  const latestAction = actionLogs[actionLogs.length - 1];
  const latestActionSettled = isExplicitlySettledAction(latestAction);
  const activityIsActive = isActive && !latestActionSettled;
  const [open, setOpen] = useState(activityIsActive);
  const wasActiveRef = useRef(activityIsActive);
  useEffect(() => {
    if (activityIsActive && !wasActiveRef.current) setOpen(true);
    if (!activityIsActive && wasActiveRef.current) setOpen(false);
    wasActiveRef.current = activityIsActive;
  }, [activityIsActive]);

  const explicitLiveIndex = actionLogs.findLastIndex(log =>
    log?.isStreaming === true ||
    log?.isLiveTyping === true ||
    log?.streamState === 'open' ||
    ['running', 'working', 'pending', 'started'].includes(String(log?.phase || log?.status || '').toLowerCase())
  );
  const currentActionIndex = activityIsActive
    ? (explicitLiveIndex >= 0 ? explicitLiveIndex : actionLogs.length - 1)
    : -1;
  const { Icon: BrowserIcon } = resolveAgentIcon('Browser use', 'Using browser', 'browser');
  let actionIndex = 0;

  return (
    <div className={`${ ACTION_CARD_CLASS } eterx-browser-activity-group`} data-active={activityIsActive ? 'true' : undefined}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="eterx-browser-activity-header flex min-h-[38px] w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-white/[0.028] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/25"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
          {activityIsActive ? (
            <span className="h-[15px] w-[15px] rounded-full border-[1.7px] border-white/18 border-t-[#DAD6CF] animate-spin" />
          ) : (
            <BrowserIcon size={16.5} color="#DAD6CF" />
          )}
        </span>
        <Shimmer
          active={activityIsActive}
          className="min-w-0 flex-1 truncate text-[12.75px] font-medium tracking-[-0.01em] text-[#D5CFC7]"
        >
          Browser use
        </Shimmer>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-[#8F897F] transition-transform duration-200 ${ open ? '' : '-rotate-90' }`}
          aria-hidden="true"
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="browser-activity-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden border-t border-white/[0.055]"
          >
            {items.map((item, itemIndex) => {
              if (item.kind === 'note') {
                const noteIsLatest = itemIndex === items.length - 1;
                return (
                  <div
                    key={`browser-note-${ getStreamRowIdentity(item.log, item.idx) }`}
                    className="border-b border-white/[0.045] px-3 py-2 last:border-b-0"
                  >
                    <WorkNoteBlock
                      text={item.log.text}
                      isActive={activityIsActive && noteIsLatest}
                      isProxyStatus={false}
                    />
                  </div>
                );
              }

              return item.logs.map((log: any) => {
                const currentIndex = actionIndex++;
                return (
                  <div
                    key={getActionIdentity(log, currentIndex)}
                    className={currentIndex > 0 ? ACTION_ROW_DIVIDER_CLASS : ''}
                  >
                    <ActionChip
                      log={log}
                      isLastChip={currentIndex === currentActionIndex}
                      isActiveGroup={activityIsActive}
                      allLogs={allLogs}
                      isNested={currentIndex > 0}
                      inCard
                    />
                  </div>
                );
              });
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const JoinedActionGroup = ({
  logs, isActiveGroup, allLogs
}: {
  logs: any[], isActiveGroup: boolean, allLogs: any[]
}) => {
  const visibleLogs = logs.filter(Boolean);
  if (visibleLogs.length === 0) return null;

  const progressLogs = visibleLogs.filter(l => l?.type === 'progress');
  const cardLogs = visibleLogs.filter(l => l?.type !== 'progress');

  const terminalOnly = cardLogs.length === 1 && isTerminalActionLike(cardLogs[0]);
  const fileChangeOnly = cardLogs.length === 1 && cardLogs[0]?.type === 'file_edit';
  const useStandaloneRows = terminalOnly || fileChangeOnly;
  const explicitLiveCardIndex = cardLogs.findLastIndex(isLiveActionEvent);
  const currentCardIndex = isActiveGroup
    ? (explicitLiveCardIndex >= 0 ? explicitLiveCardIndex : cardLogs.length - 1)
    : -1;
  const explicitLiveProgressIndex = progressLogs.findLastIndex(isLiveActionEvent);
  const currentProgressIndex = isActiveGroup && cardLogs.length === 0
    ? (explicitLiveProgressIndex >= 0 ? explicitLiveProgressIndex : progressLogs.length - 1)
    : -1;

  return (
    <div className="w-full">
      {cardLogs.length > 0 && (
        <div
          className={useStandaloneRows ? 'w-full' : `${ ACTION_CARD_CLASS } eterx-action-group`}
        >
          {cardLogs.map((log, i) => (
            <div
              key={getActionIdentity(log, i)}
              className={i > 0 ? ACTION_ROW_DIVIDER_CLASS : ''}
            >
              <ActionChip
                log={log}
                isLastChip={i === currentCardIndex}
                isActiveGroup={isActiveGroup}
                allLogs={allLogs}
                isNested={i > 0}
                inCard={!useStandaloneRows}
              />
            </div>
          ))}
        </div>
      )}

      {progressLogs.map((log, i) => (
        <div
          key={getActionIdentity(log, i)}
          className="w-full"
        >
          <ActionChip
            log={log}
            isLastChip={i === currentProgressIndex}
            isActiveGroup={isActiveGroup}
            allLogs={allLogs}
            isNested={false}
            inCard={false}
          />
        </div>
      ))}
    </div>
  );
};

// Live working indicator — real-time log-state-connected
// 3 modes: thinking (visible note last), acting (real action last), idle (between)

const THINKING_PHRASES = [{ text: 'Thinking', dur: 0 }];
const IDLE_PHRASES = [{ text: 'Working', dur: 0 }];
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
    if (ls.length === 0) return { mode: 'thinking', label: 'Working' };
    const last = ls[ls.length - 1];
    const customLabel = [last.currentAction, last.statusText, last.label]
      .map(value => String(value || '').trim())
      .find(value => value && value.length <= 72);
    if (customLabel) return { mode: 'acting', label: customLabel };
    if (last.type === 'thought_stream' || last.type === 'work_note') {
      return isLiveThoughtFresh(last)
        ? { mode: 'thinking', label: 'Thinking' }
        : { mode: 'idle', label: 'Working' };
    }
    if (['command', 'tool_call', 'exploration', 'file_edit', 'communication', 'browser'].includes(last.type)) {
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
  const doTransition = (nextText: string, nextDur: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setLabel(nextText);
    lastLabelRef.current = nextText;
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
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // React to log changes — immediately reflect mode/action
  const prevSignatureRef = useRef(logSignature);
  useEffect(() => {
    const signatureChanged = logSignature !== prevSignatureRef.current;
    if (!signatureChanged) return;
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
  }, [logSignature, logs]);

  const displayLabel = label || 'Working';

  return (
    <div className="eterx-live-working-indicator flex h-6 w-fit max-w-full items-center pl-[22px]" role="status" aria-live="polite">
      <Shimmer
        active
        durationMs={2600}
        angle={12}
        spread="2.4ch"
        baseColor="var(--eterx-ui-working-text)"
        color="var(--eterx-ui-working-highlight)"
        surfaceColor="var(--background)"
        textColor="var(--eterx-ui-working-text)"
        className="eterx-thinking-shimmer min-w-0 truncate text-[15.5px] font-normal leading-[1.2] tracking-[0.005em] text-[var(--eterx-ui-working-text)]"
      >
        {displayLabel}
      </Shimmer>
    </div>
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
const copyTextToClipboard = async (text: string) => {
  return await safeCopyTextToClipboard(text);
};

const EditMessageIcon = ({ className = '' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.15" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

const UserMessageActionButton = ({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: (event: React.MouseEvent) => void;
  label: string;
}) => {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      aria-label={label}
      className="eterx-user-message-action-button relative isolate grid h-8 w-8 place-items-center rounded-full text-[#736E67] outline-none focus-visible:ring-2 focus-visible:ring-white/18"
    >
      <span className="pointer-events-none relative z-10 grid h-6 w-6 place-items-center rounded-full">
        {children}
      </span>
    </button>
  );
};

const UserMessageActions = ({ text, onEdit }: { text: string; onEdit?: (text: string) => void }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    const didCopy = await copyTextToClipboard(text);
    if (didCopy) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="eterx-user-message-actions absolute right-full top-1/2 mr-2 flex -translate-y-1/2 shrink-0 items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-150 group-hover/steer:opacity-100 group-hover/steer:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto">
      <UserMessageActionButton label={copied ? "Copied" : "Copy message"} onClick={handleCopy}>
        {copied ? <Check className="h-[18px] w-[18px] text-emerald-400" strokeWidth={2.15} /> : <Copy className="h-[18px] w-[18px]" strokeWidth={2.15} />}
      </UserMessageActionButton>
      {onEdit && (
        <UserMessageActionButton
          label="Edit message"
          onClick={(event) => {
            event.stopPropagation();
            onEdit(text);
          }}
        >
          <EditMessageIcon className="h-[18px] w-[18px]" />
        </UserMessageActionButton>
      )}
    </div>
  );
};

const SteeringCard = ({ log, onEdit }: { log: any; onEdit?: (text: string) => void }) => {
  const isProxy =
    log._autonomyProxy === true ||
    log.source === 'user_proxy' ||
    log.source === 'proxy_manager';
  return (
    <motion.div
      initial={{ opacity: 0, x: 12, y: 4 }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="group/steer relative z-10 my-1.5 flex w-full justify-end"
    >
      <div className={`${ isProxy ? 'border-[#34383D] bg-[#16181A]' : 'border-white/[0.065] bg-[#20201F]' } relative ml-auto flex max-w-[84%] items-end gap-2.5 rounded-[18px] rounded-tr-[7px] border px-4 py-2.5 text-[13.5px] leading-[1.5] text-[#F4F2EE] shadow-none`}>
        <UserMessageActions text={log.text} onEdit={isProxy ? undefined : onEdit} />
        <span className="min-w-0 whitespace-pre-wrap break-words text-left [overflow-wrap:anywhere]">
          {log.text}
        </span>
        <CornerDownLeft className="mb-0.5 h-4 w-4 shrink-0 select-none text-[#8F887E]" strokeWidth={2.15} aria-hidden="true" />
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
      const didCopy = await safeCopyTextToClipboard(rawHtml);
      if (!didCopy) return;
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
      className="w-full my-2.5 overflow-hidden rounded-[14px] border border-white/[0.07] bg-[#151514]/80 shadow-none backdrop-blur-md"
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
            type="button"
            onClick={() => setDevice('desktop')}
            aria-label="Desktop preview"
            aria-pressed={device === 'desktop'}
            className={`p-1.5 rounded-[7px] transition-colors ${ device === 'desktop' ? 'bg-[#DCD6CC] text-[#161514]' : 'text-white/40 hover:bg-white/[0.04] hover:text-white/80' }`}
            title="Desktop"
          >
            <Monitor className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setDevice('tablet')}
            aria-label="Tablet preview"
            aria-pressed={device === 'tablet'}
            className={`p-1.5 rounded-[7px] transition-colors ${ device === 'tablet' ? 'bg-[#DCD6CC] text-[#161514]' : 'text-white/40 hover:bg-white/[0.04] hover:text-white/80' }`}
            title="Tablet"
          >
            <Tablet className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setDevice('mobile')}
            aria-label="Mobile preview"
            aria-pressed={device === 'mobile'}
            className={`p-1.5 rounded-[7px] transition-colors ${ device === 'mobile' ? 'bg-[#DCD6CC] text-[#161514]' : 'text-white/40 hover:bg-white/[0.04] hover:text-white/80' }`}
            title="Mobile"
          >
            <Smartphone className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? 'HTML copied' : 'Copy HTML'}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-[7px] text-[10.5px] font-semibold transition-colors ${ copied ? 'text-emerald-300 bg-emerald-500/10' : 'text-[#928B81] hover:text-[#E8E1D7] hover:bg-white/[0.04]' }`}
            title="Copy HTML"
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            <span className="hidden sm:inline">{copied ? 'COPIED' : 'COPY'}</span>
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            aria-label="Refresh preview"
            className="p-1.5 rounded-[7px] text-[#928B81] hover:text-[#E8E1D7] hover:bg-white/[0.04] transition-colors"
            title="Refresh Preview"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleOpenExternal}
            aria-label="Open preview in a new window"
            className="p-1.5 rounded-[7px] text-[#928B81] hover:text-[#E8E1D7] hover:bg-white/[0.04] transition-colors"
            title="Open in new window"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setShowConsole(value => !value)}
            aria-label="Toggle preview console"
            aria-pressed={showConsole}
            className={`p-1.5 rounded-[7px] transition-colors relative ${ showConsole ? 'text-emerald-300 bg-emerald-500/10' : 'text-[#928B81] hover:text-[#E8E1D7] hover:bg-white/[0.04]' }`}
            title="Toggle Iframe Console"
          >
            <Terminal className="w-3.5 h-3.5" />
            {consoleLogs.length > 0 && !showConsole && (
              <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-rose-500" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(value => !value)}
            aria-label={collapsed ? 'Expand preview' : 'Collapse preview'}
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
                className="overflow-hidden rounded-[10px] bg-white shadow-none border border-white/5 relative"
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
                      type="button"
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


export const ThinkingProcess = ({ logs, liveLogs = [], isThinking, isLast, showLiveIndicator = false, onOpenAgentTeam, isSubAgentTab = false, onEditUserMessage, assetIndexes }: { logs: any[], liveLogs?: any[], isThinking: boolean, isLast: boolean, showLiveIndicator?: boolean, onOpenAgentTeam?: (agentName?: string) => void, isSubAgentTab?: boolean, isAgentBuilder?: boolean, onEditUserMessage?: (text: string) => void, assetIndexes?: SubAgentAssetIndexes }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const NOISE_PATTERN = /reconnect|retrying|stalled|stream interrupted|model error|fallback|cancelled/i;
  const isFlowLog = (l: any) => {
    const agentName = String(l?.agentName || l?.subAgent || '').trim().toLowerCase();
    const explicitlyMain = agentName === 'main';
    const subAgentOwned = !explicitlyMain && Boolean(
      l?.subAgentId ||
      l?.subAgentChatId ||
      (l?.subAgent && agentName),
    );
    const highLevelSubAgentTypes = new Set([
      'work_note', 'progress', 'sub_agent_spawn', 'sub_agent_answer', 'sub_agent_result', 'sub_agent_complete', 'sub_agent_error',
      'sub_agent_pause', 'sub_agent_resume', 'sub_agent_close', 'inter_agent_comm', 'inter_agent_message',
    ]);
    // Detailed worker actions belong to the selected worker tab. Keeping them
    // out of Main prevents a parallel run from looking like Main performed
    // every delegated file read, shell call, and thought stream.
    if (!isSubAgentTab && subAgentOwned && !highLevelSubAgentTypes.has(String(l?.type || ''))) return false;
    const redundantAgentNarration = l?.type === 'work_note' && !isSubAgentTab &&
      /\b(?:I\s+(?:will|'ll)|let me)\s+(?:spawn|create|collect|check|poll|wait for)\b.{0,100}\b(?:sub-?agent|agent(?:'s)?\s+(?:status|result|report))/i.test(String(l?.text || ''));
    return ['thought_stream', 'work_note', 'command', 'tool_call', 'exploration', 'file_edit', 'progress', 'browser', 'safety_warning', 'communication', 'steering_received', 'autonomy_proxy_status', 'sub_agent_answer', 'sub_agent_result', 'sub_agent_spawn', 'sub_agent_action', 'sub_agent_complete', 'sub_agent_error', 'sub_agent_pause', 'sub_agent_resume', 'sub_agent_close', 'inter_agent_comm', 'inter_agent_message', 'file_preview', 'console_output', 'ask_user', 'tool_result_preview'].includes(l.type) &&
    !redundantAgentNarration &&
    shouldRenderProgressTrace(l) &&
    !(['progress', 'command', 'exploration'].includes(l.type) && /analyz(?:e|ing) task complexity/i.test(String(l.text || ''))) &&
    !(l.type === 'progress' && NOISE_PATTERN.test(String(l.text || '')) && !isApiKeyTrace(String(l.text || ''))) &&
    !(l.type === 'work_note' && (l._connection || String(l.text || '').endsWith('is starting'))) &&
    // Filter out spawning announcement commands that have spawnedAgents (shown separately as agent cards)
    !(l.spawnedAgents && Array.isArray(l.spawnedAgents) && l.spawnedAgents.length > 0 && l.type === 'command');
  };
  const flowLogs = logs.filter(isFlowLog);
  const liveFlowLogs = liveLogs.filter(isFlowLog);
  const timelineLogs = reconcileLiveActionLogs(flowLogs, liveFlowLogs);
  const statusLogs = timelineLogs;
  const segs: any[] = [];
  let aBuf: any[] = [];
  let aBufFirstIdx = -1;
  let aBufKind: 'browser' | 'standard' | null = null;
  const SPEC = new Set(['file_preview', 'console_output', 'sub_agent_answer', 'sub_agent_result', 'sub_agent_spawn', 'sub_agent_action', 'sub_agent_complete', 'sub_agent_error', 'inter_agent_comm', 'safety_warning', 'tool_result_preview']);
  const flush = (idx: number) => {
    if (aBuf.length > 0) {
      const unique: any[] = [];
      const identityIndexes = new Map<string, number>();
      aBuf.forEach((log) => {
        const identities = getActionEventIdentityKeys(log);
        const existingIndex = identities.reduce<number | undefined>(
          (found, identity) => found ?? identityIndexes.get(identity),
          undefined,
        );
        if (existingIndex !== undefined) {
          const previous = unique[existingIndex];
          unique[existingIndex] = {
            ...previous,
            ...log,
            occurrenceCount: Math.max(1, Number(previous.occurrenceCount || 1), Number(log.occurrenceCount || 1)),
          };
          getActionEventIdentityKeys(unique[existingIndex]).forEach(identity => identityIndexes.set(identity, existingIndex));
          return;
        }
        const nextIndex = unique.length;
        identities.forEach(identity => identityIndexes.set(identity, nextIndex));
        unique.push({ ...log, occurrenceCount: Math.max(1, Number(log.occurrenceCount || 1)) });
      });
      segs.push({
        kind: aBufKind === 'browser' ? 'browser_action_group' : 'action_group',
        logs: unique,
        firstIdx: aBufFirstIdx === -1 ? idx : aBufFirstIdx,
        lastIdx: idx,
      });
      aBuf = [];
      aBufFirstIdx = -1;
      aBufKind = null;
    }
  };
  const pushActionLog = (log: any, idx: number) => {
    const nextKind = isBrowserActivityAction(log) ? 'browser' : 'standard';
    if (aBuf.length > 0 && aBufKind !== nextKind) flush(idx - 1);
    if (aBuf.length === 0) aBufFirstIdx = idx;
    aBufKind = nextKind;
    aBuf.push(log);
  };
  // Group and individual lifecycle events can arrive in either order. Reconcile
  // by immutable run ID first so reused task names never collapse distinct runs.
  const groupedSpawnRunIds = new Set<string>();
  const groupedLegacyNames = new Set<string>();
  timelineLogs.forEach((log: any) => {
    if (log.type === 'sub_agent_spawn' && (Array.isArray(log.agentDetails) || Array.isArray(log.spawnedAgents))) {
      const details = log.agentDetails || log.spawnedAgents || [];
      if (Array.isArray(details)) details.forEach((agent: any) => {
        if (typeof agent === 'string') {
          groupedLegacyNames.add(agent.toLowerCase().trim());
          return;
        }
        const runId = String(agent?.agentId || agent?.subAgentId || agent?.subAgentChatId || '').trim();
        if (runId) groupedSpawnRunIds.add(runId);
        else if (agent?.name) groupedLegacyNames.add(String(agent.name).toLowerCase().trim());
      });
    }
  });

  // Live transports often emit both a rich result/answer and a generic
  // completion event for the same worker. Keep one authoritative terminal
  // card per worker run so the main timeline does not repeat or flicker.
  const terminalAgentEventTypes = new Set([
    'sub_agent_answer', 'sub_agent_result', 'sub_agent_complete',
    'sub_agent_error', 'sub_agent_close',
  ]);
  const terminalAgentEventPriority: Record<string, number> = {
    sub_agent_complete: 1,
    sub_agent_close: 2,
    sub_agent_answer: 3,
    sub_agent_result: 3,
    sub_agent_error: 4,
  };
  const terminalAgentEventIndex = new Map<string, number>();
  const agentLifecycleIdentity = (log: any) => String(
    log?.subAgentChatId || log?.subAgentId || log?.agentId ||
    log?.taskId || log?.backgroundTaskId || log?.agentName || log?.subAgent || '',
  ).trim().toLowerCase();
  timelineLogs.forEach((log: any, index: number) => {
    if (!terminalAgentEventTypes.has(String(log?.type || ''))) return;
    const identity = agentLifecycleIdentity(log);
    if (!identity) return;
    const previousIndex = terminalAgentEventIndex.get(identity);
    if (previousIndex === undefined) {
      terminalAgentEventIndex.set(identity, index);
      return;
    }
    const previous = timelineLogs[previousIndex];
    const previousPriority = terminalAgentEventPriority[String(previous?.type || '')] || 0;
    const nextPriority = terminalAgentEventPriority[String(log?.type || '')] || 0;
    if (nextPriority >= previousPriority) terminalAgentEventIndex.set(identity, index);
  });
  const isSupersededTerminalAgentEvent = (log: any, index: number) => {
    if (!terminalAgentEventTypes.has(String(log?.type || ''))) return false;
    const identity = agentLifecycleIdentity(log);
    return Boolean(identity && terminalAgentEventIndex.get(identity) !== index);
  };

  timelineLogs.forEach((log, idx) => {
    if (log.type === 'thought_stream') {
      if (shouldRenderThoughtSegment(log, timelineLogs, idx)) {
        flush(idx - 1);
        segs.push({ kind: 'thought', log, idx });
      }
    }
    else if (log.type === 'work_note' || log.type === 'autonomy_proxy_status') {
      // Skip streaming-cancelled placeholders that were never replaced by a final note
      if (log._streamingCancelled) { /* intentionally omitted */ }
      else { flush(idx - 1); segs.push({ kind: 'note', log, idx }); }
    }

    else if (log.type === 'progress') {
      // Progress/status rows are chronological boundaries (rate limits,
      // retries, key rotation, runtime hand-offs). Keeping them inside the
      // surrounding action buffer moved them below every card in that group.
      flush(idx - 1);
      pushActionLog(log, idx);
      flush(idx);
    }
    else if (log.type === 'safety_warning') { flush(idx - 1); segs.push({ kind: 'safety', log, idx }); }
    else if (log.type === 'steering_received') { flush(idx - 1); segs.push({ kind: 'steering', log, idx }); }
    else if (log.type === 'sub_agent_answer' || log.type === 'sub_agent_result') {
      if (!isSupersededTerminalAgentEvent(log, idx)) {
        flush(idx - 1);
        segs.push({ kind: 'subagent_complete', log, idx });
      }
    }
    else if (log.type === 'sub_agent_complete') {
      if (!isSupersededTerminalAgentEvent(log, idx)) {
        flush(idx - 1);
        segs.push({ kind: 'subagent_complete', log, idx });
      }
    }
    else if (log.type === 'sub_agent_spawn') {
      // Skip the per-worker event when its exact run is already represented by
      // the group event. Name fallback is only for legacy events without IDs.
      const singleName = String(log.agentName || log.subAgent || '').toLowerCase().trim();
      const singleRunId = String(log.subAgentId || log.agentId || log.subAgentChatId || '').trim();
      const isTeamEvent = Array.isArray(log.agentDetails) || Array.isArray(log.spawnedAgents);
      const isDuplicate = !isTeamEvent && (
        (singleRunId && groupedSpawnRunIds.has(singleRunId)) ||
        (!singleRunId && singleName && groupedLegacyNames.has(singleName))
      );
      if (!isDuplicate) {
        flush(idx - 1);
        segs.push({ kind: 'subagent_spawn', log, idx });
      }
    }
    else if (log.type === 'sub_agent_error') {
      if (!isSupersededTerminalAgentEvent(log, idx)) {
        flush(idx - 1);
        segs.push({ kind: 'subagent_error', log, idx });
      }
    }
    else if (['sub_agent_pause', 'sub_agent_resume', 'sub_agent_close'].includes(log.type)) {
      if (!isSupersededTerminalAgentEvent(log, idx)) {
        flush(idx - 1);
        segs.push({ kind: 'subagent_status', log, idx });
      }
    }
    else if (log.type === 'sub_agent_action') {
      if (isSubAgentTab) {
        pushActionLog(log, idx);
      }
    }
    else if (log.type === 'inter_agent_comm' || log.type === 'inter_agent_message') {
      if (isSubAgentTab) {
        flush(idx - 1);
        segs.push({ kind: 'comm', log, idx });
      }
    }
    else if (log.type === 'ask_user') { flush(idx - 1); segs.push({ kind: 'ask_user', log, idx }); }
    else if (log.type === 'console_output') {
      const commandSnippet = String(log.command || '').trim().substring(0, 20);
      const hasCommandOwner = timelineLogs
        .slice(0, idx)
        .some((candidate: any) =>
          candidate?.type === 'command' &&
          (
            (log.ownerTraceId && [candidate.traceId, candidate.id, candidate._traceIdx].map(String).includes(String(log.ownerTraceId))) ||
            (Boolean(commandSnippet) && getTerminalCommandText(candidate, undefined, String(candidate.secondary || '')).includes(commandSnippet))
          )
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

  // Browser/computer work is one visible phase until a different action
  // family begins. Work notes emitted between browser calls remain inside the
  // same parent; a later browser phase after another tool gets a new parent.
  const displaySegs: any[] = [];
  for (let index = 0; index < segs.length; index += 1) {
    const segment = segs[index];
    if (segment.kind !== 'browser_action_group') {
      displaySegs.push(segment);
      continue;
    }

    const items = [segment];
    let cursor = index + 1;
    while (cursor < segs.length) {
      const candidate = segs[cursor];
      const isBrowserActions = candidate.kind === 'browser_action_group';
      const isBrowserWorkNote = candidate.kind === 'note' && candidate.log?.type === 'work_note';
      if (!isBrowserActions && !isBrowserWorkNote) break;
      if (isBrowserWorkNote) {
        let nextBoundary = cursor + 1;
        while (
          nextBoundary < segs.length &&
          segs[nextBoundary].kind === 'note' &&
          segs[nextBoundary].log?.type === 'work_note'
        ) nextBoundary += 1;
        const nextSegment = segs[nextBoundary];
        // Keep a trailing live note in the open browser phase, and keep notes
        // between related browser calls. If another tool follows, leave the
        // note outside so it remains paired with that new action phase.
        if (nextSegment && nextSegment.kind !== 'browser_action_group') break;
      }
      items.push(candidate);
      cursor += 1;
    }
    const tail = items[items.length - 1];
    displaySegs.push({
      kind: 'browser_phase',
      items,
      firstIdx: segment.firstIdx,
      lastIdx: tail.lastIdx ?? tail.idx ?? segment.lastIdx,
    });
    index = cursor - 1;
  }
  const latestDisplaySegment = displaySegs[displaySegs.length - 1];
  const latestBrowserActions = latestDisplaySegment?.kind === 'browser_phase'
    ? [...latestDisplaySegment.items]
      .reverse()
      .find((item: any) => item.kind === 'browser_action_group')
    : null;
  const latestBrowserAction = latestBrowserActions?.logs?.[latestBrowserActions.logs.length - 1];
  const browserPhaseOwnsLiveIndicator = Boolean(
    isThinking &&
    isLast &&
    latestDisplaySegment?.kind === 'browser_phase' &&
    !isExplicitlySettledAction(latestBrowserAction)
  );

  return (
    <div ref={containerRef} className="eterx-thinking-process-stack w-full flex flex-col gap-3 py-0">
      {displaySegs.map((seg, i) => {
        const nextSeg = displaySegs[i + 1];
        const prevSeg = displaySegs[i - 1];
        const phaseIsLastVisible = i === displaySegs.length - 1 || (seg.kind === 'note' && nextSeg?.kind === 'action_group' && i + 1 === displaySegs.length - 1);
        const phaseIsActive = isThinking && isLast && phaseIsLastVisible;

        if (seg.kind === 'thought') {
          // Provider state is authoritative. The global turn flag can lag
          // behind a final API chunk while polling commits the answer.
          const thoughtIsLive = isThoughtStreamOpen(seg.log);
          return <ProfessionalThought key={`t-${ getStreamRowIdentity(seg.log, seg.idx) }`} text={seg.log.text} isLatest={thoughtIsLive} isThinking={thoughtIsLive} startedAt={seg.log.startTime} updatedAt={seg.log.endTime} />;
        }
        if (seg.kind === 'note' && nextSeg?.kind === 'action_group') {
          const firstIdx = nextSeg.firstIdx ?? nextSeg.lastIdx ?? i;
          const groupKey = `phase-g-${ getActionIdentity(nextSeg.logs[0], firstIdx) }`;
          return (
            <div
              key={`phase-${ getStreamRowIdentity(seg.log, seg.idx) }-${ groupKey }`}
              className="eterx-phase-block flex w-full flex-col gap-2"
            >
              <WorkNoteBlock text={seg.log.text} isActive={phaseIsActive} isProxyStatus={seg.log.type === 'autonomy_proxy_status'} />
              <div>
                  <JoinedActionGroup
                    logs={nextSeg.logs}
                    isActiveGroup={phaseIsActive}
                    allLogs={timelineLogs}
                />
              </div>
            </div>
          );
        }
        if (seg.kind === 'note') return <WorkNoteBlock key={`n-${ getStreamRowIdentity(seg.log, seg.idx) }`} text={seg.log.text} isActive={isThinking && isLast && i === displaySegs.length - 1} isProxyStatus={seg.log.type === 'autonomy_proxy_status'} />;
        if (seg.kind === 'safety') return <SafetyBanner key={`sf-${ getTimelineRowIdentity(seg.log, seg.idx) }`} log={seg.log} />;
        if (seg.kind === 'steering') return <SteeringCard key={`steer-${ getTimelineRowIdentity(seg.log, seg.idx) }`} log={seg.log} onEdit={onEditUserMessage} />;
        if (seg.kind === 'subagent') return null;
        if (seg.kind === 'comm') {
          return isSubAgentTab
            ? <InterAgentCommCard key={`comm-${ getTimelineRowIdentity(seg.log, seg.idx) }`} log={seg.log} onOpenAgentTeam={onOpenAgentTeam} assetIndexes={assetIndexes} />
            : null;
        }
        if (seg.kind === 'subagent_action') return null;
        if (seg.kind === 'subagent_spawn') return <AgentCreatedCard key={`ss-${ getTimelineRowIdentity(seg.log, seg.idx) }`} log={seg.log} onOpenAgentTeam={onOpenAgentTeam} assetIndexes={assetIndexes} />;
        if (seg.kind === 'subagent_complete') {
          return <SubAgentCard key={`sc-${ getTimelineRowIdentity(seg.log, seg.idx) }`} log={seg.log} onOpenAgentTeam={onOpenAgentTeam} assetIndexes={assetIndexes} />;
        }
        if (seg.kind === 'subagent_error') {
          return <SubAgentErrorCard key={`se-${ getTimelineRowIdentity(seg.log, seg.idx) }`} log={seg.log} assetIndexes={assetIndexes} />;
        }
        if (seg.kind === 'subagent_status') {
          return <SubAgentCard key={`ss-${ getTimelineRowIdentity(seg.log, seg.idx) }`} log={seg.log} onOpenAgentTeam={onOpenAgentTeam} assetIndexes={assetIndexes} />;
        }
        if (seg.kind === 'ask_user') return <AskUserTimelineCard key={`ask-tl-${ getTimelineRowIdentity(seg.log, seg.idx) }`} log={seg.log} isLive={isThinking && isLast && i === displaySegs.length - 1 && !seg.log.answeredWith} />;
        if (seg.kind === 'console') return <TerminalTraceCard key={`console-${ getActionIdentity(seg.log, seg.idx) }`} log={seg.log} preview={seg.log} isLiveChip={isThinking && isLast && i === displaySegs.length - 1} />;
        if (seg.kind === 'browser_phase') {
          const firstActions = seg.items.find((item: any) => item.kind === 'browser_action_group');
          if (!firstActions?.logs?.[0]) return null;
          const firstIdx = firstActions?.firstIdx ?? seg.firstIdx ?? i;
          const phaseKey = `browser-${ getActionIdentity(firstActions.logs[0], firstIdx) }`;
          return (
            <BrowserActivityGroup
              key={phaseKey}
              items={seg.items}
              isActive={phaseIsActive}
              allLogs={timelineLogs}
            />
          );
        }
        if (seg.kind === 'action_group' && prevSeg?.kind === 'note') return null;

        const firstIdx = seg.firstIdx ?? seg.lastIdx ?? i;
        const groupKey = `g-${ getActionIdentity(seg.logs[0], firstIdx) }`;
        return <JoinedActionGroup key={groupKey} logs={seg.logs} isActiveGroup={isThinking && isLast && i === displaySegs.length - 1} allLogs={timelineLogs} />;
      })}
      {showLiveIndicator && isThinking && isLast && !browserPhaseOwnsLiveIndicator && <LiveWorkingIndicator key="live-working" logs={statusLogs} />}
    </div>
  );
};
