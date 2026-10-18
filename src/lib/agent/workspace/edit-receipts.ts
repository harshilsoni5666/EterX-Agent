import { createHash } from 'crypto';

type Receipt = { signature: string; paths: string[] };
// No source contents or credentials are retained here. A receipt protects a
// replayed invocation, not a merely similar edit requested in a later turn.
const completedEdits = new Map<string, Receipt>();
const MAX_RECEIPTS = 512;

export function editInvocationKey(context: any): string | undefined {
  const invocation = context?.workspaceEditInvocationId;
  const owner = context?.ownerChatId || context?.chatId || context?.projectId;
  const run = context?.runId;
  if (!invocation || !owner || !run) return undefined;
  // Parallel workers can receive the same provider call ID. Their receipts
  // must not turn another worker's edit into a replay or a payload conflict.
  const agent = context?.subAgentId || context?.agentId || context?.customAgentId || 'main';
  return JSON.stringify([owner, run, context?.turnId || '', agent, invocation]);
}

export function editRequestSignature(targets: unknown): string {
  return createHash('sha256').update(JSON.stringify(targets)).digest('hex');
}

export function completedEditReceipt(key: string | undefined, signature: string) {
  if (!key) return undefined;
  const receipt = completedEdits.get(key);
  if (!receipt) return undefined;
  if (receipt.signature !== signature) {
    throw new Error('This edit invocation already committed with different arguments. Do not reuse its invocation ID for another mutation; issue a new tool call with current target context.');
  }
  completedEdits.delete(key);
  completedEdits.set(key, receipt);
  return {
    success: true,
    replayed: true,
    committedPreviously: true,
    stateChanged: false,
    message: 'This exact edit invocation already completed. The replay changed nothing; later changes to its files are preserved. Read current context if further edits are needed.',
    previousTargets: receipt.paths,
    editsApplied: 0,
    additions: 0,
    deletions: 0,
    filesModified: [],
    filesCreated: [],
    filesDeleted: [],
    operation: 'none',
    changes: [],
    results: [],
    rolledBack: false,
  };
}

export function rememberCompletedEdit(key: string | undefined, signature: string, paths: string[]): void {
  if (!key) return;
  completedEdits.delete(key);
  completedEdits.set(key, { signature, paths });
  while (completedEdits.size > MAX_RECEIPTS) completedEdits.delete(completedEdits.keys().next().value!);
}
