'use client';

import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowRightLeft, Check, CircleGauge, LoaderCircle, LogOut, MoreHorizontal, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  getDesktopSubscription, useChatGptSubscription,
  type ChatGptAccount, type ChatGptObservedUsage, type ChatGptSwitchMode,
} from '../../lib/chatgpt-subscription-client';
import { IdentityAvatar } from '../ui/identity-avatar';
import { ProviderIconAsset } from '../ui/provider-icon';

const card = 'rounded-xl border border-[var(--border)] bg-[var(--input-bg)]';
const bodyText = 'text-[12px] leading-relaxed text-[var(--muted-foreground)]';
const control = 'inline-flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
const secondary = `${control} border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--muted)]`;
const primary = `${control} bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90`;
const menuItem = 'flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[12px] font-medium outline-hidden transition-colors data-[highlighted]:bg-[var(--muted)] data-[highlighted]:text-[var(--foreground)]';
const warning = 'text-amber-800 dark:text-amber-200';
const positive = 'text-emerald-800 dark:text-emerald-300';
const accountLabels = {
  connected: 'Signed in',
  disconnected: 'Signed out',
  'consent-required': 'Plan permission needed',
  pending: 'Sign-in incomplete',
};
const usageLabels: Record<ChatGptObservedUsage['status'], string> = {
  completed: 'Last request completed',
  'plan-limit': 'Plan or app limit reached',
  'rate-limited': 'Request rate limited',
  unavailable: 'Usage check temporarily unavailable',
  ineligible: 'Plan usage unavailable for this account',
};
const busyLabels = {
  switching: 'Switching ChatGPT accounts…',
  disconnecting: 'Signing out of ChatGPT…',
  removing: 'Removing saved account…',
};

type AccountDialog = { kind: 'add' | 'welcome' }
  | { kind: 'connect' | 'disconnect' | 'remove'; account: ChatGptAccount }
  | { kind: 'change'; account: ChatGptAccount; activeWork: number };

function getDialogCopy(dialog: AccountDialog) {
  switch (dialog.kind) {
    case 'add':
      return { title: 'Add a ChatGPT account', description: 'Choose an account and workspace in your browser. Your current account stays active until you switch.' };
    case 'change':
      return {
        title: 'Agents are working',
        description: `There ${dialog.activeWork === 1 ? 'is 1 active run' : `are ${dialog.activeWork} active runs`}. Change & Resume lets current requests finish, switches to ${dialog.account.email || 'the selected ChatGPT account'}, and continues the same work.`,
      };
    case 'connect':
      return {
        title: dialog.account.status === 'pending' ? 'Resume ChatGPT sign-in' : 'Continue with a saved account',
        description: dialog.account.email
          ? `Choose ${dialog.account.email} in your browser to continue.`
          : 'Continue with the saved ChatGPT account in your browser.',
      };
    case 'disconnect':
      return {
        title: 'Sign out of ChatGPT?',
        description: `${dialog.account.email || 'This ChatGPT account'} will stay in your account list so you can reconnect it later.`,
      };
    case 'remove':
      return {
        title: 'Remove saved account?',
        description: `${dialog.account.email || 'This ChatGPT account'} will be removed from this device. You can add the account again through ChatGPT.`,
      };
    case 'welcome':
      return {
        title: 'You’re using your ChatGPT plan',
        description: 'Eligible Codex requests in EterX use your active ChatGPT account’s plan or credits. You can review usage and app limits in ChatGPT settings.',
      };
  }
}

function ChatGptSignInButton({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={primary} disabled={disabled} onClick={onClick}>
      <span aria-hidden="true" className="size-4 shrink-0 bg-current [mask:url(/icons/providers/openai.svg)_center/contain_no-repeat]" />
      Continue with ChatGPT
    </button>
  );
}

function AccountRow({
  account, selected, disabled, onSwitch, onAction,
}: {
  account: ChatGptAccount;
  selected: boolean;
  disabled: boolean;
  onSwitch: () => void;
  onAction: (kind: 'connect' | 'disconnect' | 'remove') => void;
}) {
  const connected = account.status === 'connected';
  const hasSession = connected || account.status === 'consent-required';
  const title = account.email || (account.status === 'pending' ? 'Unfinished connection' : 'ChatGPT account');
  const subtitle = selected && connected ? null : accountLabels[account.status];
  const reconnect = account.status === 'pending' ? 'Resume sign-in'
    : account.status === 'consent-required' ? 'Enable plan usage' : 'Reconnect';

  return (
    <li className={`flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3 ${selected && connected ? 'bg-emerald-500/[0.035]' : ''}`}>
      <div className="flex min-w-0 flex-1 basis-[12rem] items-center gap-3">
        <IdentityAvatar identity={account.id} name={title} size={40} />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-[var(--foreground)]" title={title}>{title}</p>
          {subtitle && <p className={`mt-0.5 ${bodyText}`}>{subtitle}</p>}
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {connected && selected ? (
          <span className={`inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold ${positive}`}>
            <Check className="size-3" aria-hidden="true" /> Active
          </span>
        ) : connected ? (
          <button type="button" className={secondary} disabled={disabled} onClick={onSwitch}>
            <ArrowRightLeft className="size-3.5" aria-hidden="true" /> Use account
          </button>
        ) : (
          <button type="button" className={secondary} disabled={disabled} onClick={() => onAction('connect')}>{reconnect}</button>
        )}
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button type="button" className={`${secondary} h-9 w-9 px-0 data-[state=open]:bg-[var(--muted)] data-[state=open]:text-[var(--foreground)]`} disabled={disabled} aria-label={`Options for ${title}`}>
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={6} collisionPadding={12} className="z-[100100] min-w-40 rounded-xl border border-[var(--border)] bg-[var(--input-bg)] p-1.5 text-[var(--foreground)] shadow-xl shadow-black/20">
              {connected && (
                <DropdownMenu.Item className={menuItem} onSelect={() => onAction('connect')}>
                  <RefreshCw className="size-3.5" aria-hidden="true" /> Reconnect
                </DropdownMenu.Item>
              )}
              {hasSession ? (
                <DropdownMenu.Item className={menuItem} onSelect={() => onAction('disconnect')}>
                  <LogOut className="size-3.5" aria-hidden="true" /> Sign out
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Item className={`${menuItem} text-red-700 dark:text-red-300`} onSelect={() => onAction('remove')}>
                  <Trash2 className="size-3.5" aria-hidden="true" /> Remove account
                </DropdownMenu.Item>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </li>
  );
}

function UsageStatus({ usage }: { usage: ChatGptObservedUsage | null }) {
  const date = usage ? new Date(usage.observedAt) : null;
  return (
    <section data-settings-search-target="chatgpt-usage" tabIndex={-1} className={card}>
      <div className="flex items-start gap-3 p-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--muted)] text-[var(--muted-foreground)]">
          <CircleGauge className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h4 className="text-[13px] font-semibold text-[var(--foreground)]">ChatGPT usage status</h4>
          <p className={`mt-1 ${bodyText}`}>Status reported by OpenAI for this account in EterX. Remaining plan usage and reset times are available in ChatGPT settings.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-[var(--border)] px-4 py-3" role="status">
        <span className={`flex items-center gap-2 text-[12px] font-medium ${usage ? usage.status === 'completed' ? positive : warning : 'text-[var(--muted-foreground)]'}`}>
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
          {usage ? usageLabels[usage.status] : 'No requests observed in this session'}
        </span>
        {date && (
          <time className={bodyText} dateTime={date.toISOString()}>
            {date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </time>
        )}
      </div>
    </section>
  );
}

export function SubscriptionSettings() {
  const desktop = getDesktopSubscription();
  const state = useChatGptSubscription();
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState('');
  const [dialog, setDialog] = useState<AccountDialog | null>(null);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const accounts = state?.accounts ?? [];
  const available = Boolean(desktop && state?.available);
  const busy = pending || Boolean(state?.authorizing || state?.accountAction);
  const shownDialog = dialog ?? (available && state?.planWelcomePending && !welcomeDismissed ? { kind: 'welcome' } as const : null);
  const dialogCopy = shownDialog && getDialogCopy(shownDialog);
  const isSignInDialog = shownDialog?.kind === 'add' || shownDialog?.kind === 'connect';
  const active = accounts.find(account => account.id === state?.activeAccountId);
  const orderedAccounts = active ? [active, ...accounts.filter(account => account !== active)] : accounts;
  const connecting = accounts.find(account => account.id === state?.authorizingAccountId);

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

  function closeDialog() {
    if (shownDialog?.kind === 'welcome' && desktop) {
      setWelcomeDismissed(true);
      void perform(desktop.dismissPlanWelcome);
    } else {
      setDialog(null);
    }
  }

  function useAccount(account: ChatGptAccount, mode: ChatGptSwitchMode = 'idle') {
    if (!desktop) return;
    if (mode !== 'idle') setDialog(null);
    void perform(async () => {
      const result = await desktop.switchAccount(account.id, mode);
      if (!result) throw new Error('Account change was unavailable.');
      if (result.activeWork > 0) setDialog({ kind: 'change', account, activeWork: result.activeWork });
    });
  }

  function confirmDialog() {
    if (!desktop || !shownDialog) return;
    setDialog(null);
    switch (shownDialog.kind) {
      case 'welcome': closeDialog(); break;
      case 'add': void perform(() => desktop.signIn()); break;
      case 'connect': void perform(() => desktop.signIn(shownDialog.account.id)); break;
      case 'disconnect': void perform(() => desktop.disconnect(shownDialog.account.id)); break;
      case 'remove': void perform(() => desktop.removeAccount(shownDialog.account.id)); break;
      case 'change': useAccount(shownDialog.account, 'resume'); break;
    }
  }

  return (
    <div className="space-y-4">
      <section data-settings-search-target="chatgpt-subscription" tabIndex={-1} className={card}>
        <div className="flex flex-wrap items-start gap-3.5 p-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-[var(--border)] bg-[var(--muted)]">
            <ProviderIconAsset provider="codex" className="size-5" />
          </span>
          <div className="min-w-0 flex-1 basis-[12rem]">
            <h4 className="text-[14px] font-semibold text-[var(--foreground)]">Codex accounts</h4>
            <p className={`mt-1 ${bodyText}`}>Connect your ChatGPT account and workspace.</p>
          </div>
          {available && desktop && (accounts.length ? (
            <button type="button" className={secondary} disabled={busy} onClick={() => setDialog({ kind: 'add' })}>
              <Plus className="size-3.5" aria-hidden="true" /> Add account
            </button>
          ) : (
            <ChatGptSignInButton disabled={busy} onClick={() => void perform(() => desktop.signIn())} />
          ))}
        </div>

        {!desktop || state?.available === false ? (
          <p className={`border-t border-[var(--border)] px-4 py-3 ${bodyText}`}>
            {state?.error || (desktop ? 'ChatGPT sign-in needs access to your system credential store.' : 'Open EterX desktop to connect a ChatGPT plan.')}
          </p>
        ) : !state ? (
          <p className={`flex items-center gap-2 border-t border-[var(--border)] px-4 py-3 ${bodyText}`} role="status">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> Loading accounts…
          </p>
        ) : (
          <>
            {orderedAccounts.length > 0 && (
              <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]" aria-label="Saved ChatGPT accounts">
                {orderedAccounts.map(account => (
                  <AccountRow key={account.id} account={account} selected={account.id === state.activeAccountId}
                    disabled={busy} onSwitch={() => useAccount(account)}
                    onAction={kind => setDialog({ kind, account })} />
                ))}
              </ul>
            )}
            {state.authorizing && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-3">
                <p className={`flex min-w-0 items-center gap-2 ${bodyText}`} role="status">
                  <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
                  {connecting?.email ? `Continue as ${connecting.email} in your browser.` : 'Choose your ChatGPT account and workspace in your browser.'}
                </p>
                <button type="button" className={secondary} disabled={pending || !state.canCancel} onClick={() => void perform(desktop.cancel)}>Cancel</button>
              </div>
            )}
            {state.accountAction && (
              <p className={`flex items-center gap-2 border-t border-[var(--border)] px-4 py-3 ${bodyText}`} role="status">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> {busyLabels[state.accountAction]}
              </p>
            )}
            {(actionError || state.error) && (
              <p className={`border-t border-[var(--border)] px-4 py-3 text-[12px] leading-relaxed ${warning}`} role="status">{actionError || state.error}</p>
            )}
          </>
        )}
      </section>

      {desktop && state?.available && state.status === 'connected' && (
        <>
          <section data-settings-search-target="chatgpt-models" tabIndex={-1} className={card}>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <h4 className="text-[13px] font-semibold text-[var(--foreground)]">Available models</h4>
                <p className={`mt-0.5 ${bodyText}`}>Models for the active ChatGPT account.</p>
              </div>
              <button type="button" className={secondary} disabled={busy || state.refreshing} onClick={() => void perform(desktop.refreshModels)}>
                <RefreshCw className={`size-3.5 ${state.refreshing ? 'animate-spin' : ''}`} aria-hidden="true" /> Refresh
              </button>
            </div>
            {state.models.length > 0 ? (
              <ul className="eterx-scrollbar max-h-52 divide-y divide-[var(--border)] overflow-y-auto border-t border-[var(--border)]">
                {state.models.map(model => (
                  <li key={model.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5">
                    <span className="min-w-0 break-words text-[12px] font-medium text-[var(--foreground)]">{model.label}</span>
                    {model.id !== model.label && <span className={`min-w-0 break-all ${bodyText}`}>{model.id}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={`border-t border-[var(--border)] px-4 py-3 ${bodyText}`} role="status">
                {state.catalogError || (state.refreshing || !state.catalogReady ? 'Loading models…' : 'No models are available for this account.')}
              </p>
            )}
            {state.models.length > 0 && state.catalogError && (
              <p className={`border-t border-[var(--border)] px-4 py-3 text-[12px] ${warning}`} role="status">{state.catalogError}</p>
            )}
          </section>
          <UsageStatus usage={state.usage} />
        </>
      )}

      {shownDialog && dialogCopy && (
        <Dialog.Root open onOpenChange={open => { if (!open) closeDialog(); }}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-[100101] bg-black/45 backdrop-blur-[2px]" />
            <Dialog.Content data-subscription-dialog className="fixed top-1/2 left-1/2 z-[100102] w-[calc(100%_-_2rem)] max-w-[450px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border)] bg-[var(--input-bg)] p-5 text-[var(--foreground)] shadow-xl">
              <Dialog.Title className="text-[15px] font-semibold">{dialogCopy.title}</Dialog.Title>
              <Dialog.Description className={`mt-2 break-words ${bodyText}`}>{dialogCopy.description}</Dialog.Description>
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                {shownDialog.kind !== 'welcome' && (
                  <Dialog.Close asChild><button type="button" className={secondary}>{shownDialog.kind === 'change' ? 'Close' : 'Cancel'}</button></Dialog.Close>
                )}
                {shownDialog.kind === 'change' ? (
                  <>
                    <button type="button" className={`${secondary} text-red-700 dark:text-red-300`} disabled={busy} onClick={() => useAccount(shownDialog.account, 'stop')}>Stop all and switch</button>
                    <button type="button" className={primary} disabled={busy} onClick={confirmDialog}>Change &amp; Resume</button>
                  </>
                ) : isSignInDialog ? (
                  <ChatGptSignInButton disabled={busy} onClick={confirmDialog} />
                ) : (
                  <button type="button" className={primary} disabled={pending} onClick={confirmDialog}>
                    {shownDialog.kind === 'welcome' ? 'Got it' : shownDialog.kind === 'disconnect' ? 'Sign out' : 'Remove'}
                  </button>
                )}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </div>
  );
}
