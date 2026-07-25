import React, { useMemo, useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import copy from 'copy-to-clipboard';

export const LOCAL_FILE_HREF_PREFIX = '#eterx-local-file:';
const LEGACY_LOCAL_FILE_HREF_PREFIX = 'eterx-local-file:';

const CODE_FENCE_SPLIT = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
const INLINE_CODE_SPLIT = /(`[^`\n]*`)/g;
const LOCAL_PATH_PATTERN = /(^|[\s([{"'>])((?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+[\\/]|\/(?:Users|home|tmp|var|mnt|Volumes)\/)[^\r\n`<>|]*?\.[A-Za-z0-9]{1,16})(?=$|[\s)\]}"'.,;!?])/g;
const LOCAL_PATH_EXACT_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+[\\/]|\/(?:Users|home|tmp|var|mnt|Volumes)\/)[^\r\n`<>|]*?\.[A-Za-z0-9]{1,16}$/;

export const getLocalFileName = (filePath: string) => {
  const cleaned = String(filePath || '').trim().replace(/[\\/]+$/, '');
  return cleaned.split(/[\\/]/).filter(Boolean).pop() || cleaned || 'File';
};

export const isLocalFilePath = (value: string) =>
  LOCAL_PATH_EXACT_PATTERN.test(String(value || '').trim());

export const encodeLocalFileHref = (filePath: string) =>
  `${ LOCAL_FILE_HREF_PREFIX }${ encodeURIComponent(String(filePath || '').trim()) }`;

export const decodeLocalFileHref = (href?: string | null) => {
  if (!href) return null;
  const prefix = href.startsWith(LOCAL_FILE_HREF_PREFIX)
    ? LOCAL_FILE_HREF_PREFIX
    : href.startsWith(LEGACY_LOCAL_FILE_HREF_PREFIX)
      ? LEGACY_LOCAL_FILE_HREF_PREFIX
      : '';
  if (!prefix) return null;
  try {
    return decodeURIComponent(href.slice(prefix.length));
  } catch {
    return href.slice(prefix.length);
  }
};

const escapeMarkdownLinkText = (value: string) => value.replace(/([\\[\]])/g, '\\$1');

const filePathMarkdownLink = (filePath: string) => {
  const cleanedPath = filePath.trim();
  if (!cleanedPath) return '';
  const fileName = escapeMarkdownLinkText(getLocalFileName(cleanedPath));
  return `[${ fileName }](${ encodeLocalFileHref(cleanedPath) })`;
};

export const linkifyLocalFilePaths = (value: string) => {
  if (!value) return '';

  return value.split(CODE_FENCE_SPLIT).map((block) => {
    if (/^(```|~~~)/.test(block)) return block;

    return block.split(INLINE_CODE_SPLIT).map((chunk) => {
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
    body: JSON.stringify({ path: target }),
  });
  return response.ok;
};

const getFileExtension = (fileName: string) => {
  const cleanName = getLocalFileName(fileName).toLowerCase();
  const match = cleanName.match(/\.([a-z0-9]{1,16})$/i);
  return match?.[1] || '';
};

const COMMON_EXTENSIONLESS_FILES = new Set([
  'dockerfile', 'makefile', 'license', 'rakefile', 'gemfile', 'procfile',
  'readme', 'authors', 'copying', 'install', 'todo', 'changelog'
]);

const getFileIconPath = (fileName: string) => {
  const filename = getLocalFileName(fileName).toLowerCase();
  const ext = getFileExtension(fileName);

  if (filename.startsWith('.git') || filename.includes('git')) return '/icons/files/git.svg';
  if (filename.includes('eslint')) return '/icons/files/eslint.svg';
  if (filename.includes('prettier')) return '/icons/files/prettier.svg';
  if (filename.includes('tsconfig')) return '/icons/files/tsconfig.svg';
  if (filename === 'package.json') return '/icons/files/npm.svg';
  if (filename === 'yarn.lock') return '/icons/files/yarn.svg';
  if (filename === 'pnpm-lock.yaml') return '/icons/files/pnpm.svg';
  if (filename.includes('next.config')) return '/icons/files/next.svg';
  if (filename.includes('vite.config')) return '/icons/files/vite.svg';
  if (filename.includes('webpack.config')) return '/icons/files/webpack.svg';
  if (filename.startsWith('.env') || filename === 'settings.json') return '/icons/files/settings.svg';
  if (filename === 'dockerfile' || ext === 'dockerfile') return '/icons/files/docker.svg';

  // If there is no extension and it is not a known extensionless file, treat it as a folder
  if (!ext && !COMMON_EXTENSIONLESS_FILES.has(filename)) {
    return '/icons/files/folder.svg';
  }

  switch (ext) {
    case 'tsx':
    case 'jsx':
      return '/icons/files/react.svg';
    case 'ts':
      return '/icons/files/typescript.svg';
    case 'js':
      return '/icons/files/javascript.svg';
    case 'py':
      return '/icons/files/python.svg';
    case 'html':
      return '/icons/files/html.svg';
    case 'css':
      return '/icons/files/css.svg';
    case 'json':
      return '/icons/files/json.svg';
    case 'go':
      return '/icons/files/go.svg';
    case 'md':
      return '/icons/files/markdown.svg';
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'ps1':
      return '/icons/files/console.svg';
    case 'svg':
      return '/icons/files/svg.svg';
    case 'yaml':
    case 'yml':
      return '/icons/files/yaml.svg';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'ico':
      return '/icons/files/image.svg';
    case 'pdf':
      return '/icons/files/pdf.svg';
    case 'csv':
    case 'tsv':
    case 'xls':
    case 'xlsx':
    case 'xlsm':
    case 'ods':
      return '/icons/files/spreadsheet.svg';
    case 'zip':
    case 'tar':
    case 'gz':
    case 'rar':
    case '7z':
      return '/icons/files/zip.svg';
    case 'lock':
      return '/icons/files/lock.svg';
    case 'sql':
    case 'db':
      return '/icons/files/database.svg';
    case 'sass':
    case 'scss':
      return '/icons/files/sass.svg';
    default:
      return '/icons/files/document.svg';
  }
};

export const LocalFileIcon = React.memo(({ fileName, size = 'md' }: { fileName: string; size?: 'sm' | 'md' }) => {
  const iconPath = useMemo(() => getFileIconPath(fileName), [fileName]);
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

  const previewUrl = useMemo(() => {
    const cleanPath = filePath.replace(/\\/g, '/');
    const segments = cleanPath.split('/').filter(Boolean).map(encodeURIComponent);
    return `/api/preview/${ segments.join('/') }`;
  }, [filePath]);

  const copyPath = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1000);
    await copyTextToClipboard(filePath);
  };

  const openPath = (event: React.MouseEvent) => {
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

  return (
    <span
      onClick={openPath}
      className={`eterx-local-file-chip inline-flex max-w-full items-center align-middle text-left ${ compact ? 'my-0.5' : 'my-1' } rounded-[10px] border border-white/[0.09] bg-[#181817] shadow-[0_7px_20px_rgba(0,0,0,0.16),inset_0_1px_0_rgba(255,255,255,0.045)] transition-colors hover:border-white/[0.14] hover:bg-[#1D1C1B] cursor-pointer`}
      title={filePath}
    >
      <span
        className={`inline-flex min-w-0 items-center gap-2 rounded-l-[10px] ${ compact ? 'px-2 py-1' : 'px-2.5 py-1.5' } text-left`}
      >
        <LocalFileIcon fileName={name} size={compact ? 'sm' : 'md'} />
        <span className="min-w-0 truncate text-[12.75px] font-semibold leading-tight tracking-normal text-[#E8E6E3]">
          {failed ? 'Open failed' : name}
        </span>
        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-[#807A72] opacity-75" strokeWidth={2} />
      </span>
      <span className="h-6 w-px shrink-0 bg-white/[0.10]" aria-hidden="true" />
      <button
        type="button"
        onClick={copyPath}
        className={`inline-flex shrink-0 items-center justify-center rounded-r-[10px] ${ compact ? 'h-8 w-8' : 'h-9 w-9' } text-[#9D968D] transition-colors hover:bg-white/[0.045] hover:text-[#E8E6E3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#94C7E0]/24`}
        aria-label={`Copy URL for ${ name }`}
        title="Copy download URL"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.2} /> : <Copy className="h-3.5 w-3.5" strokeWidth={2.1} />}
      </button>
    </span>
  );
});
