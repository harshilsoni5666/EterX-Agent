'use client';

import { ArrowUpRight, BadgeCheck, CircleGauge, LoaderCircle, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { getDesktopSubscription, useChatGptSubscription } from '../../lib/chatgpt-subscription-client';
import { ProviderIconAsset } from '../ui/provider-icon';

const secondaryButton = 'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md border border-white/[0.10] bg-white/[0.035] px-3 text-[12px] font-medium text-[#DEDEDE] transition-colors hover:bg-white/[0.075] disabled:opacity-50';

export function SubscriptionSettings() {
  const desktop = getDesktopSubscription();
  const state = useChatGptSubscription();
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState('');
  const connected = state?.available && state.status === 'connected';
  const authorizing = state?.status === 'authorizing';
  const needsConsent = state?.status === 'consent-required';

  async function perform(action: () => Promise<unknown>) {
    setPending(true);
    setActionError('');
    try {
      await action();
    } catch {
      setActionError('The action could not be completed. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <section data-settings-search-target="chatgpt-subscription" tabIndex={-1} className="rounded-xl border border-white/[0.09] bg-[#1C1C1C]">
        <div className="flex items-start gap-3.5 p-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-white/[0.10] bg-white/[0.05]">
            <ProviderIconAsset provider="openai" className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-[14px] font-semibold text-[#F4F4F4]">Codex</h4>
              {connected && <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/20 bg-emerald-400/[0.08] px-2 py-0.5 text-[11px] text-emerald-300"><BadgeCheck className="size-3" /> Using ChatGPT plan</span>}
            </div>
            <p className="mt-1 text-[12px] leading-[1.6] text-[#9C9C9C]">Connect your ChatGPT account to use its available models in EterX.</p>
            {(connected || needsConsent) && state?.email && <p className="mt-1 truncate text-[12px] text-[#C2C2C2]" title={state.email}>{state.email}</p>}
          </div>
        </div>
        <div className="space-y-3 border-t border-white/[0.07] px-4 py-3">
          {!desktop || state?.available === false ? (
            <p className="text-[12px] text-[#A7A7A7]">{desktop
              ? 'ChatGPT sign-in needs the local EterX runtime and access to your system credential store.'
              : 'Open the EterX desktop app to connect a ChatGPT plan.'}</p>
          ) : !state ? (
            <p className="flex items-center gap-2 text-[12px] text-[#A7A7A7]" role="status"><LoaderCircle className="size-3.5 animate-spin" /> Loading connection</p>
          ) : state.disconnecting ? (
            <p className="flex items-center gap-2 text-[12px] text-[#A7A7A7]" role="status"><LoaderCircle className="size-3.5 animate-spin" /> Disconnecting ChatGPT</p>
          ) : authorizing ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-[12px] text-[#C7C7C7]" role="status"><LoaderCircle className="size-3.5 animate-spin" /> Continue in your browser.</p>
              <button type="button" className={secondaryButton} disabled={pending || !state.canCancel} onClick={() => void perform(desktop.cancel)}>Cancel</button>
            </div>
          ) : connected ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={secondaryButton} disabled={pending || state.refreshing} onClick={() => void perform(desktop.refreshModels)}><RefreshCw className={`size-3.5 ${state.refreshing ? 'animate-spin' : ''}`} /> Refresh models</button>
              <button type="button" className={secondaryButton} disabled={pending} onClick={() => void perform(() => desktop.signIn())}>Reconnect</button>
              <button type="button" className={secondaryButton} disabled={pending} onClick={() => void perform(desktop.disconnect)}>Disconnect</button>
            </div>
          ) : (
            <>
              {needsConsent && <p className="text-[12px] leading-[1.6] text-[#C7C7C7]">You’re signed in. Enable ChatGPT plan usage to load your models.</p>}
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" disabled={pending} onClick={() => void perform(() => desktop.signIn())} className="inline-flex min-h-8 items-center gap-2 rounded-md bg-[#F4F4F4] px-3 text-[12px] font-semibold text-[#171717] transition-colors hover:bg-white disabled:opacity-50">
                  <img src="/icons/providers/openai.svg" alt="" className="size-4 brightness-0" />
                  {needsConsent ? 'Enable ChatGPT plan usage' : 'Continue with ChatGPT'}
                </button>
                {state.hasRegistration && <button type="button" className={secondaryButton} disabled={pending} onClick={() => void perform(() => desktop.signIn(true))}>Use another account</button>}
                {needsConsent && <button type="button" className={secondaryButton} disabled={pending} onClick={() => void perform(desktop.disconnect)}>Disconnect</button>}
              </div>
            </>
          )}
          {(actionError || state?.error) && <p className="text-[12px] leading-[1.6] text-[#F4B7A6]" role="status">{actionError || state?.error}</p>}
        </div>
      </section>

      {connected && state && desktop && (
        <>
          <section data-settings-search-target="chatgpt-usage" tabIndex={-1} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.09] bg-[#1C1C1C] p-4">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <CircleGauge className="mt-0.5 size-4 shrink-0 text-[#A7A7A7]" />
              <div>
                <h4 className="text-[13px] font-semibold text-[#F4F4F4]">ChatGPT usage</h4>
                <p className="mt-1 text-[12px] leading-[1.6] text-[#A7A7A7]">View your current limits and usage across connected apps in ChatGPT.</p>
              </div>
            </div>
            <button type="button" className={secondaryButton} onClick={() => void perform(desktop.openUsage)}>Manage usage <ArrowUpRight className="size-3.5" /></button>
          </section>

          <section data-settings-search-target="chatgpt-models" tabIndex={-1} className="rounded-xl border border-white/[0.09] bg-[#1C1C1C]">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <h4 className="text-[13px] font-semibold text-[#F4F4F4]">Available models</h4>
              {state.models.length > 0 && <span className="text-[11px] text-[#A7A7A7]">{state.models.length} in the model picker</span>}
            </div>
            {state.models.length > 0 ? (
              <ul className="max-h-52 divide-y divide-white/[0.06] overflow-y-auto border-t border-white/[0.07] eterx-scrollbar">
                {state.models.map(model => <li key={model.id} className="flex items-center justify-between gap-4 px-4 py-2.5"><span className="truncate text-[12px] text-[#DEDEDE]">{model.label}</span><span className="truncate text-[11px] text-[#999]" title={model.id}>{model.id}</span></li>)}
              </ul>
            ) : <p className="border-t border-white/[0.07] px-4 py-3 text-[12px] text-[#A7A7A7]" role="status">{state.refreshing ? 'Loading models…' : state.error ? 'Refresh models to try again.' : 'No models are available for this account.'}</p>}
          </section>
        </>
      )}
    </div>
  );
}
