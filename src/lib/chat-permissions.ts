export type ChatPermissionMode = 'ask' | 'review' | 'full';

export function normalizeChatPermissionMode(value: unknown): ChatPermissionMode {
  return value === 'ask' || value === 'review' ? value : 'full';
}

export function isChatPermissionMode(value: unknown): value is ChatPermissionMode {
  return value === 'ask' || value === 'review' || value === 'full';
}

export type ToolApprovalDecision = 'approve-once' | 'approve-session' | 'reject';

export function isToolApprovalDecision(value: unknown): value is ToolApprovalDecision {
  return value === 'approve-once' || value === 'approve-session' || value === 'reject';
}

export interface PendingToolApproval {
  id: string;
  tool: string;
  label: string;
  agent: string;
  workspace: string;
  preview: string;
}
