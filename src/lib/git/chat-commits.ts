import { literalTerminalCommands, shellExecutableName } from '../agent/shell-command-shape';

export type ChatCommitReceipt = {
  hash: string;
  subject: string;
  branch?: string;
  committedAt: number;
};

/** Read Git's successful commit summaries. The caller supplies execution evidence. */
function readCommitSummaries(output: string, committedAt: number, limit: number): ChatCommitReceipt[] {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = text.matchAll(/^\[([^\]\r\n]+?) (?:\(root-commit\) )?([a-f0-9]{4,64})\][ \t]+([^\r\n]+)/gim);
  const results: ChatCommitReceipt[] = [];
  for (const match of lines) {
    results.push({
      hash: match[2].toLowerCase(),
      subject: match[3].trim().slice(0, 500),
      branch: match[1] === 'detached HEAD' ? undefined : match[1],
      committedAt,
    });
    if (results.length >= limit) break;
  }
  return results;
}

export function readCommitSummary(output: string, committedAt: number): ChatCommitReceipt | undefined {
  return readCommitSummaries(output, committedAt, 1)[0];
}

const isReceipt = (value: any): value is ChatCommitReceipt => Boolean(value &&
  typeof value.hash === 'string' && /^[a-f0-9]{4,64}$/i.test(value.hash) &&
  typeof value.subject === 'string' && (value.branch === undefined || typeof value.branch === 'string') &&
  Number.isFinite(value.committedAt));

export function mergeChatCommitReceipts(...sources: Array<ChatCommitReceipt[] | undefined>): ChatCommitReceipt[] {
  const commits = new Map<string, ChatCommitReceipt>();
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const receipt of source) {
      if (!isReceipt(receipt)) continue;
      const hash = receipt.hash.toLowerCase();
      const previous = commits.get(hash);
      if (!previous || receipt.committedAt >= previous.committedAt) commits.set(hash, receipt);
    }
  }
  return [...commits.values()].sort((a, b) => b.committedAt - a.committedAt);
}

function runsGitCommit(tokens: string[]): boolean {
  if (!tokens.length || shellExecutableName(tokens[0]) !== 'git') return false;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '-C' || token === '-c') {
      index++;
      continue;
    }
    if (token === '--no-pager' || token.startsWith('--git-dir=') || token.startsWith('--work-tree=')) continue;
    return token === 'commit';
  }
  return false;
}

const traceReceipts = new WeakMap<object, ChatCommitReceipt[]>();

function commitsFromTrace(log: any): ChatCommitReceipt[] {
  if (!log || typeof log !== 'object' || !['console_output', 'tool_result_preview'].includes(log.type) ||
    log.isLive || log.isStreaming || log.isDelta || log.streamState === 'open') return [];
  const cached = traceReceipts.get(log);
  if (cached) return cached;

  const result = log.result && typeof log.result === 'object' ? log.result : undefined;
  const exitCode = log.exitCode ?? result?.exitCode;
  const output = result?.stdout || log.stdout || log.output;
  let receipts: ChatCommitReceipt[] = [];
  if (exitCode === 0 && typeof output === 'string' && !result?.stillRunning && result?.success !== false &&
    !['failed', 'error', 'cancelled', 'stopped'].includes(log.status)) {
    const invocation = {
      program: log.program || result?.program || log.toolArgs?.program,
      args: log.args || result?.args || log.toolArgs?.args,
      command: log.command || result?.command || log.toolArgs?.command,
    };
    const commitCount = literalTerminalCommands(invocation)?.filter(runsGitCommit).length ?? 0;
    if (commitCount) receipts = readCommitSummaries(output, Number(log.endTime || log.timestamp) || 0, commitCount);
  }

  traceReceipts.set(log, receipts);
  return receipts;
}

const chatTraceReceipts = new WeakMap<any[], { chatId: string; commits: ChatCommitReceipt[] }>();

export function readChatCommitTraces(logs: any[], chatId: string): ChatCommitReceipt[] {
  if (!logs.length) return [];
  const cached = chatTraceReceipts.get(logs);
  if (cached?.chatId === chatId) return cached.commits;
  const commits: ChatCommitReceipt[] = [];
  for (const log of logs) {
    if (log?.ownerChatId && log.ownerChatId !== chatId) continue;
    commits.push(...commitsFromTrace(log));
  }
  chatTraceReceipts.set(logs, { chatId, commits });
  return commits;
}
