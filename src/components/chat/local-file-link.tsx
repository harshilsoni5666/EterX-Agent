import React, { useMemo, useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { getFileIconPath } from '../../lib/utils/file-icon-utils';

export const LOCAL_FILE_HREF_PREFIX = '#eterx-local-file:';

const CODE_FENCE_SPLIT = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
const INLINE_CODE_SPLIT = /(`[^`\n]*`)/g;
const MARKDOWN_LINK_TOKEN_PATTERN = /(!?\[(?:\\.|[^\]\\\n])*\]\(\s*(?:<[^>\n]+>|[^)\n]+)\s*\))/g;
const LOCAL_PATH_PATTERN = /(^|[\s([{"'>])((?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+[\\/]|\/(?:Users|home|tmp|var|mnt|Volumes)\/)(?:[^\r\n`<>|]*?\.[A-Za-z0-9]{1,16}|[^\r\n`<>|]*?[\\/]))(?=$|[\s)\]}"'.,;!?])/g;
const LOCAL_PATH_EXACT_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+[\\/]|\/(?:Users|home|tmp|var|mnt|Volumes)\/)(?:[^\r\n`<>|]*?\.[A-Za-z0-9]{1,16}|[^\r\n`<>|]*?[\\/])$/;

export const getLocalFileName = (filePath: string) => {
  const cleaned = String(filePath || '').trim().replace(/[\\/]+$/, '');
  return cleaned.split(/[\\/]/).filter(Boolean).pop() || cleaned || 'File';
};

export const isLocalFilePath = (value: string) =>
  LOCAL_PATH_EXACT_PATTERN.test(String(value || '').trim());

export const encodeLocalFileHref = (filePath: string) =>
  `${ LOCAL_FILE_HREF_PREFIX }${ encodeURIComponent(String(filePath || '').trim()) }`;

const decodeNativeFileUrl = (href: string) => {
  // Chromium normalizes Windows file URLs differently depending on whether
  // the path came from a browser, Electron, or a copied markdown response.
  // Handle drive-letter URLs before URL.pathname so `file://C:/…` does not
  // become a bogus UNC host named `c:`.
  const windowsMatch = href.match(/^file:(?:\/){2,3}([A-Za-z]:[\\/][^\r\n]*)$/i);
  if (windowsMatch) {
    try {
      return decodeURIComponent(windowsMatch[1]).replace(/\//g, '\\');
    } catch {
      return windowsMatch[1].replace(/\//g, '\\');
    }
  }

  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== 'file:') return null;
    const pathname = decodeURIComponent(parsed.pathname || '');
    if (parsed.hostname) {
      return `\\\\${ decodeURIComponent(parsed.hostname) }${ pathname.replace(/\//g, '\\') }`;
    }
    // file:///C:/… has a leading slash before the Windows drive.
    if (/^\/[A-Za-z]:[\\/]/.test(pathname)) return pathname.slice(1).replace(/\//g, '\\');
    return pathname || null;
  } catch {
    return null;
  }
};

export const decodeLocalFileHref = (href?: string | null) => {
  const rawHref = String(href || '').trim().replace(/^<|>$/g, '');
  if (!rawHref) return null;

  // Providers and Markdown serializers disagree about whether the hash,
  // prefix, and path payload are encoded. Try the original and one decoded
  // form so every supported representation reaches the same chip renderer.
  const candidates = [rawHref];
  try {
    const decodedHref = decodeURIComponent(rawHref);
    if (decodedHref !== rawHref) candidates.push(decodedHref);
  } catch {
    // Keep the original candidate when a path contains a literal percent.
  }

  for (const candidate of candidates) {
    if (/^file:\/\//i.test(candidate)) {
      const nativePath = decodeNativeFileUrl(candidate);
      if (nativePath) return nativePath;
    }

    const prefixMatch = candidate.match(/^(#?eterx-local-file:)([\s\S]*)$/i);
    if (prefixMatch) {
      try {
        return decodeURIComponent(prefixMatch[2]);
      } catch {
        return prefixMatch[2];
      }
    }

    if (isLocalFilePath(candidate)) return candidate;
  }

  return null;
};

/**
 * Some providers escape the opening Markdown bracket (`\[file](href)`) while
 * composing a response. That is valid literal Markdown, but for a known
 * local-file href it leaves the raw link syntax visible to the user. Repair
 * only those local links; ordinary escaped prose remains untouched.
 */
export const normalizeEscapedLocalFileLinks = (value: string) => {
  if (!value) return '';
  return value.replace(/\\\[([^\r\n]*?)\]\(\s*(<[^>\r\n]+>|[^)\r\n]+)\s*\)/g, (match, label: string, rawHref: string) => {
    const localPath = decodeLocalFileHref(rawHref);
    return localPath ? `[${ label }](${ encodeLocalFileHref(localPath) })` : match;
  });
};

const escapeMarkdownLinkText = (value: string) => value.replace(/([\\[\]])/g, '\\$1');

const filePathMarkdownLink = (filePath: string) => {
  // A trailing separator is useful for detecting a directory in plain model
  // text, but it can escape the closing Markdown destination after some
  // provider/remark decoding paths. The native opener accepts the canonical
  // directory path without that separator.
  const cleanedPath = filePath.trim().replace(/[\\/]+$/, '');
  if (!cleanedPath) return '';
  const fileName = escapeMarkdownLinkText(getLocalFileName(cleanedPath));
  return `[${ fileName }](${ encodeLocalFileHref(cleanedPath) })`;
};

export const linkifyLocalFilePaths = (value: string) => {
  if (!value) return '';

  return value.split(CODE_FENCE_SPLIT).map((block) => {
    if (/^(```|~~~)/.test(block)) return block;

    // Preserve authored links before scanning plain text. Without this guard,
    // a full Windows path in `[C:\\Reports\\file.xlsx](...)` is wrapped a
    // second time and produces malformed nested Markdown.
    return block.split(MARKDOWN_LINK_TOKEN_PATTERN).map((markdownPart, index) => {
      if (index % 2 === 1) return markdownPart;

      return markdownPart.split(INLINE_CODE_SPLIT).map((chunk) => {
        const inlineCodeMatch = chunk.match(/^`([^`\n]+)`$/);
        if (inlineCodeMatch) {
          const inlineValue = inlineCodeMatch[1].trim();
          return LOCAL_PATH_EXACT_PATTERN.test(inlineValue) ? filePathMarkdownLink(inlineValue) : chunk;
        }

        return chunk.replace(LOCAL_PATH_PATTERN, (_match, prefix: string, filePath: string) => {
          const link = filePathMarkdownLink(filePath);
          return link ? `${ prefix }${ link }` : _match;
        });
      }).join('');
    }).join('');
  }).join('');
};

import { safeCopyTextToClipboard } from '../ui/copy-button';

export const copyTextToClipboard = async (value: string) => {
  return await safeCopyTextToClipboard(value);
};

export const openLocalFilePath = async (filePath: string) => {
  const target = String(filePath || '').trim();
  if (!target) return false;

  const electronApi = (window as any).electronAPI;
  if (electronApi?.openPath) {
    const result = await electronApi.openPath(target);
    return result !== false;
  }

  const response = await fetch('/api/files/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ path: target }),
  });
  const result = await response.json().catch(() => ({}));
  return response.ok && result?.ok !== false;
};

export const LocalFileIcon = React.memo(({ fileName, size = 'md' }: { fileName: string; size?: 'sm' | 'md' }) => {
  const iconPath = useMemo(() => getFileIconPath(fileName, { extensionless: 'folder' }), [fileName]);
  const isSmall = size === 'sm';
  const iconSize = isSmall ? 'h-4 w-4' : 'h-5 w-5';

  return (
    <img
      src={iconPath}
      className={`${ iconSize } shrink-0 object-contain`}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
});

export const LocalFileLinkChip = React.memo(({
  filePath,
  label,
  compact = false,
}: {
  filePath: string;
  label?: string;
  compact?: boolean;
}) => {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const name = label?.trim() || getLocalFileName(filePath);

  const copyPath = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1000);
    await copyTextToClipboard(filePath);
  };

  const openPath = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();

    openLocalFilePath(filePath)
      .then((ok) => {
        if (!ok) {
          setFailed(true);
          window.setTimeout(() => setFailed(false), 1800);
        }
      })
      .catch(() => {
        setFailed(true);
        window.setTimeout(() => setFailed(false), 1800);
    });
  };

  const handleKeyboardOpen = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    openPath(event);
  };

  return (
    <span
      onClick={openPath}
      onKeyDown={handleKeyboardOpen}
      className={`eterx-local-file-chip inline-flex min-w-0 max-w-full items-center overflow-hidden align-middle text-left ${ compact ? 'my-0.5' : 'my-1' } rounded-[10px] border transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#94C7E0]/24`}
      role="button"
      tabIndex={0}
      aria-label={`Open ${name}`}
      aria-description={`Full path: ${filePath}`}
    >
      <span
        className={`inline-flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-l-[10px] ${ compact ? 'px-2 py-1' : 'px-2.5 py-1.5' } text-left`}
      >
        <LocalFileIcon fileName={name} size={compact ? 'sm' : 'md'} />
        <span className="eterx-local-file-chip-name min-w-0 truncate text-[12.75px] font-semibold leading-tight tracking-normal text-[#E8E6E3]">
          {failed ? 'Open failed' : name}
        </span>
        <ExternalLink className="eterx-local-file-chip-icon h-3.5 w-3.5 shrink-0 text-[#807A72] opacity-75" strokeWidth={2} />
      </span>
      <span className="eterx-local-file-chip-divider h-6 w-px shrink-0 bg-white/[0.10]" aria-hidden="true" />
      <button
        type="button"
        onClick={copyPath}
        className={`eterx-local-file-chip-copy inline-flex shrink-0 items-center justify-center rounded-r-[10px] ${ compact ? 'h-8 w-8' : 'h-9 w-9' } transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#94C7E0]/24`}
        aria-label={`Copy file path for ${ name }`}
        title="Copy file path"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.2} /> : <Copy className="h-3.5 w-3.5" strokeWidth={2.1} />}
      </button>
    </span>
  );
});
