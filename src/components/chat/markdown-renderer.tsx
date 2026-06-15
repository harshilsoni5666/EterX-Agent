import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
// @ts-ignore
import ReactMarkdown from 'react-markdown';
// @ts-ignore
import remarkGfm from 'remark-gfm';
// @ts-ignore
import remarkMath from 'remark-math';
// @ts-ignore
import rehypeKatex from 'rehype-katex';
// @ts-ignore
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
// @ts-ignore
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Check, ChevronDown, Copy, Download, Maximize2, Minimize2, MoreHorizontal, WrapText } from 'lucide-react';
import { CopyButton } from '../ui/copy-button';
import { Tooltip } from '../ui/tooltip';
import { LiveArtifact } from './live-artifact';

/** Re-export remark/rehype plugins for use in other components */
export const remarkPlugins = [remarkGfm, remarkMath];
export const rehypePlugins = [rehypeKatex];

const MERMAID_LANGUAGE_ALIASES = new Set(['mermaid', 'mmd']);
const PLAIN_TEXT_LANGUAGE_ALIASES = new Set(['', 'text', 'txt', 'plain', 'plaintext']);
const MERMAID_START_PATTERN = /^\s*(?:graph|flowchart|sequenceDiagram|classDiagram|classDiagram-v2|stateDiagram|stateDiagram-v2|erDiagram|journey|gantt|pie|timeline|mindmap|quadrantChart|xychart-beta|block-beta|sankey-beta|gitGraph|C4Context|C4Container|C4Component|C4Dynamic)\b/i;
const CODE_FENCE_SPLIT = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
const MERMAID_FONT_FAMILY = 'var(--font-dm-sans), "DM Sans", Inter, system-ui, sans-serif';
const ACCIDENTAL_MARKDOWN_FENCE_LANGUAGES = new Set(['', 'md', 'markdown', 'text', 'txt', 'plain', 'plaintext', 'answer', 'response']);
const TABLE_SEPARATOR_PATTERN = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'section';

const getNodeText = (value: any): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(getNodeText).join('');
  if (React.isValidElement(value)) return getNodeText((value.props as any)?.children);
  if (value.children) return getNodeText(value.children);
  if (value.value) return String(value.value);
  return '';
};

const normalizeLatexOutsideCode = (value: string) =>
  value.split(CODE_FENCE_SPLIT).map((chunk) => {
    if (/^(```|~~~)/.test(chunk)) return chunk;
    return chunk
      .replace(/\\\[((?:.|\n)*?)\\\]/g, (_match, inner) => `\n\n$$\n${String(inner).trim()}\n$$\n\n`)
      .replace(/\\\((.*?)\\\)/g, (_match, inner) => `$${String(inner).trim()}$`)
      .replace(/\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}/g, (_match, env, body) => (
        `\n\n$$\n\\begin{${env}}\n${String(body).trim()}\n\\end{${env}}\n$$\n\n`
      ));
  }).join('');

const splitMarkdownTableCells = (line: string) => {
  const trimmed = line.trim();
  const body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return body.split('|').map(cell => cell.trim());
};

const isMarkdownTableSeparator = (line: string) => TABLE_SEPARATOR_PATTERN.test(line.trim());

const isPotentialMarkdownTableRow = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes('|') || isMarkdownTableSeparator(trimmed)) return false;
  const cells = splitMarkdownTableCells(trimmed);
  if (cells.length < 2) return false;
  return cells.some(Boolean);
};

const makeMarkdownTableSeparator = (line: string) => {
  const cells = splitMarkdownTableCells(line);
  if (line.trim().startsWith('|') || line.trim().endsWith('|')) {
    return `| ${cells.map(() => '---').join(' | ')} |`;
  }
  return cells.map(() => '---').join(' | ');
};

const repairMarkdownTablesOutsideCode = (value: string) =>
  value.split(CODE_FENCE_SPLIT).map((chunk) => {
    if (/^(```|~~~)/.test(chunk)) return chunk;

    const lines = chunk.split('\n');
    const repaired: string[] = [];
    let inTable = false;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const isSeparator = isMarkdownTableSeparator(line);
      const isRow = isPotentialMarkdownTableRow(line);
      const nextLine = lines[i + 1] || '';
      const nextIsSeparator = isMarkdownTableSeparator(nextLine);
      const nextIsRow = isPotentialMarkdownTableRow(nextLine);
      const isDelimitedRow = line.trim().startsWith('|') || line.trim().endsWith('|');

      repaired.push(line);

      if (isSeparator) {
        inTable = true;
        continue;
      }

      if (isRow) {
        if (!inTable && !nextIsSeparator && (nextIsRow || isDelimitedRow)) {
          repaired.push(makeMarkdownTableSeparator(line));
          inTable = true;
        }
        continue;
      }

      if (line.trim()) inTable = false;
    }

    return repaired.join('\n');
  }).join('');

const looksLikeCodePayload = (value: string, language: string) => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (language === 'md' || language === 'markdown' || language === 'answer' || language === 'response') return false;

  const hasMarkdownStructure = /(^|\n)\s*(#{1,6}\s+\S|[-+*]\s+\S|\d{1,2}[.)]\s+\S|>\s+\S|\|.+\|)/.test(trimmed);
  if (hasMarkdownStructure) return false;

  const proseWords = trimmed.match(/[A-Za-z]{2,}/g)?.length || 0;
  const proseSentences = /[.!?]\s+[A-Z0-9]/.test(trimmed);
  const codeSignals = [
    /^\s*(?:import|export|const|let|var|function|class|interface|type|enum|def|from|package|using|namespace|public|private|protected)\b/m,
    /^\s*(?:if|for|while|switch|try|catch)\s*\(/m,
    /^\s*[<{][\s\S]*[>}]\s*$/m,
    /;\s*(?:\/\/.*)?$/m,
  ].some(pattern => pattern.test(trimmed));

  return codeSignals && !(proseWords > 18 && proseSentences);
};

const unwrapAccidentalMarkdownFence = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(/^(```|~~~)([^\n]*)\n([\s\S]*?)\n?\1\s*$/);
  if (!match) return value;

  const language = match[2].trim().toLowerCase();
  if (!ACCIDENTAL_MARKDOWN_FENCE_LANGUAGES.has(language)) return value;

  const inner = match[3].trim();
  if (!inner || looksLikeCodePayload(inner, language)) return value;
  return inner;
};

export const normalizeMarkdownForRendering = (value: string) => {
  if (!value) return '';
  return repairMarkdownTablesOutsideCode(normalizeLatexOutsideCode(unwrapAccidentalMarkdownFence(value)))
    .replace(/\n{3,}(\$\$)/g, '\n\n$1')
    .replace(/(\$\$)\n{3,}/g, '$1\n\n');
};

const getCurrentTheme = () => {
  if (typeof document === 'undefined') return 'light';
  const root = document.documentElement;
  const theme = root.getAttribute('data-theme');
  if (theme === 'light' || theme === 'dark') return theme;
  if (root.classList.contains('light')) return 'light';
  if (root.classList.contains('dark')) return 'dark';
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
};

const useResolvedTheme = () => {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => getCurrentTheme() as 'dark' | 'light');

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const syncTheme = () => setTheme(getCurrentTheme() as 'dark' | 'light');
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => observer.disconnect();
  }, []);

  return theme;
};

const useClipboard = (text: string, timeout = 1600) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), timeout);
    } catch (error) {
      console.error('Copy failed:', error);
    }
  };

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { copied, copy };
};

const ToolbarButton = ({
  label,
  activeLabel,
  active = false,
  onClick,
  children,
}: {
  label: string;
  activeLabel?: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <Tooltip text={active && activeLabel ? activeLabel : label} side="bottom">
    <button
      type="button"
      onClick={onClick}
      className="eterx-markdown-tool-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.035] text-[#8C8A88] transition-all duration-200 hover:bg-white/[0.07] hover:text-[#E8E6E3] active:scale-95"
      aria-label={active && activeLabel ? activeLabel : label}
      data-active={active ? 'true' : 'false'}
    >
      {children}
    </button>
  </Tooltip>
);

const CopyToolbarButton = ({ text, label = 'Copy' }: { text: string; label?: string }) => {
  const { copied, copy } = useClipboard(text);
  return (
    <ToolbarButton label={label} activeLabel="Copied" active={copied} onClick={copy}>
      {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
    </ToolbarButton>
  );
};

const looksLikeMermaid = (content: string) => MERMAID_START_PATTERN.test(content);

const isCompactPlainTextBlock = (language: string, content: string) => {
  const lang = (language || '').toLowerCase();
  const trimmed = content.trim();
  if (!PLAIN_TEXT_LANGUAGE_ALIASES.has(lang)) return false;
  if (!trimmed || trimmed.includes('\n')) return false;
  if (looksLikeMermaid(trimmed)) return false;
  return trimmed.length <= 80;
};

const CompactPlainTextBlock = ({ content }: { content: string }) => (
  <span className="eterx-markdown-plain-snippet">{content.trim()}</span>
);

const downloadTextFile = (content: string, filename: string, type: string) => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
};

const svgToPngBlob = async (svg: string, scale = 2): Promise<Blob> => {
  const { width, height } = getSvgViewBoxSize(svg);
  const background = getCurrentTheme() === 'light' ? '#FFFFFF' : '#151515';
  const exportSvg = svg
    .replace(/<svg\b(?![^>]*\sxmlns=)/i, '<svg xmlns="http://www.w3.org/2000/svg"')
    .replace(/<svg\b([^>]*)>/i, (_match, attrs) => {
      const nextAttrs = String(attrs)
        .replace(/\swidth=["'][^"']*["']/i, '')
        .replace(/\sheight=["'][^"']*["']/i, '')
        .replace(/\sstyle=["'][^"']*["']/i, '');
      return `<svg${nextAttrs} width="${Math.ceil(width)}" height="${Math.ceil(height)}" style="background:${background}">`;
    });
  const svgBlob = new Blob([exportSvg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  try {
    const image = new Image();
    image.decoding = 'async';
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Unable to rasterize SVG'));
    });
    image.src = url;
    await loaded;

    const rasterWidth = Math.max(1, image.naturalWidth || image.width || width || 1200);
    const rasterHeight = Math.max(1, image.naturalHeight || image.height || height || 800);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(rasterWidth * scale);
    canvas.height = Math.ceil(rasterHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0, rasterWidth, rasterHeight);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('PNG export failed'));
      }, 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
};

const getSvgViewBoxSize = (svg: string) => {
  const viewBoxMatch = svg.match(/\sviewBox=["']([^"']+)["']/i);
  if (viewBoxMatch) {
    const [, , width, height] = viewBoxMatch[1]
      .trim()
      .split(/[\s,]+/)
      .map(value => Number(value));
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  const widthMatch = svg.match(/\swidth=["'](\d+(?:\.\d+)?)/i);
  const heightMatch = svg.match(/\sheight=["'](\d+(?:\.\d+)?)/i);
  const width = widthMatch ? Number(widthMatch[1]) : 0;
  const height = heightMatch ? Number(heightMatch[1]) : 0;
  return {
    width: Number.isFinite(width) && width > 0 ? width : 720,
    height: Number.isFinite(height) && height > 0 ? height : 460,
  };
};

const escapeMermaidLabel = (label: string) =>
  label
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\s+/g, ' ')
    .trim();

const shouldQuoteMermaidLabel = (label: string) =>
  /[:()[\]{}<>{}|,;/\\#%&=+*'"`]/.test(label) || /\s{2,}/.test(label);

const quoteFlowNodeLabels = (line: string) =>
  line
    .replace(/([A-Za-z][\w-]*)\[([^\]\n"]+)\]/g, (match, id, label) => (
      shouldQuoteMermaidLabel(label) ? `${id}["${escapeMermaidLabel(label)}"]` : match
    ))
    .replace(/([A-Za-z][\w-]*)\{([^}\n"]+)\}/g, (match, id, label) => (
      shouldQuoteMermaidLabel(label) ? `${id}{"${escapeMermaidLabel(label)}"}` : match
    ));

const normalizeSubgraphLine = (line: string, index: number) => {
  const match = line.match(/^(\s*)subgraph\s+(.+?)\s*$/i);
  if (!match) return line;
  const [, indent, body] = match;
  const trimmed = body.trim();
  if (!trimmed || /^end$/i.test(trimmed) || /\[["']?.+["']?\]$/.test(trimmed)) return line;

  const idTitleMatch = trimmed.match(/^([A-Za-z][\w-]*)\s+(.+)$/);
  if (idTitleMatch && shouldQuoteMermaidLabel(idTitleMatch[2])) {
    return `${indent}subgraph ${idTitleMatch[1]}["${escapeMermaidLabel(idTitleMatch[2])}"]`;
  }

  if (shouldQuoteMermaidLabel(trimmed)) {
    return `${indent}subgraph sg_${index}["${escapeMermaidLabel(trimmed)}"]`;
  }

  return line;
};

const repairMermaidChart = (chart: string) => {
  const stripped = chart
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^\s*```(?:mermaid|mmd)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\u00A0/g, ' ')
    .trim();

  if (!stripped) return '';

  return stripped
    .split('\n')
    .map((line, index) => {
      const withoutBullets = line.replace(/^(\s*)[-*]\s+(?=(?:graph|flowchart|subgraph|end|[A-Za-z][\w-]*\b))/i, '$1');
      const subgraphSafe = normalizeSubgraphLine(withoutBullets, index + 1);
      return quoteFlowNodeLabels(subgraphSafe);
    })
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
};

const getMermaidCandidates = (chart: string) => {
  const normalized = chart.replace(/\r\n?/g, '\n').trim();
  const repaired = repairMermaidChart(chart);
  return Array.from(new Set([normalized, repaired].filter(Boolean)));
};

const getMermaidDisplayWidth = ({ width, height }: { width: number; height: number }) => {
  const safeWidth = Math.max(1, width || 720);
  const safeHeight = Math.max(1, height || 460);
  const aspect = safeWidth / safeHeight;

  if (safeWidth >= 900) return Math.min(safeWidth, 1080);
  if (aspect < 0.45) return Math.min(520, Math.max(340, safeWidth * 1.35));
  if (aspect < 0.9) return Math.min(700, Math.max(440, safeWidth * 1.35));
  return Math.min(940, Math.max(560, safeWidth * 1.08));
};

type MermaidThemeName = 'light' | 'dark';

type MermaidPalette = {
  background: string;
  text: string;
  mutedText: string;
  nodeFill: string;
  nodeStroke: string;
  nodeFillVariants: string[];
  nodeStrokeVariants: string[];
  clusterFill: string;
  clusterStroke: string;
  edge: string;
  labelBackground: string;
  noteFill: string;
  noteStroke: string;
};

const MERMAID_PALETTES: Record<MermaidThemeName, MermaidPalette> = {
  light: {
    background: '#FFFFFF',
    text: '#1F1F1D',
    mutedText: '#55514A',
    nodeFill: '#F6F4EF',
    nodeStroke: '#C8C1B5',
    nodeFillVariants: ['#F4F7FB', '#F7F3EA', '#F1F8F3', '#F6F0F6', '#EEF6F7', '#FAF4EE'],
    nodeStrokeVariants: ['#B9C9DA', '#D7C7A9', '#B7D0BE', '#D0BDD2', '#AECBD0', '#D8BEAA'],
    clusterFill: '#FAF9F6',
    clusterStroke: '#DDD7CE',
    edge: '#74706A',
    labelBackground: '#FFFFFF',
    noteFill: '#FFF7E8',
    noteStroke: '#DEC99D',
  },
  dark: {
    background: '#151515',
    text: '#F0EDE8',
    mutedText: '#C8C1B8',
    nodeFill: '#242321',
    nodeStroke: '#555047',
    nodeFillVariants: ['#242B32', '#2B2822', '#223028', '#2C2630', '#223033', '#302722'],
    nodeStrokeVariants: ['#526577', '#6A5A41', '#4D6655', '#66536B', '#4C6870', '#6A5547'],
    clusterFill: '#1B1A18',
    clusterStroke: '#403D37',
    edge: '#B0AAA1',
    labelBackground: '#151515',
    noteFill: '#2A251B',
    noteStroke: '#6E5A33',
  },
};

const nodeShapeSelector = (prefix: string) => [
  `${prefix} rect`,
  `${prefix} circle`,
  `${prefix} ellipse`,
  `${prefix} polygon`,
  `${prefix} path`,
].join(',\n');

const getMermaidThemeCss = (theme: MermaidThemeName) => {
  const palette = MERMAID_PALETTES[theme];
  const variantRules = palette.nodeFillVariants.map((fill, index) => {
    const stroke = palette.nodeStrokeVariants[index] || palette.nodeStroke;
    const selector = nodeShapeSelector(`.nodes .node:nth-child(${palette.nodeFillVariants.length}n + ${index + 1})`);
    return `${selector} {
  fill: ${fill} !important;
  stroke: ${stroke} !important;
}`;
  }).join('\n\n');

  return `
svg {
  background: transparent !important;
  font-family: ${MERMAID_FONT_FAMILY} !important;
}

text,
.label,
.nodeLabel,
.node text,
.label text,
.cluster-label text,
.sectionTitle,
.messageText,
.loopText,
.noteText {
  fill: ${palette.text} !important;
  color: ${palette.text} !important;
  font-family: ${MERMAID_FONT_FAMILY} !important;
  letter-spacing: 0 !important;
}

${nodeShapeSelector('.node')} {
  fill: ${palette.nodeFill} !important;
  stroke: ${palette.nodeStroke} !important;
  stroke-width: 1.45px !important;
  filter: none !important;
}

${variantRules}

.cluster rect,
.cluster polygon,
.cluster path {
  fill: ${palette.clusterFill} !important;
  stroke: ${palette.clusterStroke} !important;
  stroke-width: 1.25px !important;
}

.flowchart-link,
.edgePath .path,
.messageLine0,
.messageLine1,
.transition {
  stroke: ${palette.edge} !important;
}

.arrowheadPath,
marker path {
  fill: ${palette.edge} !important;
  stroke: ${palette.edge} !important;
}

.edgeLabel,
.edgeLabel p,
.edgeLabel span,
.edgeLabel text {
  color: ${palette.mutedText} !important;
  fill: ${palette.mutedText} !important;
  background: ${palette.labelBackground} !important;
}

.edgeLabel rect,
.labelBkg {
  fill: ${palette.labelBackground} !important;
  opacity: 0.94 !important;
}

.note,
.noteBox {
  fill: ${palette.noteFill} !important;
  stroke: ${palette.noteStroke} !important;
}

.actorBox {
  fill: ${palette.nodeFill} !important;
  stroke: ${palette.nodeStroke} !important;
}
`.trim();
};

const injectMermaidThemeCss = (svg: string, theme: MermaidThemeName) => {
  const style = `<style data-eterx-mermaid-theme="${theme}">\n${getMermaidThemeCss(theme)}\n</style>`;
  if (/<\/svg>\s*$/i.test(svg)) {
    return svg.replace(/<\/svg>\s*$/i, `${style}</svg>`);
  }
  return `${svg}${style}`;
};

const MermaidDiagram = ({ chart }: { chart: string }) => {
  const theme = useResolvedTheme();
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const chartId = useMemo(() => `eterx-mermaid-${reactId || Math.random().toString(36).slice(2)}`, [reactId]);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [renderedChart, setRenderedChart] = useState(chart);
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionStatus, setActionStatus] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [svgSize, setSvgSize] = useState({ width: 720, height: 460 });
  const renderTokenRef = useRef(0);
  const errorTimerRef = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const displayWidth = useMemo(() => getMermaidDisplayWidth(svgSize), [svgSize]);

  useEffect(() => {
    let cancelled = false;
    const token = renderTokenRef.current + 1;
    renderTokenRef.current = token;
    if (errorTimerRef.current) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    setError('');
    setSvg('');

    const render = async () => {
      try {
        const mermaidModule = await import('mermaid');
        const mermaid = mermaidModule.default;
        const palette = MERMAID_PALETTES[theme];
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          fontFamily: MERMAID_FONT_FAMILY,
          flowchart: {
            curve: 'basis',
            htmlLabels: false,
            nodeSpacing: 34,
            rankSpacing: 48,
            padding: 12,
          },
          sequence: { showSequenceNumbers: false, mirrorActors: false },
          themeCSS: getMermaidThemeCss(theme),
          themeVariables: {
            background: palette.background,
            primaryColor: palette.nodeFill,
            primaryTextColor: palette.text,
            primaryBorderColor: palette.nodeStroke,
            mainBkg: palette.nodeFill,
            nodeBorder: palette.nodeStroke,
            nodeTextColor: palette.text,
            textColor: palette.text,
            titleColor: palette.text,
            labelTextColor: palette.text,
            lineColor: palette.edge,
            defaultLinkColor: palette.edge,
            edgeLabelBackground: palette.labelBackground,
            secondaryColor: palette.nodeFillVariants[1],
            tertiaryColor: palette.clusterFill,
            clusterBkg: palette.clusterFill,
            clusterBorder: palette.clusterStroke,
            actorBkg: palette.nodeFill,
            actorBorder: palette.nodeStroke,
            actorTextColor: palette.text,
            signalColor: palette.edge,
            signalTextColor: palette.text,
            noteBkgColor: palette.noteFill,
            noteBorderColor: palette.noteStroke,
            noteTextColor: palette.text,
            fontSize: '15px',
            fontFamily: MERMAID_FONT_FAMILY,
          },
        });

        const candidates = getMermaidCandidates(chart);
        let lastError: any = null;

        for (const candidate of candidates) {
          try {
            await mermaid.parse(candidate);
            const result = await mermaid.render(`${chartId}-${theme}-${token}-${candidates.indexOf(candidate)}`, candidate);
            if (!cancelled && renderTokenRef.current === token) {
              const themedSvg = injectMermaidThemeCss(result.svg, theme);
              setRenderedChart(candidate);
              setSvg(themedSvg);
              setSvgSize(getSvgViewBoxSize(themedSvg));
            }
            return;
          } catch (candidateError) {
            lastError = candidateError;
          }
        }

        throw lastError || new Error('Unable to render Mermaid diagram');
      } catch (err: any) {
        if (!cancelled && renderTokenRef.current === token) {
          setSvg('');
          setRenderedChart(repairMermaidChart(chart) || chart);
          const message = String(err?.message || err || 'Unable to render Mermaid diagram');
          errorTimerRef.current = window.setTimeout(() => {
            if (!cancelled && renderTokenRef.current === token) setError(message);
          }, 900);
        }
      }
    };

    render();
    return () => {
      cancelled = true;
      if (errorTimerRef.current) {
        window.clearTimeout(errorTimerRef.current);
        errorTimerRef.current = null;
      }
    };
  }, [chart, chartId, theme]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeMenu = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', closeMenu);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('mousedown', closeMenu);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  const flashStatus = (message: string) => {
    setActionStatus(message);
    window.setTimeout(() => setActionStatus(''), 1800);
  };

  const copyText = async (value: string, label: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    flashStatus(label);
  };

  const copyPng = async () => {
    if (!svg) return;
    const blob = await svgToPngBlob(svg);
    const clipboardApi = navigator.clipboard as any;
    if (clipboardApi?.write && typeof ClipboardItem !== 'undefined') {
      await clipboardApi.write([new ClipboardItem({ 'image/png': blob })]);
      flashStatus('Copied PNG');
      return;
    }
    downloadBlob(blob, 'eterx-diagram.png');
    flashStatus('Downloaded PNG');
  };

  const downloadPng = async () => {
    if (!svg) return;
    const blob = await svgToPngBlob(svg);
    downloadBlob(blob, 'eterx-diagram.png');
    flashStatus('Downloaded PNG');
  };

  const runAction = async (action: () => void | Promise<void>) => {
    try {
      await action();
    } catch (err: any) {
      flashStatus(String(err?.message || 'Action failed'));
    } finally {
      setMenuOpen(false);
    }
  };

  const canvasStyle = {
    '--eterx-mermaid-display-width': `${displayWidth}px`,
  } as React.CSSProperties;

  if (error && !svg) return null;

  return (
    <div className={`eterx-mermaid-card group/mermaid relative my-5 mx-auto max-w-full overflow-visible ${expanded ? 'eterx-mermaid-expanded' : ''}`} style={canvasStyle}>
      <div ref={menuRef} className="eterx-mermaid-toolbar absolute right-1 top-1 z-30 flex items-center opacity-75 transition-opacity duration-200 group-hover/mermaid:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          className="eterx-mermaid-trigger"
          aria-label="Diagram actions"
          aria-expanded={menuOpen}
          title="Diagram actions"
          onClick={() => setMenuOpen(value => !value)}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {menuOpen && (
          <div className="eterx-mermaid-menu absolute right-0 top-10 z-40 w-[230px] overflow-hidden rounded-2xl border border-white/[0.09] bg-[#191817]/96 p-1.5 shadow-[0_18px_48px_rgba(0,0,0,0.34)] backdrop-blur-xl">
            <button type="button" className="eterx-mermaid-menu-item" disabled={!svg} onClick={() => runAction(copyPng)}>
              <Copy className="h-4 w-4" />
              <span>Copy image</span>
            </button>
            <button type="button" className="eterx-mermaid-menu-item" onClick={() => runAction(() => copyText(renderedChart, 'Copied code'))}>
              <Copy className="h-4 w-4" />
              <span>Copy Mermaid code</span>
            </button>
            <button type="button" className="eterx-mermaid-menu-item" disabled={!svg} onClick={() => runAction(() => copyText(svg, 'Copied SVG'))}>
              <Copy className="h-4 w-4" />
              <span>Copy SVG code</span>
            </button>
            <div className="eterx-mermaid-menu-separator" />
            <button type="button" className="eterx-mermaid-menu-item" disabled={!svg} onClick={() => runAction(downloadPng)}>
              <Download className="h-4 w-4" />
              <span>Download PNG</span>
            </button>
            <button type="button" className="eterx-mermaid-menu-item" disabled={!svg} onClick={() => runAction(() => { downloadTextFile(svg, 'eterx-diagram.svg', 'image/svg+xml'); flashStatus('Downloaded SVG'); })}>
              <Download className="h-4 w-4" />
              <span>Download SVG</span>
            </button>
            <button type="button" className="eterx-mermaid-menu-item" onClick={() => runAction(() => { downloadTextFile(renderedChart, 'eterx-diagram.mmd', 'text/plain'); flashStatus('Downloaded code'); })}>
              <Download className="h-4 w-4" />
              <span>Download .mmd</span>
            </button>
            <div className="eterx-mermaid-menu-separator" />
            <button type="button" className="eterx-mermaid-menu-item" disabled={!svg} onClick={() => runAction(() => setPreviewOpen(true))}>
              <Maximize2 className="h-4 w-4" />
              <span>Open large view</span>
            </button>
            <button type="button" className="eterx-mermaid-menu-item" onClick={() => runAction(() => setExpanded(value => !value))}>
              {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              <span>{expanded ? 'Fit inline' : 'Expand inline'}</span>
            </button>
            <button type="button" className="eterx-mermaid-menu-item" onClick={() => runAction(() => setShowSource(value => !value))}>
              <ChevronDown className={`h-4 w-4 transition-transform ${showSource ? 'rotate-180' : ''}`} />
              <span>{showSource ? 'Hide source' : 'Show source'}</span>
            </button>
          </div>
        )}
      </div>
      {actionStatus && (
        <div className="eterx-mermaid-toast absolute right-2 top-12 z-20 rounded-full border border-white/[0.08] bg-[#151515]/86 px-3 py-1.5 text-[12px] font-medium text-[#B8B4AC] shadow-[0_8px_22px_rgba(0,0,0,0.22)] backdrop-blur-md">
          {actionStatus}
        </div>
      )}

      <div className="eterx-mermaid-stage custom-scrollbar overflow-auto">
        {svg ? (
          <div
            className="eterx-mermaid-canvas mx-auto"
            style={canvasStyle}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="eterx-mermaid-skeleton" style={canvasStyle}>
            <div className="eterx-mermaid-skeleton-title" />
            <div className="eterx-mermaid-skeleton-node eterx-mermaid-skeleton-node-a" />
            <div className="eterx-mermaid-skeleton-line" />
            <div className="eterx-mermaid-skeleton-node eterx-mermaid-skeleton-node-b" />
            <div className="eterx-mermaid-skeleton-line" />
            <div className="eterx-mermaid-skeleton-node eterx-mermaid-skeleton-node-c" />
          </div>
        )}
      </div>

      {showSource && (
        <div className="eterx-mermaid-source border-t border-white/[0.07]">
          <CodeBlock language="mermaid" content={renderedChart} forceSource />
        </div>
      )}
      {previewOpen && typeof document !== 'undefined' && createPortal(
        <div className="eterx-mermaid-popout" role="dialog" aria-modal="true" aria-label="Large diagram view" onClick={() => setPreviewOpen(false)}>
          <div className="eterx-mermaid-popout-panel" onClick={(event) => event.stopPropagation()}>
            <div className="eterx-mermaid-popout-toolbar">
              <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#D0CDC7]">Diagram preview</div>
              <button type="button" className="eterx-mermaid-popout-button" onClick={() => runAction(copyPng)}>Copy image</button>
              <button type="button" className="eterx-mermaid-popout-button" onClick={() => runAction(downloadPng)}>Download PNG</button>
              <button type="button" className="eterx-mermaid-popout-close" aria-label="Close large diagram view" onClick={() => setPreviewOpen(false)}>Close</button>
            </div>
            <div className="eterx-mermaid-popout-stage custom-scrollbar">
              <div className="eterx-mermaid-popout-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

const CodeBlock = ({ language, content, forceSource = false, ...props }: { language: string; content: string; forceSource?: boolean; [key: string]: any }) => {
  const [wrapLines, setWrapLines] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const lineCount = Math.max(1, content.split(/\r?\n/).length);
  const isLong = lineCount > 32 || content.length > 3200;
  const displayLanguage = language || 'text';

  if (!forceSource && MERMAID_LANGUAGE_ALIASES.has(displayLanguage.toLowerCase())) {
    return <MermaidDiagram chart={content} />;
  }

  if (!forceSource && !language && looksLikeMermaid(content)) {
    return <MermaidDiagram chart={content} />;
  }

  if (!forceSource && isCompactPlainTextBlock(displayLanguage, content)) {
    return <CompactPlainTextBlock content={content} />;
  }

  return (
    <div
      className={`eterx-markdown-code-block group/code relative my-5 flex max-w-full flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#1C1B1A] shadow-[0_10px_28px_rgba(0,0,0,0.16)] ${expanded ? 'eterx-code-expanded' : ''}`}
      data-language={displayLanguage}
    >
      <div className="eterx-markdown-code-actions absolute right-2 top-2 z-20 flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#1C1B1A]/86 p-1 opacity-55 shadow-[0_8px_22px_rgba(0,0,0,0.22)] backdrop-blur-md transition-opacity duration-200 group-hover/code:opacity-100">
        <ToolbarButton label={wrapLines ? 'Disable wrap' : 'Wrap lines'} active={wrapLines} onClick={() => setWrapLines(value => !value)}>
          <WrapText className="h-4 w-4" />
        </ToolbarButton>
        {isLong && (
          <ToolbarButton label={expanded ? 'Collapse code' : 'Expand code'} active={expanded} onClick={() => setExpanded(value => !value)}>
            {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </ToolbarButton>
        )}
        <CopyButton
          text={content}
          side="bottom"
          className="eterx-markdown-copy-button h-8 w-8 border border-white/[0.08] bg-white/[0.035] text-[#8C8A88] hover:bg-white/[0.07] hover:text-[#E8E6E3]"
        />
      </div>
      <div className={`eterx-markdown-code-scroll custom-scrollbar overflow-auto ${isLong && !expanded ? 'max-h-[520px]' : ''}`}>
        <SyntaxHighlighter
          style={vscDarkPlus as any}
          language={displayLanguage}
          PreTag="div"
          showLineNumbers={false}
          wrapLongLines={wrapLines}
          className="eterx-markdown-code-content code-span min-w-full text-[13.5px] leading-relaxed font-mono"
          customStyle={{
            margin: 0,
            background: 'var(--eterx-md-code-bg)',
            padding: '1.05rem 4.35rem 1.1rem 1.1rem',
            minWidth: '100%',
          }}
          codeTagProps={{
            style: {
              fontFamily: 'var(--font-mono)',
              whiteSpace: wrapLines ? 'pre-wrap' : 'pre',
              overflowWrap: wrapLines ? 'anywhere' : 'normal',
            },
          }}
          {...props}
        >
          {content}
        </SyntaxHighlighter>
      </div>
    </div>
  );
};

const makeHeading = (Tag: keyof JSX.IntrinsicElements, className: string) => {
  const Heading = ({ node, children, ...props }: any) => {
    const text = getNodeText(children);
    const id = props.id || slugify(text);
    return React.createElement(
      Tag,
      {
        ...props,
        id,
        className: `${className} eterx-md-heading group/heading scroll-mt-28`,
      },
      <>
        <a
          href={`#${id}`}
          className="eterx-md-heading-anchor mr-2 inline-flex translate-y-[-1px] text-[#5E5A55] opacity-0 transition-opacity group-hover/heading:opacity-100"
          aria-label={`Link to ${text || 'section'}`}
        >
          #
        </a>
        {children}
      </>
    );
  };
  return Heading;
};

export const markdownComponents = {
  code({ inline, className, children, ...props }: any) {
    const match = /language-([^\s]+)/.exec(className || '');
    const language = match ? match[1].toLowerCase() : '';
    const content = String(children).replace(/\n$/, '');

    if (!inline && language === 'js-preview') {
      return <LiveArtifact js={content} title="JS Logic Preview" />;
    }

    if (!inline && language === 'html-preview') {
      return <LiveArtifact html={content} title="HTML Preview" />;
    }

    if (!inline && (language === 'react-preview' || language === 'preview')) {
      return <LiveArtifact html={content} title="Preview" />;
    }

    if (!inline) {
      return <CodeBlock language={language} content={content} {...props} />;
    }

    return (
      <code className="eterx-markdown-inline-code rounded-md border border-white/[0.08] bg-[#363432] px-1.5 py-0.5 font-mono text-[13.5px] text-[#E2765A]" {...props}>
        {children}
      </code>
    );
  },
  p: ({ ...props }: any) => <p className="mb-4 break-words leading-[1.75] last:mb-0" {...props} />,
  a: ({ ...props }: any) => <a className="eterx-markdown-link text-[#E2765A] underline-offset-2 hover:underline" target="_blank" rel="noopener noreferrer" {...props} />,
  ul: ({ ...props }: any) => <ul className="eterx-markdown-list mb-4 list-disc space-y-1.5 pl-6 marker:text-[#8C8A88]" {...props} />,
  ol: ({ ...props }: any) => <ol className="eterx-markdown-list mb-4 list-decimal space-y-1.5 pl-6 marker:text-[#8C8A88]" {...props} />,
  li: ({ ...props }: any) => <li className="eterx-markdown-list-item leading-[1.7]" {...props} />,
  input: ({ type, ...props }: any) => type === 'checkbox'
    ? <input type="checkbox" className="eterx-markdown-checkbox mr-2 h-4 w-4 translate-y-[2px] rounded border-white/20 accent-[#E2765A]" {...props} />
    : <input type={type} {...props} />,
  h1: makeHeading('h1', 'mt-8 mb-4 text-[24px] font-bold leading-tight text-[#EBEAE6]'),
  h2: makeHeading('h2', 'mt-7 mb-3 text-[20px] font-bold leading-tight text-[#EBEAE6]'),
  h3: makeHeading('h3', 'mt-6 mb-3 text-[17px] font-bold leading-tight text-[#EBEAE6]'),
  h4: makeHeading('h4', 'mt-5 mb-2 text-[15px] font-semibold leading-tight text-[#EBEAE6]'),
  h5: makeHeading('h5', 'mt-4 mb-2 text-[14px] font-semibold leading-tight text-[#D5D3CE]'),
  h6: makeHeading('h6', 'mt-3 mb-2 text-[13px] font-semibold leading-tight text-[#BCB9B4]'),
  strong: ({ ...props }: any) => <strong className="font-bold text-[#F3F2EF]" {...props} />,
  em: ({ ...props }: any) => <em className="italic text-[#D5D3CE]" {...props} />,
  blockquote: ({ node, ...props }: any) => {
    const quoteText = getNodeText(node).trim().toLowerCase();
    const callout = quoteText.startsWith('warning:') || quoteText.startsWith('caution:')
      ? 'warning'
      : quoteText.startsWith('tip:') || quoteText.startsWith('note:') || quoteText.startsWith('important:')
        ? 'note'
        : 'quote';
    return (
      <blockquote
        className="eterx-markdown-callout my-4 rounded-r-xl border-l-[3px] border-[#E2765A]/55 bg-[#2A2927] px-4 py-3 text-[#D2CECA]"
        data-callout={callout}
        {...props}
      />
    );
  },
  hr: ({ ...props }: any) => <hr className="eterx-markdown-hr my-6 border-white/10" {...props} />,
  table: ({ ...props }: any) => (
    <div className="eterx-markdown-table-wrap custom-scrollbar my-5 overflow-x-auto rounded-2xl border border-white/[0.08] shadow-sm">
      <table className="eterx-markdown-table w-full min-w-[620px] border-collapse text-[14px]" {...props} />
    </div>
  ),
  thead: ({ ...props }: any) => <thead className="eterx-markdown-thead bg-[#1C1B1A]" {...props} />,
  th: ({ ...props }: any) => <th className="eterx-markdown-th border border-white/[0.06] px-4 py-2.5 text-left font-bold text-[#EBEAE6]" {...props} />,
  td: ({ ...props }: any) => <td className="eterx-markdown-td border border-white/[0.06] px-4 py-2.5 align-top text-[#D5D3CE]" {...props} />,
  tr: ({ ...props }: any) => <tr className="eterx-markdown-tr transition-colors hover:bg-white/[0.035]" {...props} />,
  img: ({ alt, ...props }: any) => (
    <figure className="eterx-markdown-figure my-5">
      <img className="eterx-markdown-image max-w-full rounded-xl border border-white/[0.08] shadow-md" alt={alt || ''} loading="lazy" {...props} />
      {alt && <figcaption className="mt-2 text-center text-[12px] text-[#7B7770]">{alt}</figcaption>}
    </figure>
  ),
};
