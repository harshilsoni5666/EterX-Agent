"use client";

import React, { useState } from 'react';
import {
  ChevronRight, ChevronDown, File, Folder, FolderOpen,
  FileCode, FileJson, FileText, FileType, Image, Settings, Database
} from 'lucide-react';

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  extension?: string;
  children?: FileEntry[];
}

interface FileTreeProps {
  items: FileEntry[];
  onFileClick: (path: string, name: string) => void;
  activeFilePath?: string;
  depth?: number;
}

const FileIcon: React.FC<{ name: string; ext?: string; isDir?: boolean; isOpen?: boolean }> = ({ name, ext, isDir, isOpen }) => {
  if (isDir) {
    return isOpen
      ? <FolderOpen className="w-4 h-4 text-[#E2A95A] shrink-0" />
      : <Folder className="w-4 h-4 text-[#C4983C] shrink-0" />;
  }

  const iconMap: Record<string, { icon: typeof File; color: string }> = {
    ts: { icon: FileCode, color: 'text-blue-400' },
    tsx: { icon: FileCode, color: 'text-blue-400' },
    js: { icon: FileCode, color: 'text-yellow-400' },
    jsx: { icon: FileCode, color: 'text-yellow-400' },
    json: { icon: FileJson, color: 'text-amber-400' },
    md: { icon: FileText, color: 'text-gray-400' },
    mdx: { icon: FileText, color: 'text-gray-400' },
    txt: { icon: FileText, color: 'text-gray-500' },
    py: { icon: FileCode, color: 'text-green-400' },
    css: { icon: FileCode, color: 'text-purple-400' },
    scss: { icon: FileCode, color: 'text-pink-400' },
    html: { icon: FileCode, color: 'text-orange-400' },
    svg: { icon: Image, color: 'text-orange-300' },
    png: { icon: Image, color: 'text-green-300' },
    jpg: { icon: Image, color: 'text-green-300' },
    jpeg: { icon: Image, color: 'text-green-300' },
    gif: { icon: Image, color: 'text-purple-300' },
    yaml: { icon: Settings, color: 'text-teal-400' },
    yml: { icon: Settings, color: 'text-teal-400' },
    toml: { icon: Settings, color: 'text-gray-400' },
    sql: { icon: Database, color: 'text-blue-300' },
    go: { icon: FileCode, color: 'text-cyan-400' },
    rs: { icon: FileCode, color: 'text-orange-500' },
    java: { icon: FileCode, color: 'text-red-400' },
    sh: { icon: FileCode, color: 'text-green-500' },
    env: { icon: Settings, color: 'text-yellow-600' },
  };

  const match = iconMap[ext || ''];
  if (match) {
    const IconComp = match.icon;
    return <IconComp className={`w-4 h-4 ${match.color} shrink-0`} />;
  }

  return <File className="w-4 h-4 text-[#8C8A88] shrink-0" />;
};

const formatSize = (bytes?: number): string => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
};

export const FileTree: React.FC<FileTreeProps> = ({ items, onFileClick, activeFilePath, depth = 0 }) => {
  return (
    <div className="select-none">
      {items.map((item) => (
        <TreeItem
          key={item.path}
          item={item}
          onFileClick={onFileClick}
          activeFilePath={activeFilePath}
          depth={depth}
        />
      ))}
    </div>
  );
};

const TreeItem: React.FC<{
  item: FileEntry;
  onFileClick: (path: string, name: string) => void;
  activeFilePath?: string;
  depth: number;
}> = ({ item, onFileClick, activeFilePath, depth }) => {
  const [expanded, setExpanded] = useState(depth < 1);
  const isActive = item.path === activeFilePath;
  const paddingLeft = 12 + depth * 16;

  if (item.type === 'directory') {
    return (
      <div>
        <div
          onClick={() => setExpanded(!expanded)}
          style={{ paddingLeft }}
          className={`flex items-center gap-1.5 py-[3px] pr-2 cursor-pointer group transition-colors duration-100 ${
            expanded ? 'text-[#E8E6E3]' : 'text-[#A3A19E]'
          } hover:bg-white/5 active:bg-white/10`}
        >
          {expanded
            ? <ChevronDown className="w-3 h-3 text-[#555350] shrink-0" />
            : <ChevronRight className="w-3 h-3 text-[#555350] shrink-0" />
          }
          <FileIcon name={item.name} isDir isOpen={expanded} />
          <span className="text-[12px] truncate font-medium">{item.name}</span>
        </div>
        {expanded && item.children && (
          <FileTree
            items={item.children}
            onFileClick={onFileClick}
            activeFilePath={activeFilePath}
            depth={depth + 1}
          />
        )}
      </div>
    );
  }

  return (
    <div
      onClick={() => onFileClick(item.path, item.name)}
      style={{ paddingLeft: paddingLeft + 16 }}
      className={`flex items-center gap-1.5 py-[3px] pr-2 cursor-pointer group transition-colors duration-100 ${
        isActive
          ? 'bg-[#E2765A]/10 text-white border-l-2 border-[#E2765A]'
          : 'text-[#A3A19E] hover:bg-white/5 hover:text-[#E8E6E3] active:bg-white/10'
      }`}
    >
      <FileIcon name={item.name} ext={item.extension} />
      <span className="text-[12px] truncate">{item.name}</span>
      {item.size && (
        <span className="text-[10px] text-[#555350] ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {formatSize(item.size)}
        </span>
      )}
    </div>
  );
};
