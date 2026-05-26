import path from 'path';
import fs from 'fs-extra';

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

const MAILBOX_DIR = path.resolve(process.cwd(), '.workspaces', 'agents', 'mailbox');

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
  from: string;           // Sender agent name (e.g., 'Dave', 'Main')
  to: string;             // Recipient: agent name or '*' for broadcast
  projectId: string;      // Chat scope
  type: MessageType;
  subject: string;        // Short summary (max 100 chars)
  body: string;           // Full message content
  metadata?: {
    filePaths?: string[];   // Related files
    toolName?: string;      // Tool that triggered this message
    priority?: 'low' | 'normal' | 'high' | 'critical';
    replyTo?: string;       // ID of message being replied to
    expiresAt?: number;     // Auto-expire timestamp
  };
  read: boolean;
  readAt?: number;
}

export interface MailboxSummary {
  agentName: string;
  unreadCount: number;
  totalCount: number;
  latestMessage?: {
    from: string;
    type: MessageType;
    subject: string;
    timestamp: number;
  };
}

// ═══════════════════════════════════════════════════════════════
// In-Memory Mailbox Store
// ═══════════════════════════════════════════════════════════════

class InterAgentMailbox {
  // Key: "projectId:agentName" → messages for that agent
  private mailboxes: Map<string, AgentMessage[]> = new Map();
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

  /**
   * Send a message from one agent to another (or broadcast to all).
   * Returns immediately — message is queued in recipient's mailbox.
   */
  send(message: Omit<AgentMessage, 'id' | 'timestamp' | 'read'>): AgentMessage {
    const fullMessage: AgentMessage = {
      ...message,
      id: `msg_${Date.now()}_${++this.messageCounter}`,
      timestamp: Date.now(),
      read: false,
    };

    if (message.to === '*') {
      // Broadcast: deliver to ALL mailboxes in this project
      for (const [key, box] of this.mailboxes.entries()) {
        if (key.startsWith(`${message.projectId}:`) && !key.endsWith(`:${message.from.toLowerCase()}`)) {
          box.push({ ...fullMessage });
          this.capMailbox(box);
        }
      }
      // Also notify listeners
      for (const [key, listeners] of this.listeners.entries()) {
        if (key.startsWith(`${message.projectId}:`) && !key.endsWith(`:${message.from.toLowerCase()}`)) {
          listeners.forEach(cb => { try { cb(fullMessage); } catch {} });
        }
      }
    } else {
      // Direct message
      const inbox = this.getMailbox(message.projectId, message.to);
      inbox.push(fullMessage);
      this.capMailbox(inbox);

      // Notify listeners
      const key = this.mailboxKey(message.projectId, message.to);
      const listeners = this.listeners.get(key) || [];
      listeners.forEach(cb => { try { cb(fullMessage); } catch {} });
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

    // Remove expired messages
    const now = Date.now();
    messages = messages.filter(m => !m.metadata?.expiresAt || m.metadata.expiresAt > now);

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

    for (const [key, inbox] of this.mailboxes.entries()) {
      if (!key.startsWith(prefix)) continue;
      const agentName = key.substring(prefix.length);
      const unread = inbox.filter(m => !m.read);
      const latest = inbox[inbox.length - 1];
      summaries.push({
        agentName,
        unreadCount: unread.length,
        totalCount: inbox.length,
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
  registerAgent(projectId: string, agentName: string): void {
    this.getMailbox(projectId, agentName);
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
  clearProject(projectId: string): void {
    const prefix = `${projectId}:`;
    for (const key of [...this.mailboxes.keys()]) {
      if (key.startsWith(prefix)) this.mailboxes.delete(key);
    }
    for (const key of [...this.listeners.keys()]) {
      if (key.startsWith(prefix)) this.listeners.delete(key);
    }
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
      const safeProject = message.projectId.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 32);
      const logFile = path.join(MAILBOX_DIR, `${safeProject}_messages.jsonl`);
      await fs.appendFile(logFile, JSON.stringify(message) + '\n');
    } catch { /* persistence is best-effort */ }
  }
}

// ═══════════════════════════════════════════════════════════════
// Singleton Export
// ═══════════════════════════════════════════════════════════════

export const interAgentMailbox = new InterAgentMailbox();
