"use client";

import React, { useEffect, useRef, useCallback } from 'react';
import { Save, Copy, WrapText, Hash, ArrowUpDown } from 'lucide-react';
import SyntaxHighlighter from 'react-syntax-highlighter';
import { atomOneDark } from 'react-syntax-highlighter/dist/esm/styles/hljs';

interface OpenFile {
  path: string;
  name: string;
  content: string;
  language: string;
  modified: boolean;
}

interface CodeEditorProps {
  file: OpenFile;
  onContentChange: (content: string) => void;
  onSave: () => void;
}

// Custom dark theme matching EterX aesthetic
const customTheme = {
  ...atomOneDark,
  'hljs': {
    ...atomOneDark['hljs'],
    background: '#050505',
    color: '#C8C6C3',
  },
};

export const CodeEditor: React.FC<CodeEditorProps> = ({ file, onContentChange, onSave }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isEditing, setIsEditing] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [scrollTop, setScrollTop] = React.useState(0);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        onSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSave]);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { }
  };

  const lines = file.content.split('\n');
  const lineCount = lines.length;

  const getPathBreadcrumb = (filePath: string) => {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const last3 = parts.slice(-3);
    return last3.map((part, i) => (
      <span key={i} className="flex items-center gap-1">
        {i > 0 && <span className="text-[#555350]">/</span>}
        <span className={i === last3.length - 1 ? 'text-[#E8E6E3]' : 'text-[#8C8A88]'}>
          {part}
        </span>
      </span>
    ));
  };

  return (
    <div className="flex flex-col h-full bg-[#050505]">
      {/* File Toolbar */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#0A0A0A]/60 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-1 text-[11px] font-mono">
          {getPathBreadcrumb(file.path)}
          {file.modified && (
            <span className="ml-2 text-[10px] text-[#E2765A] font-sans font-medium">Modified</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-[#555350] mr-2 font-mono">
            {lineCount} lines · {file.language}
          </span>
          <button
            onClick={copyToClipboard}
            className="p-1 rounded text-[#8C8A88] hover:text-white hover:bg-white/5 transition-all"
            title="Copy file"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onSave}
            className={`p-1 rounded transition-all ${
              file.modified
                ? 'text-[#E2765A] hover:bg-[#E2765A]/10'
                : 'text-[#555350]'
            }`}
            title="Save (Ctrl+S)"
          >
            <Save className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setIsEditing(!isEditing)}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
              isEditing
                ? 'bg-[#E2765A]/20 text-[#E2765A] border border-[#E2765A]/30'
                : 'bg-white/5 text-[#8C8A88] hover:text-white hover:bg-white/10 border border-transparent'
            }`}
          >
            {isEditing ? 'EDITING' : 'VIEW'}
          </button>
        </div>
      </div>

      {/* Editor Content */}
      <div className="flex-1 overflow-auto custom-scrollbar relative" ref={scrollRef}>
        {isEditing ? (
          <div className="flex min-h-full">
            {/* Line Numbers (edit mode) */}
            <div className="sticky left-0 bg-[#070707] border-r border-white/5 py-3 px-2 select-none shrink-0 z-10">
              {lines.map((_, i) => (
                <div key={i} className="text-right text-[12px] leading-[20px] text-[#3A3A3A] font-mono pr-2 min-w-[40px]">
                  {i + 1}
                </div>
              ))}
            </div>
            {/* Textarea */}
            <textarea
              ref={textareaRef}
              value={file.content}
              onChange={(e) => onContentChange(e.target.value)}
              className="flex-1 bg-transparent text-[#C8C6C3] font-mono text-[13px] leading-[20px] p-3 resize-none outline-none border-none min-h-full"
              spellCheck={false}
              style={{ tabSize: 2 }}
            />
          </div>
        ) : (
          <div className="flex min-h-full">
            {/* Line Numbers (view mode) */}
            <div className="sticky left-0 bg-[#070707] border-r border-white/5 py-3 px-2 select-none shrink-0 z-10">
              {lines.map((_, i) => (
                <div key={i} className="text-right text-[12px] leading-[20px] text-[#3A3A3A] font-mono pr-2 min-w-[40px]">
                  {i + 1}
                </div>
              ))}
            </div>
            {/* Syntax Highlighted Content */}
            <div className="flex-1 overflow-x-auto">
              <SyntaxHighlighter
                language={file.language}
                style={customTheme}
                showLineNumbers={false}
                customStyle={{
                  margin: 0,
                  padding: '12px',
                  background: 'transparent',
                  fontSize: '13px',
                  lineHeight: '20px',
                  fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  minHeight: '100%',
                }}
                wrapLines={true}
                lineProps={{ style: { wordBreak: 'break-all', whiteSpace: 'pre-wrap' } }}
              >
                {file.content}
              </SyntaxHighlighter>
            </div>
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="flex items-center justify-between px-3 py-1 bg-[#0A0A0A] border-t border-white/5 shrink-0">
        <div className="flex items-center gap-3 text-[10px] text-[#555350]">
          <span>{file.language.toUpperCase()}</span>
          <span>UTF-8</span>
          <span>LF</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-[#555350]">
          <span>Ln {lineCount}, Col 1</span>
          <span>Spaces: 2</span>
        </div>
      </div>

      {/* Copied Toast */}
      {copied && (
        <div className="absolute top-14 right-4 bg-[#1A1A1A] border border-white/10 rounded-lg px-3 py-1.5 text-[12px] text-emerald-400 shadow-lg z-50 animate-pulse">
          Copied to clipboard
        </div>
      )}
    </div>
  );
};
