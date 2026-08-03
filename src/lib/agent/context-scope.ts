import crypto from 'crypto';

/**
 * Stable, filesystem-safe identity for persisted agent state.
 *
 * Sanitizing alone is not enough: `chat:a` and `chat_a` would otherwise
 * address the same file. Keep a readable prefix for diagnostics and append a
 * digest so every logical chat/sub-agent has a unique storage namespace.
 */
export function stableScopeSegment(value: unknown, maxPrefixLength = 96): string {
  const raw = String(value ?? '').trim() || '_global';
  const prefix = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, Math.max(16, maxPrefixLength)) || '_global';
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `${prefix}-${digest}`;
}

/**
 * Memory/state identity for one agent conversation.
 * Operational `projectId` remains the parent chat for routing, cancellation,
 * workspace ownership, and inter-agent mail. Persisted conversation state can
 * be narrower (for example one spawned sub-agent thread).
 */
export interface AgentConversationScopeContext {
  projectId?: string;
  memoryScopeId?: string;
  conversationScopeId?: string;
}

export function getAgentConversationScope(context: AgentConversationScopeContext | null | undefined): string {
  const scoped = String(context?.memoryScopeId || context?.conversationScopeId || '').trim();
  return scoped || String(context?.projectId || 'agent');
}
