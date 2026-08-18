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
import { LocalFileLinkChip, decodeLocalFileHref, isLocalFilePath, linkifyLocalFilePaths, normalizeEscapedLocalFileLinks } from './local-file-link';

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
const PLAIN_TEXT_LANGUAGE_ALIASES = new Set(['', 'text', 'txt', 'plain', 'plaintext']);
const MERMAID_START_PATTERN = /^\s*(?:graph|flowchart|sequenceDiagram|classDiagram|classDiagram-v2|stateDiagram|stateDiagram-v2|erDiagram|journey|gantt|pie|timeline|mindmap|quadrantChart|xychart-beta|block-beta|sankey-beta|gitGraph|C4Context|C4Container|C4Component|C4Dynamic)\b/i;
const CODE_FENCE_SPLIT = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
const MERMAID_FONT_FAMILY = '"Segoe UI", -apple-system, BlinkMacSystemFont, Arial, sans-serif';
const ACCIDENTAL_MARKDOWN_FENCE_LANGUAGES = new Set(['', 'md', 'markdown', 'text', 'txt', 'plain', 'plaintext', 'answer', 'response']);
const TABLE_SEPARATOR_PATTERN = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const PROTECTED_MARKDOWN_CODE_SPLIT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*?`+)/g;
const PROTECTED_MARKDOWN_MATH_AND_CODE_SPLIT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*?`+|\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$)/g;
const DISPLAY_MATH_ENVIRONMENTS = [
  'equation',
  'align',
  'alignat',
  'gather',
  'multline',
  'flalign',
  'split',
  'aligned',
  'gathered',
  'cases',
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'array',
  'smallmatrix',
].join('|');
const DISPLAY_MATH_ENVIRONMENT_PATTERN = new RegExp(
  `\\\\begin\\{(${DISPLAY_MATH_ENVIRONMENTS})\\*?\\}([\\s\\S]*?)\\\\end\\{\\1\\*?\\}`,
  'g',
);
const CURRENCY_AMOUNT_PATTERN = /(?:\\)?\$((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\$/g;

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

const normalizeLatexOutsideCode = (value: string) => {
  const normalizedDelimiters = value.split(PROTECTED_MARKDOWN_CODE_SPLIT).map((chunk) => {
    if (/^(```|~~~|`)/.test(chunk)) return chunk;
    return chunk
      .replace(
        /^([ \t]*)\$\$[ \t]*([^\n]+?)[ \t]*\$\$[ \t]*$/gm,
        (_match, indentation, inner) => `${indentation}$$\n${String(inner).trim()}\n${indentation}$$`,
      )
      .replace(/\\\[([\s\S]*?)\\\]/g, (_match, inner) => `\n\n$$\n${String(inner).trim()}\n$$\n\n`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_match, inner) => `$${String(inner).trim()}$`);
  }).join('');

  return normalizedDelimiters.split(PROTECTED_MARKDOWN_MATH_AND_CODE_SPLIT).map((chunk) => {
    if (/^(```|~~~|`|\$)/.test(chunk)) return chunk;
    return chunk.replace(DISPLAY_MATH_ENVIRONMENT_PATTERN, (match, environment, body) => {
      const normalizedEnvironment = match.match(/^\\begin\{([^}]+)\}/)?.[1] || environment;
      return `\n\n$$\n\\begin{${normalizedEnvironment}}\n${String(body).trim()}\n\\end{${normalizedEnvironment}}\n$$\n\n`;
    });
  }).join('');
};

const splitMarkdownTableCells = (line: string) => {
  const trimmed = line.trim();
  let body = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  let codeFenceLength = 0;
  let mathDelimiterLength = 0;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];

    if (escaped) {
      cell += character;
      escaped = false;
      continue;
    }

    if (character === '\\') {
      cell += character;
      escaped = true;
      continue;
    }

    if (character === '`' && mathDelimiterLength === 0) {
      let runLength = 1;
      while (body[index + runLength] === '`') runLength += 1;
      const marker = '`'.repeat(runLength);
      cell += marker;
      index += runLength - 1;
      if (codeFenceLength === 0) codeFenceLength = runLength;
      else if (codeFenceLength === runLength) codeFenceLength = 0;
      continue;
    }

    if (character === '$' && codeFenceLength === 0) {
      const runLength = body[index + 1] === '$' ? 2 : 1;
      const marker = '$'.repeat(runLength);
      cell += marker;
      index += runLength - 1;
      if (mathDelimiterLength === 0) mathDelimiterLength = runLength;
      else if (mathDelimiterLength === runLength) mathDelimiterLength = 0;
      continue;
    }

    if (character === '|' && codeFenceLength === 0 && mathDelimiterLength === 0) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }

    cell += character;
  }

  cells.push(cell.trim());
  return cells;
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
    return `| ${ cells.map(() => '---').join(' | ') } |`;
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
      const secondNextLine = lines[i + 2] || '';
      const nextIsSeparator = isMarkdownTableSeparator(nextLine);
      const nextIsRow = isPotentialMarkdownTableRow(nextLine);
      const separatorAfterBlankLine = !nextLine.trim() && isMarkdownTableSeparator(secondNextLine);

      if (!line.trim() && inTable && nextIsRow) {
        continue;
      }

      repaired.push(line);

      if (isRow && separatorAfterBlankLine) {
        inTable = true;
        i += 1;
        continue;
      }

      if (isSeparator) {
        inTable = true;
        continue;
      }

      if (isRow) {
        if (!inTable && !nextIsSeparator && nextIsRow) {
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

// Models occasionally start a Markdown fence and then continue writing prose
// without closing it. Letting remark parse that entire tail as code makes a
// normal answer appear as a red monospace wall. Preserve real code fences,
// but unwrap an unfinished fence when its body is clearly prose/Markdown.
const normalizeUnclosedMarkdownFence = (value: string) => {
  const lines = value.split('\n');
  let openerIndex = -1;
  let openerChar = '';
  let openerLength = 0;
  let openerInfo = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const opener = line.match(/^\s*(`{3,}|~{3,})([^\n]*)$/);
    if (!opener) continue;

    const marker = opener[1];
    const info = opener[2].trim().split(/\s+/)[0].toLowerCase();
    if (openerIndex < 0) {
      openerIndex = index;
      openerChar = marker[0];
      openerLength = marker.length;
      openerInfo = info;
      continue;
    }

    if (marker[0] === openerChar && marker.length >= openerLength) {
      openerIndex = -1;
      openerChar = '';
      openerLength = 0;
      openerInfo = '';
    }
  }

  if (openerIndex < 0) return value;

  const body = lines.slice(openerIndex + 1).join('\n').trim();
  const isAccidentalLanguage = ACCIDENTAL_MARKDOWN_FENCE_LANGUAGES.has(openerInfo);
  const shouldUnwrap = isAccidentalLanguage || !looksLikeCodePayload(body, openerInfo);
  if (shouldUnwrap) {
    lines.splice(openerIndex, 1);
  } else {
    lines.push(`${ openerChar.repeat(openerLength) }`);
  }
  return lines.join('\n');
};

const looksLikeStandaloneLatex = (line: string) => {
  const trimmed = line.trim();
  if (
    !trimmed ||
    trimmed.includes('$') ||
    trimmed.includes('`') ||
    /\[[^\]]+\]\([^)]+\)/.test(trimmed) ||
    trimmed.startsWith('```') ||
    trimmed.startsWith('~~~')
  ) return false;
  if (/^(?:[-+*]|\d{1,2}[.)]|#{1,6})\s/.test(trimmed)) return false;
  const hasLatexCommand = /\\[A-Za-z]+/.test(trimmed);
  const hasMathOperator = /(?:=|\^|_|\\(?:frac|int|sum|cdot|times|approx|infty|sqrt|left|right)\b)/.test(trimmed);
  const wordCount = trimmed.match(/[A-Za-z]{2,}/g)?.length || 0;
  return hasLatexCommand && hasMathOperator && trimmed.length <= 320 && wordCount <= 28;
};

const normalizeStandaloneLatexOutsideCode = (value: string) =>
  value.split(CODE_FENCE_SPLIT).map((chunk) => {
    if (/^(```|~~~)/.test(chunk)) return chunk;
    return chunk
      .split('\n')
      .map(line => looksLikeStandaloneLatex(line) ? `$$\n${ line.trim() }\n$$` : line)
      .join('\n');
  }).join('');

// Single-dollar math is useful, but currency amounts such as `$2,339.12$`
// are much more common in answers and are not equations. Treat both escaped
// and unescaped currency forms as literal text before remark-math sees them;
// otherwise KaTeX can expose a red parser error or a stray backslash.
const normalizeCurrencyAmountsOutsideCode = (value: string) =>
  value.split(CODE_FENCE_SPLIT).map((chunk) => {
    if (/^(```|~~~)/.test(chunk)) return chunk;
    return chunk.replace(CURRENCY_AMOUNT_PATTERN, (_match, amount) => `\\$${ amount }\\$`);
  }).join('');

const SYSTEM_TAGS = [
  'thought',
  'deep_work_action',
  'plan',
  'work_note',
  'workspace_note',
  'search',
  'execute',
  'thinking',
  'reflection',
  'analysis',
  'boltAction',
  'boltArtifact',
  'artifact',
  'task_tracker',
  'status',
  'read_file',
  'write_file',
  'run_command'
];

// Only strip COMPLETE tag pairs — never use `$` as a closing alternative.
// Using `$` would silently eat everything from an unclosed tag to end-of-string,
// truncating real answer content mid-stream.
const SYSTEM_TAGS_PATTERN = new RegExp(
  `<(${ SYSTEM_TAGS.join('|') })(?:\\s[^>]*)?(?:\\/>|>[\\s\\S]*?<\\/\\1>)`,
  'gi'
);

const stripSystemTagsOutsideCode = (value: string) =>
  value.split(CODE_FENCE_SPLIT).map((chunk) => {
    // Preserve code blocks completely
    if (/^(```|~~~|`)/.test(chunk)) return chunk;

    // Strip fully formed or streaming system tags and their contents
    let processed = chunk.replace(SYSTEM_TAGS_PATTERN, '');

    // Anti-Flicker: Strip incomplete tag token at the very end of the stream.
    // Only matches when `<` is followed directly by a letter/slash+letter (genuine tag start),
    // so `< 5` or `<= 10` comparisons are NOT stripped.
    processed = processed.replace(/<\/?[A-Za-z_][^>]*$/, '');

    return processed;
  }).join('');

export const normalizeMarkdownForRendering = (value: string) => {
  if (!value) return '';
  // Provider streams can contain CRLF, a BOM, or a stray NUL character. None
  // of those are meaningful Markdown and they can make the parser disagree
  // about fence/table boundaries across platforms.
  const normalizedInput = String(value)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '');
  const normalized = normalizeStandaloneLatexOutsideCode(
    normalizeCurrencyAmountsOutsideCode(
      normalizeLatexOutsideCode(
        stripSystemTagsOutsideCode(
          normalizeUnclosedMarkdownFence(
            unwrapAccidentalMarkdownFence(normalizeEscapedLocalFileLinks(normalizedInput)),
          ),
        ),
      ),
    ),
  );
  return linkifyLocalFilePaths(repairMarkdownTablesOutsideCode(normalized)
    .replace(/\n{3,}(\$\$)/g, '\n\n$1')
    .replace(/(\$\$)\n{3,}/g, '$1\n\n'));
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
      shouldQuoteMermaidLabel(label) ? `${ id }["${ escapeMermaidLabel(label) }"]` : match
    ))
    .replace(/([A-Za-z][\w-]*)\{([^}\n"]+)\}/g, (match, id, label) => (
      shouldQuoteMermaidLabel(label) ? `${ id }{"${ escapeMermaidLabel(label) }"}` : match
    ));

const normalizeSubgraphLine = (line: string, index: number) => {
  const match = line.match(/^(\s*)subgraph\s+(.+?)\s*$/i);
  if (!match) return line;
  const [, indent, body] = match;
  const trimmed = body.trim();
  if (!trimmed || /^end$/i.test(trimmed) || /\[["']?.+["']?\]$/.test(trimmed)) return line;

  const idTitleMatch = trimmed.match(/^([A-Za-z][\w-]*)\s+(.+)$/);
  if (idTitleMatch && shouldQuoteMermaidLabel(idTitleMatch[2])) {
    return `${ indent }subgraph ${ idTitleMatch[1] }["${ escapeMermaidLabel(idTitleMatch[2]) }"]`;
  }

  if (shouldQuoteMermaidLabel(trimmed)) {
    return `${ indent }subgraph sg_${ index }["${ escapeMermaidLabel(trimmed) }"]`;
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

const nodeShapeSelector = (prefix: string) => [
  `${ prefix } rect`,
  `${ prefix } circle`,
  `${ prefix } ellipse`,
  `${ prefix } polygon`,
  `${ prefix } path`,
].join(',\n');

const getMermaidThemeCss = (theme: MermaidThemeName) => {
  const palette = MERMAID_PALETTES[theme];
  const variantRules = palette.nodeFillVariants.map((fill, index) => {
    const stroke = palette.nodeStrokeVariants[index] || palette.nodeStroke;
    const selector = nodeShapeSelector(`.nodes .node:nth-child(${ palette.nodeFillVariants.length }n + ${ index + 1 })`);
    return `${ selector } {
  fill: ${ fill } !important;
  stroke: ${ stroke } !important;
}`;
  }).join('\n\n');

  return `
svg {
  background: transparent !important;
  font-family: ${ MERMAID_FONT_FAMILY } !important;
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
  fill: ${ palette.text } !important;
  color: ${ palette.text } !important;
  font-family: ${ MERMAID_FONT_FAMILY } !important;
  letter-spacing: 0 !important;
}

${ nodeShapeSelector('.node') } {
  fill: ${ palette.nodeFill } !important;
  stroke: ${ palette.nodeStroke } !important;
  stroke-width: 1.45px !important;
  filter: none !important;
}

${ variantRules }

.cluster rect,
.cluster polygon,
.cluster path {
  fill: ${ palette.clusterFill } !important;
  stroke: ${ palette.clusterStroke } !important;
  stroke-width: 1.25px !important;
}

.flowchart-link,
.edgePath .path,
.messageLine0,
.messageLine1,
.transition {
  stroke: ${ palette.edge } !important;
}

.arrowheadPath,
marker path {
  fill: ${ palette.edge } !important;
  stroke: ${ palette.edge } !important;
}

.edgeLabel,
.edgeLabel p,
.edgeLabel span,
.edgeLabel text {
  color: ${ palette.mutedText } !important;
  fill: ${ palette.mutedText } !important;
  background: ${ palette.labelBackground } !important;
}

.edgeLabel rect,
.labelBkg {
  fill: ${ palette.labelBackground } !important;
  opacity: 0.94 !important;
}

.note,
.noteBox {
  fill: ${ palette.noteFill } !important;
  stroke: ${ palette.noteStroke } !important;
}

.actorBox {
  fill: ${ palette.nodeFill } !important;
  stroke: ${ palette.nodeStroke } !important;
}
`.trim();
};

const injectMermaidThemeCss = (svg: string, theme: MermaidThemeName) => {
  const style = `<style data-eterx-mermaid-theme="${ theme }">\n${ getMermaidThemeCss(theme) }\n</style>`;
  if (/<\/svg>\s*$/i.test(svg)) {
    return svg.replace(/<\/svg>\s*$/i, `${ style }</svg>`);
  }
  return `${ svg }${ style }`;
};

const MermaidDiagram = ({ chart }: { chart: string }) => {
  const theme = useResolvedTheme();
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const chartId = useMemo(() => `eterx-mermaid-${ reactId || Math.random().toString(36).slice(2) }`, [reactId]);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [renderedChart, setRenderedChart] = useState(chart);
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
            fontSize: '14px',
            fontFamily: MERMAID_FONT_FAMILY,
          },
        });

        const candidates = getMermaidCandidates(chart);
        let lastError: any = null;

        for (const candidate of candidates) {
          try {
            await mermaid.parse(candidate);
            const result = await mermaid.render(`${ chartId }-${ theme }-${ token }-${ candidates.indexOf(candidate) }`, candidate);
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
  const [wrapLines, setWrapLines] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const theme = useResolvedTheme();
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
        <SyntaxHighlighter
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
        </SyntaxHighlighter>
      </div>
    </div>
  );
}, (prevProps, nextProps) => prevProps.content === nextProps.content && prevProps.language === nextProps.language && prevProps.forceSource === nextProps.forceSource);

export const makeMarkdownHeading = (Tag: keyof JSX.IntrinsicElements, className: string) => {
  const Heading = ({ node, children, ...props }: any) => {
    const text = getNodeText(children);
    // Keep old/provider-authored decorative emoji from dominating heading
    // typography. Emoji used naturally in ordinary prose remain untouched.
    const cleanText = text.replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\s]+/u, '').trimStart();
    const renderedChildren = cleanText && cleanText !== text ? cleanText : children;
    const sourceLine = Number(node?.position?.start?.line || 0);
    const stableSuffix = sourceLine > 0 ? `-${ sourceLine }` : '';
    const id = props.id || `${ slugify(text) }${ stableSuffix }`;
    return React.createElement(
      Tag,
      {
        ...props,
        id,
        className: `${ className } eterx-md-heading scroll-mt-28`,
      },
      renderedChildren,
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
  code({ inline, className, children, node, ...props }: any) {
    const match = /language-([^\s]+)/.exec(className || '');
    const language = match ? match[1].toLowerCase() : '';
    const content = String(children).replace(/\n$/, '');
    const isInlineCode = inline === true || (
      inline !== false &&
      !language &&
      node?.position?.start?.line === node?.position?.end?.line
    );

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
  p: ({ ...props }: any) => <p className="eterx-markdown-paragraph mb-3 break-words text-[13.5px] leading-[1.65] last:mb-0" {...props} />,
  a: ({ node, href, children, ...props }: any) => {
    const localPath = decodeLocalFileHref(href);
    if (localPath) {
      return <LocalFileLinkChip filePath={localPath} label={getNodeText(children)} compact />;
    }
    return <WebsiteLink href={href} {...props}>{children}</WebsiteLink>;
  },
  ul: ({ ...props }: any) => <ul className="eterx-markdown-list mb-3 list-disc space-y-1 pl-5 marker:text-[#8C8A88] text-[13.5px] leading-[1.6]" {...props} />,
  ol: ({ ...props }: any) => <ol className="eterx-markdown-list mb-3 list-decimal space-y-1 pl-5 marker:text-[#8C8A88] text-[13.5px] leading-[1.6]" {...props} />,
  li: ({ ...props }: any) => <li className="eterx-markdown-list-item leading-[1.6] pl-0.5" {...props} />,
  input: ({ type, ...props }: any) => type === 'checkbox'
    ? <input type="checkbox" className="eterx-markdown-checkbox mr-2 h-3.5 w-3.5 translate-y-[2px] rounded border-white/20 accent-[#E2765A] cursor-pointer" {...props} />
    : <input type={type} {...props} />,
  h1: makeMarkdownHeading('h1', 'eterx-answer-heading-1 mt-5 mb-2.5 font-semibold tracking-tight leading-[1.25]'),
  h2: makeMarkdownHeading('h2', 'eterx-answer-heading-2 mt-4.5 mb-2 font-semibold tracking-tight leading-[1.3]'),
  h3: makeMarkdownHeading('h3', 'eterx-answer-heading-3 mt-3.5 mb-1.5 font-semibold tracking-tight leading-[1.35]'),
  h4: makeMarkdownHeading('h4', 'eterx-answer-heading-4 mt-3 mb-1 font-semibold leading-[1.4]'),
  h5: makeMarkdownHeading('h5', 'eterx-answer-heading-5 mt-2.5 mb-1 font-semibold leading-snug'),
  h6: makeMarkdownHeading('h6', 'eterx-answer-heading-6 mt-2 mb-1 font-semibold leading-snug'),
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
