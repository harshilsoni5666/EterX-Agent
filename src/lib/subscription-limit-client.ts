'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAntigravity } from './antigravity-client';
import { useChatGptSubscription } from './chatgpt-subscription-client';
import { appStorage, subscribeAppStorageKeys } from './client-storage';
import { useNativeProviders } from './native-provider-client';
import { NATIVE_PROVIDERS, type SubscriptionProvider } from './native-provider-contract';

const ALERTS_KEY = 'eterx_subscription_limit_alerts';
const UNKNOWN_RESET_TTL_MS = 15 * 60_000;
const alertsEnabled = () => appStorage.getItem(ALERTS_KEY) === 'true';
const subscribe = (listener: () => void) => subscribeAppStorageKeys([ALERTS_KEY], listener);

export function useSubscriptionLimitAlertsEnabled() {
  return useSyncExternalStore(subscribe, alertsEnabled, () => false);
}

export function setSubscriptionLimitAlertsEnabled(enabled: boolean) {
  if (enabled) appStorage.setItem(ALERTS_KEY, 'true');
  else appStorage.removeItem(ALERTS_KEY);
}

export type SubscriptionLimitNotice = {
  id: string;
  provider: SubscriptionProvider;
  accountLabel: string;
  kind: 'plan' | 'request' | 'included';
  window?: string;
  observedAt: number;
  retryAt?: number;
};

function activeNotice(
  notices: SubscriptionLimitNotice[], now: number, accountId: string,
  notice: Omit<SubscriptionLimitNotice, 'id' | 'retryAt'>, retryAt?: number | null,
) {
  if (!Number.isFinite(notice.observedAt) || notice.observedAt <= 0) return;
  const reset = typeof retryAt === 'number' && Number.isFinite(retryAt) && retryAt > 0 && retryAt <= 8.64e15
    ? retryAt : undefined;
  if ((reset ?? notice.observedAt + UNKNOWN_RESET_TTL_MS) <= now) return;
  const cycle = reset === undefined ? Math.floor(notice.observedAt / UNKNOWN_RESET_TTL_MS) : Math.ceil(reset / 60_000);
  const id = JSON.stringify([notice.provider, accountId, notice.kind, notice.window ?? '', reset === undefined, cycle]);
  notices.push({ ...notice, id, retryAt: reset });
}

export function useSubscriptionLimitNotices(enabled: boolean) {
  const codex = useChatGptSubscription();
  const antigravity = useAntigravity();
  const native = useNativeProviders();
  const [clock, setClock] = useState(0);
  const notices = useMemo(() => {
    const notices: SubscriptionLimitNotice[] = [];
    if (!enabled) return notices;
    const now = Date.now();
    for (const account of codex?.accounts ?? []) {
      const usage = account.usage;
      if (account.status !== 'connected' || (usage?.status !== 'plan-limit' && usage?.status !== 'rate-limited')) continue;
      activeNotice(notices, now, account.id, {
        provider: 'codex', accountLabel: account.label, kind: usage.status === 'plan-limit' ? 'plan' : 'request', observedAt: usage.observedAt,
      }, usage.retryAt);
    }
    for (const account of antigravity?.accounts ?? []) {
      if (!antigravity?.version || !account.connected || !account.allowanceUpdatedAt) continue;
      for (const window of account.allowance) {
        if (window.remaining !== 0) continue;
        activeNotice(notices, now, account.id, {
          provider: 'antigravity', accountLabel: account.label, kind: 'included',
          window: [window.group, window.window].filter(Boolean).join(' · '), observedAt: account.allowanceUpdatedAt,
        }, window.resetAt);
      }
    }
    for (const provider of NATIVE_PROVIDERS) {
      for (const account of native?.providers[provider].accounts ?? []) {
        if (!account.connected || account.method !== 'browser') continue;
        const previousLength = notices.length;
        if (account.limit) activeNotice(notices, now, account.id, {
          provider, accountLabel: account.label, kind: account.limit.kind, observedAt: account.limit.observedAt,
        }, account.limit.retryAt);
        if (notices.length > previousLength || !account.limitsUpdatedAt) continue;
        for (const window of account.limits ?? []) {
          if (window.usedPercent < 100) continue;
          activeNotice(notices, now, account.id, {
            provider, accountLabel: account.label, kind: 'included', window: window.label, observedAt: account.limitsUpdatedAt,
          }, window.resetsAt);
        }
      }
    }
    return [...new Map(notices.map(notice => [notice.id, notice])).values()].sort((a, b) => b.observedAt - a.observedAt);
  // The clock revision expires notices even when the provider remains idle.
  }, [enabled, codex, antigravity, native, clock]);

  useEffect(() => {
    if (!notices.length) return;
    const next = Math.min(...notices.map(notice => notice.retryAt ?? notice.observedAt + UNKNOWN_RESET_TTL_MS));
    const timer = window.setTimeout(() => setClock(clock => clock + 1), Math.max(50, Math.min(2_147_000_000, next - Date.now() + 50)));
    return () => window.clearTimeout(timer);
  }, [notices]);
  return notices;
}
