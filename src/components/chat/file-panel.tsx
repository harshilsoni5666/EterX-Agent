'use client';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, ExternalLink, Copy, Check, Globe, Code2,
  Columns2, RefreshCw, FileCode2, FileText, Monitor,
  Maximize2, Minimize2, Terminal, Search, TerminalSquare, ShieldAlert,
  Download, Settings, ChevronDown, ChevronRight, Folder, FolderOpen, Plus
} from 'lucide-react';

const Editor = dynamic(() => import('@monaco-editor/react'), { ssr: false });
const DiffEditor = dynamic(
  () => import('@monaco-editor/react').then(mod => mod.DiffEditor),
  { ssr: false },
);

/* ─── Syntax highlighter ─── */
const KW_FLOW = new Set(['if','else','elif','for','while','switch','case','break','continue','return','try','catch','finally','throw','raise','with','match','do']);
const KW_DECL = new Set(['const','let','var','function','class','async','await','import','export','from','as','type','interface','enum','extends','implements','static','abstract','override','def','lambda','pass','yield','del','require','fn','pub','use','struct']);
const KW_VAL  = new Set(['true','false','null','undefined','None','True','False','NaN','Infinity','void']);
const KW_THIS = new Set(['this','self','super','new','typeof','instanceof','in','of','is','not','and','or','delete','readonly','keyof','number','string','boolean','object','any','never']);

function highlightSyntax(code: string): string {
  if (!code) return '';
  const e = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const TOKEN = /(\/\/[^\n]*|#[^!\n][^\n]*|\/\*[\s\S]*?\*\/)|([\"'`])(?:(?!\2)[^\\]|\\.)*\2|(0x[0-9A-Fa-f]+|\b\d+\.?\d*(?:e[+-]?\d+)?\b)|([A-Z][a-zA-Z0-9_]*)|([a-z_][a-zA-Z0-9_]*)|(--?[a-zA-Z][a-zA-Z0-9-]*)/g;
  let out = '', last = 0;
  for (const m of e.matchAll(TOKEN)) {
    const [full,cmt,,num,pascal,ident,flag] = m;
    out += e.slice(last, m.index!); last = m.index! + full.length;
    if (cmt)       out += `<span style="color:#6E7681;font-style:italic">${full}</span>`;
    else if (m[2]) out += `<span style="color:#A5D6FF">${full}</span>`;
    else if (num)  out += `<span style="color:#79B8FF">${full}</span>`;
    else if (pascal) out += `<span style="color:#FFA657">${full}</span>`;
    else if (ident) {
      if (KW_FLOW.has(ident))      out += `<span style="color:#FF7B72">${full}</span>`;
      else if (KW_DECL.has(ident)) out += `<span style="color:#FF7B72;font-weight:600">${full}</span>`;
      else if (KW_VAL.has(ident))  out += `<span style="color:#79C0FF">${full}</span>`;
      else if (KW_THIS.has(ident)) out += `<span style="color:#79C0FF">${full}</span>`;
      else out += e.slice(last).trimStart().startsWith('(') ? `<span style="color:#D2A8FF">${full}</span>` : full;
    }
    else if (flag) out += `<span style="color:#56D364">${full}</span>`;
    else out += full;
  }
  return out + e.slice(last);
}

function getLanguage(fn: string) {
  const ext = fn.split('.').pop()?.toLowerCase() || '';
  const m: Record<string,string> = {
    js:'JS', jsx:'JSX', ts:'TS', tsx:'TSX', html:'HTML', htm:'HTML', css:'CSS', scss:'SCSS', less:'LESS',
    json:'JSON', md:'MD', mdx:'MDX', py:'Python', rb:'Ruby', go:'Go', rs:'Rust', c:'C', cpp:'C++', cs:'C#',
    java:'Java', php:'PHP', sh:'Shell', yml:'YAML', yaml:'YAML', xml:'XML', sql:'SQL', pdf:'PDF',
    ppt:'PPT', pptx:'PPTX', doc:'DOC', docx:'DOCX', xls:'XLS', xlsx:'XLSX', csv:'CSV', png:'PNG',
    jpg:'JPG', jpeg:'JPG', webp:'WEBP', svg:'SVG', mp4:'MP4', webm:'WEBM', mp3:'MP3', wav:'WAV', zip:'ZIP'
  };
  return m[ext] || ext.toUpperCase() || 'Text';
}

function getFileColor(fn: string) {
  const ext = fn.split('.').pop()?.toLowerCase() || '';
  const c: Record<string,string> = {
    ts:'#3178c6', tsx:'#3178c6', js:'#f7df1e', jsx:'#61dafb', html:'#e44d26', htm:'#e44d26',
    css:'#1572b6', scss:'#cd6799', less:'#1d365d', json:'#a4b856', py:'#3572a5', go:'#00add8',
    rs:'#dea584', md:'#8b949e', mdx:'#8b949e', pdf:'#e5484d', ppt:'#d65f2a', pptx:'#d65f2a',
    doc:'#2f6fed', docx:'#2f6fed', xls:'#2b8a3e', xlsx:'#2b8a3e', csv:'#2b8a3e',
    png:'#9b6bff', jpg:'#9b6bff', jpeg:'#9b6bff', webp:'#9b6bff', gif:'#9b6bff', svg:'#f59e0b',
    mp4:'#f97316', webm:'#f97316', mov:'#f97316', mp3:'#22c55e', wav:'#22c55e', zip:'#9ca3af'
  };
  return c[ext] || '#8b949e';
}

type PreviewKind =
  | 'html'
  | 'pdf'
  | 'image'
  | 'video'
  | 'audio'
  | 'markdown'
  | 'data'
  | 'text'
  | 'office'
  | 'archive'
  | 'code'
  | 'unknown';

type PreviewDevice = 'desktop' | 'mobile';

type PreviewFile = { filename: string; filepath: string; content?: string };

const TEXT_PREVIEW_LIMIT = 80000;
const FILE_TREE_DEPTH = 3;
const FILE_TREE_POLL_MS = 15000;
const FILE_READ_LINE_LIMIT = 5000;

const countLines = (value: string) => {
  if (!value) return 0;
  const matches = value.match(/\n/g);
  return (matches?.length || 0) + 1;
};

function getFileExtension(fn: string) {
  const ext = fn.split('.').pop()?.toLowerCase() || '';
  return ext || 'file';
}

function getPreviewKind(fn: string): PreviewKind {
  const ext = getFileExtension(fn);
  if (['html', 'htm'].includes(ext)) return 'html';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio';
  if (['md', 'mdx'].includes(ext)) return 'markdown';
  if (['json', 'csv', 'xml', 'yaml', 'yml', 'toml', 'ini'].includes(ext)) return 'data';
  if (['txt', 'log', 'env'].includes(ext)) return 'text';
  if (['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) return 'office';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
  if (['js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less', 'vue', 'svelte'].includes(ext)) return 'code';
  return 'unknown';
}

function isConnectedWebAsset(fn?: string) {
  if (!fn) return false;
  return ['code'].includes(getPreviewKind(fn));
}

function getPreviewLabel(fn?: string) {
  if (!fn) return 'Preview';
  const ext = getFileExtension(fn);
  const labels: Record<string, string> = {
    html: 'Web page', htm: 'Web page', pdf: 'PDF document',
    ppt: 'Presentation deck', pptx: 'Presentation deck',
    doc: 'Word document', docx: 'Word document',
    xls: 'Spreadsheet', xlsx: 'Spreadsheet', csv: 'Data table',
    md: 'Markdown', mdx: 'Markdown',
    png: 'Image', jpg: 'Image', jpeg: 'Image', webp: 'Image', svg: 'Vector image',
    mp4: 'Video', webm: 'Video', mov: 'Video', mp3: 'Audio', wav: 'Audio',
    zip: 'Archive'
  };
  return labels[ext] || getLanguage(fn);
}

function buildPreviewUrl(filepath: string) {
  return `/api/preview/${filepath.replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
}

function getPreviewAddress(file?: PreviewFile | null, fallback = 'http://localhost:3000') {
  if (!file?.filepath) return fallback;
  return `file:///${normalizeWorkspacePath(file.filepath)}`;
}

function normalizeLocalhostPreviewAddress(input: string) {
  const trimmed = input.trim();
  const hostMatch = trimmed.match(/^(localhost|127\.0\.0\.1|\[::1\]|::1)(?::(\d+))?(\/.*)?$/i);
  if (hostMatch) {
    const host = hostMatch[1];
    const port = hostMatch[2] || '3000';
    const rest = hostMatch[3] || '/';
    return `http://${host}:${port}${rest}`;
  }

  const portOnlyMatch = trimmed.match(/^:?(3000|[1-9]\d{1,4})(\/.*)?$/);
  if (portOnlyMatch) {
    return `http://localhost:${portOnlyMatch[1]}${portOnlyMatch[2] || '/'}`;
  }

  return '';
}

function resolvePreviewAddress(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return 'http://localhost:3000';
  if (trimmed.startsWith('/api/preview/')) return trimmed;

  const localAddress = normalizeLocalhostPreviewAddress(trimmed);
  if (localAddress) return localAddress;

  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const filePath = trimmed.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '');
  if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('/')) {
    return buildPreviewUrl(filePath);
  }

  return trimmed;
}

function normalizeWorkspacePath(filepath?: string) {
  return (filepath || '').replace(/\\/g, '/').replace(/^([A-Za-z])\//, '$1:/');
}

function getDirname(filepath?: string) {
  const normalized = normalizeWorkspacePath(filepath);
  return normalized.split('/').slice(0, -1).join('/');
}

function flattenFileEntries(entries: FileEntry[] = []): PreviewFile[] {
  const files: PreviewFile[] = [];
  const walk = (nodes: FileEntry[]) => {
    nodes.forEach(node => {
      if (node.type === 'file') files.push({ filename: node.name, filepath: node.path });
      if (node.children?.length) walk(node.children);
    });
  };
  walk(entries);
  return files;
}

function findConnectedHtmlFile(activeFile: PreviewFile | null, openFiles: PreviewFile[], workspaceFiles: PreviewFile[]) {
  const candidates = [...openFiles, ...workspaceFiles]
    .filter(file => /\.(html|htm)$/i.test(file.filename))
    .filter((file, index, all) => all.findIndex(next => normalizeWorkspacePath(next.filepath) === normalizeWorkspacePath(file.filepath)) === index);

  if (!candidates.length) return null;
  if (!activeFile?.filepath) return candidates[0];

  const activeDir = getDirname(activeFile.filepath);
  return [...candidates].sort((a, b) => {
    const aDir = getDirname(a.filepath);
    const bDir = getDirname(b.filepath);
    const aSame = aDir === activeDir ? 0 : 1;
    const bSame = bDir === activeDir ? 0 : 1;
    if (aSame !== bSame) return aSame - bSame;

    const aIndex = /^index\.(html|htm)$/i.test(a.filename) ? 0 : 1;
    const bIndex = /^index\.(html|htm)$/i.test(b.filename) ? 0 : 1;
    if (aIndex !== bIndex) return aIndex - bIndex;

    const aDistance = Math.abs(aDir.length - activeDir.length);
    const bDistance = Math.abs(bDir.length - activeDir.length);
    return aDistance - bDistance;
  })[0];
}

function withReloadKey(url: string, key: number) {
  if (!url || key === 0) return url;
  return `${url}${url.includes('?') ? '&' : '?'}previewReload=${key}`;
}

type ResolvedUiTheme = 'dark' | 'light';

function readResolvedUiTheme(): ResolvedUiTheme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

type TabMode = 'code' | 'diff' | 'preview';

export interface FilePanelProps {
  filename: string;
  filepath: string;
  content?: string;
  diffLines?: Array<{ type: 'added'|'removed'|'unchanged'|'context'; content: string; oldLine?: number; newLine?: number }>;
  isEdit?: boolean;
  language?: string;
  linesAdded?: number;
  linesRemoved?: number;
  added?: number;
  removed?: number;
  lineCount?: number;
  totalLines?: number;
  loadedLines?: number;
  startLine?: number;
  endLine?: number;
  truncated?: boolean;
  size?: number;
  loadError?: string;
  artifactKind?: 'code' | 'document' | 'media' | 'preview' | 'terminal' | 'task' | 'other';
  updatedAt?: string | number | Date;
  onClose?: () => void;
  activeTabMode?: 'preview' | 'code' | 'diff';
}

export const FilePanelModal = ({ filename, filepath, content: initialContent, diffLines, isEdit, linesAdded, linesRemoved, added: addedProp, removed: removedProp, onClose, activeTabMode }: FilePanelProps) => {
  const isHtml = /\.(html|htm|svg)$/i.test(filename);
  const [localContent, setLocalContent] = useState<string>(initialContent || '');
  const [tab, setTab] = useState<TabMode>(activeTabMode || (isEdit && diffLines?.length ? 'diff' : 'code'));
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (activeTabMode) setTab(activeTabMode);
  }, [activeTabMode]);
  
  // Real-time Console State
  const [consoleLogs, setConsoleLogs] = useState<{level: string, message: string}[]>([]);
  const [showConsole, setShowConsole] = useState(false);

  useEffect(() => {
    if (filepath) {
      fetch('/api/code/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: filepath })
      })
      .then(res => res.json())
      .then(data => {
        if (data.content !== undefined) setLocalContent(data.content);
      })
      .catch(e => console.error('[FilePanel] Fetch error:', e));
    }
  }, [filepath]);

  // Build URL for preview, keeping the visible address readable for local files.
  const modalPreviewUrl = isHtml ? buildPreviewUrl(filepath) : 'http://localhost:3000';
  const [urlInput, setUrlInput] = useState<string>(isHtml ? getPreviewAddress({ filename, filepath }, modalPreviewUrl) : modalPreviewUrl);
  const [previewUrl, setPreviewUrl] = useState<string>(modalPreviewUrl);

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'preview-console') {
        setConsoleLogs(prev => [...prev, { level: e.data.level, message: e.data.args.join(' ') }]);
        setShowConsole(true);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const handleCopy = () => {
    navigator.clipboard.writeText(localContent || diffLines?.map(l => l.content).join('\n') || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const added   = diffLines?.filter(l => l.type === 'added').length   || addedProp || linesAdded || 0;
  const removed = diffLines?.filter(l => l.type === 'removed').length || removedProp || linesRemoved || 0;
  const lineCount = countLines(localContent || '');
  const lang = getLanguage(filename);
  const fileColor = getFileColor(filename);
  const normalizedPath = filepath.replace(/\\/g, '/');

  const tabs = [
    { id: 'code'    as const, label: 'Code',    icon: Code2,     show: true },
    { id: 'diff'    as const, label: 'Changes', icon: FileText,  show: !!(isEdit && diffLines?.length) },
    { id: 'preview' as const, label: 'Preview', icon: Monitor,   show: true }, // Always allow full preview
  ].filter(t => t.show) as { id: TabMode; label: string; icon: any; show: boolean }[];

  /* ── Code panel ── */
  const CodePanel = () => {
    const languageMap: Record<string, string> = {
      'JS': 'javascript', 'TS': 'typescript', 'TSX': 'typescript', 'JSX': 'javascript',
      'HTML': 'html', 'CSS': 'css', 'SCSS': 'scss', 'JSON': 'json', 'PY': 'python',
      'GO': 'go', 'RS': 'rust', 'C': 'c', 'C++': 'cpp', 'C#': 'csharp', 'JAVA': 'java',
      'PHP': 'php', 'SHELL': 'shell', 'YAML': 'yaml', 'XML': 'xml', 'SQL': 'sql'
    };
    const langKey = getLanguage(filename);
    const editorLang = languageMap[langKey] || 'plaintext';

    return (
      <div className="flex-1 w-full h-full relative bg-[#07070A]">
        <Editor
          height="100%"
          language={editorLang}
          theme="vs-dark"
          value={localContent}
          onChange={(value) => setLocalContent(value || '')}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'JetBrains Mono, Menlo, monospace',
            lineHeight: 24,
            padding: { top: 16, bottom: 16 },
            scrollBeyondLastLine: false,
            smoothScrolling: false,
            cursorBlinking: 'solid',
            cursorSmoothCaretAnimation: 'off',
            formatOnPaste: true,
            wordWrap: 'on',
            renderLineHighlight: 'none',
            fontLigatures: false,
            renderValidationDecorations: 'off',
          }}
          loading={
            <div className="flex items-center justify-center h-full text-[#555350] text-[12px] font-mono">
               Preparing editor...
            </div>
          }
        />
      </div>
    );
  };

  /* ── Diff panel ── */
  const DiffPanel = () => {
    const languageMap: Record<string, string> = {
      'JS': 'javascript', 'TS': 'typescript', 'TSX': 'typescript', 'JSX': 'javascript',
      'HTML': 'html', 'CSS': 'css', 'SCSS': 'scss', 'JSON': 'json', 'PY': 'python'
    };
    const editorLang = languageMap[getLanguage(filename)] || 'plaintext';

    const original = useMemo(() => (diffLines || []).filter((l: any) => l.type !== 'added').map((l: any) => l.content).join('\n'), [diffLines]);
    const modified = useMemo(() => (diffLines || []).filter((l: any) => l.type !== 'removed').map((l: any) => l.content).join('\n'), [diffLines]);

    return (
      <div className="flex-1 w-full h-full relative bg-[#07070A]">
        <DiffEditor
          height="100%"
          language={editorLang}
          theme="vs-dark"
          original={original}
          modified={modified}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'JetBrains Mono, Menlo, monospace',
            lineHeight: 24,
            padding: { top: 16, bottom: 16 },
            readOnly: true,
            renderSideBySide: true,
            scrollBeyondLastLine: false,
            smoothScrolling: false,
            wordWrap: 'off'
          }}
          loading={<div className="flex items-center justify-center h-full text-[#555350] text-[12px] font-mono">Preparing comparison...</div>}
        />
      </div>
    );
  };

  const CodeHeader = () => (
    <div className="flex items-center justify-between px-4 py-[10px] border-b border-white/[0.04] bg-[#0A0A0C] shrink-0">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: fileColor }} />
        <span className="text-[12.5px] font-semibold text-[#E8E6E3] truncate">{filename}</span>
        <span className="text-[9px] font-mono text-[#555350] bg-white/[0.04] border border-white/[0.06] px-1.5 py-[2px] rounded shrink-0 uppercase tracking-wide">{lang}</span>
        {added > 0 && <span className="text-[10px] font-bold font-mono text-emerald-400 bg-emerald-500/10 px-1.5 py-[1.5px] rounded shrink-0">+{added}</span>}
        {removed > 0 && <span className="text-[10px] font-bold font-mono text-red-400 bg-red-500/10 px-1.5 py-[1.5px] rounded shrink-0">−{removed}</span>}
        {tab === 'code' && localContent && <span className="text-[10px] font-mono text-[#555350] shrink-0">{lineCount}L</span>}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <div className="flex items-center bg-white/[0.02] border border-white/[0.05] rounded p-0.5 mr-2">
          {isHtml && (
            <button onClick={() => setTab('preview')} className="px-2 py-0.5 rounded-[3px] text-[10px] font-medium transition-colors text-[#555350] hover:text-[#A3A19E]">Preview</button>
          )}
          <button onClick={() => setTab('code')} className={`px-2 py-0.5 rounded-[3px] text-[10px] font-medium transition-colors ${tab==='code' ? 'bg-white/[0.1] text-[#E8E6E3]' : 'text-[#555350] hover:text-[#A3A19E]'}`}>Code</button>
          {isEdit && diffLines?.length ? (
            <button onClick={() => setTab('diff')} className={`px-2 py-0.5 rounded-[3px] text-[10px] font-medium transition-colors ${tab==='diff' ? 'bg-white/[0.1] text-[#E8E6E3]' : 'text-[#555350] hover:text-[#A3A19E]'}`}>Diff</button>
          ) : null}
        </div>

        <button onClick={handleCopy} className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold tracking-wide transition-all ${copied ? 'text-emerald-400 bg-emerald-500/10' : 'text-[#555350] hover:text-[#E8E6E3] hover:bg-white/[0.04]'}`}>
          {copied ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>}
          {copied ? 'COPIED' : 'COPY'}
        </button>
        <button onClick={() => window.open(`vscode://file/${normalizedPath}`, '_blank')} title="Open in VS Code" className="p-1.5 rounded-md text-[#555350] hover:text-[#E8E6E3] hover:bg-white/[0.04] transition-all ml-0.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="10 9 15 4 20 9"></polyline><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path><path d="M8 12v6"></path><path d="M12 12v6"></path><path d="M16 12v6"></path></svg>
        </button>
      </div>
    </div>
  );

  const PreviewHeader = () => (
    <div className="flex items-center justify-between px-4 py-2 bg-[#111115] border-b border-white/[0.06] shrink-0">
      <div className="flex gap-1.5 shrink-0 w-[60px]">
        <div className="w-2.5 h-2.5 rounded-full bg-[#FF5F57] shadow-sm border border-black/20" />
        <div className="w-2.5 h-2.5 rounded-full bg-[#FEBC2E] shadow-sm border border-black/20" />
        <div className="w-2.5 h-2.5 rounded-full bg-[#28C840] shadow-sm border border-black/20" />
      </div>
      
      <div className="flex-1 flex justify-center px-4">
        <div className="flex items-center gap-2 bg-[#0D0D10] border border-white/[0.05] rounded-md px-3 py-1.5 max-w-[400px] w-full shadow-inner justify-center">
          <Globe className="w-3 h-3 text-[#555350] shrink-0" />
          <input 
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') setPreviewUrl(resolvePreviewAddress(urlInput)); }}
            className="text-[11px] text-[#A3A19E] font-mono truncate bg-transparent outline-none flex-1" 
          />
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0 w-[120px] justify-end">
        <div className="flex items-center bg-[#050505] border border-white/[0.05] rounded p-0.5 mr-2">
          <button onClick={() => setTab('preview')} className="px-2 py-0.5 rounded-[3px] text-[10px] font-medium transition-colors bg-white/[0.1] text-[#E8E6E3]">Preview</button>
          <button onClick={() => setTab('code')} className="px-2 py-0.5 rounded-[3px] text-[10px] font-medium transition-colors text-[#555350] hover:text-[#A3A19E]">Code</button>
        </div>
        <button onClick={() => {
           const iframe = document.getElementById('preview-iframe') as HTMLIFrameElement;
           if (iframe && iframe.contentWindow) {
             iframe.contentWindow.postMessage({ type: 'preview-reload' }, '*');
           }
        }} className="p-1.5 rounded-md text-[#555350] hover:text-[#E8E6E3] hover:bg-white/[0.04] transition-all" title="Reload Preview">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
        </button>
        <button onClick={() => window.open(`file:///${normalizedPath}`, '_blank')} className="p-1.5 rounded-md text-[#555350] hover:text-[#4FC1FF] hover:bg-white/[0.04] transition-all" title="Open in browser">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
        </button>
      </div>
    </div>
  );

  const panelContent = (
    <div className="flex h-full w-full bg-[#1E1E1E]">
      {tab !== 'preview' ? (
        <div className="flex-1 flex flex-col h-full bg-[#1E1E1E]">
          {!activeTabMode && <CodeHeader />}
          <div className="flex-1 overflow-hidden relative">
            {tab === 'code' && <CodePanel />}
            {tab === 'diff' && <DiffPanel />}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col h-full bg-[#1E1E1E] relative">
          {!activeTabMode && <PreviewHeader />}
          {previewUrl ? (
            <div className="flex-1 flex flex-col relative overflow-hidden">
               <iframe id="preview-iframe" key={previewUrl} src={previewUrl} className="flex-1 border-0 bg-white w-full h-full" sandbox="allow-scripts allow-same-origin allow-modals allow-forms" title={`Preview: ${filename}`} />
               
               {/* Console UI */}
               <AnimatePresence>
                 {showConsole && (
                    <motion.div 
                      initial={{ y: 100, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      exit={{ y: 100, opacity: 0 }}
                      className="absolute bottom-0 left-0 right-0 h-48 bg-[#0D0D10] border-t border-white/[0.08] shadow-2xl flex flex-col z-20"
                    >
                       <div className="flex items-center justify-between px-3 py-1.5 bg-[#111115] border-b border-white/[0.05] shrink-0">
                         <div className="flex items-center gap-1.5 text-[10.5px] font-mono text-[#A3A19E]">
                           <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#555350]"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
                           Console Output
                           <span className="bg-white/[0.05] text-[#555350] px-1.5 rounded-full text-[9px] ml-1">{consoleLogs.length}</span>
                         </div>
                         <div className="flex items-center gap-1">
                           <button onClick={() => setConsoleLogs([])} className="px-2 py-0.5 rounded text-[10px] text-[#555350] hover:text-[#E8E6E3] hover:bg-white/[0.05] transition-colors">Clear</button>
                           <button onClick={() => setShowConsole(false)} className="p-1 rounded text-[#555350] hover:text-red-400 hover:bg-red-500/10 transition-colors"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
                         </div>
                       </div>
                       <div className="eterx-scrollbar flex-1 overflow-auto p-2 space-y-1 font-mono text-[11.5px] [scrollbar-gutter:stable]">
                         {consoleLogs.map((log, i) => (
                           <div key={i} className={`flex gap-2 px-2 py-1 rounded-[4px] border ${log.level === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-400' : log.level === 'warn' ? 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400' : 'bg-transparent border-transparent text-[#E8E6E3] hover:bg-white/[0.02]'}`}>
                              <div className="shrink-0 pt-0.5">
                                 {log.level === 'error' ? <X className="w-3 h-3" /> : log.level === 'warn' ? <div className="w-3 h-3 rounded-full border border-yellow-400 flex items-center justify-center text-[8px]">!</div> : <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1" />}
                              </div>
                              <div className="whitespace-pre-wrap break-all">{log.message}</div>
                           </div>
                         ))}
                         {consoleLogs.length === 0 && <div className="text-[#555350] p-2 italic">No logs yet...</div>}
                       </div>
                    </motion.div>
                 )}
               </AnimatePresence>
               
               {/* Floating Console Toggle if Hidden */}
               {!showConsole && consoleLogs.length > 0 && (
                  <button 
                    onClick={() => setShowConsole(true)}
                    className="absolute bottom-4 right-4 bg-[#0D0D10]/90 backdrop-blur border border-white/[0.1] text-[#E8E6E3] rounded-full p-2 shadow-lg hover:scale-105 transition-transform group flex items-center gap-2"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
                    <span className="text-[11px] font-mono font-medium max-w-0 overflow-hidden group-hover:max-w-[100px] transition-all whitespace-nowrap">View Console</span>
                    {consoleLogs.filter(l => l.level==='error').length > 0 && (
                      <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border-2 border-[#0A0A0C]" />
                    )}
                  </button>
               )}
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[#555350]">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="opacity-30"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
              <span className="text-[12px] font-mono">No content available for preview</span>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return fullscreen ? (
    createPortal(
      <div className="fixed inset-0 z-[99999] flex flex-col bg-[#0A0A0C]">
        {panelContent}
      </div>,
      document.body
    )
  ) : (
    panelContent
  );
};

/* --- IDE Multi-Tab Panel --- */
import { useGlobalFilePanel } from '../../contexts/FilePanelContext';
import { LayoutList } from 'lucide-react';
import WorkspaceReviewEditor from './workspace-review-editor';
import { LiveBrowserPanel } from './live-browser-panel';

type IdeTabMode = 'preview' | 'code' | 'review' | 'browser';

// File icon for real filesystem nodes
const FileNodeIcon = ({ name, isDir, isOpen }: { name: string, isDir: boolean, isOpen?: boolean }) => {
  if (isDir) return isOpen ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#C09553]"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#C09553]"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>;
};

const PreviewFileNodeIcon = ({ name, isDir, isOpen }: { name: string, isDir: boolean, isOpen?: boolean }) => {
  if (isDir) {
    return isOpen
      ? <FolderOpen className="h-[14px] w-[14px] shrink-0 text-[#C09553]" strokeWidth={1.8} />
      : <Folder className="h-[14px] w-[14px] shrink-0 text-[#C09553]" strokeWidth={1.8} />;
  }

  const ext = getFileExtension(name);
  const labels: Record<string, string> = {
    ts: 'TS', tsx: 'TX', js: 'JS', jsx: 'JX', html: 'WEB', htm: 'WEB', css: 'CSS', scss: 'SC', json: '{}',
    py: 'PY', md: 'MD', mdx: 'MX', pdf: 'PDF', ppt: 'PPT', pptx: 'PPT', doc: 'DOC', docx: 'DOC',
    xls: 'XLS', xlsx: 'XLS', csv: 'CSV', png: 'IMG', jpg: 'IMG', jpeg: 'IMG', webp: 'IMG', gif: 'IMG',
    svg: 'SVG', mp4: 'VID', webm: 'VID', mov: 'VID', mp3: 'AUD', wav: 'AUD', zip: 'ZIP'
  };
  const label = labels[ext] || 'FILE';
  const color = getFileColor(name);

  return (
    <div
      className="flex h-[15px] min-w-[22px] max-w-[28px] shrink-0 items-center justify-center rounded-[4px] border px-[3px] text-[7.5px] font-black leading-none tracking-[-0.01em]"
      style={{ color, borderColor: `${color}55`, backgroundColor: `${color}14` }}
    >
      {label}
    </div>
  );
};

interface FileEntry { name: string; path: string; type: 'file' | 'directory'; children?: FileEntry[]; extension?: string; }

const FileTreeNode = ({ node, depth, openFilePaths, activeFilePath, onFileClick }: {
  node: FileEntry; depth: number;
  openFilePaths: Set<string>;
  activeFilePath: string;
  onFileClick: (path: string, name: string) => void;
}) => {
  const [expanded, setExpanded] = useState(depth < 1);
  const isActive = node.path === activeFilePath;
  const isOpen = openFilePaths.has(node.path);

  if (node.type === 'directory') {
    return (
      <div>
        <div
          onClick={() => setExpanded(e => !e)}
          className={`flex items-center gap-1.5 px-2 py-[3px] hover:bg-[#2A2D2E] cursor-pointer rounded-sm mx-1`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          {expanded ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#888] shrink-0"><polyline points="6 9 12 15 18 9"></polyline></svg> : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#888] shrink-0"><polyline points="9 18 15 12 9 6"></polyline></svg>}
          <PreviewFileNodeIcon name={node.name} isDir={true} isOpen={expanded} />
          <span className="text-[12px] text-[#CCCCCC] truncate">{node.name}</span>
        </div>
        {expanded && node.children?.map((child, i) => (
          <FileTreeNode key={i} node={child} depth={depth + 1} openFilePaths={openFilePaths} activeFilePath={activeFilePath} onFileClick={onFileClick} />
        ))}
      </div>
    );
  }

  return (
    <div
      onClick={() => onFileClick(node.path, node.name)}
      data-active={isActive ? 'true' : undefined}
      data-open={isOpen ? 'true' : undefined}
      className={`eterx-ide-tree-node flex items-center gap-1.5 py-[3px] hover:bg-[#2A2D2E] cursor-pointer rounded-sm mx-1 group ${
        isActive ? 'bg-[#37373D]' : isOpen ? 'bg-[#2D2D30]' : ''
      }`}
      style={{ paddingLeft: `${8 + depth * 14 + 12}px`, paddingRight: '8px' }}
    >
      <PreviewFileNodeIcon name={node.name} isDir={false} />
      <span className={`text-[12px] truncate flex-1 ${isActive ? 'text-white' : isOpen ? 'text-[#E8E6E3]' : 'text-[#BBBBBB]'}`}>{node.name}</span>
      {isOpen && <div className="w-1.5 h-1.5 rounded-full bg-[#4FC1FF] shrink-0 opacity-70" />}
    </div>
  );
};

export const IdePanel = () => {
  const { openFiles, reviewFiles, reviewSubagents, activeIndex, closePanel, setActiveIndex, openPanel } = useGlobalFilePanel();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, index: number } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [activeTabMode, setActiveTabMode] = useState<IdeTabMode>('code');
  const [fileTree, setFileTree] = useState<FileEntry[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState<string>('');
  const [workspaceName, setWorkspaceName] = useState<string>('');
   const [terminalOpen, setTerminalOpen] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isTreeLoading, setIsTreeLoading] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>('desktop');
  const [iframeHistory, setIframeHistory] = useState<string[]>([]);
  const [iframeHistoryIndex, setIframeHistoryIndex] = useState(-1);
  const [consoleLogs, setConsoleLogs] = useState<{ type: 'info' | 'warn' | 'error', text: string }[]>([]);
  const [isPanelClosing, setIsPanelClosing] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const panelShellRef = useRef<HTMLDivElement>(null);
  const fileContainerRef = useRef<HTMLDivElement>(null);
  const treeSignatureRef = useRef('');
  const treeFetchInFlightRef = useRef(false);
  const fileReadAbortRef = useRef<AbortController | null>(null);
  const fileReadPathRef = useRef('');
  const autoFileReadAbortRef = useRef<AbortController | null>(null);
  const panelCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dockPosition, setDockPosition] = useState<{ left: number; top: number } | null>(null);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedUiTheme>('light');
  const isLightTheme = resolvedTheme === 'light';
  const editorBackground = isLightTheme ? '#FFFFFF' : '#0d0d0f';
  const previewShellBackground = isLightTheme ? '#F7F6F3' : '#262628';
  const previewToolbarStyle = isLightTheme
    ? { background: 'linear-gradient(180deg,#FFFFFF 0%,#F0EFEB 100%)', borderBottom: '1px solid rgba(31,31,29,0.10)' }
    : { background: 'linear-gradient(180deg,#343436 0%,#2D2D2F 100%)', borderBottom: '1px solid rgba(255,255,255,0.06)' };
  const previewAddressStyle = isLightTheme
    ? { background: 'rgba(255,255,255,0.82)', border: '1px solid rgba(31,31,29,0.12)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.78)' }
    : { background: 'rgba(0,0,0,0.26)', border: '1px solid rgba(255,255,255,0.07)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.035)' };

  useEffect(() => {
    const syncTheme = () => setResolvedTheme(readResolvedUiTheme());
    syncTheme();

    const root = document.documentElement;
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    window.addEventListener('eterx-settings-updated', syncTheme);

    return () => {
      observer.disconnect();
      window.removeEventListener('eterx-settings-updated', syncTheme);
    };
  }, []);

  useEffect(() => () => {
    if (panelCloseTimerRef.current) clearTimeout(panelCloseTimerRef.current);
    fileReadAbortRef.current?.abort();
    autoFileReadAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (isFullscreen) {
      setDockPosition(null);
      return;
    }

    const updateDockPosition = () => {
      const rect = fileContainerRef.current?.getBoundingClientRect();
      if (!rect) return;

      setDockPosition({
        left: rect.left + rect.width / 2,
        top: 24,
      });
    };

    updateDockPosition();
    const frame = window.requestAnimationFrame(updateDockPosition);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateDockPosition) : null;
    if (observer && panelShellRef.current) observer.observe(panelShellRef.current);
    if (observer && fileContainerRef.current) observer.observe(fileContainerRef.current);
    window.addEventListener('resize', updateDockPosition);

    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', updateDockPosition);
    };
  }, [activeTabMode, isFullscreen, openFiles.length, sidebarOpen]);

  // Derive workspace root — go 1 level up (direct parent = project folder)
  useEffect(() => {
    if (openFiles.length === 0) return;
    const firstPath = openFiles[0].filepath;
    if (!firstPath) return;
    const parts = firstPath.replace(/\\/g, '/').split('/');
    // Use the immediate parent directory of the file as the workspace root
    const rootParts = parts.slice(0, Math.max(1, parts.length - 1));
    const root = rootParts.join('/').replace(/^([A-Za-z])\//, '$1:/');
    setWorkspaceRoot(root);
    setWorkspaceName(rootParts[rootParts.length - 1] || 'Workspace');
  }, [openFiles[0]?.filepath]);

  // Fetch real file tree from workspace root
  const fetchFileTree = useCallback(async (root: string, silent = false) => {
    if (!root) return;
    if (treeFetchInFlightRef.current) return;
    treeFetchInFlightRef.current = true;
    if (!silent) setIsTreeLoading(true);
    try {
      const res = await fetch(`/api/code/files?path=${encodeURIComponent(root)}&depth=${FILE_TREE_DEPTH}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.tree) {
        const nextSignature = data.signature || `${data.root || root}:${data.totalEntries || data.tree.length}`;
        if (nextSignature !== treeSignatureRef.current) {
          treeSignatureRef.current = nextSignature;
          setFileTree(data.tree);
        }
      }
    } catch {} finally {
      treeFetchInFlightRef.current = false;
      if (!silent) setIsTreeLoading(false);
    }
  }, []);

  // Initial fetch + live polling every 3s (silent — only updates if content changed)
  useEffect(() => {
    if (!workspaceRoot) return;
    fetchFileTree(workspaceRoot, false);
    if (!sidebarOpen || activeTabMode !== 'code') return;
    const interval = setInterval(() => {
      if (document.hidden) return;
      fetchFileTree(workspaceRoot, true);
    }, FILE_TREE_POLL_MS);
    return () => clearInterval(interval);
  }, [workspaceRoot, fetchFileTree, sidebarOpen, activeTabMode]);

  // Capture real console logs from preview iframe via postMessage (silent — never auto-opens console)
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'preview-console') {
        const level = e.data.level as 'info' | 'warn' | 'error';
        const text = (e.data.args as string[]).join(' ');
        setConsoleLogs(prev => [...prev.slice(-99), { type: level, text }]);
        // Never auto-open — user controls the console
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setPaletteOpen(open => !open); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') { e.preventDefault(); setSidebarOpen(open => !open); }
      if (e.key === 'Escape') {
        setPaletteOpen(false);
        if (isFullscreen) setIsFullscreen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  const activeFile = activeIndex >= 0 && activeIndex < openFiles.length ? openFiles[activeIndex] : null;
  const reviewSourceFiles = useMemo(() => {
    const byPath = new Map<string, FilePanelProps>();
    const absorb = (file: FilePanelProps) => {
      const key = (file.filepath || file.filename || '').replace(/\\/g, '/').toLowerCase();
      if (!key) return;
      const existing = byPath.get(key);
      if (!existing) {
        byPath.set(key, file);
        return;
      }
      const merged = { ...existing };
      (Object.keys(file) as Array<keyof FilePanelProps>).forEach(prop => {
        const value = file[prop];
        if (value !== undefined) (merged as any)[prop] = value;
      });
      byPath.set(key, merged);
    };
    if (reviewFiles.length > 0) {
      reviewFiles.forEach(absorb);
      openFiles.forEach(file => {
        const key = (file.filepath || file.filename || '').replace(/\\/g, '/').toLowerCase();
        if (byPath.has(key)) absorb(file);
      });
    } else {
      openFiles.forEach(absorb);
    }
    return Array.from(byPath.values());
  }, [reviewFiles, openFiles]);

  useEffect(() => {
    const requestedMode = activeFile?.activeTabMode;
    if (!requestedMode) return;
    setActiveTabMode(requestedMode === 'diff' ? 'review' : requestedMode);
  }, [activeFile?.filepath, activeFile?.activeTabMode]);

  const workspaceFiles = useMemo(() => flattenFileEntries(fileTree), [fileTree]);
  const connectedHtmlFile = useMemo(
    () => findConnectedHtmlFile(activeFile, openFiles, workspaceFiles),
    [activeFile?.filepath, openFiles, workspaceFiles]
  );
  const shouldUseConnectedWebPreview = activeTabMode === 'preview' && !!activeFile && isConnectedWebAsset(activeFile.filename) && !!connectedHtmlFile;
  const previewTarget = activeTabMode === 'preview'
    ? (shouldUseConnectedWebPreview ? connectedHtmlFile : (activeFile || connectedHtmlFile))
    : activeFile;
  const previewKind = previewTarget ? getPreviewKind(previewTarget.filename) : 'html';
  const previewFileUrl = previewTarget?.filepath ? buildPreviewUrl(previewTarget.filepath) : '';
  const previewTitleFile = shouldUseConnectedWebPreview && activeFile ? activeFile : previewTarget;
  const previewFileExtension = previewTitleFile ? getFileExtension(previewTitleFile.filename).toUpperCase() : 'URL';
  const previewFileColor = previewTitleFile ? getFileColor(previewTitleFile.filename) : '#8b949e';
  const previewPath = previewTitleFile?.filepath ? normalizeWorkspacePath(previewTitleFile.filepath) : 'http://localhost:3000';
  const previewContent = previewTarget?.content || '';
  const textPreview = previewContent.length > TEXT_PREVIEW_LIMIT ? previewContent.slice(0, TEXT_PREVIEW_LIMIT) : previewContent;
  const isTextPreviewTrimmed = previewContent.length > TEXT_PREVIEW_LIMIT;
  const previewLineCount = useMemo(() => countLines(previewContent), [previewContent]);
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const [copiedPreviewPath, setCopiedPreviewPath] = useState(false);

  // Real-time URL State for Full Project Previews
  const [urlInput, setUrlInput] = useState('http://localhost:3000');
  const [previewUrl, setPreviewUrl] = useState('http://localhost:3000');

  const handlePreviewAddressSubmit = () => {
    setPreviewUrl(resolvePreviewAddress(urlInput));
    setIsPreviewLoading(true);
  };

  // Keep preview connected to the selected file, or to its nearest HTML entry for scripts/styles.
  useEffect(() => {
    const target = previewTarget;
    if (target?.filepath) {
      const url = buildPreviewUrl(target.filepath);
      setPreviewUrl(url);
      setUrlInput(getPreviewAddress(target, url));
    }
  }, [previewTarget?.filepath]);

  const previousUrlRef = useRef(previewUrl);

  // Reset preview loading state ONLY when the actual URL changes, ensuring zero-latency tab switching
  useEffect(() => {
    if (previewUrl !== previousUrlRef.current) {
      setIsPreviewLoading(true);
      previousUrlRef.current = previewUrl;
      const timer = setTimeout(() => setIsPreviewLoading(false), 2000); // safety fallback
      return () => clearTimeout(timer);
    }
  }, [previewUrl]);

  useEffect(() => {
    if (activeTabMode !== 'preview') return;
    if (['text', 'markdown', 'data', 'code', 'office', 'archive', 'unknown'].includes(previewKind)) {
      setIsPreviewLoading(false);
    }
  }, [activeTabMode, previewKind, previewTarget?.filepath, previewContent]);

  const openFilePaths = useMemo(
    () => new Set(openFiles.map(f => f.filepath.replace(/\\/g, '/'))),
    [openFiles]
  );
  const activeFilePath = useMemo(() => activeFile?.filepath.replace(/\\/g, '/') || '', [activeFile?.filepath]);
  const activeFileKind = activeFile ? getPreviewKind(activeFile.filename) : 'unknown';
  const activeFileIsTextReadable = ['text', 'markdown', 'data', 'code'].includes(activeFileKind);
  const activeFileIsLoading = !!activeFile && activeFileIsTextReadable && activeFile.content === undefined && !activeFile.loadError;
  const activeFileDisplayLineCount = activeFile
    ? (activeFile.totalLines ?? activeFile.lineCount ?? countLines(activeFile.content || ''))
    : 0;
  const activeFileLoadedRange = activeFile?.truncated && activeFile.startLine !== undefined && activeFile.endLine !== undefined
    ? `Lines ${activeFile.startLine}-${activeFile.endLine} of ${activeFile.totalLines ?? activeFileDisplayLineCount}`
    : `${activeFileDisplayLineCount} lines`;

  useEffect(() => {
    if (activeTabMode !== 'code' || !activeFile || !activeFileIsTextReadable) return;
    if (activeFile.content !== undefined || activeFile.loadError) return;
    if (fileReadPathRef.current && normalizeWorkspacePath(fileReadPathRef.current) === normalizeWorkspacePath(activeFile.filepath)) return;

    autoFileReadAbortRef.current?.abort();
    const controller = new AbortController();
    autoFileReadAbortRef.current = controller;

    fetch('/api/code/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: activeFile.filepath, limit: FILE_READ_LINE_LIMIT }),
      signal: controller.signal,
    }).then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || 'File could not be read.');
      openPanel({
        filename: activeFile.filename,
        filepath: activeFile.filepath,
        content: data.content || '',
        language: data.language,
        lineCount: data.totalLines,
        totalLines: data.totalLines,
        loadedLines: data.loadedLines,
        startLine: data.startLine,
        endLine: data.endLine,
        truncated: data.truncated,
        size: data.size,
        loadError: '',
        activeTabMode: 'code',
      });
    }).catch(error => {
      if (controller.signal.aborted) return;
      openPanel({
        filename: activeFile.filename,
        filepath: activeFile.filepath,
        content: '',
        loadError: error?.message || 'File could not be read.',
        activeTabMode: 'code',
      });
    }).finally(() => {
      if (autoFileReadAbortRef.current === controller) autoFileReadAbortRef.current = null;
    });

    return () => controller.abort();
  }, [activeFile?.filepath, activeFile?.content, activeFile?.loadError, activeFile?.filename, activeFileIsTextReadable, activeTabMode, openPanel]);

  const handleTreeFileClick = (filePath: string, fileName: string) => {
    fileReadAbortRef.current?.abort();
    const controller = new AbortController();
    fileReadAbortRef.current = controller;
    fileReadPathRef.current = filePath;
    const kind = getPreviewKind(fileName);
    const isReadableInEditor = ['text', 'markdown', 'data', 'code'].includes(kind);
    setActiveTabMode(isReadableInEditor ? 'code' : 'preview');

    // Open the tab immediately, then hydrate content in the background.
    openPanel({ filename: fileName, filepath: filePath, content: undefined, loadError: '', activeTabMode: isReadableInEditor ? 'code' : 'preview' });

    if (!isReadableInEditor) {
      fileReadAbortRef.current = null;
      fileReadPathRef.current = '';
      return;
    }

    fetch('/api/code/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, limit: FILE_READ_LINE_LIMIT }),
      signal: controller.signal,
    }).then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || 'File could not be read.');
      openPanel({
        filename: fileName,
        filepath: filePath,
        content: data.content || '',
        language: data.language,
        lineCount: data.totalLines,
        totalLines: data.totalLines,
        loadedLines: data.loadedLines,
        startLine: data.startLine,
        endLine: data.endLine,
        truncated: data.truncated,
        size: data.size,
        loadError: '',
        activeTabMode: 'code',
      });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      openPanel({
        filename: fileName,
        filepath: filePath,
        content: '',
        loadError: error?.message || 'File could not be read.',
        activeTabMode: 'code',
      });
    }).finally(() => {
      if (fileReadAbortRef.current === controller) {
        fileReadAbortRef.current = null;
        fileReadPathRef.current = '';
      }
    });
  };

  const handleCloseOthers = (index: number) => {
    openFiles
      .map((_, i) => i)
      .filter(i => i !== index)
      .sort((a, b) => b - a)
      .forEach(i => closePanel(i));
    setActiveIndex(0);
  };

  const handleCloseAll = () => {
    if (panelCloseTimerRef.current) clearTimeout(panelCloseTimerRef.current);
    setIsPanelClosing(true);
    panelCloseTimerRef.current = setTimeout(() => {
      openFiles
        .map((_, i) => i)
        .sort((a, b) => b - a)
        .forEach(i => closePanel(i));
      setIsPanelClosing(false);
      panelCloseTimerRef.current = null;
    }, 170);
  };

  if (openFiles.length === 0) return null;

  // Track preview URL changes for history
  const handlePreviewLoad = () => {
    setIsPreviewLoading(false);
    if (previewUrl) {
      setIframeHistory(prev => {
        const sliced = prev.slice(0, iframeHistoryIndex + 1);
        return [...sliced, previewUrl];
      });
      setIframeHistoryIndex(prev => prev + 1);
    }
  };

  const handleBack = () => {
    if (iframeHistoryIndex > 0) {
      const newIndex = iframeHistoryIndex - 1;
      setIframeHistoryIndex(newIndex);
      if (iframeRef.current) { iframeRef.current.src = iframeHistory[newIndex]; }
    }
  };

  const handleForward = () => {
    if (iframeHistoryIndex < iframeHistory.length - 1) {
      const newIndex = iframeHistoryIndex + 1;
      setIframeHistoryIndex(newIndex);
      if (iframeRef.current) { iframeRef.current.src = iframeHistory[newIndex]; }
    }
  };

  const handleRefresh = () => {
    setIsPreviewLoading(true);
    setPreviewReloadKey(k => k + 1);
    if (iframeRef.current?.contentWindow) {
      try { iframeRef.current.contentWindow.location.reload(); }
      catch { if (iframeRef.current) iframeRef.current.src = iframeRef.current.src; }
    } else {
      window.setTimeout(() => setIsPreviewLoading(false), 240);
    }
  };

  const handleCopyPreviewPath = () => {
    const pathToCopy = previewTitleFile?.filepath ? getPreviewAddress(previewTitleFile, previewUrl) : previewUrl;
    navigator.clipboard.writeText(pathToCopy);
    setCopiedPreviewPath(true);
    window.setTimeout(() => setCopiedPreviewPath(false), 1400);
  };

  const handleOpenPreviewFile = () => {
    if (previewFileUrl) window.open(previewFileUrl, '_blank');
    else if (previewUrl) window.open(previewUrl, '_blank');
  };

  const canGoBack = iframeHistoryIndex > 0;
  const canGoForward = iframeHistoryIndex < iframeHistory.length - 1;

  const renderPreviewSurface = () => {
    const surfaceRadius = isFullscreen ? 0 : '0 0 24px 24px';
    const frameSrc = withReloadKey(previewUrl || previewFileUrl, previewReloadKey);
    const fileSrc = withReloadKey(previewFileUrl || previewUrl, previewReloadKey);
    const isDeviceFramed = previewDevice !== 'desktop';
    const deviceFrameStyle = previewDevice === 'mobile'
      ? {
          width: 'min(360px, calc(100% - 32px))',
          height: 'min(760px, calc(100% - 38px))',
          aspectRatio: '390 / 844',
          borderRadius: 40,
          boxSizing: 'border-box' as const,
        }
      : { width: '100%', height: '100%', borderRadius: surfaceRadius };

    if (!previewTarget && !previewUrl) {
      return (
        <div className="flex h-full items-center justify-center bg-[#f6f5f2] p-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-black/10 bg-white shadow-sm">
              <Monitor className="h-6 w-6 text-black/45" strokeWidth={1.7} />
            </div>
            <div>
              <div className="text-[13px] font-bold uppercase tracking-[0.16em] text-black/65">Preview</div>
              <div className="mt-1 text-[12px] text-black/38">Open a file or enter a URL</div>
            </div>
          </div>
        </div>
      );
    }

    if (previewKind === 'html' || previewKind === 'pdf') {
      return (
        <div className={`h-full w-full ${isDeviceFramed ? 'eterx-scrollbar flex items-center justify-center overflow-auto bg-black p-3 [scrollbar-gutter:stable]' : 'bg-white'}`}>
          <div
            className={`${isDeviceFramed ? 'relative overflow-hidden border-[8px] border-[#050505] bg-white shadow-[0_28px_90px_rgba(0,0,0,0.72)] ring-1 ring-white/[0.16]' : 'h-full w-full overflow-hidden bg-white'}`}
            style={deviceFrameStyle}
          >
            {previewDevice === 'mobile' && (
              <div className="pointer-events-none absolute left-1/2 top-2 z-10 h-1.5 w-20 -translate-x-1/2 rounded-full bg-black/80 shadow-[0_1px_0_rgba(255,255,255,0.18)]" />
            )}
            <iframe
              ref={iframeRef}
              key={frameSrc}
              src={frameSrc || ''}
              className="h-full w-full border-none bg-white"
              style={{ borderRadius: isDeviceFramed ? 32 : surfaceRadius }}
              onLoad={handlePreviewLoad}
              title={previewTarget ? `Preview: ${previewTarget.filename}` : 'Preview'}
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads"
            />
          </div>
        </div>
      );
    }

    if (previewKind === 'image') {
      return (
        <div
          className="eterx-scrollbar flex h-full w-full items-center justify-center overflow-auto p-8 [scrollbar-gutter:stable]"
          style={{
            backgroundColor: '#f4f3ef',
            backgroundImage: 'linear-gradient(45deg, rgba(0,0,0,0.035) 25%, transparent 25%), linear-gradient(-45deg, rgba(0,0,0,0.035) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(0,0,0,0.035) 75%), linear-gradient(-45deg, transparent 75%, rgba(0,0,0,0.035) 75%)',
            backgroundSize: '24px 24px',
            backgroundPosition: '0 0, 0 12px, 12px -12px, -12px 0px',
          }}
        >
          <img
            key={fileSrc}
            src={fileSrc}
            alt={previewTarget?.filename || 'Preview'}
            onLoad={() => setIsPreviewLoading(false)}
            onError={() => setIsPreviewLoading(false)}
            className="max-h-full max-w-full rounded-[14px] border border-black/10 bg-white shadow-[0_18px_50px_rgba(0,0,0,0.18)]"
          />
        </div>
      );
    }

    if (previewKind === 'video') {
      return (
        <div className="flex h-full w-full items-center justify-center bg-[#101012] p-8">
          <video
            key={fileSrc}
            src={fileSrc}
            controls
            playsInline
            onLoadedData={() => setIsPreviewLoading(false)}
            className="max-h-full max-w-full rounded-[16px] border border-white/10 bg-black shadow-[0_24px_70px_rgba(0,0,0,0.42)]"
          />
        </div>
      );
    }

    if (previewKind === 'audio') {
      return (
        <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_50%_30%,rgba(255,255,255,0.08),transparent_32%),#101012] p-8">
          <div className="w-full max-w-[520px] rounded-[22px] border border-white/10 bg-white/[0.06] p-6 shadow-[0_24px_70px_rgba(0,0,0,0.35)] backdrop-blur-xl">
            <div className="mb-5 flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.08]">
                <TerminalSquare className="h-5 w-5 text-white/65" strokeWidth={1.8} />
              </div>
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold text-white/88">{previewTarget?.filename}</div>
                <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.16em] text-white/32">{previewFileExtension}</div>
              </div>
            </div>
            <audio key={fileSrc} src={fileSrc} controls onLoadedData={() => setIsPreviewLoading(false)} className="w-full" />
          </div>
        </div>
      );
    }

    if (['text', 'markdown', 'data', 'code'].includes(previewKind)) {
      return (
        <div className="h-full w-full overflow-hidden bg-[#0f1012] text-[#d8d5d0]">
          <div className="flex h-[38px] items-center justify-between border-b border-white/[0.07] bg-white/[0.035] px-4">
            <div className="flex min-w-0 items-center gap-2">
              <div className="h-2 w-2 rounded-full" style={{ backgroundColor: previewFileColor }} />
              <span className="truncate text-[11px] font-bold uppercase tracking-[0.14em] text-white/52">{getLanguage(previewTarget?.filename || '')}</span>
            </div>
            <div className="flex items-center gap-2 text-[10px] font-mono text-white/30">
              {previewLineCount > 0 && <span>{previewLineCount}L</span>}
              {isTextPreviewTrimmed && <span>Trimmed</span>}
            </div>
          </div>
          <pre className="eterx-scrollbar h-[calc(100%-38px)] overflow-auto p-5 text-[12.5px] leading-[1.75] [scrollbar-gutter:stable]" style={{ fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {textPreview || 'No preview content'}
          </pre>
        </div>
      );
    }

    return (
      <div className="flex h-full w-full items-center justify-center bg-[#f5f4f0] p-8">
        <div className="grid w-full max-w-[760px] grid-cols-[minmax(0,1fr)_220px] gap-5 rounded-[26px] border border-black/[0.075] bg-white p-5 shadow-[0_24px_80px_rgba(0,0,0,0.12)] max-[900px]:grid-cols-1">
          <div className="min-w-0 rounded-[20px] border border-black/[0.06] bg-[#faf9f6] p-5">
            <div className="mb-5 flex items-start gap-4">
              <div
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[20px] border text-[13px] font-black"
                style={{ color: previewFileColor, borderColor: `${previewFileColor}55`, backgroundColor: `${previewFileColor}12` }}
              >
                {previewFileExtension}
              </div>
              <div className="min-w-0 pt-1">
                <div className="truncate text-[19px] font-bold tracking-[-0.01em] text-[#161616]">{previewTarget?.filename || 'Preview asset'}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-black/[0.08] bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-black/48">{getPreviewLabel(previewTarget?.filename)}</span>
                  {previewKind === 'office' && <span className="rounded-full border border-black/[0.08] bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-black/48">Document</span>}
                  {previewKind === 'archive' && <span className="rounded-full border border-black/[0.08] bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-black/48">Archive</span>}
                </div>
              </div>
            </div>
            <div className="rounded-[16px] border border-black/[0.06] bg-white px-3 py-2">
              <div className="truncate text-[11px] font-mono text-black/42">{previewPath}</div>
            </div>
          </div>

          <div className="flex flex-col justify-between rounded-[20px] border border-black/[0.06] bg-[#171717] p-4 text-white">
            <div>
              <div className="mb-3 flex items-center justify-between">
                <FileText className="h-4 w-4 text-white/44" strokeWidth={1.8} />
                <span className="text-[10px] font-black uppercase tracking-[0.17em] text-white/32">{previewFileExtension}</span>
              </div>
              <div className="text-[12px] font-medium leading-5 text-white/64">
                {previewKind === 'office' ? 'Open or download this document asset.' : 'Open this asset outside the inline preview.'}
              </div>
            </div>
            <div className="mt-6 flex flex-col gap-2">
              <button onClick={handleOpenPreviewFile} className="flex h-9 items-center justify-center gap-2 rounded-full bg-white text-[11px] font-bold uppercase tracking-[0.12em] text-black transition-transform active:scale-[0.98]">
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={2.2} />
                Open
              </button>
              <a href={previewFileUrl || previewUrl} download={previewTarget?.filename} className="flex h-9 items-center justify-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.06] text-[11px] font-bold uppercase tracking-[0.12em] text-white/74 transition-colors hover:bg-white/[0.1]">
                <Download className="h-3.5 w-3.5" strokeWidth={2.2} />
                Download
              </a>
              <button onClick={handleCopyPreviewPath} className="flex h-9 items-center justify-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.04] text-[11px] font-bold uppercase tracking-[0.12em] text-white/68 transition-colors hover:bg-white/[0.08]">
                {copiedPreviewPath ? <Check className="h-3.5 w-3.5" strokeWidth={2.2} /> : <Copy className="h-3.5 w-3.5" strokeWidth={2.2} />}
                {copiedPreviewPath ? 'Copied' : 'Copy path'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const workspaceControlDock = (
    <div className="eterx-ide-dock relative flex h-[34px] items-center gap-1 rounded-full border border-white/[0.10] bg-[linear-gradient(180deg,#202020_0%,#161616_100%)] px-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.07)] backdrop-blur-xl">
      {activeTabMode === 'code' && (
        <button onClick={() => setSidebarOpen(s => !s)} data-active={sidebarOpen ? 'true' : undefined} className={`eterx-ide-dock-button flex h-7 w-7 items-center justify-center rounded-full transition-all ${sidebarOpen ? 'bg-white/[0.13] text-white shadow-inner' : 'text-[#74716D] hover:bg-white/[0.07] hover:text-white'}`} title="Toggle Sidebar">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
        </button>
      )}
      {!isFullscreen && (
        <button onClick={() => setTerminalOpen(t => !t)} data-active={terminalOpen ? 'true' : undefined} className={`eterx-ide-dock-button relative flex h-7 w-7 items-center justify-center rounded-full transition-all ${terminalOpen ? 'bg-white/[0.13] text-white shadow-inner' : 'text-[#74716D] hover:bg-white/[0.07] hover:text-white'}`} title="Toggle Terminal">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
          {consoleLogs.length > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[#FF5F57]" />}
        </button>
      )}
      <button onClick={() => setIsFullscreen(f => !f)} data-active={isFullscreen ? 'true' : undefined} className={`eterx-ide-dock-button flex h-7 w-7 items-center justify-center rounded-full transition-all ${isFullscreen ? 'bg-white/[0.13] text-white shadow-inner' : 'text-[#74716D] hover:bg-white/[0.07] hover:text-white'}`} title="Fullscreen">
        {isFullscreen ?
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
          : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
        }
      </button>
      <button className="eterx-ide-dock-button flex h-7 w-7 items-center justify-center rounded-full text-[#74716D] transition-all hover:bg-white/[0.07] hover:text-white" title="Settings">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
      </button>
      <button
        onClick={handleCloseAll}
        className="eterx-ide-dock-button flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.075] bg-white/[0.035] text-[#777] shadow-[inset_0_1px_0_rgba(255,255,255,0.045)] transition-all duration-200 hover:border-white/[0.16] hover:bg-white/[0.085] hover:text-white active:scale-95"
        title="Close file workspace"
        aria-label="Close file workspace"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="4.25" y="4.25" width="15.5" height="15.5" rx="4" stroke="currentColor" strokeWidth="1.55" opacity="0.78" />
          <path d="M9 8.75h4.7a2.8 2.8 0 0 1 0 5.6H8.75" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M10.45 11.2 8.35 8.75l2.1-2.45" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );

  const panelContent = (
    <div ref={panelShellRef} className={`eterx-ide-panel-shell flex-1 flex flex-col relative z-10 h-full overflow-hidden transition-opacity duration-150 ease-out ${isPanelClosing ? 'opacity-0' : 'opacity-100'} ${isFullscreen ? 'p-0' : 'pt-1.5 pb-1 pr-3 pl-1.5'}`} onContextMenu={e => e.preventDefault()}>
      {isFullscreen && activeTabMode !== 'review' && (
      <div className="pointer-events-none absolute inset-x-0 top-2 z-[90] flex justify-center">
        <div className="pointer-events-auto [-webkit-app-region:no-drag]">
          {workspaceControlDock}
        </div>
      </div>
      )}

      {/* Unified liquid glass container */}
      <div
        ref={fileContainerRef}
        className={`eterx-ide-container ${isFullscreen ? 'rounded-none' : 'rounded-[24px]'} flex-1 flex flex-col bg-[linear-gradient(180deg,#202020_0%,#161616_100%)] backdrop-blur-3xl overflow-hidden relative isolate border border-white/[0.10] shadow-[0_28px_70px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.07)]`}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
        
        {/* Unified header row */}
        {activeTabMode !== 'review' && (
        <div className={`eterx-ide-header ${isFullscreen ? '' : 'rounded-t-[24px]'} relative flex h-[56px] border-b border-white/[0.075] shrink-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.055),rgba(255,255,255,0.018))] overflow-hidden`}>
        {/* Left header mode toggle */}
        <div className="flex items-center px-2.5 shrink-0 justify-start w-[196px] max-w-[34%] border-r border-white/[0.06]">
          <div className="eterx-ide-mode-toggle flex h-[36px] items-center rounded-full border border-white/[0.085] bg-[#151515]/85 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_10px_24px_rgba(0,0,0,0.18)]">
             <button
               onClick={() => setActiveTabMode('preview')}
               data-active={activeTabMode === 'preview' ? 'true' : undefined}
               aria-pressed={activeTabMode === 'preview'}
               className={`eterx-ide-mode-tab h-[28px] px-3.5 text-[10px] font-bold uppercase tracking-[0.13em] rounded-full transition-all duration-200 ${activeTabMode === 'preview' ? 'bg-[#F3F0EA] text-[#111] shadow-[0_6px_18px_rgba(255,255,255,0.12),inset_0_1px_0_rgba(255,255,255,0.8)]' : 'text-[#7D7A75] hover:text-[#E8E6E3] hover:bg-white/[0.045]'}`}
             >Preview</button>
             <button
               onClick={() => setActiveTabMode('code')}
               data-active={activeTabMode === 'code' ? 'true' : undefined}
               aria-pressed={activeTabMode === 'code'}
               className={`eterx-ide-mode-tab h-[28px] px-3.5 text-[10px] font-bold uppercase tracking-[0.13em] rounded-full transition-all duration-200 flex items-center gap-1.5 ${activeTabMode === 'code' ? 'bg-[#F3F0EA] text-[#111] shadow-[0_6px_18px_rgba(255,255,255,0.12),inset_0_1px_0_rgba(255,255,255,0.8)]' : 'text-[#7D7A75] hover:text-[#E8E6E3] hover:bg-white/[0.045]'}`}
             >
               {activeTabMode === 'code' && <div className="eterx-ide-mode-dot w-1.5 h-1.5 rounded-full bg-[#111]" />}
               Code
             </button>
             <button
               onClick={() => setActiveTabMode('browser')}
               data-active={activeTabMode === 'browser' ? 'true' : undefined}
               aria-pressed={activeTabMode === 'browser'}
               className={`eterx-ide-mode-tab h-[28px] px-3.5 text-[10px] font-bold uppercase tracking-[0.13em] rounded-full transition-all duration-200 flex items-center gap-1.5 ${activeTabMode === 'browser' ? 'bg-[#F3F0EA] text-[#111] shadow-[0_6px_18px_rgba(255,255,255,0.12),inset_0_1px_0_rgba(255,255,255,0.8)]' : 'text-[#7D7A75] hover:text-[#E8E6E3] hover:bg-white/[0.045]'}`}
             >
               {activeTabMode === 'browser' && <div className="eterx-ide-mode-dot w-1.5 h-1.5 rounded-full bg-emerald-500" />}
               Live
             </button>
          </div>
        </div>

            <div className="flex-1 flex items-center justify-between px-3 min-w-0">
             {/* Tab bar, only in code mode */}
             {activeTabMode === 'code' && (
               <div className="flex-1 min-w-0 h-full flex items-center" style={{ WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 32px), transparent)', maskImage: 'linear-gradient(to right, black calc(100% - 32px), transparent)' }}>
                 <div className="eterx-tab-strip-scroll flex h-full w-full items-center gap-1.5 overflow-x-auto overflow-y-hidden">
                  {openFiles.map((f, i) => {
                   const lang = getLanguage(f.filename).substring(0, 2).toLowerCase();
                   let iconChar = '{}'; let iconCol = 'text-[#666]';
                   if (lang === 'ts' || lang === 'tx') { iconChar = 'TS'; iconCol = 'text-[#999]'; }
                   if (lang === 'ht') { iconChar = 'WEB'; iconCol = 'text-[#FFF]'; }
                   if (lang === 'js') { iconChar = 'JS'; iconCol = 'text-[#AAA]'; }
                   return (
                     <div 
                       key={`${f.filepath}-${i}`}
                       onClick={() => setActiveIndex(i)}
                       onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, index: i }); }}
                       data-active={activeIndex === i ? 'true' : undefined}
                       className={`eterx-ide-open-tab group relative flex h-[30px] max-w-[210px] items-center gap-2 px-2.5 rounded-full text-[12px] cursor-pointer shrink-0 transition-all duration-200 border ${activeIndex === i ? 'bg-white/[0.105] text-white border-white/[0.18] shadow-[inset_0_1px_0_rgba(255,255,255,0.065)]' : 'text-[#74716D] hover:bg-white/[0.055] border-transparent hover:text-[#E8E6E3]'}`}
                     >
                      <div className={`min-w-[18px] text-center font-mono font-bold text-[9.5px] ${iconCol}`}>{iconChar}</div>
                      <span className="min-w-0 truncate">{f.filename}</span>
                      <button 
                        onClick={(e) => { e.stopPropagation(); closePanel(i); }} 
                        className={`eterx-ide-open-tab-close flex h-4 w-4 shrink-0 items-center justify-center rounded-full hover:bg-white/[0.1] hover:text-white transition-all ${activeIndex === i ? 'opacity-100 text-[#888]' : 'opacity-0 group-hover:opacity-100 text-[#555]'}`}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                      </button>
                    </div>
                   );
                  })}
                 </div>
               </div>
             )}
            
          </div>
        </div>
        )}

      {/* Main workspace area */}
      <div className={`${isFullscreen ? '' : 'rounded-b-[24px]'} flex-1 flex overflow-hidden`}>
        
        {/* Left sidebar, hidden in preview mode for full render space */}
        {sidebarOpen && activeTabMode === 'code' && (
          <div className="eterx-ide-sidebar w-[250px] bg-[#121212]/72 border-r border-white/[0.065] flex flex-col shrink-0 select-none">
            <div className="eterx-ide-sidebar-header px-3 py-2.5 flex items-center justify-between group border-b border-white/[0.055] bg-white/[0.018]">
              <div className="flex items-center gap-1.5 min-w-0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><polyline points="9 18 15 12 9 6"></polyline></svg>
                <span className="text-[11.5px] font-semibold text-[#CCCCCC] tracking-wide truncate uppercase">{workspaceName || 'Explorer'}</span>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                 <button title="Search" onClick={() => setPaletteOpen(true)} className="p-1 rounded-[6px] text-[#888] hover:text-white hover:bg-white/[0.07] transition-all"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg></button>
                 <button title="Refresh" onClick={() => fetchFileTree(workspaceRoot)} className="p-1 rounded-[6px] text-[#888] hover:text-white hover:bg-white/[0.07] transition-all"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg></button>
                 <button onClick={() => setSidebarOpen(false)} className="p-1 rounded-[6px] text-[#888] hover:text-white hover:bg-white/[0.07] transition-all"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></button>
              </div>
            </div>
            
            <div className="eterx-scrollbar flex-1 overflow-y-auto overflow-x-hidden py-1 relative [scrollbar-gutter:stable]">
              {isTreeLoading && fileTree.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-3 py-12">
                  <div className="relative w-8 h-8">
                    <div className="absolute inset-0 rounded-full border-[1.5px] border-white/5" />
                    <div className="absolute inset-0 rounded-full border-[1.5px] border-transparent border-t-white/40 animate-spin" />
                  </div>
                  <span className="text-[10px] text-white/20 uppercase tracking-[0.2em]">Scanning</span>
                </div>
              ) : fileTree.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-3 py-12">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="text-white/10"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  <span className="text-[10px] text-white/20 uppercase tracking-[0.2em]">No workspace</span>
                </div>
              ) : (
                fileTree.map((node, i) => (
                  <FileTreeNode
                    key={`${node.path}-${i}`}
                    node={node}
                    depth={0}
                    openFilePaths={openFilePaths}
                    activeFilePath={activeFilePath}
                    onFileClick={handleTreeFileClick}
                  />
                ))
              )}
            </div>

            {/* Live status bar */}
            <div className="eterx-ide-sidebar-status px-3 py-2 border-t border-white/[0.055] bg-white/[0.015] flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full transition-colors ${isTreeLoading ? 'bg-white/30 animate-pulse' : 'bg-white/60'}`} />
              <span className="text-[10px] text-white/20 font-mono uppercase tracking-widest">
                {isTreeLoading ? 'Refreshing' : `${openFiles.length} open`}
              </span>
            </div>
          </div>
        )}

        {/* Editor/Preview/Console Area */}
        <div className={`eterx-ide-content ${isFullscreen ? '' : 'rounded-b-[24px]'} flex-1 flex flex-col min-w-0 bg-transparent relative overflow-hidden`}>
          <div className="flex-1 flex flex-col min-w-0">
            <div className={`eterx-ide-editor-shell ${isFullscreen ? '' : 'rounded-b-[24px]'} flex-1 relative overflow-hidden`} style={{ background: editorBackground }}>
              {activeTabMode === 'review' ? (
                <WorkspaceReviewEditor
                  files={reviewSourceFiles}
                  subagents={reviewSubagents}
                  activeFileId={activeFile?.filepath}
                  initialMode="review"
                  title={workspaceName || 'Workspace'}
                  className="border-l-0"
                  onSelectFile={(file) => {
                    const openIndex = openFiles.findIndex(openFile => openFile.filepath === file.filepath);
                    if (openIndex >= 0) setActiveIndex(openIndex);
                  }}
                  onOpenDiff={(file) => {
                    const openIndex = openFiles.findIndex(openFile => openFile.filepath === file.filepath);
                    if (openIndex >= 0) setActiveIndex(openIndex);
                  }}
                  onClose={handleCloseAll}
                />
              ) : activeTabMode === 'code' ? (
                activeFile ? (
                  activeFileIsLoading ? (
                    <div className="flex h-full flex-col items-center justify-center gap-3 text-center" style={{ background: editorBackground }}>
                      <div className={`h-8 w-8 animate-spin rounded-full border-2 ${isLightTheme ? 'border-black/10 border-t-black/55' : 'border-white/10 border-t-white/50'}`} />
                      <span className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${isLightTheme ? 'text-black/38' : 'text-white/30'}`}>Reading file</span>
                      <span className={`max-w-[360px] truncate font-mono text-[11px] ${isLightTheme ? 'text-black/34' : 'text-white/24'}`}>{activeFile.filepath}</span>
                    </div>
                  ) : activeFile.loadError && !activeFile.content ? (
                    <div className="flex h-full flex-col items-center justify-center gap-3 p-12 text-center" style={{ background: editorBackground }}>
                      <ShieldAlert className={`h-9 w-9 ${isLightTheme ? 'text-black/22' : 'text-white/16'}`} strokeWidth={1.4} />
                      <h3 className={`text-[13px] font-semibold uppercase tracking-[0.16em] ${isLightTheme ? 'text-black/52' : 'text-white/50'}`}>Could not load file</h3>
                      <p className={`max-w-[420px] text-[12px] leading-5 ${isLightTheme ? 'text-black/42' : 'text-white/32'}`}>{activeFile.loadError}</p>
                    </div>
                  ) : (
                  <>
                  <Editor
                    height="100%"
                    path={activeFile.filepath}
                    value={activeFile.content || ''}
                    language={(() => {
                      const ext = activeFile.filename.split('.').pop()?.toLowerCase() || '';
                      const map: Record<string,string> = { ts:'typescript',tsx:'typescript',js:'javascript',jsx:'javascript',html:'html',css:'css',scss:'scss',json:'json',md:'markdown',py:'python',go:'go',rs:'rust',sh:'shell' };
                      return map[ext] || 'plaintext';
                    })()}
                    theme={isLightTheme ? 'vs-light' : 'vs-dark'}
                    options={{
                      readOnly: true,
                      minimap: { enabled: false },
                      fontSize: 14,
                      lineHeight: 24,
                      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                      fontLigatures: false,
                      scrollBeyondLastLine: false,
                      renderLineHighlight: 'none',
                      cursorBlinking: 'solid',
                      cursorSmoothCaretAnimation: 'off',
                      smoothScrolling: false,
                      padding: { top: 18, bottom: 18 },
                      overviewRulerBorder: false,
                      hideCursorInOverviewRuler: true,
                      renderValidationDecorations: 'off',
                      scrollbar: { verticalScrollbarSize: 4, horizontalScrollbarSize: 4 },
                    }}
                    loading={
                      <div className="flex flex-col items-center justify-center h-full" style={{ background: editorBackground }}>
                        <div className={`w-8 h-8 border-2 rounded-full animate-spin mb-3 ${isLightTheme ? 'border-black/10 border-t-black/55' : 'border-white/10 border-t-white/50'}`} />
                        <span className="text-[11px] text-white/30 uppercase tracking-widest">Preparing editor...</span>
                      </div>
                    }
                  />
                  <div className={`pointer-events-none absolute bottom-3 right-3 rounded-full border px-3 py-1 text-[10.5px] font-semibold tabular-nums shadow-lg backdrop-blur ${activeFile.truncated ? 'border-amber-500/25 bg-amber-500/12 text-amber-200' : isLightTheme ? 'border-black/10 bg-white/82 text-black/42' : 'border-white/10 bg-black/42 text-white/42'}`}>
                    {activeFileLoadedRange}
                  </div>
                  </>
                  )
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-center p-12">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.75" strokeLinecap="round" strokeLinejoin="round" className="mb-4 text-white opacity-10"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
                    <h3 className="text-white/50 text-[13px] font-medium mb-1 uppercase tracking-widest">No file selected</h3>
                    <p className="text-white/20 text-[11px] max-w-[200px] uppercase tracking-widest">Open a file from the explorer</p>
                  </div>
                )
              ) : activeTabMode === 'browser' ? (
                <div className={`${isFullscreen ? '' : 'rounded-b-[24px]'} h-full flex flex-col overflow-hidden`}>
                  <LiveBrowserPanel
                    isFullscreen={isFullscreen}
                    onToggleFullscreen={() => setIsFullscreen(f => !f)}
                  />
                </div>
              ) : (
                <div className={`eterx-ide-preview-shell ${isFullscreen ? '' : 'rounded-b-[24px]'} h-full flex flex-col overflow-hidden`} style={{ background: previewShellBackground }}>
                  {/* Premium Browser Chrome - Redesigned to match high-end concept */}
                  <div
                    className="h-[54px] shrink-0 flex items-center justify-between px-4"
                    style={previewToolbarStyle}
                  >
                    {/* Left: Device Toggles & Nav */}
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="eterx-ide-device-toggle flex items-center p-1 rounded-[10px]" style={isLightTheme ? { background: 'rgba(31,31,29,0.06)', border: '1px solid rgba(31,31,29,0.10)' } : { background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <button
                          onClick={() => setPreviewDevice('desktop')}
                          data-active={previewDevice === 'desktop' ? 'true' : undefined}
                          aria-pressed={previewDevice === 'desktop'}
                          className={`eterx-ide-device-button p-1.5 rounded-[7px] transition-all ${previewDevice === 'desktop' ? 'bg-[#F3F0EA] text-[#151515] shadow-[0_5px_14px_rgba(255,255,255,0.10)]' : 'text-white/35 hover:text-white/75 hover:bg-white/[0.06]'}`}
                          title="Desktop view"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
                        </button>
                        <button
                          onClick={() => setPreviewDevice('mobile')}
                          data-active={previewDevice === 'mobile' ? 'true' : undefined}
                          aria-pressed={previewDevice === 'mobile'}
                          className={`eterx-ide-device-button p-1.5 rounded-[7px] transition-all ${previewDevice === 'mobile' ? 'bg-[#F3F0EA] text-[#151515] shadow-[0_5px_14px_rgba(255,255,255,0.10)]' : 'text-white/35 hover:text-white/75 hover:bg-white/[0.06]'}`}
                          title="Mobile view"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>
                        </button>
                      </div>
                      
                      {/* Nav Buttons integrated seamlessly */}
                      <div className="flex items-center gap-1">
                        <button onClick={handleBack} disabled={!canGoBack} data-disabled={!canGoBack ? 'true' : undefined} className={`eterx-ide-nav-button w-7 h-7 rounded-full flex items-center justify-center transition-all ${canGoBack ? 'text-white/75 hover:text-white hover:bg-white/[0.06]' : 'text-white/18 cursor-default'}`}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M15 18l-6-6 6-6"/></svg>
                        </button>
                        <button onClick={handleForward} disabled={!canGoForward} data-disabled={!canGoForward ? 'true' : undefined} className={`eterx-ide-nav-button w-7 h-7 rounded-full flex items-center justify-center transition-all ${canGoForward ? 'text-white/75 hover:text-white hover:bg-white/[0.06]' : 'text-white/18 cursor-default'}`}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6"/></svg>
                        </button>
                      </div>

                    </div>

                    {/* Center: Address bar and preview controls */}
                    <div className="flex min-w-[220px] flex-1 justify-center max-w-[680px] mx-4">
                      <div
                        className="eterx-ide-address-bar w-full h-[34px] flex items-center justify-between gap-3 px-3 rounded-[10px] transition-all group focus-within:ring-1 focus-within:ring-white/22"
                        style={previewAddressStyle}
                      >
                        <input
                          value={urlInput}
                          onChange={e => setUrlInput(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handlePreviewAddressSubmit(); }}
                          aria-label="Preview address"
                          className="eterx-ide-address-input min-w-0 flex-1 truncate bg-transparent font-mono text-[12px] tracking-wide text-white/68 outline-none placeholder:text-white/22"
                          placeholder="Enter dev server URL (e.g. http://localhost:3000)"
                        />
                        <div className="flex shrink-0 items-center gap-2.5">
                          <button onClick={handleCopyPreviewPath} className="eterx-ide-address-action text-white/35 hover:text-white/85 transition-colors" title="Copy path">
                            {copiedPreviewPath ? <Check className="h-[13px] w-[13px]" strokeWidth={2.5} /> : <Copy className="h-[13px] w-[13px]" strokeWidth={2.5} />}
                          </button>
                          <button onClick={handleOpenPreviewFile} className="eterx-ide-address-action text-white/35 hover:text-white/85 transition-colors" title="Open in browser">
                            <ExternalLink className="h-[13px] w-[13px]" strokeWidth={2.5} />
                          </button>
                          <button onClick={handleRefresh} className="eterx-ide-address-action text-white/35 hover:text-white/85 transition-colors" title="Reload frame">
                            <RefreshCw className="h-[13px] w-[13px]" strokeWidth={2.5} />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Right: Actions */}
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => setActiveTabMode('code')} className="eterx-ide-preview-action flex items-center gap-2 px-3 py-1.5 rounded-[8px] text-white/78 hover:text-white transition-all text-[11.5px] font-medium" style={{ border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.045)' }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                        Edit
                      </button>
                      <button onClick={() => setTerminalOpen(t => !t)} className="eterx-ide-preview-icon-button h-8 w-8 rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/[0.06] transition-all relative" title="Toggle Console">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
                        {consoleLogs.length > 0 && <span className="absolute top-0 right-0 w-2 h-2 rounded-full bg-[#FF5F57] border border-[#323233]" />}
                      </button>
                      <button onClick={() => setIsFullscreen(f => !f)} className="eterx-ide-preview-icon-button h-8 w-8 rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/[0.06] transition-all" title="Fullscreen">
                        {isFullscreen ? 
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
                        : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
                        }
                      </button>
                    </div>
                  </div>

                  {/* Preview frame, full remaining height */}
                  <div className={`${isFullscreen ? '' : 'rounded-b-[24px]'} flex-1 relative overflow-hidden bg-white`}>
                    <AnimatePresence>
                      {isPreviewLoading && (
                        <motion.div 
                          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-6 backdrop-blur-md" style={{ background: isLightTheme ? 'rgba(250,250,248,0.72)' : 'rgba(24,24,27,0.7)' }}
                        >
                          <div className={`relative w-[340px] h-[220px] rounded-xl overflow-hidden flex flex-col ${isLightTheme ? 'border border-black/10 bg-white shadow-[0_20px_50px_rgba(31,31,29,0.14)]' : 'border border-white/10 bg-[#1e1e1e] shadow-[0_20px_50px_rgba(0,0,0,0.5)]'}`}>
                            {/* Header */}
                            <div className="h-10 border-b border-white/5 flex items-center px-4 gap-2 bg-white/[0.02]">
                              <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.5, repeat: Infinity, delay: 0 }} className="w-3 h-3 rounded-full bg-[#FF5F57]/80 shadow-[0_0_10px_rgba(255,95,87,0.5)]" />
                              <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.5, repeat: Infinity, delay: 0.2 }} className="w-3 h-3 rounded-full bg-[#FEBC2E]/80 shadow-[0_0_10px_rgba(254,188,46,0.5)]" />
                              <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.5, repeat: Infinity, delay: 0.4 }} className="w-3 h-3 rounded-full bg-[#28C840]/80 shadow-[0_0_10px_rgba(40,200,64,0.5)]" />
                              <div className="flex-1 ml-4 h-5 rounded-md bg-white/[0.04]" />
                            </div>
                            {/* Body skeleton */}
                            <div className={`flex-1 p-6 flex flex-col gap-4 relative overflow-hidden ${isLightTheme ? 'bg-[#F7F6F3]' : 'bg-[#18181b]'}`}>
                               {/* Shimmer overlay */}
                               <motion.div 
                                 className="absolute inset-0 z-10 eterx-surface-shimmer eterx-surface-shimmer-panel"
                               />
                               <div className="w-3/4 h-5 rounded-md bg-white/5" />
                               <div className="w-1/2 h-4 rounded-md bg-white/5" />
                               <div className="w-full h-16 rounded-md bg-white/5 mt-2" />
                               <div className="w-full h-10 rounded-md bg-white/5" />
                            </div>
                          </div>
                          <motion.span 
                            animate={{ opacity: [0.4, 1, 0.4] }} 
                            transition={{ duration: 1.5, repeat: Infinity }}
                            className="text-[12px] text-[#A3A19E] tracking-[0.2em] font-medium font-mono uppercase"
                          >
                            Rendering preview...
                          </motion.span>
                        </motion.div>
                      )}
                    </AnimatePresence>
                    {renderPreviewSurface()}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Console output panel */}
          <AnimatePresence>
            {terminalOpen && (
              <motion.div 
                initial={{ y: 200, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 200, opacity: 0 }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="h-[180px] bg-black/40 backdrop-blur-xl border-t border-white/10 flex flex-col z-20 absolute bottom-0 left-0 right-0"
              >
                <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-white/[0.02]">
                  <div className="flex items-center gap-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#888888]"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
                    <span className="text-[11px] font-bold uppercase tracking-wider text-[#A3A19E]">Console Output</span>
                    <div className="px-1.5 py-0.5 rounded-full bg-[#2D2D30] text-[#A3A19E] text-[9px] font-bold leading-none">{consoleLogs.length}</div>
                  </div>
                  <div className="flex items-center gap-4">
                    <button onClick={() => setConsoleLogs([])} className="text-[10px] font-medium text-[#555350] hover:text-white transition-colors">Clear</button>
                    <button onClick={() => setTerminalOpen(false)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#555350] hover:text-white"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
                  </div>
                </div>
                <div className="eterx-scrollbar flex-1 overflow-y-auto overflow-x-hidden p-4 font-mono text-[12px] leading-relaxed [scrollbar-gutter:stable]">
                  {consoleLogs.map((log, i) => (
                    <div key={i} className={`flex gap-3 p-2 rounded mb-2 ${log.type === 'warn' ? 'bg-yellow-500/5 border border-yellow-500/10 text-[#D4D4D4]' : 'text-[#D4D4D4]'}`}>
                      {log.type === 'warn' && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-yellow-500/70 shrink-0 mt-0.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>}
                      <span className="flex-1">{log.text}</span>
                    </div>
                  ))}
                  {consoleLogs.length === 0 && (
                    <div className="flex items-center justify-center h-full text-[#555350] italic text-[11px]">No logs to show</div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Context Menu Portal */}
      <AnimatePresence>
        {contextMenu && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.1 }}
            className="fixed z-[99999] w-48 py-1.5 bg-[#1C1C1F]/90 backdrop-blur-xl border border-white/[0.1] rounded-lg shadow-2xl overflow-hidden"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button onClick={() => { closePanel(contextMenu.index); setContextMenu(null); }} className="w-full text-left px-3 py-1.5 text-[12px] text-[#E8E6E3] hover:bg-[#4FC1FF]/20 hover:text-[#4FC1FF] transition-colors flex justify-between items-center group">
              Close <span className="text-[10px] text-[#555350] group-hover:text-[#4FC1FF]/50 font-mono">Ctrl+W</span>
            </button>
            <button onClick={() => { handleCloseOthers(contextMenu.index); setContextMenu(null); }} className="w-full text-left px-3 py-1.5 text-[12px] text-[#E8E6E3] hover:bg-[#4FC1FF]/20 hover:text-[#4FC1FF] transition-colors">
              Close Others
            </button>
            <div className="h-[1px] bg-white/[0.05] my-1" />
            <button onClick={() => { handleCloseAll(); setContextMenu(null); }} className="w-full text-left px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-500/20 transition-colors">
              Close All
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Command Palette */}
      <AnimatePresence>
        {paletteOpen && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-[#000000]/40 backdrop-blur-sm z-[99998]" onClick={() => setPaletteOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -20, scale: 0.95 }}
              className="absolute top-[20%] left-1/2 -translate-x-1/2 w-[500px] bg-[#1C1C1F]/90 backdrop-blur-2xl border border-white/[0.1] rounded-xl shadow-2xl overflow-hidden z-[99999] flex flex-col"
            >
              <div className="flex items-center px-4 py-3 border-b border-white/[0.05]">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#A3A19E] mr-3 shrink-0"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                <input 
                  autoFocus 
                  placeholder="Type a command or search open editors..." 
                  className="flex-1 bg-transparent border-none outline-none text-[#E8E6E3] placeholder:text-[#555350] text-[13px] font-mono"
                />
                <span className="text-[10px] text-[#555350] font-mono bg-white/[0.05] px-1.5 rounded">ESC</span>
              </div>
              <div className="eterx-scrollbar max-h-[300px] overflow-y-auto overflow-x-hidden p-2 [scrollbar-gutter:stable]">
                <div className="px-3 py-1.5 text-[10px] font-bold text-[#555350] uppercase tracking-wider">Commands</div>
                
                <div onClick={() => { setSidebarOpen(!sidebarOpen); setPaletteOpen(false); }} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/[0.05] cursor-pointer group">
                  <div className="flex items-center gap-3"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#8C8A88] group-hover:text-[#4FC1FF]"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="12" y1="3" x2="12" y2="21"></line></svg><span className="text-[12px] text-[#E8E6E3]">Toggle Left Sidebar</span></div>
                  <span className="text-[10px] text-[#555350] font-mono border border-white/[0.05] bg-[#0A0A0C] px-1.5 rounded">Ctrl+B</span>
                </div>

                <div onClick={() => { handleCloseAll(); setPaletteOpen(false); }} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/[0.05] cursor-pointer group">
                  <div className="flex items-center gap-3"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#8C8A88] group-hover:text-red-400"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg><span className="text-[12px] text-[#E8E6E3]">Close All Editors</span></div>
                </div>

                <div className="px-3 py-1.5 text-[10px] font-bold text-[#555350] uppercase tracking-wider mt-2">Open Files</div>
                {openFiles.map((f, i) => (
                  <div key={i} onClick={() => { setActiveIndex(i); setPaletteOpen(false); }} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/[0.05] cursor-pointer group">
                    <div className="flex items-center gap-3"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#8C8A88] group-hover:text-[#4FC1FF]"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline></svg><span className="text-[12px] text-[#E8E6E3]">{f.filename}</span></div>
                  </div>
                ))}
              </div>
            </motion.div>
          </>
        )}
        </AnimatePresence>
      </div>
    </div>
  );

  const dockPortal = activeTabMode !== 'review' && !isFullscreen && dockPosition && typeof document !== 'undefined' ? createPortal(
    <div
      className="fixed z-[9999] -translate-x-1/2 [-webkit-app-region:no-drag]"
      style={{ left: dockPosition.left, top: dockPosition.top }}
    >
      {workspaceControlDock}
    </div>,
    document.body
  ) : null;

  return isFullscreen ? (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', flexDirection: 'column' }}
    >
      {panelContent}
    </div>
  ) : (
    <>
      {panelContent}
      {dockPortal}
    </>
  );
};
