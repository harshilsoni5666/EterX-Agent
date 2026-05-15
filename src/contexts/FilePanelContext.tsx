'use client';
import React, { createContext, useContext, useState, ReactNode, useCallback } from 'react';
import { FilePanelProps } from '../components/chat/file-panel';

interface FilePanelContextType {
  openFiles: FilePanelProps[];
  activeIndex: number;
  openPanel: (props: FilePanelProps) => void;
  closePanel: (index: number) => void;
  setActiveIndex: (index: number) => void;
}

const FilePanelContext = createContext<FilePanelContextType | null>(null);

export function FilePanelProvider({ children }: { children: ReactNode }) {
  const [openFiles, setOpenFiles] = useState<FilePanelProps[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(-1);

  const openPanel = useCallback((props: FilePanelProps) => {
    setOpenFiles(prev => {
      const existingIdx = prev.findIndex(f => f.filepath === props.filepath);
      if (existingIdx !== -1) {
        setActiveIndex(existingIdx);
        const newFiles = [...prev];
        newFiles[existingIdx] = { ...newFiles[existingIdx], ...props };
        return newFiles;
      }
      setActiveIndex(prev.length);
      return [...prev, props];
    });
  }, []);

  const closePanel = useCallback((index: number) => {
    setOpenFiles(prev => {
      if (index < 0 || index >= prev.length) return prev;

      const newFiles = prev.filter((_, i) => i !== index);
      setActiveIndex(current => {
        if (newFiles.length === 0) return -1;
        if (current === index) return Math.min(index, newFiles.length - 1);
        if (current > index) return current - 1;
        if (current >= newFiles.length) return newFiles.length - 1;
        return current;
      });
      return newFiles;
    });
  }, []);

  return (
    <FilePanelContext.Provider value={{ openFiles, activeIndex, openPanel, closePanel, setActiveIndex }}>
      {children}
    </FilePanelContext.Provider>
  );
}

export function useGlobalFilePanel() {
  const ctx = useContext(FilePanelContext);
  if (!ctx) throw new Error('useGlobalFilePanel must be used within FilePanelProvider');
  return ctx;
}
