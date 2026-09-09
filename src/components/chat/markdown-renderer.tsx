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
import { Check, ChevronDown, Copy, Download, Globe2, Maximize2, Minimize2, MoreHorizontal, WrapText } from 'lucide-react';
import { CopyButton, safeCopyTextToClipboard, safeCopyPngToClipboard } from '../ui/copy-button';
import { Tooltip } from '../ui/tooltip';
import { LiveArtifact } from './live-artifact';
import { LocalFileLinkChip, decodeLocalFileHref, isLocalFilePath } from './local-file-link';

// Text paints immediately. Expensive code/diagram work is settled once its
// stream closes instead of retokenizing a growing block on every word.
export const MarkdownStreamContext = React.createContext(false);

/** Re-export remark/rehype plugins for use in other components */
export const remarkPlugins: any[] = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: true }],
];
export const rehypePlugins: any[] = [[rehypeKatex, {
  throwOnError: false,
  strict: 'ignore',
  trust: false,
  output: 'htmlAndMathml',
  macros: {
    '\\RR': '\\mathbb{R}',
    '\\NN': '\\mathbb{N}',
    '\\ZZ': '\\mathbb{Z}',
    '\\QQ': '\\mathbb{Q}',
    '\\CC': '\\mathbb{C}',
  },
}]];

const MERMAID_LANGUAGE_ALIASES = new Set(['mermaid', 'mmd']);
const MERMAID_FONT_FAMILY = '"Segoe UI", -apple-system, BlinkMacSystemFont, Arial, sans-serif';
const PROTECTED_MARKDOWN_CODE_SPLIT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*?`+)/g;

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

const getWebsiteLinkMeta = (href?: string) => {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const hostname = url.hostname.replace(/^www\./i, '');
    return {
      hostname,
      faviconUrl: `${url.origin}/favicon.ico`,
    };
  } catch {
    return null;
  }
};

export const WebsiteLink = React.memo(({
  href,
  children,
  className = '',
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
  const website = useMemo(() => getWebsiteLinkMeta(href), [href]);
  const [failedFaviconUrl, setFailedFaviconUrl] = useState('');

  if (!website) {
    return (
      <a
        className={`eterx-markdown-link font-medium underline-offset-3 transition-colors hover:underline ${className}`}
        target="_blank"
        rel="noopener noreferrer"
        href={href}
        {...props}
      >
        {children}
      </a>
    );
  }

  return (
    <a
      className={`eterx-website-link ${className}`}
      target="_blank"
      rel="noopener noreferrer"
      href={href}
      data-website-url={href}
      aria-label={`${getNodeText(children) || website.hostname} — ${href}`}
      {...props}
    >
      <span className="eterx-website-link-icon" aria-hidden="true">
        {failedFaviconUrl !== website.faviconUrl ? (
          <img
            src={website.faviconUrl}
            alt=""
            loading="lazy"
            onError={() => setFailedFaviconUrl(website.faviconUrl)}
          />
        ) : (
          <Globe2 />
        )}
      </span>
      <span className="eterx-website-link-label">{children}</span>
    </a>
  );
});
WebsiteLink.displayName = 'WebsiteLink';

const ResponsiveMath = React.memo(({
  children,
  className = '',
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let animationFrame = 0;
    let lastAvailableWidth = 0;
    const fitEquation = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const equation = element.querySelector<HTMLElement>(':scope > .katex');
        if (!equation) return;

        const availableWidth = Math.max(1, element.clientWidth - 12);
        if (Math.abs(availableWidth - lastAvailableWidth) < 0.5) return;
        lastAvailableWidth = availableWidth;
        element.style.setProperty('--eterx-math-scale', '1');
        const naturalWidth = Math.max(equation.scrollWidth, equation.getBoundingClientRect().width);
        const scale = naturalWidth > availableWidth
          ? Math.max(0.01, Math.min(1, availableWidth / naturalWidth))
          : 1;
        element.style.setProperty('--eterx-math-scale', scale.toFixed(4));
      });
    };

    fitEquation();
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(fitEquation)
      : null;
    observer?.observe(element);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer?.disconnect();
    };
  }, [children]);

  return (
    <span ref={ref} className={className} {...props}>
      {children}
    </span>
  );
});
ResponsiveMath.displayName = 'ResponsiveMath';

// Preserve the model's Markdown. Presentation rules belong in prompts;
// the renderer must not invent tables, unwrap fences, guess math, or rewrite
// paths. Private reasoning in provider text remains outside the answer.
export const normalizeMarkdownForRendering = (value: string) => {
  if (!value) return '';
  const text = String(value)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '');
  return text.split(PROTECTED_MARKDOWN_CODE_SPLIT).map(chunk => {
    if (/^(```|~~~|`)/.test(chunk)) return chunk;
    return chunk.replace(/<(analysis|thinking|reasoning|thought|scratchpad|reflection)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  }).join('');
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

export const useClipboard = (text: string, timeout = 2000) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = async () => {
    const ok = await safeCopyTextToClipboard(text);
    if (ok) {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), timeout);
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
      return `<svg${ nextAttrs } width="${ Math.ceil(width) }" height="${ Math.ceil(height) }" style="background:${ background }">`;
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

const getMermaidDisplayWidth = ({ width, height }: { width: number; height: number }) => {
  const safeWidth = Math.max(1, width || 720);
  const safeHeight = Math.max(1, height || 460);
  const aspect = safeWidth / safeHeight;

  if (safeWidth <= 420 && safeHeight <= 340) return Math.min(440, Math.max(280, safeWidth + 24));
  if (aspect < 0.5) return Math.min(430, Math.max(300, safeWidth * 1.08));
  if (aspect < 0.9) return Math.min(500, Math.max(340, safeWidth * 1.04));
  if (safeWidth >= 900) return 620;
  return Math.min(600, Math.max(380, safeWidth));
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

const MermaidDiagram = ({ chart }: { chart: string }) => {
  const theme = useResolvedTheme();
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const chartId = useMemo(() => `eterx-mermaid-${ reactId || Math.random().toString(36).slice(2) }`, [reactId]);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const renderedChart = chart;
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionStatus, setActionStatus] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [svgSize, setSvgSize] = useState({ width: 460, height: 300 });
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
            nodeSpacing: 26,
            rankSpacing: 38,
            padding: 10,
          },
          sequence: {
            showSequenceNumbers: false,
            mirrorActors: false,
            actorMargin: 36,
            boxMargin: 8,
            messageMargin: 26,
            diagramMarginX: 16,
            diagramMarginY: 16,
          },
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
            fontSize: '14px',
            fontFamily: MERMAID_FONT_FAMILY,
          },
        });

        // Render exactly the authored source. Invalid or unfinished syntax
        // falls back to that same source instead of a guessed repair.
        await mermaid.parse(chart);
        const result = await mermaid.render(`${ chartId }-${ theme }-${ token }`, chart);
        if (!cancelled && renderTokenRef.current === token) {
          setSvg(result.svg);
          setSvgSize(getSvgViewBoxSize(result.svg));
        }
      } catch (err: any) {
        if (!cancelled && renderTokenRef.current === token) {
          setSvg('');
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

  useEffect(() => {
    if (!previewOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [previewOpen]);

  const flashStatus = (message: string) => {
    setActionStatus(message);
    window.setTimeout(() => setActionStatus(''), 1800);
  };

  const copyText = async (value: string, label: string) => {
    const ok = await safeCopyTextToClipboard(value);
    if (ok) flashStatus(label);
  };

  const copyPng = async () => {
    if (!svg) return;
    const blob = await svgToPngBlob(svg);
    if (await safeCopyPngToClipboard(blob)) {
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
    '--eterx-mermaid-display-width': `${ displayWidth }px`,
    '--eterx-mermaid-intrinsic-width': `${ Math.max(1, svgSize.width) }px`,
  } as React.CSSProperties;

  return (
    <div
      className={`eterx-mermaid-card group/mermaid relative my-3.5 mx-auto max-w-full overflow-visible ${ expanded ? 'eterx-mermaid-expanded' : '' }`}
      style={canvasStyle}
      data-diagram-shape={svgSize.height > svgSize.width * 1.4 ? 'tall' : svgSize.width > svgSize.height * 1.7 ? 'wide' : 'balanced'}
    >
      <div ref={menuRef} className="eterx-mermaid-toolbar absolute right-1 top-1 z-30 flex items-center gap-1 opacity-80 transition-opacity duration-200 group-hover/mermaid:opacity-100 focus-within:opacity-100">
        <Tooltip text="Open large view" side="bottom">
          <button
            type="button"
            className="eterx-mermaid-trigger"
            aria-label="Open large diagram view"
            disabled={!svg}
            onClick={() => {
              setPreviewZoom(1);
              setPreviewOpen(true);
            }}
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </Tooltip>
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
          <div className="eterx-mermaid-menu absolute right-0 top-10 z-40 w-[230px] overflow-hidden rounded-2xl border border-white/[0.09] bg-[#191817]/96 p-1.5 shadow-none backdrop-blur-xl">
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
            <button type="button" className="eterx-mermaid-menu-item" disabled={!svg} onClick={() => runAction(() => {
              setPreviewZoom(1);
              setPreviewOpen(true);
            })}>
              <Maximize2 className="h-4 w-4" />
              <span>Open large view</span>
            </button>
            <button type="button" className="eterx-mermaid-menu-item" onClick={() => runAction(() => setExpanded(value => !value))}>
              {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              <span>{expanded ? 'Fit inline' : 'Expand inline'}</span>
            </button>
            <button type="button" className="eterx-mermaid-menu-item" onClick={() => runAction(() => setShowSource(value => !value))}>
              <ChevronDown className={`h-4 w-4 transition-transform ${ showSource ? 'rotate-180' : '' }`} />
              <span>{showSource ? 'Hide source' : 'Show source'}</span>
            </button>
          </div>
        )}
      </div>
      {actionStatus && (
        <div className="eterx-mermaid-toast absolute right-2 top-12 z-20 rounded-full border border-white/[0.08] bg-[#151515]/86 px-3 py-1.5 text-[12px] font-medium text-[#B8B4AC] shadow-none backdrop-blur-md">
          {actionStatus}
        </div>
      )}

      <div className="eterx-mermaid-stage">
        {svg ? (
          <div
            className="eterx-mermaid-canvas mx-auto"
            style={canvasStyle}
            role="img"
            aria-label="Rendered Mermaid diagram"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : error ? (
          <div className="eterx-mermaid-error" role="status">
            <div className="eterx-mermaid-error-title">Diagram could not be rendered</div>
            <div className="eterx-mermaid-error-message">The Mermaid source is still available for review or correction.</div>
            <button type="button" className="eterx-mermaid-error-action" onClick={() => setShowSource(true)}>
              Show source
            </button>
          </div>
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
              <div className="eterx-mermaid-popout-title min-w-0 flex-1 truncate">Diagram preview</div>
              <div className="eterx-mermaid-zoom-controls" aria-label="Diagram zoom controls">
                <button
                  type="button"
                  className="eterx-mermaid-popout-button"
                  disabled={previewZoom <= 1}
                  onClick={() => setPreviewZoom(value => Math.max(1, value - 0.25))}
                >
                  Zoom out
                </button>
                <span className="eterx-mermaid-zoom-value">{Math.round(previewZoom * 100)}%</span>
                <button
                  type="button"
                  className="eterx-mermaid-popout-button"
                  disabled={previewZoom >= 2}
                  onClick={() => setPreviewZoom(value => Math.min(2, value + 0.25))}
                >
                  Zoom in
                </button>
                <button type="button" className="eterx-mermaid-popout-button" onClick={() => setPreviewZoom(1)}>Fit</button>
              </div>
              <button type="button" className="eterx-mermaid-popout-button" onClick={() => runAction(copyPng)}>Copy image</button>
              <button type="button" className="eterx-mermaid-popout-button" onClick={() => runAction(downloadPng)}>Download PNG</button>
              <button type="button" className="eterx-mermaid-popout-close" aria-label="Close large diagram view" onClick={() => setPreviewOpen(false)}>Close</button>
            </div>
            <div className="eterx-mermaid-popout-stage eterx-scrollbar">
              <div
                className="eterx-mermaid-popout-canvas"
                style={{ width: `${previewZoom * 100}%`, height: `${previewZoom * 100}%` }}
                role="img"
                aria-label="Large Mermaid diagram view"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

// Custom premium soft light theme for Prism code syntax highlighting
const customLightTheme = {
  "pre[class*=\"language-\"]": {
    "color": "#1F1F1D",
    "background": "none",
    "textShadow": "none",
    "fontFamily": "var(--font-mono)",
    "textAlign": "left",
    "whiteSpace": "pre",
    "spacing": "normal",
    "wordBreak": "normal",
    "wordSpacing": "normal",
    "lineHeight": "1.5",
    "tabSize": "4",
    "hyphens": "none"
  },
  "code[class*=\"language-\"]": {
    "color": "#1F1F1D",
    "background": "none",
    "textShadow": "none",
    "fontFamily": "var(--font-mono)",
    "textAlign": "left",
    "whiteSpace": "pre",
    "spacing": "normal",
    "wordBreak": "normal",
    "wordSpacing": "normal",
    "lineHeight": "1.5",
    "tabSize": "4",
    "hyphens": "none"
  },
  "comment": { "color": "#7E7A72", "fontStyle": "italic" },
  "prolog": { "color": "#7E7A72" },
  "doctype": { "color": "#7E7A72" },
  "cdata": { "color": "#7E7A72" },
  "punctuation": { "color": "#4A463F" },
  "namespace": { "opacity": "0.7" },
  "property": { "color": "#9333EA" },
  "tag": { "color": "#2563EB" },
  "boolean": { "color": "#D97706" },
  "number": { "color": "#D97706" },
  "constant": { "color": "#D97706" },
  "symbol": { "color": "#D97706" },
  "deleted": { "color": "#DC2626" },
  "selector": { "color": "#15803D" },
  "attr-name": { "color": "#D97706" },
  "string": { "color": "#15803D" },
  "char": { "color": "#15803D" },
  "builtin": { "color": "#2563EB" },
  "inserted": { "color": "#15803D" },
  "operator": { "color": "#4A463F" },
  "entity": { "color": "#2563EB", "cursor": "help" },
  "url": { "color": "#2563EB" },
  "variable": { "color": "#1F1F1D" },
  "atrule": { "color": "#2563EB" },
  "attr-value": { "color": "#15803D" },
  "keyword": { "color": "#2563EB", "fontWeight": "600" },
  "function": { "color": "#7E22CE" },
  "class-name": { "color": "#9333EA" },
  "regex": { "color": "#D97706" },
  "important": { "color": "#2563EB", "fontWeight": "bold" },
  "bold": { "fontWeight": "bold" },
  "italic": { "fontStyle": "italic" }
};

const CodeBlock = React.memo(({ language, content, forceSource = false, ...props }: { language: string; content: string; forceSource?: boolean;[key: string]: any }) => {
  const streaming = React.useContext(MarkdownStreamContext);
  const [wrapLines, setWrapLines] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const theme = useResolvedTheme();
  const lineCount = Math.max(1, content.split(/\r?\n/).length);
  const isLong = lineCount > 32 || content.length > 3200;
  const displayLanguage = language || 'text';

  if (!streaming && !forceSource && MERMAID_LANGUAGE_ALIASES.has(displayLanguage.toLowerCase())) {
    return <MermaidDiagram chart={content} />;
  }

  const highlightStyle = theme === 'light' ? customLightTheme : vscDarkPlus;

  return (
    <div
      className={`eterx-markdown-code-block group/code relative my-5 flex max-w-full flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#1C1B1A] shadow-none ${ expanded ? 'eterx-code-expanded' : '' }`}
      data-language={displayLanguage}
    >
      <div className="eterx-markdown-code-actions absolute right-2 top-2 z-20 flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#1C1B1A]/86 p-1 opacity-55 shadow-none backdrop-blur-md transition-opacity duration-200 group-hover/code:opacity-100">
        <ToolbarButton label={wrapLines ? 'Disable wrap' : 'Wrap lines'} active={wrapLines} onClick={() => setWrapLines(value => !value)}>
          <WrapText className="h-4 w-4" />
        </ToolbarButton>
        <CopyButton
          text={content}
          side="bottom"
          className="eterx-markdown-copy-button h-8 w-8 border border-white/[0.08] bg-white/[0.035] text-[#8C8A88] hover:bg-white/[0.07] hover:text-[#E8E6E3]"
        />
      </div>
      <div className={`eterx-markdown-code-scroll overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${ isLong && !expanded ? 'max-h-[520px]' : '' }`}>
        {streaming ? (
          <div className="eterx-markdown-code-content code-span min-w-full text-[12.5px] leading-relaxed font-mono"
            style={{ margin: 0, background: 'var(--eterx-md-code-bg)', padding: '0.85rem 4rem 0.9rem 0.9rem', minWidth: '100%' }}>
            <code style={{ fontFamily: 'var(--font-mono)', whiteSpace: wrapLines ? 'pre-wrap' : 'pre', overflowWrap: wrapLines ? 'anywhere' : 'normal' }}>{content}</code>
          </div>
        ) : <SyntaxHighlighter
          style={highlightStyle as any}
          language={displayLanguage}
          PreTag="div"
          showLineNumbers={false}
          wrapLongLines={wrapLines}
          className="eterx-markdown-code-content code-span min-w-full text-[12.5px] leading-relaxed font-mono"
          customStyle={{
            margin: 0,
            background: 'var(--eterx-md-code-bg)',
            padding: '0.85rem 4rem 0.9rem 0.9rem',
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
        </SyntaxHighlighter>}
      </div>
    </div>
  );
}, (prevProps, nextProps) => prevProps.content === nextProps.content && prevProps.language === nextProps.language && prevProps.forceSource === nextProps.forceSource);

export const makeMarkdownHeading = (Tag: keyof JSX.IntrinsicElements, className: string) => {
  const Heading = ({ node, children, ...props }: any) => {
    const text = getNodeText(children);
    const sourceLine = Number(node?.position?.start?.line || 0);
    const stableSuffix = sourceLine > 0 ? `-${ sourceLine }` : '';
    const id = props.id || `${ slugify(text) }${ stableSuffix }`;
    return React.createElement(
      Tag,
      {
        ...props,
        id,
        className: `${ className } eterx-answer-heading eterx-md-heading scroll-mt-28`,
      },
      children,
    );
  };
  return Heading;
};

export const markdownComponents = {
  span: ({ node, className = '', title: _title, children, ...props }: any) => {
    const classes = String(className).split(/\s+/).filter(Boolean);
    // rehype-katex intentionally keeps rendering after a parse failure. Its
    // default error span exposes a red parser message and a browser tooltip;
    // keep the source readable as ordinary answer text instead.
    if (classes.includes('katex-error')) {
      return <span className="eterx-katex-fallback" {...props}>{children}</span>;
    }
    return classes.includes('katex-display')
      ? <ResponsiveMath className={className} {...props}>{children}</ResponsiveMath>
      : <span className={className} {...props}>{children}</span>;
  },
  code: function MarkdownCode({ inline, className, children, node, ...props }: any) {
    const streaming = React.useContext(MarkdownStreamContext);
    const match = /language-([^\s]+)/.exec(className || '');
    const language = match ? match[1].toLowerCase() : '';
    const content = String(children).replace(/\n$/, '');
    const isInlineCode = inline === true || (
      inline !== false &&
      !language &&
      node?.position?.start?.line === node?.position?.end?.line
    );

    if (!isInlineCode && streaming) {
      return <CodeBlock language={language} content={content} forceSource {...props} />;
    }

    if (!isInlineCode && language === 'js-preview') {
      return <LiveArtifact js={content} title="JS Logic Preview" />;
    }

    if (!isInlineCode && language === 'html-preview') {
      return <LiveArtifact html={content} title="HTML Preview" />;
    }

    if (!isInlineCode && (language === 'react-preview' || language === 'preview')) {
      return <LiveArtifact html={content} title="Preview" />;
    }

    if (!isInlineCode) {
      return <CodeBlock language={language} content={content} {...props} />;
    }

    if (isLocalFilePath(content)) {
      return <LocalFileLinkChip filePath={content.trim()} compact />;
    }

    return (
      <code className="eterx-markdown-inline-code font-semibold" {...props}>
        {children}
      </code>
    );
  },
  // CodeBlock renders its own accessible, scrollable container. ReactMarkdown
  // otherwise adds a <pre> around it, producing invalid <pre><div> nesting
  // and browser-dependent layout/scroll behaviour.
  pre: ({ children }: any) => <>{children}</>,
  p: ({ node, ...props }: any) => <p className="eterx-markdown-paragraph mb-3 break-words text-[13.5px] leading-[1.65] last:mb-0" {...props} />,
  a: ({ node, href, children, ...props }: any) => {
    const localPath = decodeLocalFileHref(href);
    if (localPath) {
      return <LocalFileLinkChip filePath={localPath} label={getNodeText(children)} compact />;
    }
    return <WebsiteLink href={href} {...props}>{children}</WebsiteLink>;
  },
  ul: ({ node, ...props }: any) => <ul className="eterx-markdown-list mb-3 list-disc space-y-1 pl-5 marker:text-[#8C8A88] text-[13.5px] leading-[1.6]" {...props} />,
  ol: ({ node, ...props }: any) => <ol className="eterx-markdown-list mb-3 list-decimal space-y-1 pl-5 marker:text-[#8C8A88] text-[13.5px] leading-[1.6]" {...props} />,
  li: ({ node, ...props }: any) => <li className="eterx-markdown-list-item leading-[1.6] pl-0.5" {...props} />,
  input: ({ type, ...props }: any) => type === 'checkbox'
    ? <input type="checkbox" className="eterx-markdown-checkbox mr-2 h-3.5 w-3.5 translate-y-[2px] rounded border-white/20 accent-[#E2765A] cursor-pointer" {...props} />
    : <input type={type} {...props} />,
  h1: makeMarkdownHeading('h1', 'eterx-answer-heading-1'),
  h2: makeMarkdownHeading('h2', 'eterx-answer-heading-2'),
  h3: makeMarkdownHeading('h3', 'eterx-answer-heading-3'),
  h4: makeMarkdownHeading('h4', 'eterx-answer-heading-4'),
  h5: makeMarkdownHeading('h5', 'eterx-answer-heading-5'),
  h6: makeMarkdownHeading('h6', 'eterx-answer-heading-6'),
  strong: ({ ...props }: any) => <strong className="font-semibold tracking-normal" {...props} />,
  em: ({ ...props }: any) => <em className="italic" {...props} />,
  blockquote: ({ node, ...props }: any) => {
    const quoteText = getNodeText(node).trim().toLowerCase();
    const callout = quoteText.startsWith('warning:') || quoteText.startsWith('caution:')
      ? 'warning'
      : quoteText.startsWith('tip:') || quoteText.startsWith('note:') || quoteText.startsWith('important:')
        ? 'note'
        : 'quote';
    return (
      <blockquote
        className="eterx-markdown-callout my-3 rounded-lg border-l-[3px] border-[#E2765A] bg-[#222120]/70 px-3.5 py-2.5 text-[12.5px] leading-relaxed shadow-none backdrop-blur-sm"
        data-callout={callout}
        {...props}
      />
    );
  },
  hr: ({ ...props }: any) => <hr className="eterx-markdown-hr my-4 border-white/[0.08]" {...props} />,
  table: ({ node, ...props }: any) => (
    <div
      className="eterx-markdown-table-wrap my-4 w-full max-w-full overflow-x-auto overflow-y-hidden rounded-lg border border-white/[0.10] bg-[#1A1918]/90 shadow-none"
      role="region"
      aria-label="Data table"
      tabIndex={0}
    >
      <table className="eterx-markdown-table w-full min-w-full border-collapse text-left text-[12.5px]" {...props} />
    </div>
  ),
  thead: ({ node, ...props }: any) => <thead className="eterx-markdown-thead bg-white/[0.04] border-b border-white/[0.08]" {...props} />,
  tbody: ({ node, ...props }: any) => <tbody className="eterx-markdown-tbody" {...props} />,
  th: ({ node, ...props }: any) => <th className="eterx-markdown-th border-b border-r border-white/[0.06] last:border-r-0 px-3 py-2 text-left font-semibold text-[#F4F3EF] bg-white/[0.03]" {...props} />,
  td: ({ node, ...props }: any) => <td className="eterx-markdown-td border-b border-r border-white/[0.04] last:border-r-0 px-3 py-2 align-top text-[#E0DDD7] font-normal" {...props} />,
  tr: ({ node, ...props }: any) => <tr className="eterx-markdown-tr transition-colors hover:bg-white/[0.035] even:bg-white/[0.015]" {...props} />,
  img: ({ alt, ...props }: any) => (
    // Images normally arrive as children of a Markdown paragraph. A block
    // <figure> there creates invalid HTML and causes the browser to reparent
    // surrounding text. Keep the captioned image inline-safe with a block
    // span wrapper instead.
    <span className="eterx-markdown-figure my-5" role="figure">
      <img className="eterx-markdown-image max-w-full rounded-xl border border-white/[0.08] shadow-none" alt={alt || ''} loading="lazy" {...props} />
      {alt && <span className="eterx-markdown-image-caption mt-2 text-center text-[12px]">{alt}</span>}
    </span>
  ),
};
