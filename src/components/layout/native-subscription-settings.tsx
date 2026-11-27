'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CircleCheck, LoaderCircle, LogOut, RefreshCw, UserPlus } from 'lucide-react';
import { desktopNativeProvider, requestNativeProvider, useNativeProviders } from '../../lib/native-provider-client';
import { NATIVE_PROVIDER_INFO, type NativeProvider, type NativeProviderRequest } from '../../lib/native-provider-contract';
import { ProviderIconAsset } from '../ui/provider-icon';

const button = 'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--muted)] px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50';
const field = 'min-h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 text-xs text-[var(--foreground)] focus-visible:outline-2';
const muted = 'text-xs leading-relaxed text-[var(--muted-foreground)]';

export function NativeSubscriptionSettings({ provider }: { provider: NativeProvider }) {
  const state = useNativeProviders()?.providers[provider];
  const meta = NATIVE_PROVIDER_INFO[provider];
  const cli = provider !== 'cursor';
  const [connecting, setConnecting] = useState(false);
  const [accountId, setAccountId] = useState<string>();
  const [label, setLabel] = useState('');
  const [method, setMethod] = useState<'browser' | 'api-key'>('browser');
  const [apiKey, setApiKey] = useState('');
  const [binary, setBinary] = useState<string>();
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const watching = useRef(false);
  const startedSignIn = useRef(false);
  const opened = useRef('');
  const connected = state?.accounts.filter(account => account.connected) ?? [];
  const busy = sending || Boolean(state?.activity);

  useEffect(() => {
    if (!cli || !state || state.activity || state.version || watching.current) return;
    watching.current = true;
    void requestNativeProvider({ action: 'refresh', provider }).catch(() => setError('Could not read the installed runtime.'));
  }, [cli, provider, state]);

  useEffect(() => {
    const url = state?.authorizationUrl;
    if (!url || !startedSignIn.current || opened.current === url) return;
    opened.current = url;
    const bridge = (window as Window & { electronAPI?: { openExternal?: (url: string) => Promise<unknown> } }).electronAPI;
    void bridge?.openExternal?.(url)?.catch(() => undefined);
  }, [state?.authorizationUrl]);

  async function perform(request: Omit<NativeProviderRequest, 'provider'>) {
    setSending(true);
    setError('');
    try {
      if (request.action === 'sign-in') { startedSignIn.current = true; opened.current = ''; }
      await requestNativeProvider({ ...request, provider });
      if (request.action === 'sign-in') { setConnecting(false); setLabel(''); setApiKey(''); }
      if (request.action === 'binary') setBinary(undefined);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') : 'Could not update the connection.';
      setError(message);
    } finally { setSending(false); }
  }

  function add(id?: string) {
    setConnecting(true);
    setAccountId(id);
    setApiKey('');
    setMethod('browser');
  }

  const signinCopy = provider === 'claude-code' ? 'Sign in through Claude Code' : 'Sign in with ' + meta.auth;
  const runtimeAvailable = Boolean(state?.version);
  return <div className="space-y-4">
    <section tabIndex={-1} data-settings-search-target={provider + '-connection'} className="rounded-xl border border-[var(--border)] bg-[var(--input-bg)]">
      <header className="flex flex-wrap items-center gap-3 p-4">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-[var(--border)] bg-[var(--muted)]">
          <ProviderIconAsset provider={provider} className="size-6" />
        </div>
        <div className="min-w-0 flex-1 basis-32">
          <h4 className="text-sm font-semibold">{meta.name}</h4>
          <p className={'mt-0.5 ' + muted}>{connected.length ? connected.length + (connected.length === 1 ? ' account connected' : ' accounts connected') : 'Connect an account to choose its models.'}</p>
        </div>
        {runtimeAvailable && <button type="button" className={button} disabled={busy || connecting} onClick={() => add()}>
          <UserPlus size={14} aria-hidden="true" />{state?.accounts.length ? 'Add account' : 'Connect account'}
        </button>}
      </header>
      {!desktopNativeProvider() ? <p className={'border-t border-[var(--border)] px-4 py-3 ' + muted}>Open EterX desktop to connect this provider.</p>
        : !state ? <p role="status" className={'border-t border-[var(--border)] px-4 py-3 ' + muted}>Loading provider settings…</p>
        : <>
          {cli && <div className="space-y-2 border-t border-[var(--border)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold">Local runtime</p>
                <p className={'mt-0.5 ' + muted}>{state.version ? 'Version ' + state.version : 'Install the official CLI to connect an account.'}</p>
              </div>
              {!state.version && <a href={meta.setupUrl} target="_blank" rel="noreferrer" className={button}>
                Installation guide<ArrowUpRight size={13} aria-hidden="true" />
              </a>}
            </div>
            <form className="space-y-1.5" onSubmit={event => { event.preventDefault(); void perform({ action: 'binary', binaryPath: binary ?? state.binaryPath }); }}>
              <label className={'block ' + muted} htmlFor={provider + '-binary'}>CLI executable path</label>
              <div className="flex flex-wrap gap-2">
                <input id={provider + '-binary'} className={field + ' basis-36'} value={binary ?? state.binaryPath} maxLength={1024}
                  autoComplete="off" spellCheck={false} placeholder="Find automatically" onChange={event => setBinary(event.target.value)} />
                <button className={button} disabled={busy} type="submit">{binary === undefined ? 'Refresh runtime' : 'Save path'}</button>
              </div>
            </form>
          </div>}
          {connecting && <form className="space-y-3 border-t border-[var(--border)] p-4" onSubmit={event => {
            event.preventDefault();
            void perform({ action: 'sign-in', accountId, label: label.trim(), apiKey: method === 'api-key' ? apiKey.trim() : undefined });
          }}>
            {!accountId && <label className={'flex flex-col gap-1.5 ' + muted}>
              Account label (optional)
              <input className={field} value={label} maxLength={80} autoComplete="off" placeholder="Personal or work" onChange={event => setLabel(event.target.value)} />
            </label>}
            {meta.apiKey && <div className="flex flex-wrap gap-2" aria-label="Sign-in method">
              <button type="button" aria-pressed={method === 'browser'} className={button} onClick={() => { setMethod('browser'); setApiKey(''); }}>Browser sign-in</button>
              <button type="button" aria-pressed={method === 'api-key'} className={button} onClick={() => setMethod('api-key')}>API key</button>
            </div>}
            {method === 'api-key' && <label className={'flex flex-col gap-1.5 ' + muted}>
              Cursor API key
              <input className={field} value={apiKey} type="password" maxLength={4096} autoComplete="off" spellCheck={false}
                onChange={event => setApiKey(event.target.value)} />
            </label>}
            {provider === 'claude-code' && <p className={muted}>Your installed Claude Code CLI opens the browser and keeps your sign-in in its own profile.</p>}
            <div className="flex flex-wrap gap-2">
              <button className={button} type="submit" disabled={busy || (method === 'api-key' && !apiKey.trim())}>
                {method === 'api-key' ? 'Connect API key' : signinCopy}
              </button>
              <button className={button} type="button" onClick={() => { setConnecting(false); setApiKey(''); setLabel(''); }} disabled={sending}>Cancel</button>
            </div>
          </form>}
          {state.activity && <div className="space-y-2 border-t border-[var(--border)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className={'flex items-center gap-2 ' + muted} role="status">
                <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                {state.activity === 'sign-in' ? 'Waiting for ' + meta.auth + ' sign-in…' : state.activity === 'refresh' ? 'Refreshing provider…' : 'Signing out…'}
              </p>
              {state.activity === 'sign-in' && <button type="button" className={button} disabled={sending}
                onClick={() => void perform({ action: 'cancel' })}>Cancel</button>}
            </div>
            {state.authorizationUrl && <div className="flex flex-wrap items-center gap-2">
              <a href={state.authorizationUrl} target="_blank" rel="noreferrer" className={button}>
                Open {meta.auth} sign-in<ArrowUpRight size={13} aria-hidden="true" />
              </a>
              {state.deviceCode && <p className={muted}>Enter code <code className="select-all rounded bg-[var(--muted)] px-2 py-1 font-semibold text-[var(--foreground)]">{state.deviceCode}</code></p>}
            </div>}
          </div>}
          {state.accounts.length > 0 && <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]" aria-label={meta.name + ' accounts'}>
            {state.accounts.map(account => <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-3" key={account.id}>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 break-all text-xs font-semibold">
                  {account.connected && <CircleCheck size={13} className="text-emerald-500" aria-hidden="true" />}{account.label}
                </p>
                <p className={'mt-0.5 ' + muted}>{account.connected ? (account.method === 'api-key' ? 'API key connected' : 'Connected') : 'Sign-in required'}
                  {account.runningTurns > 0 && ' · ' + account.runningTurns + (account.runningTurns === 1 ? ' turn running' : ' turns running')}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {!account.connected && <button className={button} type="button" disabled={busy || !runtimeAvailable} onClick={() => add(account.id)}>Reconnect</button>}
                {account.connected && <button className={button} type="button" disabled={busy}
                  onClick={() => void perform({ action: 'refresh', accountId: account.id })}><RefreshCw size={13} aria-hidden="true" />Refresh models</button>}
                {account.connected && <button className={button} type="button" disabled={busy || account.runningTurns > 0}
                  onClick={() => void perform({ action: 'sign-out', accountId: account.id })}><LogOut size={13} aria-hidden="true" />Sign out</button>}
              </div>
            </li>)}
          </ul>}
        </>}
      {(error || state?.error) && <p role="alert" className="border-t border-[var(--border)] px-4 py-3 text-xs text-[var(--destructive)]">{error || state?.error}</p>}
    </section>
    {connected.length > 0 && <section tabIndex={-1} data-settings-search-target={provider + '-models'} className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--input-bg)]">
      <header className="flex flex-wrap items-center justify-between gap-2 p-4">
        <div>
          <h4 className="text-sm font-semibold">Available models</h4>
          <p className={'mt-0.5 ' + muted}>{state?.models.length ?? 0} across connected accounts</p>
        </div>
      </header>
      {state?.models.length ? <ul className="max-h-64 divide-y divide-[var(--border)] overflow-auto border-t border-[var(--border)] eterx-scrollbar">
        {state.models.map(model => <li key={model.id} className="flex items-center gap-2 px-4 py-2.5 text-xs">
          <ProviderIconAsset provider={provider} className="size-4" /><span className="min-w-0 break-words">{model.label}</span>
        </li>)}
      </ul> : <p className={'border-t border-[var(--border)] px-4 py-3 ' + muted}>No models are available for this account.</p>}
    </section>}
  </div>;
}
