import path from 'path';
import fs from 'fs-extra';
import { getEterxWorkspaceDir } from '../storage-paths';
import { stableScopeSegment } from '../context-scope';

/**
 * Inter-Agent Communication Protocol v1.0
 * 
 * Real-time mailbox system for agent-to-agent messaging.
 * Any agent (main or sub) can send messages to any other agent at any time.
 * 
 * Architecture:
 * - Each agent has a mailbox (in-memory + disk-backed)
 * - Messages are typed: info_share, question, answer, alert, coordination, discovery
 * - Agents check their mailbox during ReAct loop iterations
 * - Messages are scoped per-chat (projectId) to prevent cross-chat leakage
 * - Supports broadcast (to all agents) and direct (to specific agent)
 */

const MAILBOX_DIR = getEterxWorkspaceDir('agents', 'mailbox');

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type MessageType = 
  | 'info_share'     // Agent discovered something useful for others
  | 'question'       // Agent needs input from another agent
  | 'answer'         // Response to a question
  | 'alert'          // Urgent: error, blocker, or critical finding
  | 'coordination'   // Task coordination: "I'm handling X, you do Y"
  | 'discovery'      // Agent found something unexpected
  | 'progress'       // Status update on current work
  | 'handoff';       // Passing work or context to another agent

export interface AgentMessage {
  id: string;
  timestamp: number;
  from: string;           // Sender task-based agent name or 'Main'
  to: string;             // Recipient: agent name or '*' for broadcast
  projectId: string;      // Chat scope
  type: MessageType;
  subject: string;        // Short summary (max 100 chars)
  body: string;           // Full message content
  metadata?: {
    filePaths?: string[];   // Related files
    artifactPaths?: string[];
    toolName?: string;      // Tool that triggered this message
    priority?: 'low' | 'normal' | 'high' | 'critical';
    replyTo?: string;       // ID of message being replied to
    expiresAt?: number;     // Auto-expire timestamp
    deliverAfter?: number;  // Do not surface to agents before this timestamp
    requiresResponse?: boolean;
    confidence?: number;
    tags?: string[];
    deliveryMode?: 'interrupt' | 'defer' | 'silent';
    subAgentId?: string;
    subAgentChatId?: string;
    resultChars?: number;
    resultHash?: string;
    resultUsability?: 'pending' | 'usable' | 'empty' | 'failed' | 'cancelled';
    evidenceReady?: boolean;
    verificationStatus?: 'verified' | 'unverified' | 'unspecified';
    payloadTruncated?: boolean;
    recipientAgentId?: string;
    recipientSubAgentChatId?: string;
    broadcastRecipientRuns?: Array<{ agentName: string; agentId?: string; subAgentChatId?: string }>;
    broadcast?: boolean;
  };
  read: boolean;
  readAt?: number;
}

export interface MailboxSummary {
  agentName: string;
  unreadCount: number;
  totalCount: number;
  urgentUnreadCount?: number;
  deferredUnreadCount?: number;
  scheduledCount?: number;
  silentCount?: number;
  latestMessage?: {
    from: string;
    type: MessageType;
    subject: string;
    timestamp: number;
  };
}

export interface AgentPresence {
  agentName: string;
  agentId?: string;
  subAgentChatId?: string;
  role: 'main' | 'sub_agent' | 'unknown';
  status: string;
  task?: string;
  progress?: string;
  registeredAt: number;
  updatedAt: number;
}

// ═══════════════════════════════════════════════════════════════
// In-Memory Mailbox Store
// ═══════════════════════════════════════════════════════════════

class InterAgentMailbox {
  // Key: "projectId:agentName" → messages for that agent
  private mailboxes: Map<string, AgentMessage[]> = new Map();
  private presence: Map<string, Map<string, AgentPresence>> = new Map();
  private projectLogs: Map<string, AgentMessage[]> = new Map();
  // Listeners for real-time delivery
  private listeners: Map<string, Array<(msg: AgentMessage) => void>> = new Map();
  // Message counter for unique IDs
  private messageCounter = 0;

  private mailboxKey(projectId: string, agentName: string): string {
    return `${projectId}:${agentName.toLowerCase()}`;
  }

  private getMailbox(projectId: string, agentName: string): AgentMessage[] {
    const key = this.mailboxKey(projectId, agentName);
    if (!this.mailboxes.has(key)) {
      this.mailboxes.set(key, []);
    }
    return this.mailboxes.get(key)!;
  }

  private presenceKey(agentName: string): string {
    return agentName.toLowerCase();
  }

  private getPresenceMap(projectId: string): Map<string, AgentPresence> {
    if (!this.presence.has(projectId)) {
      this.presence.set(projectId, new Map());
    }
    return this.presence.get(projectId)!;
  }

  private getRegisteredRecipients(projectId: string, sender: string): string[] {
    const senderKey = this.presenceKey(sender);
    const recipients = new Map<string, string>();
    const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'closed', 'error', 'stopped']);

    for (const presence of this.getPresenceMap(projectId).values()) {
      const key = this.presenceKey(presence.agentName);
      const isAvailable = presence.role === 'main' || !terminalStatuses.has(String(presence.status || '').toLowerCase());
      if (key !== senderKey && isAvailable) recipients.set(key, presence.agentName);
    }

    return Array.from(recipients.values());
  }

  private appendProjectLog(message: AgentMessage): void {
    const log = this.projectLogs.get(message.projectId) || [];
    log.push({ ...message });
    if (log.length > 1000) {
      log.splice(0, log.length - 1000);
    }
    this.projectLogs.set(message.projectId, log);
  }

  private isVisibleToAgent(message: AgentMessage, agentName: string): boolean {
    const normalized = this.presenceKey(agentName);
    return this.presenceKey(message.from) === normalized ||
      this.presenceKey(message.to) === normalized ||
      message.to === '*';
  }

  private isInterruptingMessage(message: AgentMessage): boolean {
    const priority = message.metadata?.priority || 'normal';
    return message.metadata?.deliveryMode === 'interrupt' ||
      message.metadata?.requiresResponse === true ||
      priority === 'critical';
  }

  private isDeliverable(message: AgentMessage, now = Date.now()): boolean {
    return (!message.metadata?.expiresAt || message.metadata.expiresAt > now) &&
      (!message.metadata?.deliverAfter || message.metadata.deliverAfter <= now);
  }

  getProjectMessages(projectId: string, opts?: {
    agentName?: string;
    type?: MessageType;
    from?: string;
    to?: string;
    limit?: number;
  }): AgentMessage[] {
    const now = Date.now();
    let messages = [...(this.projectLogs.get(projectId) || [])]
      .filter(message => this.isDeliverable(message, now));

    if (opts?.agentName) {
      messages = messages.filter(message => this.isVisibleToAgent(message, opts.agentName!));
    }
    if (opts?.type) {
      messages = messages.filter(message => message.type === opts.type);
    }
    if (opts?.from) {
      messages = messages.filter(message => this.presenceKey(message.from) === this.presenceKey(opts.from!));
    }
    if (opts?.to) {
      messages = messages.filter(message => message.to === '*' || this.presenceKey(message.to) === this.presenceKey(opts.to!));
    }
    if (opts?.limit) {
      messages = messages.slice(-opts.limit);
    }

    return messages;
  }

  getThread(projectId: string, messageId: string): AgentMessage[] {
    const messages = this.getProjectMessages(projectId, { limit: 1000 });
    const byId = new Map(messages.map(message => [message.id, message]));
    const threadIds = new Set<string>();

    let cursor: AgentMessage | undefined = byId.get(messageId);
    while (cursor) {
      threadIds.add(cursor.id);
      const parentId = cursor.metadata?.replyTo;
      cursor = parentId ? byId.get(parentId) : undefined;
    }
    if (threadIds.size === 0) threadIds.add(messageId);

    let changed = true;
    while (changed) {
      changed = false;
      for (const message of messages) {
        const parentId = message.metadata?.replyTo;
        if (parentId && threadIds.has(parentId) && !threadIds.has(message.id)) {
          threadIds.add(message.id);
          changed = true;
        }
      }
    }

    return messages.filter(message => threadIds.has(message.id));
  }

  getInterruptingMessages(projectId: string, agentName: string, limit = 3, agentId?: string): AgentMessage[] {
    return this.checkMailbox(projectId, agentName, { unreadOnly: true, limit: Math.max(limit * 4, limit), agentId })
      .filter(message => this.isInterruptingMessage(message))
      .slice(-limit);
  }

  getDeferredMessages(projectId: string, agentName: string, limit = 5, agentId?: string): AgentMessage[] {
    return this.checkMailbox(projectId, agentName, { unreadOnly: true, limit: Math.max(limit * 6, 20), agentId })
      .filter(message => !this.isInterruptingMessage(message))
      .filter(message => message.metadata?.deliveryMode !== 'silent')
      .slice(-limit);
  }

  /**
   * Send a message from one agent to another (or broadcast to all).
   * Returns immediately — message is queued in recipient's mailbox.
   */
  send(message: Omit<AgentMessage, 'id' | 'timestamp' | 'read'>): AgentMessage {
    const broadcastRecipients = message.to === '*'
      ? this.getRegisteredRecipients(message.projectId, message.from)
      : [];
    const directRecipient = message.to === '*'
      ? undefined
      : this.getPresenceMap(message.projectId).get(this.presenceKey(message.to));
    const fullMessage: AgentMessage = {
      ...message,
      metadata: {
        ...message.metadata,
        recipientAgentId: message.metadata?.recipientAgentId || directRecipient?.agentId,
        recipientSubAgentChatId: message.metadata?.recipientSubAgentChatId || directRecipient?.subAgentChatId,
        broadcastRecipientRuns: message.metadata?.broadcastRecipientRuns || (message.to === '*'
          ? broadcastRecipients.map(agentName => {
              const presence = this.getPresenceMap(message.projectId).get(this.presenceKey(agentName));
              return { agentName, agentId: presence?.agentId, subAgentChatId: presence?.subAgentChatId };
            })
          : undefined),
        broadcast: message.metadata?.broadcast === true || message.to === '*',
      },
      id: `msg_${Date.now()}_${++this.messageCounter}`,
      timestamp: Date.now(),
      read: false,
    };
    this.appendProjectLog(fullMessage);

    if (message.to === '*') {
      // Broadcast to every registered teammate, including planned agents
      // that have not emitted their first trace yet.
      for (const recipient of broadcastRecipients) {
        const recipientPresence = this.getPresenceMap(message.projectId).get(this.presenceKey(recipient));
        const deliveredMessage = {
          ...fullMessage,
          to: recipient,
          metadata: {
            ...fullMessage.metadata,
            recipientAgentId: recipientPresence?.agentId,
            recipientSubAgentChatId: recipientPresence?.subAgentChatId,
          },
        };
        const inbox = this.getMailbox(message.projectId, recipient);
        inbox.push(deliveredMessage);
        this.capMailbox(inbox);

        const key = this.mailboxKey(message.projectId, recipient);
        if (this.isDeliverable(deliveredMessage)) {
          const listeners = this.listeners.get(key) || [];
          listeners.forEach(cb => { try { cb(deliveredMessage); } catch {} });
        }
      }
    } else {
      // Direct message
      const deliveredMessage = { ...fullMessage };
      const inbox = this.getMailbox(message.projectId, message.to);
      inbox.push(deliveredMessage);
      this.capMailbox(inbox);

      // Notify listeners
      const key = this.mailboxKey(message.projectId, message.to);
      if (this.isDeliverable(deliveredMessage)) {
        const listeners = this.listeners.get(key) || [];
        listeners.forEach(cb => { try { cb(deliveredMessage); } catch {} });
      }
    }

    // Best-effort disk persistence
    this.persistMessage(fullMessage).catch(() => {});

    console.log(`[InterAgent] 📨 ${message.from} → ${message.to}: [${message.type}] ${message.subject}`);
    return fullMessage;
  }

  /**
   * Check mailbox for unread messages. Non-destructive — messages stay until marked read.
   */
  checkMailbox(projectId: string, agentName: string, opts?: {
    unreadOnly?: boolean;
    type?: MessageType;
    from?: string;
    limit?: number;
    agentId?: string;
  }): AgentMessage[] {
    const inbox = this.getMailbox(projectId, agentName);
    let messages = [...inbox];

    if (opts?.unreadOnly !== false) {
      messages = messages.filter(m => !m.read);
    }
    if (opts?.type) {
      messages = messages.filter(m => m.type === opts.type);
    }
    if (opts?.from) {
      messages = messages.filter(m => m.from.toLowerCase() === opts.from!.toLowerCase());
    }
    if (opts?.agentId) {
      messages = messages.filter(message => message.metadata?.recipientAgentId === opts.agentId);
    }

    // Hide expired or not-yet-deliverable messages from active mailboxes.
    const now = Date.now();
    messages = messages.filter(m => this.isDeliverable(m, now));
    messages = messages.filter(m => m.metadata?.deliveryMode !== 'silent');

    if (opts?.limit) {
      messages = messages.slice(-opts.limit);
    }

    return messages;
  }

  /**
   * Mark messages as read.
   */
  markRead(projectId: string, agentName: string, messageIds?: string[]): number {
    const inbox = this.getMailbox(projectId, agentName);
    let count = 0;
    for (const msg of inbox) {
      if (!msg.read && (!messageIds || messageIds.includes(msg.id))) {
        msg.read = true;
        msg.readAt = Date.now();
        count++;
      }
    }
    return count;
  }

  /**
   * Get a summary of all agent mailboxes for a project.
   */
  getMailboxSummaries(projectId: string): MailboxSummary[] {
    const summaries: MailboxSummary[] = [];
    const prefix = `${projectId}:`;
    const now = Date.now();

    for (const [key, inbox] of this.mailboxes.entries()) {
      if (!key.startsWith(prefix)) continue;
      const mailboxAgentKey = key.substring(prefix.length);
      const agentName = this.getPresenceMap(projectId).get(this.presenceKey(mailboxAgentKey))?.agentName || mailboxAgentKey;
      const deliverable = inbox.filter(m => this.isDeliverable(m, now) && m.metadata?.deliveryMode !== 'silent');
      const unread = deliverable.filter(m => !m.read);
      const latest = deliverable[deliverable.length - 1];
      const scheduled = inbox.filter(m => !m.read &&
        !!m.metadata?.deliverAfter &&
        m.metadata.deliverAfter > now &&
        (!m.metadata?.expiresAt || m.metadata.expiresAt > now));
      const silent = inbox.filter(m => !m.read && this.isDeliverable(m, now) && m.metadata?.deliveryMode === 'silent');
      summaries.push({
        agentName,
        unreadCount: unread.length,
        totalCount: inbox.length,
        urgentUnreadCount: unread.filter(m => this.isInterruptingMessage(m)).length,
        deferredUnreadCount: unread.filter(m => !this.isInterruptingMessage(m)).length,
        scheduledCount: scheduled.length,
        silentCount: silent.length,
        latestMessage: latest ? {
          from: latest.from,
          type: latest.type,
          subject: latest.subject,
          timestamp: latest.timestamp,
        } : undefined,
      });
    }
    return summaries;
  }

  /**
   * Register an agent so it has a mailbox (call when spawning).
   */
  registerAgent(projectId: string, agentName: string, details?: {
    agentId?: string;
    subAgentChatId?: string;
    role?: AgentPresence['role'];
    task?: string;
    status?: string;
    progress?: string;
  }): void {
    this.getMailbox(projectId, agentName);
    const now = Date.now();
    const team = this.getPresenceMap(projectId);
    const key = this.presenceKey(agentName);
    const existing = team.get(key);
    const isNewRun = Boolean(details?.agentId && existing?.agentId && details.agentId !== existing.agentId);
    if (isNewRun) {
      // A task name may be reused after completion, but unread instructions
      // from the old run must never leak into the new worker's mailbox.
      this.mailboxes.set(this.mailboxKey(projectId, agentName), []);
    }
    team.set(key, {
      agentName,
      agentId: details?.agentId ?? existing?.agentId,
      subAgentChatId: details?.subAgentChatId ?? existing?.subAgentChatId,
      role: details?.role || existing?.role || (agentName.toLowerCase() === 'main' ? 'main' : 'sub_agent'),
      status: details?.status || existing?.status || 'registered',
      task: details?.task ?? existing?.task,
      progress: details?.progress ?? existing?.progress,
      registeredAt: isNewRun ? now : existing?.registeredAt || now,
      updatedAt: now,
    });
  }

  updateAgentPresence(projectId: string, agentName: string, update: Partial<Omit<AgentPresence, 'agentName' | 'registeredAt' | 'updatedAt'>>): void {
    const now = Date.now();
    const team = this.getPresenceMap(projectId);
    const key = this.presenceKey(agentName);
    const existing = team.get(key) || {
      agentName,
      role: agentName.toLowerCase() === 'main' ? 'main' as const : 'sub_agent' as const,
      status: 'registered',
      registeredAt: now,
      updatedAt: now,
    };

    team.set(key, {
      ...existing,
      ...update,
      agentName: existing.agentName || agentName,
      registeredAt: existing.registeredAt,
      updatedAt: now,
    });
  }

  getTeamSnapshot(projectId: string): AgentPresence[] {
    return Array.from(this.getPresenceMap(projectId).values()).sort((a, b) => {
      if (a.role !== b.role) return a.role === 'main' ? -1 : 1;
      return a.registeredAt - b.registeredAt || a.agentName.localeCompare(b.agentName);
    });
  }

  /**
   * Subscribe to real-time message delivery.
   * Returns unsubscribe function.
   */
  subscribe(projectId: string, agentName: string, callback: (msg: AgentMessage) => void): () => void {
    const key = this.mailboxKey(projectId, agentName);
    if (!this.listeners.has(key)) {
      this.listeners.set(key, []);
    }
    this.listeners.get(key)!.push(callback);

    return () => {
      const list = this.listeners.get(key);
      if (list) {
        const idx = list.indexOf(callback);
        if (idx >= 0) list.splice(idx, 1);
      }
    };
  }

  /**
   * Build a compact context string for injection into agent prompts.
   * Shows unread messages in a format the LLM can easily parse.
   */
  buildMailboxContext(projectId: string, agentName: string): string {
    const unread = this.checkMailbox(projectId, agentName, { unreadOnly: true, limit: 10 });
    if (unread.length === 0) return '';

    const lines = unread.map(m => {
      const priority = m.metadata?.priority === 'critical' ? '🔴' :
                       m.metadata?.priority === 'high' ? '🟠' : '📩';
      const age = Math.round((Date.now() - m.timestamp) / 1000);
      const ageStr = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;
      return `${priority} FROM ${m.from} (${ageStr}) [${m.type}]: ${m.subject}\n   ${m.body.substring(0, 200)}`;
    });

    return `\n━━━ MESSAGES FROM OTHER AGENTS (${unread.length} unread) ━━━\n${lines.join('\n\n')}\n━━━ END MESSAGES ━━━\n`;
  }

  /**
   * Clear all mailboxes for a project.
   */
  async clearProject(projectId: string): Promise<void> {
    const prefix = `${projectId}:`;
    for (const key of [...this.mailboxes.keys()]) {
      if (key.startsWith(prefix)) this.mailboxes.delete(key);
    }
    for (const key of [...this.listeners.keys()]) {
      if (key.startsWith(prefix)) this.listeners.delete(key);
    }
    this.presence.delete(projectId);
    this.projectLogs.delete(projectId);

    try {
      const safeProject = stableScopeSegment(projectId, 32);
      await fs.remove(path.join(MAILBOX_DIR, `${safeProject}_messages.jsonl`));
    } catch { /* persisted mailbox cleanup is best-effort */ }
  }

  getAgentPresence(projectId: string, agentName: string): AgentPresence | undefined {
    return this.getPresenceMap(projectId).get(this.presenceKey(agentName));
  }

  // Cap mailbox at 200 messages to prevent memory bloat
  private capMailbox(inbox: AgentMessage[]): void {
    if (inbox.length > 200) {
      inbox.splice(0, inbox.length - 200);
    }
  }

  // Best-effort disk persistence for crash recovery
  private async persistMessage(message: AgentMessage): Promise<void> {
    try {
      await fs.ensureDir(MAILBOX_DIR);
      const safeProject = stableScopeSegment(message.projectId, 32);
      const logFile = path.join(MAILBOX_DIR, `${safeProject}_messages.jsonl`);
      await fs.appendFile(logFile, JSON.stringify(message) + '\n');
    } catch { /* persistence is best-effort */ }
  }
}

// ═══════════════════════════════════════════════════════════════
// Singleton Export
// ═══════════════════════════════════════════════════════════════

export const interAgentMailbox = new InterAgentMailbox();
