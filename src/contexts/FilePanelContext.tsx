'use client';
import React, { createContext, useContext, useState, ReactNode, useCallback, useMemo } from 'react';
import type { FilePanelProps } from '../components/chat/file-panel';

interface FilePanelStateContextType {
  openFiles: FilePanelProps[];
  activeIndex: number;
}

interface FilePanelActionsContextType {
  openPanel: (props: FilePanelProps) => void;
  closePanel: (index: number) => void;
  setActiveIndex: (index: number) => void;
}

const FilePanelStateContext = createContext<FilePanelStateContextType | null>(null);
const FilePanelActionsContext = createContext<FilePanelActionsContextType | null>(null);
const FilePanelPresenceContext = createContext<boolean>(false);

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

  const stateValue = useMemo(() => ({ openFiles, activeIndex }), [openFiles, activeIndex]);
  const actionsValue = useMemo(
    () => ({ openPanel, closePanel, setActiveIndex }),
    [openPanel, closePanel]
  );
  const hasOpenFiles = openFiles.length > 0;

  return (
    <FilePanelActionsContext.Provider value={actionsValue}>
      <FilePanelPresenceContext.Provider value={hasOpenFiles}>
        <FilePanelStateContext.Provider value={stateValue}>
          {children}
        </FilePanelStateContext.Provider>
      </FilePanelPresenceContext.Provider>
    </FilePanelActionsContext.Provider>
  );
}

export function useGlobalFilePanel() {
  const state = useContext(FilePanelStateContext);
  const actions = useContext(FilePanelActionsContext);
  if (!state || !actions) throw new Error('useGlobalFilePanel must be used within FilePanelProvider');
  return { ...state, ...actions };
}

export function useFilePanelActions() {
  const actions = useContext(FilePanelActionsContext);
  if (!actions) throw new Error('useFilePanelActions must be used within FilePanelProvider');
  return actions;
}

export function useHasOpenFiles() {
  return useContext(FilePanelPresenceContext);
}
