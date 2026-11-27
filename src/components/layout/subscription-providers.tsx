'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, ChevronRight, Download, LoaderCircle, LogOut, RefreshCw, UserPlus } from 'lucide-react';
import { useChatGptSubscription } from '../../lib/chatgpt-subscription-client';
import { desktopAntigravity, requestAntigravity, useAntigravity } from '../../lib/antigravity-client';
import type { AntigravityAction, AntigravityRequest } from '../../lib/antigravity-contract';
import type { SubscriptionProvider } from '../../lib/agent/model-selector-store';
import { ProviderIconAsset } from '../ui/provider-icon';
import { SubscriptionSettings } from './subscription-settings';
import { NativeSubscriptionSettings } from './native-subscription-settings';
import { SubscriptionLimitSettings } from './subscription-limit-alerts';
import { useNativeProviders } from '../../lib/native-provider-client';
import { SUBSCRIPTION_PROVIDER_NAMES, NATIVE_PROVIDERS } from '../../lib/native-provider-contract';
import styles from './subscription-providers.module.css';

const button = 'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--muted)] px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] transition-colors hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
const body = 'text-xs leading-relaxed text-[var(--muted-foreground)]';

const activityText = {
  installing: 'Downloading Antigravity from Google…',
  'signing-in': 'Waiting for Google sign-in…',
  refreshing: 'Refreshing models…',
  'signing-out': 'Signing out…',
  switching: 'Switching Antigravity accounts…',
  removing: 'Removing account…',
};

function AntigravitySettings() {
  const state = useAntigravity();
  const available = Boolean(desktopAntigravity());
  const [action, setAction] = useState<AntigravityAction | null>(null);
  const [code, setCode] = useState('');
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [browserAccount, setBrowserAccount] = useState<string | null>(null);
  const openedUrl = useRef('');
  const [error, setError] = useState('');
  const busy = Boolean(state?.activity || action);
  const connected = state?.accounts.filter(account => account.connected) ?? [];

  useEffect(() => {
    const url = state?.authorizationUrl;
    if (!url || !browserAccount || state?.activityAccountId !== browserAccount || url === openedUrl.current) return;
    const api = (window as Window & { electronAPI?: { openExternal?: (url: string) => Promise<unknown> } }).electronAPI;
    openedUrl.current = url;
    void api?.openExternal?.(url).catch(() => undefined);
  }, [browserAccount, state]);

  async function perform(next: AntigravityAction, options?: Omit<AntigravityRequest, 'action'>) {
    setAction(next);
    setError('');
    try {
      const result = await requestAntigravity(next, options);
      if (next === 'sign-in') {
        setCode('');
        setBrowserAccount(result?.activity === 'signing-in' ? result.activityAccountId : null);
        setAdding(false);
        setLabel('');
      }
      if (next === 'submit-code' || next === 'cancel') setCode('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') : 'Antigravity could not complete the request.');
    } finally { setAction(null); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (code.trim() && state?.activityAccountId) void perform('submit-code', { code, accountId: state.activityAccountId });
  }

  return <div className="space-y-4">
    <section data-settings-search-target="antigravity-connection" tabIndex={-1} className="rounded-xl border border-[var(--border)] bg-[var(--input-bg)]">
      <div className="flex flex-wrap items-start gap-3.5 p-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-[var(--border)] bg-[var(--muted)]">
          <ProviderIconAsset provider="antigravity" className="size-6" />
        </span>
        <div className="min-w-0 flex-1 basis-36">
          <h4 className="text-sm font-semibold text-[var(--foreground)]">Antigravity accounts</h4>
          <p className={`mt-1 ${body}`}>{connected.length ? connected.length + (connected.length === 1 ? ' account connected' : ' accounts connected')
            : 'Sign in to Antigravity with your Google account.'}</p>
        </div>
        {state?.version && state.supported && (state.accounts.length > 0
          ? <button type="button" className={button} disabled={busy || adding} onClick={() => setAdding(true)}><UserPlus size={14} aria-hidden="true" />Add account</button>
          : <button type="button" className={button} disabled={busy} onClick={() => void perform('sign-in')}>Sign in with Google</button>)}
      </div>

      {!available ? <p className={`border-t border-[var(--border)] px-4 py-3 ${body}`}>Open EterX desktop to connect Antigravity.</p>
        : !state ? <p className={`border-t border-[var(--border)] px-4 py-3 ${body}`} role="status">Loading the connection…</p>
        : !state.supported ? <p className={`border-t border-[var(--border)] px-4 py-3 ${body}`}>Antigravity is unavailable on this platform.</p>
        : <div className="space-y-3 border-t border-[var(--border)] px-4 py-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-[var(--foreground)]">Antigravity runtime</p>
              <p className={`mt-0.5 ${body}`}>{state.version ? `Version ${state.version}` : 'Install the Google runtime to continue.'}</p>
            </div>
            {!state.version && <button type="button" className={button} disabled={busy} onClick={() => void perform('install')}><Download size={14} aria-hidden="true" />Install</button>}
          </div>

          {adding && <form className="space-y-2 rounded-lg border border-[var(--border)] p-3" onSubmit={event => { event.preventDefault(); void perform('sign-in', { label }); }}>
            <label htmlFor="antigravity-account-label" className={`block ${body}`}>Account label (optional)</label>
            <div className="flex flex-wrap items-center gap-2">
              <input id="antigravity-account-label" value={label} onChange={event => setLabel(event.target.value)} autoComplete="off" maxLength={80}
                placeholder="Personal or work" className="min-h-8 min-w-0 flex-1 basis-40 rounded-lg border border-[var(--border)] bg-[var(--input-bg)] px-2.5 text-xs focus-visible:outline-2" />
              <button type="submit" disabled={busy} className={button}>Sign in with Google</button>
              <button type="button" disabled={busy} className={button} onClick={() => { setAdding(false); setLabel(''); }}>Cancel</button>
            </div>
          </form>}

          {state.authorizationUrl && <form onSubmit={submit} className="space-y-2 rounded-lg border border-[var(--border)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h5 className="text-xs font-semibold text-[var(--foreground)]">Finish Antigravity sign-in</h5>
              <a href={state.authorizationUrl} className={button} target="_blank" rel="noreferrer">Open Antigravity sign-in<ArrowUpRight size={14} aria-hidden="true" /></a>
            </div>
            <label htmlFor="antigravity-sign-in-code" className={`block ${body}`}>Paste the code from the Antigravity sign-in page.</label>
            <div className="flex flex-wrap items-center gap-2">
              <input id="antigravity-sign-in-code" value={code} onChange={event => setCode(event.target.value)} type="password"
                autoComplete="off" spellCheck={false} maxLength={8192} placeholder="Authorization code"
                className="min-h-8 min-w-0 flex-1 basis-40 rounded-lg border border-[var(--border)] bg-[var(--input-bg)] px-2.5 text-xs text-[var(--foreground)] focus-visible:outline-2" />
              <button type="submit" className={button} disabled={Boolean(action) || !code.trim()}>Connect</button>
            </div>
          </form>}

          {state.activity && <div className="flex flex-wrap items-center justify-between gap-2">
            <p className={`flex items-center gap-2 ${body}`} role="status"><LoaderCircle size={14} className="animate-spin" aria-hidden="true" />{activityText[state.activity]}</p>
            {(state.activity === 'installing' || state.activity === 'signing-in') && <button type="button" className={button} disabled={Boolean(action)} onClick={() => void perform('cancel')}>Cancel</button>}
          </div>}
        </div>}
      {state?.accounts.length ? <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]" aria-label="Saved Antigravity accounts">
        {state.accounts.map(account => {
          return <li key={account.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              <p className="break-words text-xs font-semibold text-[var(--foreground)]">{account.label}</p>
              <p className={`mt-0.5 ${body}`}>{account.connected ? 'Connected' : 'Sign-in required'}
                {account.runningTurns > 0 && ` · ${account.runningTurns} ${account.runningTurns === 1 ? 'turn' : 'turns'} running`}
              </p>
            </div>
            {state.version && <div className="flex flex-wrap gap-1.5">
              {!account.connected && <button type="button" className={button} disabled={busy} onClick={() => void perform('sign-in', { accountId: account.id })}>Sign in</button>}
              {account.connected && <button type="button" className={button} disabled={busy} onClick={() => void perform('refresh', { accountId: account.id })}>
                <RefreshCw size={13} aria-hidden="true" />Refresh models
              </button>}
              {account.connected ? <button type="button" className={button} disabled={busy || account.runningTurns > 0} onClick={() => void perform('sign-out', { accountId: account.id })}>
                <LogOut size={13} aria-hidden="true" />Sign out
              </button> : <button type="button" className={button} disabled={busy || account.runningTurns > 0} onClick={() => void perform('remove', { accountId: account.id })}>Remove</button>}
            </div>}
          </li>;
        })}
      </ul> : null}
      {(error || state?.error) && <p role="alert" className="border-t border-[var(--border)] px-4 py-3 text-xs text-[var(--destructive)]">{error || state?.error}</p>}
    </section>

    {connected.length > 0 && <section data-settings-search-target="antigravity-models" tabIndex={-1} className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--input-bg)]">
      <div className="flex flex-wrap items-center justify-between gap-2 p-4">
        <div>
          <h4 className="text-sm font-semibold text-[var(--foreground)]">Available models</h4>
          <p className={`mt-1 ${body}`}>{state?.models.length ?? 0} across connected accounts</p>
        </div>
      </div>
      {state?.models.length ? <ul className="max-h-64 divide-y divide-[var(--border)] overflow-auto border-t border-[var(--border)] eterx-scrollbar">
        {state.models.map(model => <li className="flex items-center gap-2 px-4 py-2.5 text-xs text-[var(--foreground)]" key={model.id}>
          <ProviderIconAsset provider="antigravity" className="size-4" />
          <span className="min-w-0 break-words">{model.label}</span>
        </li>)}
      </ul> : <p className={`border-t border-[var(--border)] px-4 py-3 ${body}`}>No models are available for this account.</p>}
    </section>}
  </div>;
}

export function SubscriptionProviders({ provider, onSelect }: { provider: SubscriptionProvider; onSelect: (provider: SubscriptionProvider) => void }) {
  const codex = useChatGptSubscription();
  const antigravity = useAntigravity();
  const native = useNativeProviders();
  const connectedAccounts = antigravity?.version ? antigravity.accounts.filter(account => account.connected).length : 0;
  const providers = [
    { id: 'codex', name: SUBSCRIPTION_PROVIDER_NAMES.codex, connected: codex?.status === 'connected', status: codex?.status === 'connected' ? 'ChatGPT connected' : 'Connect ChatGPT' },
    { id: 'antigravity', name: SUBSCRIPTION_PROVIDER_NAMES.antigravity, connected: connectedAccounts > 0, status: connectedAccounts ? `${connectedAccounts} connected`
      : antigravity?.activity === 'installing' ? 'Installing…' : antigravity?.version ? 'Sign in with Google' : 'Set up' },
    ...NATIVE_PROVIDERS.map(id => {
      const status = native?.providers[id];
      const connected = status?.accounts.filter(account => account.connected).length ?? 0;
      return { id, name: SUBSCRIPTION_PROVIDER_NAMES[id], connected: connected > 0,
        status: connected ? connected + ' connected' : status?.activity === 'sign-in' ? 'Signing in…' : 'Set up' };
    }),
  ] as const;

  return <div className={styles.container}>
    <div className={styles.layout}>
      <nav className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--input-bg)] p-1.5" aria-label="Subscription providers">
        <div className={styles.providers}>
          {providers.map(item => <button key={item.id} type="button" aria-pressed={provider === item.id} onClick={() => onSelect(item.id)}
            className={`group flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-3 text-left transition-colors focus-visible:outline-2 ${provider === item.id ? 'bg-[var(--muted)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]'}`}>
            <ProviderIconAsset provider={item.id} className="size-[18px]" />
            <span className="min-w-0 flex-1"><span className="block text-[13px] font-semibold leading-5">{item.name}</span>
              <span className="flex items-center gap-1.5 text-[11px] leading-4 text-[var(--muted-foreground)]">
                {item.connected && <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />}{item.status}
              </span>
            </span>
            {provider === item.id && <ChevronRight size={14} className="hidden shrink-0 sm:block" aria-hidden="true" />}
          </button>)}
        </div>
      </nav>
      <div className="min-w-0" aria-label={(providers.find(item => item.id === provider)?.name || 'Provider') + ' settings'}>
        {provider === 'codex' ? <SubscriptionSettings /> : provider === 'antigravity' ? <AntigravitySettings />
          : <NativeSubscriptionSettings key={provider} provider={provider} />}
      </div>
    </div>
    <div className="mt-4"><SubscriptionLimitSettings onManage={onSelect} /></div>
  </div>;
}
