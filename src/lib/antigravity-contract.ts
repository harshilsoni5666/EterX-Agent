import type { ModelThinkingCapabilities } from './agent/model-routing';

export type AntigravityModel = {
  id: string;
  label: string;
  thinking: ModelThinkingCapabilities | null;
  capabilities?: { image: boolean; audio: boolean; embeddedContext: boolean };
};

export type AntigravityAllowance = {
  group: string;
  window: string;
  remaining: number | null;
  resetAt: number | null;
};

export type AntigravityTurnUsage = {
  model: string;
  completedAt: number;
  inputTokens: number | null;
  outputTokens: number | null;
};

export type AntigravityAccount = {
  id: string;
  label: string;
  connected: boolean;
  runningTurns: number;
  lastTurn: AntigravityTurnUsage | null;
  allowance: AntigravityAllowance[];
  allowanceUpdatedAt: number | null;
  allowanceError: string | null;
  loadingAllowance: boolean;
};

export type AntigravityState = {
  revision: string;
  usageRevision: string;
  supported: boolean;
  version: string | null;
  connected: boolean;
  activeAccountId: string | null;
  accounts: AntigravityAccount[];
  models: AntigravityModel[];
  capabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
  activity: 'installing' | 'signing-in' | 'refreshing' | 'signing-out' | 'switching' | 'removing' | null;
  activityAccountId: string | null;
  authorizationUrl: string | null;
  error: string | null;
};

export const ANTIGRAVITY_ACTIONS = [
  'state', 'watch', 'install', 'sign-in', 'submit-code', 'cancel', 'refresh', 'sign-out', 'disconnect-all', 'switch', 'remove', 'usage',
] as const;

export type AntigravityAction = typeof ANTIGRAVITY_ACTIONS[number];

export type AntigravityRequest = {
  action: AntigravityAction;
  accountId?: string;
  label?: string;
  code?: string;
  revision?: string;
};
