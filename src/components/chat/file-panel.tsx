'use client';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, ExternalLink, Copy, Check, Globe, Code2,
  Columns2, RefreshCw, FileCode2, FileText, Monitor,
  Maximize2, Minimize2, Terminal, Search, TerminalSquare, ShieldAlert,
  Download, Settings, ChevronDown, ChevronRight, Folder, FolderOpen, Plus
} from 'lucide-react';
import Editor, { DiffEditor } from '@monaco-editor/react';

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
  const m: Record<string,string> = { js:'JS', jsx:'JSX', ts:'TS', tsx:'TSX', html:'HTML', css:'CSS', scss:'SCSS', json:'JSON', md:'MD', py:'Python', rb:'Ruby', go:'Go', rs:'Rust', c:'C', cpp:'C++', cs:'C#', java:'Java', php:'PHP', sh:'Shell', yml:'YAML', yaml:'YAML', xml:'XML', sql:'SQL' };
  return m[ext] || ext.toUpperCase() || 'Text';
}

function getFileColor(fn: string) {
  const ext = fn.split('.').pop()?.toLowerCase() || '';
  const c: Record<string,string> = { ts:'#3178c6', tsx:'#3178c6', js:'#f7df1e', jsx:'#61dafb', html:'#e44d26', css:'#1572b6', scss:'#cd6799', json:'#a4b856', py:'#3572a5', go:'#00add8', rs:'#dea584', md:'#8b949e' };
  return c[ext] || '#8b949e';
}

type TabMode = 'code' | 'diff' | 'preview';

export interface FilePanelProps {
  filename: string;
  filepath: string;
  content?: string;
  diffLines?: Array<{ type: 'added'|'removed'|'unchanged'; content: string; oldLine?: number; newLine?: number }>;
  isEdit?: boolean;
  onClose?: () => void;
  activeTabMode?: 'preview' | 'code' | 'diff';
}

export const FilePanelModal = ({ filename, filepath, content: initialContent, diffLines, isEdit, onClose, activeTabMode }: FilePanelProps) => {
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

  // Build URL for preview, supporting localhost for non-HTML
  const [urlInput, setUrlInput] = useState<string>(isHtml ? `/api/preview/${filepath.replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent).join('/')}` : 'http://localhost:3000');
  const [previewUrl, setPreviewUrl] = useState<string>(urlInput);

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

  const added   = diffLines?.filter(l => l.type === 'added').length   ?? 0;
  const removed = diffLines?.filter(l => l.type === 'removed').length ?? 0;
  const lineCount = (localContent || '').split('\n').length;
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
            smoothScrolling: true,
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'on',
            formatOnPaste: true,
            wordWrap: 'on',
            renderLineHighlight: 'all',
          }}
          loading={
            <div className="flex items-center justify-center h-full text-[#555350] text-[12px] font-mono">
               Loading Monaco Editor...
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
            smoothScrolling: true,
            wordWrap: 'off'
          }}
          loading={<div className="flex items-center justify-center h-full text-[#555350] text-[12px] font-mono">Loading Diff...</div>}
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
            onKeyDown={e => { if (e.key === 'Enter') setPreviewUrl(urlInput); }}
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
                       <div className="flex-1 overflow-auto p-2 space-y-1 font-mono text-[11.5px] custom-scrollbar">
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

/* ─── IDE Multi-Tab Panel ─── */
import { useGlobalFilePanel } from '../../contexts/FilePanelContext';
import { LayoutList } from 'lucide-react';

// File icon for real filesystem nodes
const FileNodeIcon = ({ name, isDir, isOpen }: { name: string, isDir: boolean, isOpen?: boolean }) => {
  if (isDir) return isOpen ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#C09553]"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#C09553]"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (ext === 'tsx' || ext === 'jsx') return <div className="text-[#61DAFB] font-bold text-[10px] w-4 text-center">⚛</div>;
  if (ext === 'ts') return <div className="text-[#3178C6] font-bold text-[10px] w-4 text-center">TS</div>;
  if (ext === 'js') return <div className="text-[#F0DB4F] font-bold text-[10px] w-4 text-center">JS</div>;
  if (ext === 'html' || ext === 'htm') return <div className="text-[#E34F26] font-bold text-[10px] w-4 text-center">&lt;/&gt;</div>;
  if (ext === 'css' || ext === 'scss') return <div className="text-[#264de4] font-bold text-[10px] w-4 text-center">🎨</div>;
  if (ext === 'json') return <div className="text-[#CBCB41] font-bold text-[10px] w-4 text-center">{"{}"}</div>;
  if (ext === 'py') return <div className="text-[#3572A5] font-bold text-[10px] w-4 text-center">Py</div>;
  if (ext === 'md') return <div className="text-[#888] font-bold text-[10px] w-4 text-center">MD</div>;
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#8C8A88]"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>;
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
          <FileNodeIcon name={node.name} isDir={true} isOpen={expanded} />
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
      className={`flex items-center gap-1.5 py-[3px] hover:bg-[#2A2D2E] cursor-pointer rounded-sm mx-1 group ${
        isActive ? 'bg-[#37373D]' : isOpen ? 'bg-[#2D2D30]' : ''
      }`}
      style={{ paddingLeft: `${8 + depth * 14 + 12}px`, paddingRight: '8px' }}
    >
      <FileNodeIcon name={node.name} isDir={false} />
      <span className={`text-[12px] truncate flex-1 ${isActive ? 'text-white' : isOpen ? 'text-[#E8E6E3]' : 'text-[#BBBBBB]'}`}>{node.name}</span>
      {isOpen && <div className="w-1.5 h-1.5 rounded-full bg-[#4FC1FF] shrink-0 opacity-70" />}
    </div>
  );
};

export const IdePanel = () => {
  const { openFiles, activeIndex, closePanel, setActiveIndex, openPanel } = useGlobalFilePanel();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, index: number } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [activeTabMode, setActiveTabMode] = useState<'preview'|'code'>('code');
  const [fileTree, setFileTree] = useState<FileEntry[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState<string>('');
  const [workspaceName, setWorkspaceName] = useState<string>('');
   const [terminalOpen, setTerminalOpen] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isTreeLoading, setIsTreeLoading] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [iframeHistory, setIframeHistory] = useState<string[]>([]);
  const [iframeHistoryIndex, setIframeHistoryIndex] = useState(-1);
  const [consoleLogs, setConsoleLogs] = useState<{ type: 'info' | 'warn' | 'error', text: string }[]>([]);
  const [isPanelClosing, setIsPanelClosing] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const treeSignatureRef = useRef('');
  const treeFetchInFlightRef = useRef(false);
  const panelCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (panelCloseTimerRef.current) clearTimeout(panelCloseTimerRef.current);
  }, []);

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
      const res = await fetch(`/api/code/files?path=${encodeURIComponent(root)}&depth=4`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.tree) {
        const nextSignature = JSON.stringify(data.tree);
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
    const interval = setInterval(() => {
      if (document.hidden) return;
      fetchFileTree(workspaceRoot, true);
    }, 5000);
    return () => clearInterval(interval);
  }, [workspaceRoot, fetchFileTree]);

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
  const htmlEntryFile = openFiles.find(f => /\.(html|htm)$/i.test(f.filename));
  const previewTarget = activeTabMode === 'preview' ? (htmlEntryFile || activeFile) : activeFile;

  // Real-time URL State for Full Project Previews
  const [urlInput, setUrlInput] = useState('http://localhost:3000');
  const [previewUrl, setPreviewUrl] = useState('http://localhost:3000');

  // Auto-switch to single-file preview ONLY if user explicitly opens an HTML file
  useEffect(() => {
    const target = previewTarget;
    if (target?.filepath && /\.(html|htm)$/i.test(target.filename)) {
      const pathSegments = target.filepath.replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent);
      const url = `/api/preview/${pathSegments.join('/')}`;
      setPreviewUrl(url);
      setUrlInput(url);
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

  const openFilePaths = new Set(openFiles.map(f => f.filepath.replace(/\\/g, '/')));
  const activeFilePath = activeFile?.filepath.replace(/\\/g, '/') || '';

  const handleTreeFileClick = (filePath: string, fileName: string) => {
    // 0-Latency UI Update: Open tab instantly before network fetch
    openPanel({ filename: fileName, filepath: filePath, content: undefined });

    fetch('/api/code/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath })
    }).then(r => r.json()).then(data => {
      // Background update: populate the content
      openPanel({ filename: fileName, filepath: filePath, content: data.content || '' });
    }).catch(() => {
      openPanel({ filename: fileName, filepath: filePath, content: '' });
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
    if (iframeRef.current?.contentWindow) {
      try { iframeRef.current.contentWindow.location.reload(); }
      catch { if (iframeRef.current) iframeRef.current.src = iframeRef.current.src; }
    }
  };

  const canGoBack = iframeHistoryIndex > 0;
  const canGoForward = iframeHistoryIndex < iframeHistory.length - 1;

  const panelContent = (
    <div className={`flex-1 flex flex-col relative z-10 h-full overflow-hidden transition-[opacity,transform,padding] duration-200 ease-out ${isPanelClosing ? 'translate-x-5 scale-[0.992] opacity-0' : 'translate-x-0 scale-100 opacity-100 animate-in slide-in-from-right-8'} ${isFullscreen ? 'p-0' : 'py-2.5 pr-2.5 pl-2'}`} onContextMenu={e => e.preventDefault()}>
      
      {/* ── UNIFIED LIQUID GLASS CONTAINER ── */}
      <div
        className={`${isFullscreen ? 'rounded-none' : 'rounded-[24px]'} flex-1 flex flex-col bg-[#1F1F1F] backdrop-blur-3xl overflow-hidden relative isolate border border-white/[0.08] shadow-[0_24px_60px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.055)]`}
        style={{ clipPath: isFullscreen ? 'none' : 'inset(0 round 24px)' }}
      >
        
        {/* ── UNIFIED HEADER ROW ── */}
        <div className={`${isFullscreen ? '' : 'rounded-t-[24px]'} flex h-[52px] border-b border-white/5 shrink-0 bg-white/[0.02] overflow-hidden`}>
        
        {/* Left Header (Mode Toggle) — always 256px wide to anchor layout */}
        <div className="flex items-center px-4 shrink-0 justify-start w-64 border-r border-white/5">
          <div className="flex bg-white/[0.05] rounded-full p-0.5 border border-white/5">
             <button
               onClick={() => setActiveTabMode('preview')}
               className={`px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] rounded-full transition-all duration-200 ${activeTabMode === 'preview' ? 'bg-white text-black' : 'text-[#666666] hover:text-white'}`}
             >Preview</button>
             <button
               onClick={() => setActiveTabMode('code')}
               className={`px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] rounded-full transition-all duration-200 flex items-center gap-1.5 ${activeTabMode === 'code' ? 'bg-white/[0.1] text-white' : 'text-[#666666] hover:text-white'}`}
             >
               {activeTabMode === 'code' && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
               Code
             </button>
          </div>
        </div>

            <div className="flex-1 flex items-center justify-between px-4 min-w-0">
             {/* Tab bar — only in Code mode */}
             {activeTabMode === 'code' && (
               <div className="flex-1 min-w-0 h-full flex items-center" style={{ WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 32px), transparent)', maskImage: 'linear-gradient(to right, black calc(100% - 32px), transparent)' }}>
                 <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide h-full w-full" style={{ scrollbarWidth: 'none' }}>
                  {openFiles.map((f, i) => {
                   const lang = getLanguage(f.filename).substring(0, 2).toLowerCase();
                   let iconChar = '{}'; let iconCol = 'text-[#666]';
                   if (lang === 'ts' || lang === 'tx') { iconChar = 'TS'; iconCol = 'text-[#999]'; }
                   if (lang === 'ht') { iconChar = '</>'; iconCol = 'text-[#FFF]'; }
                   if (lang === 'js') { iconChar = 'JS'; iconCol = 'text-[#AAA]'; }
                   return (
                     <div 
                       key={`${f.filepath}-${i}`}
                       onClick={() => setActiveIndex(i)}
                       onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, index: i }); }}
                       className={`group relative flex items-center gap-2.5 px-3.5 py-1.5 rounded-full text-[12px] cursor-pointer shrink-0 transition-all duration-200 border ${activeIndex === i ? 'bg-white/10 text-white border-white/20' : 'text-[#666] hover:bg-white/[0.05] border-transparent hover:text-white'}`}
                     >
                      <div className={`font-mono font-bold text-[10px] ${iconCol}`}>{iconChar}</div>
                      {f.filename}
                      <button 
                        onClick={(e) => { e.stopPropagation(); closePanel(i); }} 
                        className={`flex items-center justify-center w-4 h-4 rounded-[4px] hover:bg-white/[0.1] hover:text-white transition-all ${activeIndex === i ? 'opacity-100 text-[#888]' : 'opacity-0 group-hover:opacity-100 text-[#555]'}`}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                      </button>
                    </div>
                   );
                  })}
                 </div>
               </div>
             )}
            
            <div className="flex items-center gap-1.5 shrink-0 px-2 ml-4">
               {activeTabMode === 'code' && (
                 <button onClick={() => setSidebarOpen(s => !s)} className={`w-8 h-8 flex items-center justify-center transition-all rounded-[6px] ${sidebarOpen ? 'text-white bg-white/10 shadow-inner' : 'text-[#666] hover:text-white hover:bg-white/5'}`} title="Toggle Sidebar">
                   <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
                 </button>
               )}
               {!isFullscreen && (
                 <button onClick={() => setTerminalOpen(!terminalOpen)} className={`w-8 h-8 flex items-center justify-center transition-all rounded-[6px] ${terminalOpen ? 'text-white bg-white/10 shadow-inner' : 'text-[#666] hover:text-white hover:bg-white/5'}`} title="Toggle Terminal">
                   <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
                 </button>
               )}
               <button onClick={() => setIsFullscreen(f => !f)} className={`w-8 h-8 flex items-center justify-center transition-all rounded-[6px] ${isFullscreen ? 'text-white bg-white/10 shadow-inner' : 'text-[#666] hover:text-white hover:bg-white/5'}`} title="Fullscreen">
                 {isFullscreen ? 
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
                  : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
                 }
               </button>
               <button className="w-8 h-8 flex items-center justify-center text-[#666] hover:text-white hover:bg-white/5 transition-all rounded-[6px]" title="Settings">
                 <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
               </button>
               <button
                 onClick={handleCloseAll}
                 className="group flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.075] bg-white/[0.035] text-[#777] shadow-[inset_0_1px_0_rgba(255,255,255,0.045)] transition-all duration-200 hover:border-white/[0.16] hover:bg-white/[0.085] hover:text-white active:scale-95"
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
          </div>
        </div>

      {/* ── MAIN WORKSPACE AREA ── */}
      <div className={`${isFullscreen ? '' : 'rounded-b-[24px]'} flex-1 flex overflow-hidden`}>
        
        {/* Left Sidebar — hidden in Preview mode for full-screen render */}
        {sidebarOpen && activeTabMode === 'code' && (
          <div className="w-64 bg-white/[0.01] border-r border-white/5 flex flex-col shrink-0 select-none">
            <div className="px-3 py-2 flex items-center justify-between group border-b border-white/[0.05]">
              <div className="flex items-center gap-1.5 min-w-0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><polyline points="9 18 15 12 9 6"></polyline></svg>
                <span className="text-[11.5px] font-semibold text-[#CCCCCC] tracking-wide truncate uppercase">{workspaceName || 'Explorer'}</span>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                 <button title="Search" onClick={() => setPaletteOpen(true)} className="p-1 rounded-[4px] hover:bg-white/[0.05] transition-all"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg></button>
                 <button title="Refresh" onClick={() => fetchFileTree(workspaceRoot)} className="p-1 rounded-[4px] hover:bg-white/[0.05] transition-all"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg></button>
                 <button onClick={() => setSidebarOpen(false)} className="p-1 rounded-[4px] hover:bg-white/[0.05] transition-all"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></button>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto py-1 relative" style={{ scrollbarWidth: 'none' }}>
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
            <div className="px-3 py-2 border-t border-white/[0.04] flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full transition-colors ${isTreeLoading ? 'bg-white/30 animate-pulse' : 'bg-white/60'}`} />
              <span className="text-[10px] text-white/20 font-mono uppercase tracking-widest">
                {isTreeLoading ? 'Syncing…' : `${openFiles.length} open`}
              </span>
            </div>
          </div>
        )}

        {/* Editor/Preview/Console Area */}
        <div className={`${isFullscreen ? '' : 'rounded-b-[24px]'} flex-1 flex flex-col min-w-0 bg-transparent relative overflow-hidden`}>
          <div className="flex-1 flex flex-col min-w-0">
            <div className={`${isFullscreen ? '' : 'rounded-b-[24px]'} flex-1 relative overflow-hidden`} style={{ background: '#0d0d0f' }}>
              {activeTabMode === 'code' ? (
                activeFile ? (
                  <Editor
                    height="100%"
                    path={activeFile.filepath}
                    value={activeFile.content || ''}
                    language={(() => {
                      const ext = activeFile.filename.split('.').pop()?.toLowerCase() || '';
                      const map: Record<string,string> = { ts:'typescript',tsx:'typescript',js:'javascript',jsx:'javascript',html:'html',css:'css',scss:'scss',json:'json',md:'markdown',py:'python',go:'go',rs:'rust',sh:'shell' };
                      return map[ext] || 'plaintext';
                    })()}
                    theme="vs-dark"
                    options={{
                      readOnly: true,
                      minimap: { enabled: false },
                      fontSize: 13,
                      lineHeight: 22,
                      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                      fontLigatures: true,
                      scrollBeyondLastLine: false,
                      renderLineHighlight: 'line',
                      cursorBlinking: 'smooth',
                      smoothScrolling: true,
                      padding: { top: 16, bottom: 16 },
                      overviewRulerBorder: false,
                      hideCursorInOverviewRuler: true,
                      scrollbar: { verticalScrollbarSize: 4, horizontalScrollbarSize: 4 },
                    }}
                    loading={
                      <div className="flex flex-col items-center justify-center h-full" style={{ background: '#0d0d0f' }}>
                        <div className="w-8 h-8 border-2 border-white/10 border-t-white/50 rounded-full animate-spin mb-3" />
                        <span className="text-[11px] text-white/30 uppercase tracking-widest">Loading editor…</span>
                      </div>
                    }
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-center p-12">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.75" strokeLinecap="round" strokeLinejoin="round" className="mb-4 text-white opacity-10"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
                    <h3 className="text-white/50 text-[13px] font-medium mb-1 uppercase tracking-widest">No file selected</h3>
                    <p className="text-white/20 text-[11px] max-w-[200px] uppercase tracking-widest">Open a file from the explorer</p>
                  </div>
                )
              ) : (
                <div className={`${isFullscreen ? '' : 'rounded-b-[24px]'} h-full flex flex-col overflow-hidden`} style={{ background: '#2C2C2E' }}>
                  {/* Premium Browser Chrome - Redesigned to match high-end concept */}
                  <div
                    className="h-[52px] shrink-0 flex items-center justify-between px-4"
                    style={{ background: '#323233', borderBottom: '1px solid rgba(0,0,0,0.3)' }}
                  >
                    {/* Left: Device Toggles & Nav */}
                    <div className="flex items-center gap-3">
                      <div className="flex items-center p-0.5 rounded-[8px]" style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.03)' }}>
                        <button className="p-1.5 rounded-[6px] bg-[#454547] text-white shadow-sm transition-all" title="Desktop view">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
                        </button>
                        <button className="p-1.5 rounded-[6px] text-white/30 hover:text-white/60 transition-all" title="Mobile view">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>
                        </button>
                      </div>
                      
                      {/* Nav Buttons integrated seamlessly */}
                      <div className="flex items-center gap-1 opacity-60">
                        <button onClick={handleBack} disabled={!canGoBack} className={`w-6 h-6 flex items-center justify-center transition-all ${canGoBack ? 'text-white hover:text-white' : 'text-white/20 cursor-default'}`}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M15 18l-6-6 6-6"/></svg>
                        </button>
                        <button onClick={handleForward} disabled={!canGoForward} className={`w-6 h-6 flex items-center justify-center transition-all ${canGoForward ? 'text-white hover:text-white' : 'text-white/20 cursor-default'}`}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6"/></svg>
                        </button>
                      </div>
                    </div>

                    {/* Center: URL Bar Pill */}
                    <div className="flex-1 flex justify-center max-w-[600px] mx-4">
                      <div
                        className="w-full h-[32px] flex items-center justify-between px-3 rounded-[8px] transition-all group focus-within:ring-1 focus-within:ring-white/20"
                        style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.03)' }}
                      >
                        <div className="flex items-center gap-3 w-full">
                           <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/40"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>
                           <input
                             value={urlInput}
                             onChange={e => setUrlInput(e.target.value)}
                             onKeyDown={e => { if (e.key === 'Enter') { setPreviewUrl(urlInput); setIsPreviewLoading(true); } }}
                             className="text-[12.5px] text-white/60 font-mono truncate flex-1 tracking-wide bg-transparent outline-none"
                             placeholder="Enter dev server URL (e.g. http://localhost:3000)"
                           />
                           <div className="flex items-center gap-3 shrink-0">
                             <button onClick={() => previewUrl && window.open(previewUrl, '_blank')} className="text-white/30 hover:text-white/80 transition-colors" title="Open in browser">
                               <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                             </button>
                             <button onClick={handleRefresh} className="text-white/30 hover:text-white/80 transition-colors" title="Reload frame">
                               <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
                             </button>
                           </div>
                        </div>
                      </div>
                    </div>

                    {/* Right: Actions */}
                    <div className="flex items-center gap-3 shrink-0">
                      <button onClick={() => setActiveTabMode('code')} className="flex items-center gap-2 px-3 py-1.5 rounded-[6px] text-white/80 hover:text-white transition-all text-[11.5px] font-medium" style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)' }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                        Edit
                      </button>
                      <button onClick={() => setTerminalOpen(t => !t)} className="text-white/40 hover:text-white transition-all relative p-1" title="Toggle Console">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
                        {consoleLogs.length > 0 && <span className="absolute 1 top-0 right-0 w-2 h-2 rounded-full bg-[#FF5F57] border border-[#323233]" />}
                      </button>
                      <button onClick={() => setIsFullscreen(f => !f)} className="text-white/40 hover:text-white transition-all p-1" title="Fullscreen">
                        {isFullscreen ? 
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
                        : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
                        }
                      </button>
                    </div>
                  </div>

                  {/* Preview iframe — full remaining height */}
                  <div className={`${isFullscreen ? '' : 'rounded-b-[24px]'} flex-1 relative overflow-hidden bg-white`}>
                    <AnimatePresence>
                      {isPreviewLoading && (
                        <motion.div 
                          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-6 backdrop-blur-md" style={{ background: 'rgba(24,24,27,0.7)' }}
                        >
                          <div className="relative w-[340px] h-[220px] rounded-xl overflow-hidden border border-white/10 bg-[#1e1e1e] shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col">
                            {/* Header */}
                            <div className="h-10 border-b border-white/5 flex items-center px-4 gap-2 bg-white/[0.02]">
                              <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.5, repeat: Infinity, delay: 0 }} className="w-3 h-3 rounded-full bg-[#FF5F57]/80 shadow-[0_0_10px_rgba(255,95,87,0.5)]" />
                              <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.5, repeat: Infinity, delay: 0.2 }} className="w-3 h-3 rounded-full bg-[#FEBC2E]/80 shadow-[0_0_10px_rgba(254,188,46,0.5)]" />
                              <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.5, repeat: Infinity, delay: 0.4 }} className="w-3 h-3 rounded-full bg-[#28C840]/80 shadow-[0_0_10px_rgba(40,200,64,0.5)]" />
                              <div className="flex-1 ml-4 h-5 rounded-md bg-white/[0.04]" />
                            </div>
                            {/* Body skeleton */}
                            <div className="flex-1 p-6 flex flex-col gap-4 relative overflow-hidden bg-[#18181b]">
                               {/* Shimmer overlay */}
                               <motion.div 
                                 className="absolute inset-0 z-10"
                                 style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)' }}
                                 animate={{ x: ['-100%', '100%'] }}
                                 transition={{ duration: 1.5, ease: 'easeInOut', repeat: Infinity }}
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
                            Connecting to server...
                          </motion.span>
                        </motion.div>
                      )}
                    </AnimatePresence>
                    <iframe
                      ref={iframeRef}
                      key={previewUrl}
                      src={previewUrl || ''}
                      className="w-full h-full border-none"
                      style={{ borderRadius: isFullscreen ? 0 : '0 0 24px 24px' }}
                      onLoad={handlePreviewLoad}
                      title="Preview"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── CONSOLE OUTPUT PANEL ── */}
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
                <div className="flex-1 overflow-y-auto p-4 font-mono text-[12px] leading-relaxed scrollbar-hide">
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
              <div className="max-h-[300px] overflow-y-auto p-2" style={{ scrollbarWidth: 'none' }}>
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

  return isFullscreen ? (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', flexDirection: 'column' }}
    >
      {panelContent}
    </div>
  ) : panelContent;
};
