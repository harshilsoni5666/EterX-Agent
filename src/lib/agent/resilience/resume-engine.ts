/**
 * Conversation-scoped resume evidence for the legacy context path.
 * The modern Context Fabric owns durable objectives and exact transcript pages.
 */
import path from 'path';
import { isContinuationControlMessage } from '../continuation-control';
import { detectChatBoundary } from '../chat-boundary';
import type { LifetimeEvent } from '../memory/lifetime';

export interface ResumeBriefOptions {
  chatId: string;
  /** Optional provenance when records came from a serialized session. */
  sessionChatId?: string;
  currentMessage: string;
  lastUserMessageInSession?: string;
  sessionFileRecords?: Array<{ filename: string; action: string; purpose: string; timestamp: number }>;
  sessionActionSummary?: string[];
  sessionTaskPlan?: Array<{ name: string; status: string; description?: string }>;
}

export interface ResumeBriefResult {
  brief: string;
  isContaminated: boolean;
  hasPendingDeliverable: boolean;
  alreadyDoneFiles: string[];
  nextLogicalStep: string;
}

export async function buildResumeBrief(opts: ResumeBriefOptions): Promise<ResumeBriefResult> {
  const { sessionFileRecords = [], sessionActionSummary = [], sessionTaskPlan = [] } = opts;
  const foreignSession = Boolean(opts.sessionChatId && opts.sessionChatId !== opts.chatId);
  const boundary = detectChatBoundary({
    newMessage: opts.currentMessage,
    lastUserMessage: opts.lastUserMessageInSession || '',
    lastAgentOutput: sessionActionSummary.slice(-3).join('\n'),
    activeTaskPlan: sessionTaskPlan,
    recentToolNames: [],
    recentFileNames: sessionFileRecords.slice(-12).map(record => record.filename),
    pendingAskUser: false,
  });
  if (foreignSession || boundary.shouldResetSession) {
    return { brief: '', isContaminated: true, hasPendingDeliverable: false, alreadyDoneFiles: [], nextLogicalStep: '' };
  }

  // File creation proves neither execution of a helper nor completion of an
  // artifact. Use recorded operations, preserve full paths, and never scan
  // unrelated Desktop files to infer what this conversation accomplished.
  const latestByPath = new Map<string, (typeof sessionFileRecords)[number]>();
  for (const record of [...sessionFileRecords].sort((a, b) => a.timestamp - b.timestamp)) {
    if (!record.filename) continue;
    const key = process.platform === 'win32' ? record.filename.toLowerCase() : record.filename;
    latestByPath.delete(key);
    latestByPath.set(key, record);
  }
  const alreadyDoneFiles = [...latestByPath.values()].slice(-12).map(record =>
    JSON.stringify({ path: record.filename, operation: record.action, purpose: String(record.purpose || '').slice(0, 180) })
  );
  const pending = sessionTaskPlan.filter(step => ['pending', 'in_progress', 'blocked', 'failed'].includes(step.status));
  const hasPendingDeliverable = pending.some(step => /\b(deliver|export|publish|produce|artifact)\b/i.test(step.name));
  const nextLogicalStep = pending.length
    ? `Resume the recorded unfinished outcome: ${pending[0].name}. ${pending[0].description || ''}`
    : 'Continue the active objective from the latest confirmed result and current user guidance; completion has not been inferred from filenames.';
  const parts = [
    '[SESSION CONTINUITY]',
    'Historical records from this chat; preserve user constraints and distinguish attempted work from confirmed results.',
    opts.lastUserMessageInSession
      ? `Previous user message: ${opts.lastUserMessageInSession.slice(0, 1200)}` : '',
    alreadyDoneFiles.length ? `Recorded file operations:\n${alreadyDoneFiles.join('\n')}` : '',
    sessionActionSummary.length ? `Recent recorded actions:\n${sessionActionSummary.slice(-6).join('\n')}` : '',
    pending.length ? `Unfinished plan outcomes:\n${pending.slice(0, 8).map(step => JSON.stringify(step)).join('\n')}` : '',
    nextLogicalStep,
    'Reuse applicable evidence. Read a target again only when its state or omitted detail matters. A helper file is not proof it ran; a final answer is not proof an external action completed.',
    '[END SESSION CONTINUITY]',
  ];
  return { brief: parts.filter(Boolean).join('\n'), isContaminated: false, hasPendingDeliverable, alreadyDoneFiles, nextLogicalStep };
}

export function isPureContinuationMessage(message: string): boolean {
  return isContinuationControlMessage(message);
}

/** Historical identities only; these do not authorize skipping a new mutation. */
export function buildDoneToolSignatures(events: LifetimeEvent[]): Set<string> {
  const signatures = new Set<string>();
  for (const event of events) {
    if (event.metadata?.success === false) continue;
    const filename = String(event.metadata?.filename || '');
    if (filename && (event.type === 'file_write' || event.type === 'file_edit')) {
      const normalized = path.normalize(filename);
      signatures.add(`write:${process.platform === 'win32' ? normalized.toLowerCase() : normalized}`);
    }
    const command = String(event.metadata?.command || '').trim();
    if (event.type === 'terminal_cmd' && command) signatures.add(`cmd:${command}`);
  }
  return signatures;
}
