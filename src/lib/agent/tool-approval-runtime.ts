import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ChatPermissionMode, PendingToolApproval, ToolApprovalDecision } from '../chat-permissions';
import { terminalInvocationText } from './terminal-result-trace';
import { getToolDisplayLabel } from './tool-trace';
import { getRuntimeWorkspaceRoot, resolveWorkspaceDirectoryForContext, resolveWorkspacePathForContext } from './workspace/path_resolver';

type RunScope = {
  mode: ChatPermissionMode;
  chatId: string;
  sessionId: string;
  signal?: AbortSignal;
};

type ApprovalScope = RunScope & { decisions: Map<string, 'approve-session' | 'reject'> };
type Outcome = ToolApprovalDecision | 'expired' | 'cancelled';
type BlockedTool = { error: string; success: false; executed: false; cancelled?: true };
type Ticket = {
  view: PendingToolApproval;
  scope: ApprovalScope;
  signature: string;
  finish: (outcome: Outcome) => void;
};
type Receipt = { chatId: string; sessionId: string; decision: ToolApprovalDecision };

const globals = globalThis as typeof globalThis & {
  __eterxToolApprovals?: {
    scope: AsyncLocalStorage<ApprovalScope | undefined>;
    pending: Map<string, Ticket>;
    receipts: Map<string, Receipt>;
    modes?: Map<string, ChatPermissionMode>;
  };
};
const { scope, pending, receipts } = globals.__eterxToolApprovals ??= {
  scope: new AsyncLocalStorage(), pending: new Map(), receipts: new Map(),
};
const liveModes = globals.__eterxToolApprovals.modes ??= new Map();
const modeScopeKey = (sessionId: string, chatId: string) => JSON.stringify([sessionId, chatId]);

export function setRuntimeChatPermissionMode(chatId: string, sessionId: string, mode: ChatPermissionMode) {
  liveModes.set(modeScopeKey(sessionId, chatId), mode);
}

const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const RECEIPT_TTL_MS = 60_000;
const INTERNAL_TOOLS = new Set([
  'ask_user', 'context_memory', 'get_skill_guidelines', 'task_decomposer', 'task_checkpoint',
  'spawn_sub_agent', 'agent_communicate', 'wait_timer',
]);
const TERMINAL_READ_MODES = new Set(['list', 'check', 'wait']);

export function runWithToolApprovals<T>(run: RunScope, execute: () => T): T {
  // Full-access runs still need a scope so later tool calls can pick up changes.
  return scope.run({ ...run, decisions: new Map() }, execute);
}

function isOrdinaryWorkspaceEdit(args: Record<string, any>, context: any, workspace: string): boolean {
  const edits = Array.isArray(args.files) && args.files.length ? args.files : [args];
  if (args.delete === true || !edits.every(edit => edit && edit.delete !== true)) return false;

  try {
    const root = realpathSync(workspace);
    return edits.every(edit => {
      const filename = String(edit.filename || (edits.length === 1 ? args.filename : '') || '').trim();
      if (!filename) return false;
      const target = resolveWorkspacePathForContext(filename, context);
      const parent = realpathSync(path.dirname(target));
      const resolved = path.join(parent, path.basename(target));
      const relative = path.relative(root, resolved);
      if (!relative || path.isAbsolute(relative)) return false;
      // Hidden files, device/stream paths, and common credential files need review.
      if (relative.split(path.sep).some(part => part.startsWith('.') || /[:\u0000-\u001f]/.test(part) ||
        /^(?:credentials?|secrets?|passwd|id_(?:rsa|ed25519))(?:\.|$)|\.(?:pem|key|pfx|p12)$/i.test(part) ||
        (process.platform === 'win32' && /[. ]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) return false;
      const stat = lstatSync(resolved, { throwIfNoEntry: false });
      return !stat || (stat.isFile() && stat.nlink === 1);
    });
  } catch {
    return false;
  }
}

function workspaceFor(context: any): string {
  try { return getRuntimeWorkspaceRoot(context); } catch { return String(context?.workspacePath || ''); }
}

function approvalPreview(tool: string, args: Record<string, any>, context: any): string {
  if (tool !== 'workspace_run_command') {
    return JSON.stringify(args, (key, value) => (
      /^(?:authorization|password|api[_-]?key|access[_-]?token|client[_-]?secret|token|secret)$/i.test(key) ? '[redacted]' : value
    ), 2);
  }

  const commands = Array.isArray(args.commands) ? args.commands : [args];
  return commands.map(command => {
    let cwd = String(command.cwd || args.cwd || '');
    try { cwd = resolveWorkspaceDirectoryForContext(cwd, context); } catch { /* Show the submitted location. */ }
    const shell = command.program ? '' : command.shell || args.shell || context?.terminalShell;
    const env = Object.keys({ ...args.env, ...command.env });
    return [
      terminalInvocationText(command),
      cwd && `Working directory: ${cwd}`,
      shell && shell !== 'auto' && `Shell: ${shell}`,
      env.length > 0 && `Environment overrides: ${env.join(', ')}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

function invocationSignature(tool: string, args: Record<string, any>, context: any, workspace: string): string {
  const invocation = JSON.stringify([tool, workspace, context?.terminalShell, context?.agentId, context?.subAgentId, args], (_, value) => (
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
      : value
  ));
  return createHash('sha256').update(invocation).digest('hex');
}

function blocked(outcome: 'expired' | 'cancelled' | 'reject' | 'unavailable'): BlockedTool {
  switch (outcome) {
    case 'cancelled':
      return { success: false, executed: false, cancelled: true, error: 'CANCELLED_BY_USER' };
    case 'expired':
      return { success: false, executed: false, error: 'Approval expired. Continue with independent work and wait for a new user instruction before retrying this action.' };
    case 'reject':
      return { success: false, executed: false, error: 'The user rejected this action. Do not retry or work around it. Continue with other authorized work.' };
    case 'unavailable':
      return { success: false, executed: false, error: 'This action requires approval from an active EterX chat.' };
  }
}

/** Return a blocking result before a tool or its argument-dependent preparation runs. */
export async function requestToolApproval(tool: string, args: Record<string, any>, context: any): Promise<BlockedTool | null> {
  const run = scope.getStore();
  if (!run || INTERNAL_TOOLS.has(tool) || (tool === 'workspace_run_command' && TERMINAL_READ_MODES.has(args.mode))) return null;
  // Snapshot the policy for this invocation, never for the whole run. An
  // invocation already executing or waiting for approval keeps its decision.
  const mode = liveModes.get(modeScopeKey(run.sessionId, run.chatId)) ?? run.mode;
  if (mode === 'full') return null;
  if (!run.sessionId) return blocked('unavailable');

  const signals = [run.signal, context?.abortSignal, context?.signal].filter((signal): signal is AbortSignal => Boolean(signal));
  const signal = AbortSignal.any(signals);
  if (signal.aborted || context?.isCancelled?.()) return blocked('cancelled');

  const workspace = workspaceFor(context);
  if (mode === 'review' && (
    (tool === 'web_search' && (!args.action || args.action === 'search')) ||
    (tool === 'workspace_edit_file' && isOrdinaryWorkspaceEdit(args, context, workspace))
  )) return null;

  const signature = invocationSignature(tool, args, context, workspace);
  const prior = run.decisions.get(signature);
  if (prior) return prior === 'reject' ? blocked('reject') : null;

  const view = {
    id: randomUUID(), tool,
    label: tool === 'workspace_run_command' ? 'Shell' : getToolDisplayLabel(tool),
    agent: context?.subAgentId ? String(context.agentName || context.subAgentName || 'Subagent') : '',
    workspace,
    preview: approvalPreview(tool, args, context),
  };
  const outcome = await new Promise<Outcome>(resolve => {
    const finish = (decision: Outcome) => {
      if (!pending.delete(view.id)) return;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(decision);
    };
    const onAbort = () => finish('cancelled');
    const timer = setTimeout(() => finish('expired'), APPROVAL_TIMEOUT_MS);
    timer.unref?.();
    pending.set(view.id, { view, scope: run, signature, finish });
    signal.addEventListener('abort', onAbort, { once: true });
  });
  if (signal.aborted || context?.isCancelled?.()) return blocked('cancelled');
  if (outcome === 'expired') run.decisions.set(signature, 'reject');
  return outcome === 'approve-once' || outcome === 'approve-session' ? null : blocked(outcome);
}

export function listPendingToolApprovals(chatId: string, sessionId: string): PendingToolApproval[] {
  return Array.from(pending.values())
    .filter(ticket => ticket.scope.chatId === chatId && ticket.scope.sessionId === sessionId)
    .map(ticket => ticket.view);
}

export function decideToolApproval(chatId: string, sessionId: string, id: string, decision: ToolApprovalDecision): 'accepted' | 'missing' | 'conflict' {
  const ticket = pending.get(id);
  if (!ticket) {
    const receipt = receipts.get(id);
    if (receipt?.chatId !== chatId || receipt.sessionId !== sessionId) return 'missing';
    return receipt.decision === decision ? 'accepted' : 'conflict';
  }
  if (ticket.scope.chatId !== chatId || ticket.scope.sessionId !== sessionId) return 'missing';

  receipts.set(id, { chatId, sessionId, decision });
  setTimeout(() => receipts.delete(id), RECEIPT_TTL_MS).unref?.();
  if (decision === 'approve-once') {
    ticket.finish(decision);
  } else {
    ticket.scope.decisions.set(ticket.signature, decision);
    for (const candidate of pending.values()) {
      if (candidate.scope === ticket.scope && candidate.signature === ticket.signature) candidate.finish(decision);
    }
  }
  return 'accepted';
}
