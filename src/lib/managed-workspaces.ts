export type RunLocation = 'local' | 'sandbox' | 'worktree';
export type ManagedWorkspace = {
  id: string;
  chatId: string;
  kind: 'sandbox' | 'worktree';
  path: string;
  sourcePath: string | null;
  branch: string | null;
  createdAt: number;
  expiresAt: number | null;
  status: 'ready' | 'expired' | 'removed' | 'creating' | 'failed';
};
export const DEFAULT_SCRATCH_RETENTION_DAYS = 7;
export function normalizeScratchRetention(value: unknown) {
  return Number.isFinite(Number(value)) && Number(value) >= 1
    ? Math.max(1, Math.min(365, Math.round(Number(value)))) : DEFAULT_SCRATCH_RETENTION_DAYS;
}

export async function requestWorkspace(body: Record<string, unknown>): Promise<ManagedWorkspace | null> {
  const response = await fetch('/api/workspaces', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not prepare this workspace.');
  return result.workspace;
}
