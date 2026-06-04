'use client';
import React, { createContext, useContext, useState, ReactNode, useCallback, useMemo } from 'react';
import type { FilePanelProps } from '../components/chat/file-panel';
import type { WorkspaceReviewSubagent } from '../components/chat/workspace-review-editor';

interface FilePanelStateContextType {
  openFiles: FilePanelProps[];
  reviewFiles: FilePanelProps[];
  reviewSubagents: WorkspaceReviewSubagent[];
  activeIndex: number;
}

interface FilePanelActionsContextType {
  openPanel: (props: FilePanelProps) => void;
  closePanel: (index: number) => void;
  clearPanels: () => void;
  setActiveIndex: (index: number) => void;
  setReviewFiles: (files: FilePanelProps[], chatId?: string | null) => void;
  setReviewSubagents: (subagents: WorkspaceReviewSubagent[], chatId?: string | null) => void;
  setActiveReviewChatId: (chatId: string | null) => void;
}

const FilePanelStateContext = createContext<FilePanelStateContextType | null>(null);
const FilePanelActionsContext = createContext<FilePanelActionsContextType | null>(null);
const FilePanelPresenceContext = createContext<boolean>(false);

function mergeDefinedPanelProps(current: FilePanelProps, next: FilePanelProps): FilePanelProps {
  const merged = { ...current };
  (Object.keys(next) as Array<keyof FilePanelProps>).forEach(key => {
    const value = next[key];
    if (value !== undefined) {
      (merged as any)[key] = value;
    }
  });
  return merged;
}

export function FilePanelProvider({ children }: { children: ReactNode }) {
  const [openFiles, setOpenFiles] = useState<FilePanelProps[]>([]);
  const [reviewFilesByChat, setReviewFilesByChat] = useState<Record<string, FilePanelProps[]>>({});
  const [reviewSubagentsByChat, setReviewSubagentsByChat] = useState<Record<string, WorkspaceReviewSubagent[]>>({});
  const [activeReviewChatId, setActiveReviewChatIdState] = useState<string>('__new__');
  const [activeIndex, setActiveIndex] = useState<number>(-1);

  const openPanel = useCallback((props: FilePanelProps) => {
    const nextProps: FilePanelProps = { ...props, activeTabMode: props.activeTabMode ?? 'code' };
    setOpenFiles(prev => {
      const existingIdx = prev.findIndex(f => f.filepath === nextProps.filepath);
      if (existingIdx !== -1) {
        setActiveIndex(existingIdx);
        const newFiles = [...prev];
        newFiles[existingIdx] = mergeDefinedPanelProps(newFiles[existingIdx], nextProps);
        return newFiles;
      }
      setActiveIndex(prev.length);
      return [...prev, nextProps];
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

  const clearPanels = useCallback(() => {
    setOpenFiles([]);
    setActiveIndex(-1);
  }, []);

  const setReviewFiles = useCallback((files: FilePanelProps[], chatId?: string | null) => {
    const key = chatId || '__new__';
    setReviewFilesByChat(prev => {
      if (files.length === 0) {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: files };
    });
  }, []);

  const setReviewSubagents = useCallback((subagents: WorkspaceReviewSubagent[], chatId?: string | null) => {
    const key = chatId || '__new__';
    setReviewSubagentsByChat(prev => {
      if (subagents.length === 0) {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: subagents };
    });
  }, []);

  const setActiveReviewChatId = useCallback((chatId: string | null) => {
    setActiveReviewChatIdState(chatId || '__new__');
  }, []);

  const reviewFiles = reviewFilesByChat[activeReviewChatId] || [];
  const reviewSubagents = reviewSubagentsByChat[activeReviewChatId] || [];
  const stateValue = useMemo(() => ({ openFiles, reviewFiles, reviewSubagents, activeIndex }), [openFiles, reviewFiles, reviewSubagents, activeIndex]);
  const actionsValue = useMemo(
    () => ({ openPanel, closePanel, clearPanels, setActiveIndex, setReviewFiles, setReviewSubagents, setActiveReviewChatId }),
    [openPanel, closePanel, clearPanels, setReviewFiles, setReviewSubagents, setActiveReviewChatId]
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
