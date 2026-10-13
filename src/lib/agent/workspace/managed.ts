import type { ManagedWorkspace } from '../../managed-workspaces';

export const managedWorkspaces = require('../../../../electron/managed-workspaces') as {
  create(options: { chatId: string; kind: 'sandbox' | 'worktree'; sourcePath?: string | null; days?: number }): Promise<ManagedWorkspace>;
  list(chatId?: string): ManagedWorkspace[];
  findByPath(path: string): ManagedWorkspace | null;
  update(id: string, action: string, days?: number): Promise<ManagedWorkspace>;
  acquireWorkspaceLease(path: string): (() => void) & { setProcess?: (pid?: number) => void };
  cleanupExpiredWorkspaces(): Promise<void>;
  startWorkspaceCleanup(): void;
  retentionDays(): number;
};
