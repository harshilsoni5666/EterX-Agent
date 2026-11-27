import { requestAskUser } from '../core/ask_user';

const OUTBOUND_SEND_ENV = 'ETERX_ALLOW_UNSAFE_COMMUNICATION_SEND';
const APPROVAL_WAIT_MS = 5 * 60 * 1000;

type OutboundApprovalFailure = {
  success: false;
  status: string;
  approvalRequired: true;
  approval: Record<string, string | undefined>;
};

const EXTERNAL_ACTION_PATTERN = /\b(?:send|reply|respond|message|text|email|dm|post|publish|notify|forward|invite|react|comment|upload|create|update)\b/i;
const EXTERNAL_TARGET_PATTERN = /\b(?:telegram|slack|whatsapp|discord|signal|mattermost|matrix|email|mail|sms|gateway|connector|channel|chat|conversation|message|messages|recipient|contact|github|gitlab|jira|linear|notion|teams|outlook|gmail)\b/i;

/** A direct user request is authorization; avoid a redundant second prompt. */
export function isUserInitiatedCommunicationRequest(message: unknown): boolean {
  const text = String(message || '').trim();
  return Boolean(text && EXTERNAL_ACTION_PATTERN.test(text) && EXTERNAL_TARGET_PATTERN.test(text));
}

export function hasOutboundApproval(input: any, context: any, actionKey: string): boolean {
  if (process.env[OUTBOUND_SEND_ENV] === '1') return true;
  if (context?.allowExternalCommunicationSend === true) return true;
  if (context?.communicationApproval === true || context?.approval?.externalCommunication === true) return true;
  if (context?.userInitiatedCommunication === true) return true;

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
  if (!context?._onTrace) return null;
  const safeTarget = String(target || 'the selected recipient').slice(0, 300);
  const safeSummary = String(summary || `${platform} ${action}`).slice(0, 1000);
  try {
    const result = await requestAskUser({
      question: `Approve ${platform} ${action}?`,
      mode: 'confirm',
      context: `Target: ${safeTarget}\nSummary: ${safeSummary}`,
      urgent: true,
    }, context, APPROVAL_WAIT_MS);
    return result.success && 'selectedOption' in result && isPositiveApproval(result.answer, result.selectedOption);
  } catch (error) {
    if (error instanceof Error && error.message === 'CANCELLED_BY_USER') return false;
    throw error;
  }
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
