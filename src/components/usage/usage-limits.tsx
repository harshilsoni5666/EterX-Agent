import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CircleGauge, RefreshCw } from 'lucide-react';
import { getDesktopSubscription, useChatGptSubscription, type ChatGptAccount, type ChatGptObservedUsage } from '../../lib/chatgpt-subscription-client';
import { requestAntigravity, useAntigravity } from '../../lib/antigravity-client';
import { requestNativeProvider, useNativeProviders } from '../../lib/native-provider-client';
import { NATIVE_PROVIDER_INFO, NATIVE_PROVIDERS, type NativeProvider } from '../../lib/native-provider-contract';
import type { AntigravityAccount } from '../../lib/antigravity-contract';
import type { SubscriptionProvider } from '../../lib/agent/model-selector-store';
import { ProviderIconAsset } from '../ui/provider-icon';
import { exactCount, modelLabel } from './usage-format';
import styles from './usage-dashboard.module.css';

const manageUsageUrl = 'https://chatgpt.com/settings/usage';
const timestamp = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const observationLabels: Record<ChatGptObservedUsage['status'], string> = {
  completed: 'Last request completed',
  'plan-limit': 'Plan or app limit reached',
  'rate-limited': 'Last request rate limited',
  unavailable: 'Usage status temporarily unavailable',
  ineligible: 'Plan unavailable for this account',
};
const connectionLabels: Record<ChatGptAccount['status'], string> = {
  connected: 'No request observed yet',
  disconnected: 'Signed out',
  'consent-required': 'Plan permission needed',
  pending: 'Sign-in incomplete',
};

function observedTime(time: number | undefined) {
  if (!time || !Number.isFinite(time) || Math.abs(time) > 8.64e15) return null;
  return { iso: new Date(time).toISOString(), label: timestamp.format(time) };
}

function AntigravityAccountLimits({ account }: { account: AntigravityAccount }) {
  const requested = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const loading = refreshing || account.loadingAllowance;

  useEffect(() => {
    if (account.loadingAllowance || requested.current || Date.now() - (account.allowanceUpdatedAt || 0) < 5 * 60_000) return;
    requested.current = true;
    void requestAntigravity('usage', { accountId: account.id }).catch(() => setRefreshError('Could not refresh this account’s plan limits.'));
  }, [account.allowanceUpdatedAt, account.id, account.loadingAllowance]);

  async function refresh() {
    setRefreshing(true);
    setRefreshError('');
    try { await requestAntigravity('usage', { accountId: account.id }); }
    catch { setRefreshError('Could not refresh this account’s plan limits.'); }
    finally { setRefreshing(false); }
  }

  const updated = observedTime(account.allowanceUpdatedAt ?? undefined);
  const turn = account.lastTurn;
  const turnTime = observedTime(turn?.completedAt);
  const counts = turn ? [turn.inputTokens === null ? '' : `${exactCount(turn.inputTokens)} input`,
    turn.outputTokens === null ? '' : `${exactCount(turn.outputTokens)} output`].filter(Boolean) : [];

  return <div className={styles.limitProviderAccount}>
    <div className={`${styles.limitRow} ${styles.limitProviderAccountHeader}`}>
      <div className={styles.limitAccount}>
        <strong>{account.label}</strong>
      </div>
      <div className={styles.limitObservation} aria-live="polite">
        {account.runningTurns > 0 && <span className={styles.limitStatus} data-tone="neutral">
          <i className={styles.rowDot} aria-hidden="true" />{account.runningTurns === 1 ? 'Turn running' : `${account.runningTurns} turns running`}
        </span>}
        {turn && <span className={styles.note}>
          {modelLabel(turn.model)}{counts.length ? ` · ${counts.join(' · ')} tokens` : ' · No token counts reported'}
          {turnTime && <> · <time dateTime={turnTime.iso}>{turnTime.label}</time></>}
        </span>}
        {updated && <span className={styles.note}>Limits updated <time dateTime={updated.iso}>{updated.label}</time></span>}
      </div>
      <button type="button" className={styles.actionButton} aria-label={`Refresh plan limits for ${account.label}`} disabled={loading} onClick={() => void refresh()}>
        <RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : undefined} />Refresh limits
      </button>
    </div>
    {account.allowance.length > 0 && <ul className={styles.limitList}>
      {account.allowance.map((item, index) => {
        const reset = observedTime(item.resetAt ?? undefined);
        const percent = item.remaining === null ? null : Math.round(item.remaining * 1_000) / 10;
        const window = item.window.replace(/[_-]+/g, ' ');
        return <li key={`${item.group}:${item.window}:${index}`} className={styles.limitRow}>
          <div className={styles.limitAccount}><strong>{item.group}</strong><span className={styles.note}>{window}</span></div>
          <div className={styles.limitObservation}>
            <span className={styles.limitStatus} data-tone={percent === null ? 'neutral' : percent > 15 ? 'positive' : 'warning'}>
              <i className={styles.rowDot} aria-hidden="true" />{percent === null ? 'Allowance unavailable' : `${percent}% remaining`}
            </span>
          </div>
          {reset && <span className={styles.note}>Resets <time dateTime={reset.iso}>{reset.label}</time></span>}
        </li>;
      })}
    </ul>}
    {(refreshError || account.allowanceError) ? <p className={styles.limitEmpty} role="status">{refreshError || account.allowanceError}</p>
      : !account.allowance.length && <p className={styles.limitEmpty} role="status">{loading ? 'Refreshing Antigravity plan limits…' : 'No plan limits have been reported yet.'}</p>}
  </div>;
}

function AntigravityLimits({ onManage }: { onManage: () => void }) {
  const state = useAntigravity();
  const accounts = state?.version ? state.accounts.filter(account => account.connected) : [];
  return <section className={styles.limitPanel} aria-label="Antigravity subscription limits">
    <div className={styles.limitHead}>
      <div className={styles.limitIdentity}>
        <div className={styles.limitProviderIcon}><ProviderIconAsset provider="antigravity" /></div>
        <div>
          <h2>Antigravity</h2>
          <p className={styles.note}>Google account plan limits</p>
        </div>
      </div>
      <button type="button" className={styles.actionButton} onClick={onManage}>{accounts.length ? 'Manage accounts' : 'Connect Antigravity'}</button>
    </div>
    {!accounts.length ? <p className={styles.limitEmpty}>Sign in with Google to view your Antigravity plan limits.</p>
      : accounts.map(account => <AntigravityAccountLimits key={account.id} account={account} />)}
  </section>;
}

function NativeProviderLimits({ provider, onManage }: { provider: NativeProvider; onManage: () => void }) {
  const state = useNativeProviders()?.providers[provider];
  const meta = NATIVE_PROVIDER_INFO[provider];
  const accounts = state?.accounts.filter(account => account.connected) ?? [];
  const [error, setError] = useState('');
  return <section className={styles.limitPanel} aria-label={meta.name + ' usage'}>
    <div className={styles.limitHead}>
      <div className={styles.limitIdentity}>
        <div className={styles.limitProviderIcon}><ProviderIconAsset provider={provider} /></div>
        <div><h2>{meta.name}</h2><p className={styles.note}>Account usage and recent turns</p></div>
      </div>
      <div className="flex flex-wrap gap-2">
        {accounts.length > 0 && <a className={styles.actionButton} href={meta.usageUrl} target="_blank" rel="noreferrer">
          {provider === 'grok-build' ? 'Open Grok' : 'Open usage'}<ArrowUpRight size={13} aria-hidden="true" />
        </a>}
        <button type="button" className={styles.actionButton} onClick={onManage}>{accounts.length ? 'Manage accounts' : 'Connect ' + meta.name}</button>
      </div>
    </div>
    {!accounts.length && <p className={styles.limitEmpty}>Connect an account in Subscription settings to see its usage.</p>}
    {accounts.map(account => {
      const last = account.lastTurn;
      const retry = observedTime(account.limit?.retryAt);
      const counts = last ? [
        last.input === null ? '' : exactCount(last.input) + ' input',
        last.output === null ? '' : exactCount(last.output) + ' output',
      ].filter(Boolean).join(' · ') : '';
      return <div key={account.id} className={styles.limitProviderAccount}>
        <div className={styles.limitRow + ' ' + styles.limitProviderAccountHeader}>
          <div className={styles.limitAccount}><strong>{account.label}</strong></div>
          <div className={styles.limitObservation}>
            {account.runningTurns > 0 && <span className={styles.limitStatus} role="status">Turn running</span>}
            {account.limit && <span className={styles.limitStatus} data-tone="warning">
              {account.limit.kind === 'plan' ? 'Plan limit reported' : 'Request limit reported'}
              {retry && <> · <time dateTime={retry.iso}>{retry.label}</time></>}
            </span>}
            <span className={styles.note}>{last ? modelLabel(last.model) + ' · ' + (counts ? counts + ' tokens' : 'No token counts reported') : 'No recent turns'}</span>
          </div>
          {provider === 'claude-code' && <button type="button" className={styles.actionButton} disabled={Boolean(state?.activity)}
            onClick={() => {
              setError('');
              void requestNativeProvider({ provider, action: 'refresh', accountId: account.id }).catch(() => setError('Could not refresh Claude Code plan limits.'));
            }}><RefreshCw size={13} aria-hidden="true" />Refresh limits</button>}
        </div>
        {account.limits?.length ? <ul className={styles.limitList}>{account.limits.map(window => {
          const reset = observedTime(window.resetsAt ?? undefined);
          return <li key={window.label} className={styles.limitRow}>
            <strong>{window.label}</strong>
            <span className={styles.limitStatus} data-tone={window.usedPercent >= 85 ? 'warning' : 'positive'}>{Math.round(window.usedPercent)}% used</span>
            {reset && <span className={styles.note}>Resets <time dateTime={reset.iso}>{reset.label}</time></span>}
          </li>;
        })}</ul> : <p className={styles.limitEmpty}>{provider === 'claude-code' ? 'No plan limits reported.' : 'Plan limits are available in your provider account.'}</p>}
      </div>;
    })}
    {(error || state?.error) && <p className={styles.limitEmpty} role="status">{error || state?.error}</p>}
  </section>;
}

export function UsageLimits({ onManageSubscription }: { onManageSubscription: (provider: SubscriptionProvider) => void }) {
  const state = useChatGptSubscription();
  const desktop = getDesktopSubscription();
  const [now, setNow] = useState(Date.now);
  const accounts = [...(state?.accounts ?? [])].sort((a, b) =>
    Number(b.id === state?.activeAccountId) - Number(a.id === state?.activeAccountId));
  const activeCount = accounts.filter(account => account.status === 'connected').length;
  const rows = accounts.map(account => ({
    account,
    active: account.id === state?.activeAccountId,
    usage: account.status === 'connected' ? account.usage ?? (account.id === state?.activeAccountId ? state?.usage : null) : null,
  }));
  const nextRetry = rows.reduce((next, row) => {
    const retry = row.usage?.retryAt ?? 0;
    return Number.isFinite(retry) && retry > now ? Math.min(next, retry) : next;
  }, Infinity);

  useEffect(() => {
    if (!Number.isFinite(nextRetry)) return;
    const timeout = window.setTimeout(() => setNow(Date.now()), Math.min(2_147_000_000, Math.max(0, nextRetry - Date.now()) + 100));
    return () => window.clearTimeout(timeout);
  }, [nextRetry, now]);

  return <div className={styles.limits}>
    <section className={styles.limitPanel} aria-label="Codex subscription limits">
      <div className={styles.limitHead}>
        <div className={styles.limitIdentity}>
          <div className={styles.limitProviderIcon}><ProviderIconAsset provider="codex" /></div>
          <div>
            <h2>Codex</h2>
            <p className={styles.note}>Observed request status for your connected accounts.</p>
          </div>
        </div>
        <button type="button" className={styles.actionButton} onClick={() => onManageSubscription('codex')}>
          {accounts.length ? 'Manage connections' : 'Subscription settings'}
        </button>
      </div>
      {desktop && !state ? <p role="status" className={styles.limitEmpty}>Reading subscription connections…</p>
        : !state?.available ? <p className={styles.limitEmpty}>Subscription status is available through the EterX desktop connection.</p>
        : !rows.length ? <p className={styles.limitEmpty}>Connect a ChatGPT account in Subscription settings to see its request status.</p>
        : <div className={styles.limitBody}>
          <div className={styles.limitSummary}>
            <span className={styles.statLabel}>Connected accounts</span>
            <strong>{exactCount(activeCount)}</strong>
            <span className={styles.note}>of {exactCount(rows.length)} saved</span>
          </div>
          <ul className={styles.limitList}>
            {rows.map(({ account, active, usage }) => {
              const lastSeen = observedTime(usage?.observedAt);
              const retry = usage?.retryAt && usage.retryAt > now ? observedTime(usage.retryAt) : null;
              const tone = usage?.status === 'completed' && !retry ? 'positive'
                : retry || (usage && usage.status !== 'completed') ? 'warning' : 'neutral';

              return <li className={styles.limitRow} key={account.id}>
                <div className={styles.limitAccount}>
                  <strong>{account.label}</strong>
                  {active && account.status === 'connected' && <small className={styles.limitCurrent}>Current</small>}
                </div>
                <div className={styles.limitObservation}>
                  <span className={styles.limitStatus} data-tone={tone}>
                    <i className={styles.rowDot} aria-hidden="true" />{usage ? observationLabels[usage.status] : connectionLabels[account.status]}
                  </span>
                  {lastSeen && <time className={styles.note} dateTime={lastSeen.iso}>{lastSeen.label}</time>}
                </div>
                {retry && <div className={styles.limitRetry}>
                  <RefreshCw size={13} aria-hidden="true" />
                  <span>EterX retry after <time dateTime={retry.iso}>{retry.label}</time></span>
                </div>}
              </li>;
            })}
          </ul>
        </div>}
    </section>

    <section className={styles.limitPanel} aria-label="Plan allowance">
      <div className={styles.limitHead}>
        <div className={styles.limitIdentity}>
          <div className={styles.limitProviderIcon}><CircleGauge size={16} aria-hidden="true" /></div>
          <div>
            <h2>Plan allowance</h2>
            <p className={styles.note}>ChatGPT shows the remaining plan usage, app limits, and reset windows.</p>
          </div>
        </div>
        <a href={manageUsageUrl} target="_blank" rel="noreferrer" className={styles.actionButton}>
          Open ChatGPT usage<ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </div>
    </section>
    <AntigravityLimits onManage={() => onManageSubscription('antigravity')} />
    {NATIVE_PROVIDERS.map(provider => <NativeProviderLimits key={provider} provider={provider} onManage={() => onManageSubscription(provider)} />)}
  </div>;
}
