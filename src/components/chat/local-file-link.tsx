import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { workspacePathKey } from '../../lib/workspace-paths';
import { getFileIconPath } from '../../lib/utils/file-icon-utils';
import { defaultUrlTransform } from 'react-markdown';

export const LOCAL_FILE_HREF_PREFIX = '#eterx-local-file:';
export const LocalFileWorkspaceContext = React.createContext<string | null>(null);
export const LocalFilePathsContext = React.createContext<string[]>([]);

const isAbsoluteLocalPath = (value: string) => /^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/])/.test(value);
const isRelativeArtifactPath = (value: string) => !/^(?:[a-z][\w+.-]*:|\/\/|#|\?)/i.test(value)
  && !/[?#\r\n\0]/.test(value)
  && (/^\.\.?[\\/]/.test(value)
    || /[\\/][^\\/]+\.[a-z0-9]{1,16}$/i.test(value)
    || /^[^\\/]+\.(?:html?|pdf|docx?|xlsx?|csv|tsv|pptx?|zip|png|jpe?g|svg|webp|txt|md|json|py|tsx?|jsx?)$/i.test(value));

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

// Native paths are not Markdown destinations: spaces stop parsing and
// backslashes can escape punctuation. Encode authored image paths before
// parsing, including parentheses in folder names. Call outside code spans.
export const normalizeLocalImageMarkdown = (text: string) => {
  const opening = /!\[(?:\\.|[^\]\\\n])*\]\(\s*/g;
  let result = '';
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(text))) {
    if (match.index > 0 && text[match.index - 1] === '\\') continue;
    const start = opening.lastIndex;
    let end = start;
    if (text[start] === '<') {
      const closing = text.indexOf('>', start + 1);
      if (closing < 0) continue;
      end = closing + 1;
      while (text[end] === ' ' || text[end] === '\t') end++;
      if (text[end] !== ')') continue;
    } else {
      let depth = 1;
      for (; end < text.length; end++) {
        if (text[end] === '\n') break;
        if (text[end] === '(') depth++;
        if (text[end] === ')' && --depth === 0) break;
      }
      if (text[end] !== ')' || depth !== 0) continue;
    }
    const destination = text.slice(start, end).trim();
    // Keep optional Markdown titles separate from the filesystem path.
    const titled = destination.match(/^([\s\S]+?)\s+("[^"\n]*"|'[^'\n]*')$/);
    const source = titled ? titled[1] : destination;
    if (/[\r\n]/.test(source)) continue;
    const local = decodeLocalFileHref(source);
    if (!local || source.startsWith('/api/')) continue;
    const encoded = encodeLocalFileHref(local).replace(/\(/g, '%28').replace(/\)/g, '%29');
    result += text.slice(consumed, match.index) + match[0] + encoded
      + (titled ? ` ${titled[2]}` : '') + ')';
    consumed = end + 1;
    opening.lastIndex = consumed;
  }
  return result + text.slice(consumed);
};

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
    // Some models emit ChatGPT-style artifact links. Preserve the reference
    // for resolution against this chat's actual files, never as a web URL.
    if (/^(?:sandbox|attachment):\/?/i.test(candidate)) return candidate;
    const localApi = candidate.startsWith('/api/') || /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/api\//i.test(candidate);
    if (localApi) {
      try {
        const parsed = new URL(candidate, 'http://localhost');
        const target = parsed.searchParams.get('path') || parsed.searchParams.get('filePath') || parsed.searchParams.get('filepath');
        if (target && isAbsoluteLocalPath(target)) return target;
      } catch {}
      return null;
    }
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

    // Explicit links may point to extensionless files or directories anywhere
    // on the host. Keep automatic prose detection more conservative.
    if (/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/]|\/(?!\/)|~[\\/])/.test(candidate)
      && !/[\r\n\0]/.test(candidate)) {
      try { return decodeURIComponent(candidate); } catch { return candidate; }
    }
    const relative = candidate.split(/[?#]/)[0].replace(/:(\d+)(?::\d+)?$/, '');
    if (isRelativeArtifactPath(relative)) {
      try { return decodeURIComponent(relative); } catch { return relative; }
    }
  }

  return null;
};

// Preserve image sources for the shared viewer; native anchors use file chips.
export const localAwareUrlTransform = (url: string, key: string) => {
  if (key === 'src' && /^data:image\/[^,;\s]+(?:;[^,]*)?,/i.test(url)) return url;
  if (key === 'src' && url.startsWith('blob:')) return url;
  if (key === 'src' && decodeLocalFileHref(url)) return url;
  if (key === 'href') {
    const localPath = decodeLocalFileHref(url);
    if (localPath) return encodeLocalFileHref(localPath);
  }
  return defaultUrlTransform(url);
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
  // The encoded destination preserves a trailing directory separator safely.
  const cleanedPath = filePath.trim();
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

  const electronApi = typeof window !== 'undefined' ? (window as any).electronAPI : null;
  if (electronApi?.openPath) {
    try {
      const result = await electronApi.openPath(target);
      return result === true || result?.ok === true;
    } catch {
      // A packaged renderer can outlive a restarting native bridge. Continue
      // through the bundled local server instead of leaving the chip inert.
    }
  }

  try {
    const response = await fetch('/api/files/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ path: target }),
    });
    const result = await response.json().catch(() => ({}));
    return response.ok && result?.ok !== false;
  } catch {
    return false;
  }
};

export const LocalFileIcon = React.memo(({ fileName, size = 'md' }: { fileName: string; size?: 'sm' | 'md' }) => {
  const iconPath = useMemo(() => /[\\/]$/.test(fileName)
    ? '/icons/files/folder.svg'
    : getFileIconPath(fileName, { extensionless: 'folder' }), [fileName]);
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

export const LocalFileLinkChip = React.memo(({ filePath, label, compact = false }: { filePath: string; label?: string; compact?: boolean }) => {
  const workspace = React.useContext(LocalFileWorkspaceContext);
  const recordedPaths = React.useContext(LocalFilePathsContext);
  const source = (decodeLocalFileHref(filePath) || filePath).trim();
  const reference = source.replace(/#L?\d+(?:[-:]L?\d+)?$/i, '').replace(/:(\d+)(?::\d+)?$/, '');
  const synthetic = /^(?:sandbox|attachment):/i.test(reference);
  const target = useMemo(() => {
    const local = synthetic ? reference.replace(/^(?:sandbox|attachment):/i, '') : reference;
    const normalized = workspacePathKey(local);
    const exact = recordedPaths.find(path => workspacePathKey(path) === normalized);
    if (exact) return exact;
    if (!synthetic && isAbsoluteLocalPath(local)) return local;
    const joined = workspace && isAbsoluteLocalPath(workspace) && !synthetic
      ? workspace.replace(/[\\/]+$/, '') + '/' + local : null;
    const inWorkspace = joined && recordedPaths.find(path => workspacePathKey(path) === workspacePathKey(joined));
    if (inWorkspace) return inWorkspace;
    const suffix = local.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    const uniquePaths = [...new Map(recordedPaths.map(path => [workspacePathKey(path), path])).values()];
    const matches = uniquePaths.filter(path => workspacePathKey(path).endsWith('/' + (/^[a-z]:/i.test(path) ? suffix.toLowerCase() : suffix)));
    if (matches.length === 1) return matches[0];
    // Synthetic sandbox paths have no local meaning. A unique recorded output
    // can resolve their filename; ambiguous references must remain unresolved.
    const name = getLocalFileName(local);
    const names = uniquePaths.filter(path => getLocalFileName(path).localeCompare(name, undefined, { sensitivity: /^[a-z]:/i.test(path) ? 'accent' : 'variant' }) === 0);
    if ((synthetic || !/[\\/]/.test(local)) && names.length === 1) return names[0];
    if (synthetic || (!/[\\/]/.test(local) && names.length > 1)) return null;
    return joined;
  }, [recordedPaths, reference, synthetic, workspace]);
  const filename = getLocalFileName(target || reference.replace(/^(?:sandbox|attachment):/i, ''));
  const suppliedLabel = label?.trim();
  const name = filename || suppliedLabel || 'File';
  const [message, setMessage] = useState('');
  const [opening, setOpening] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setMessage(''); }, [target, reference]);
  const openPath = async (event: React.SyntheticEvent) => {
    event.preventDefault(); event.stopPropagation();
    if (pending.current) return;
    if (!target) { setMessage('Could not resolve this file to a unique local path in this chat.'); return; }
    pending.current = true; setOpening(true); setMessage('');
    const ok = await openLocalFilePath(target).catch(() => false);
    pending.current = false;
    if (!mounted.current) return;
    setOpening(false);
    setMessage(ok ? '' : 'Could not open this file. It may be missing or have no associated app.');
  };
  return <span className={'eterx-local-file-chip inline-flex min-w-0 max-w-full flex-wrap items-center overflow-hidden align-middle text-left ' + (compact ? 'my-0.5' : 'my-1') + ' rounded-[10px] border transition-colors'} title={target || reference}>
    <button type="button" onClick={openPath} aria-label={'Open ' + name + ' in default app'} aria-busy={opening} disabled={opening}
      className={'eterx-local-file-chip-open inline-flex min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-[10px] ' + (compact ? 'h-8 px-2' : 'h-9 px-2.5') + ' text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-current'}>
      <LocalFileIcon fileName={target || reference} size={compact ? 'sm' : 'md'} />
      <span className="eterx-local-file-chip-name min-w-0 truncate text-[12.75px] font-semibold leading-tight tracking-normal text-[var(--foreground)]">{name}</span>
      <ExternalLink className="eterx-local-file-chip-icon h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)] opacity-75" strokeWidth={2} />
    </button>
    {message && <span role="status" className="eterx-local-file-chip-error w-full whitespace-normal px-2 py-1 text-xs">{message}</span>}
  </span>;
});
