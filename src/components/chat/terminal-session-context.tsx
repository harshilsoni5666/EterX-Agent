'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

const TerminalSessionContext = createContext({ chatId: '', workspaceOwner: '' });
export function TerminalSessionOwner({ chatId, workspaceOwner, children }: { chatId: string; workspaceOwner: string; children: ReactNode }) {
  const value = useMemo(() => ({ chatId, workspaceOwner }), [chatId, workspaceOwner]);
  return <TerminalSessionContext.Provider value={value}>{children}</TerminalSessionContext.Provider>;
}
export const useTerminalSessionOwner = () => useContext(TerminalSessionContext);
