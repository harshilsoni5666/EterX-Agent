'use client';

import { createContext, useContext } from 'react';

// React context follows chat overlays even when they render into document.body.
export const WorkspacePaneVisibleContext = createContext(true);

export function useWorkspacePaneVisible() {
  return useContext(WorkspacePaneVisibleContext);
}
