import type { ModelThinkingCapabilities } from './agent/model-routing';

export const NATIVE_PROVIDERS = ['cursor', 'grok-build', 'claude-code'] as const;
export type NativeProvider = typeof NATIVE_PROVIDERS[number];

export const NATIVE_PROVIDER_INFO = {
  cursor: { name: 'Cursor', auth: 'Cursor', setupUrl: 'https://cursor.com/docs/sdk/typescript',
    usageUrl: 'https://cursor.com/dashboard?tab=usage', apiKey: true },
  'grok-build': { name: 'Grok Build', auth: 'Grok', setupUrl: 'https://docs.x.ai/build/overview',
    usageUrl: 'https://grok.com', apiKey: false },
  'claude-code': { name: 'Claude Code', auth: 'Claude', setupUrl: 'https://code.claude.com/docs/en/setup',
    usageUrl: 'https://claude.ai/settings/usage', apiKey: false },
} as const;

export function isNativeProvider(value: unknown): value is NativeProvider {
  return typeof value === 'string' && (NATIVE_PROVIDERS as readonly string[]).includes(value);
}

export type NativeSessionProvider = 'antigravity' | NativeProvider;
export type SubscriptionProvider = 'codex' | NativeSessionProvider;
export const SUBSCRIPTION_PROVIDER_NAMES: Record<SubscriptionProvider, string> = {
  codex: 'Codex',
  antigravity: 'Antigravity',
  cursor: NATIVE_PROVIDER_INFO.cursor.name,
  'grok-build': NATIVE_PROVIDER_INFO['grok-build'].name,
  'claude-code': NATIVE_PROVIDER_INFO['claude-code'].name,
};
export const isNativeSessionProvider = (value: unknown): value is NativeSessionProvider =>
  value === 'antigravity' || isNativeProvider(value);

export type NativeProviderModel = {
  id: string;
  label: string;
  thinking?: ModelThinkingCapabilities;
  effortId?: string;
  capabilities?: string[];
};

export type NativeUsageWindow = { label: string; usedPercent: number; resetsAt: number | null };
export type NativeLimitSignal = { kind: 'plan' | 'request'; retryAt?: number };
export type NativeLimitObservation = NativeLimitSignal & { observedAt: number };
export type NativeProviderAccount = {
  id: string;
  label: string;
  connected: boolean;
  method: 'browser' | 'api-key';
  runningTurns: number;
  lastTurn?: { model: string; input: number | null; output: number | null };
  limits?: NativeUsageWindow[];
  limitsUpdatedAt?: number;
  limit?: NativeLimitObservation;
};

export const NATIVE_PROVIDER_ACTIONS = ['watch', 'refresh', 'binary', 'sign-in', 'switch', 'cancel', 'sign-out', 'clear'] as const;
export type NativeProviderAction = typeof NATIVE_PROVIDER_ACTIONS[number];
export type NativeProviderRequest = {
  action: NativeProviderAction;
  provider?: NativeProvider;
  accountId?: string;
  label?: string;
  apiKey?: string;
  binaryPath?: string;
  revision?: string;
};

export type NativeProviderStatus = {
  accounts: NativeProviderAccount[];
  activeAccountId: string | null;
  models: NativeProviderModel[];
  version: string | null;
  binaryPath: string;
  activity: 'refresh' | 'sign-in' | 'sign-out' | 'clear' | null;
  authorizationUrl?: string;
  deviceCode?: string;
  error?: string;
};

export type NativeProviderSnapshot = {
  revision: string;
  usageRevision: number;
  providers: Record<NativeProvider, NativeProviderStatus>;
};
