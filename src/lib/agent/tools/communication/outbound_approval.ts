const OUTBOUND_SEND_ENV = 'ETERX_ALLOW_UNSAFE_COMMUNICATION_SEND';
const APPROVAL_WAIT_MS = 5 * 60 * 1000;
const APPROVAL_POLL_MS = 500;

type OutboundApprovalFailure = {
  success: false;
  status: string;
  approvalRequired: true;
  approval: Record<string, string | undefined>;
};

export function hasOutboundApproval(input: any, context: any, actionKey: string): boolean {
  if (process.env[OUTBOUND_SEND_ENV] === '1') return true;
  if (context?.allowExternalCommunicationSend === true) return true;
  if (context?.communicationApproval === true || context?.approval?.externalCommunication === true) return true;

  const approved = new Set<string>([
    ...readStringList(context?.approvedActions),
    ...readStringList(context?.toolPolicy?.approvedActions),
    ...readStringList(context?.allowedActions),
    ...readStringList(context?.toolPolicy?.allowedActions),
  ]);
  if (approved.has(actionKey) || approved.has('communication.send') || approved.has('communication.external.write')) {
    return true;
  }

  const token = String(input?.approvalToken || input?.confirmationToken || '').trim();
  const approvedTokens = new Set<string>([
    ...readStringList(context?.approvalTokens),
    ...readStringList(context?.toolPolicy?.approvalTokens),
  ]);
  return Boolean(token && approvedTokens.has(token));
}

export async function requireOutboundApproval(
  platform: string,
  action: string,
  input: any,
  context: any,
  target?: string,
  summary?: string,
): Promise<OutboundApprovalFailure | null> {
  const actionKey = `${platform.toLowerCase()}.${action}`;
  if (hasOutboundApproval(input, context, actionKey)) return null;

  const approval = buildApprovalFailure(platform, action, input, target, summary);
  const userApproved = await askUserForOutboundApproval(platform, action, target, summary, context);
  if (userApproved === true) return null;
  if (userApproved === false) {
    return {
      ...approval,
      status: `${platform} action "${action}" was not approved by the user.`,
    };
  }

  return approval;
}

function buildApprovalFailure(
  platform: string,
  action: string,
  input: any,
  target?: string,
  summary?: string,
): OutboundApprovalFailure {
  const confirmHint = input?.confirm === true
    ? 'confirm=true was provided, but this runtime still needs a user approval token or trusted communication-send capability.'
    : 'Set confirm=true only after the user approves, then provide a user approval token or run from a trusted communication-send context.';

  return {
    success: false,
    status: `${platform} action "${action}" requires explicit user approval. ${confirmHint}`,
    approvalRequired: true,
    approval: {
      platform,
      action,
      target,
      summary,
      requiredCapability: 'communication.send',
    },
  };
}

async function askUserForOutboundApproval(
  platform: string,
  action: string,
  target: string | undefined,
  summary: string | undefined,
  context: any,
): Promise<boolean | null> {
  if (!context?._onTrace || typeof globalThis === 'undefined') return null;

  const timestamp = Date.now();
  const responseKey = `ask_user_${timestamp}_${Math.random().toString(36).slice(2, 10)}`;
  const chatId = String(context?.projectId || context?.chatId || '').slice(0, 160);
  const sessionId = String(context?.agentSessionId || '').slice(0, 160);
  const safeTarget = String(target || 'the selected recipient').slice(0, 300);
  const safeSummary = String(summary || `${platform} ${action}`).slice(0, 1000);

  const question = `Approve ${platform} ${action}?`;
  const askEvent = {
    type: 'ask_user',
    question,
    mode: 'confirm',
    options: [],
    questions: [],
    context: `Target: ${safeTarget}\nSummary: ${safeSummary}`,
    defaultValue: 'no',
    urgent: true,
    responseKey,
    chatId,
    timestamp,
  };

  (globalThis as any).__pendingAskUser = (globalThis as any).__pendingAskUser || {};
  (globalThis as any).__pendingAskUser[responseKey] = {
    question,
    mode: 'confirm',
    options: [],
    questions: [],
    context: askEvent.context,
    defaultValue: 'no',
    urgent: true,
    chatId,
    sessionId,
    status: 'pending',
    answer: null,
    selectedOption: null,
    answers: null,
    createdAt: timestamp,
  };

  context._onTrace(askEvent);

  const startedAt = Date.now();
  while (Date.now() - startedAt < APPROVAL_WAIT_MS) {
    const pending = (globalThis as any).__pendingAskUser?.[responseKey];
    if (pending?.status === 'answered' && pending?.answer !== null) {
      delete (globalThis as any).__pendingAskUser[responseKey];
      return isPositiveApproval(pending.answer, pending.selectedOption);
    }
    await new Promise(resolve => setTimeout(resolve, APPROVAL_POLL_MS));
  }

  if ((globalThis as any).__pendingAskUser?.[responseKey]) {
    delete (globalThis as any).__pendingAskUser[responseKey];
  }
  return false;
}

function isPositiveApproval(answer: unknown, selectedOption: unknown): boolean {
  const values = [answer, selectedOption]
    .map(value => {
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object') return JSON.stringify(value);
      return String(value ?? '');
    })
    .join(' ')
    .toLowerCase();

  return /\b(yes|y|true|approve|approved|confirm|confirmed|proceed|ok|allow|send)\b/.test(values);
}

function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(/[,\n]/).map(v => v.trim()).filter(Boolean);
}
