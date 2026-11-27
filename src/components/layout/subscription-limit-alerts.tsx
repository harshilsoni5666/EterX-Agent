'use client';

import { useId, useState } from 'react';
import { Bell, ChevronRight, X } from 'lucide-react';
import { SUBSCRIPTION_PROVIDER_NAMES, type SubscriptionProvider } from '../../lib/native-provider-contract';
import {
  setSubscriptionLimitAlertsEnabled, useSubscriptionLimitAlertsEnabled, useSubscriptionLimitNotices,
  type SubscriptionLimitNotice,
} from '../../lib/subscription-limit-client';
import { ProviderIconAsset } from '../ui/provider-icon';

const titles = { plan: 'Plan limit reached', request: 'Requests temporarily limited', included: 'Included quota used' };
const resetFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function NoticeDetail({ notice }: { notice: SubscriptionLimitNotice }) {
  return <span className="block break-words text-xs leading-relaxed text-[var(--muted-foreground)]">
    {notice.accountLabel}{notice.window && ' · ' + notice.window}
    {notice.retryAt && <> · {notice.kind === 'included' ? 'Resets' : 'Try after'}{' '}
      <time dateTime={new Date(notice.retryAt).toISOString()}>{resetFormat.format(notice.retryAt)}</time></>}
  </span>;
}

export function SubscriptionLimitSettings({ onManage }: { onManage: (provider: SubscriptionProvider) => void }) {
  const enabled = useSubscriptionLimitAlertsEnabled();
  const notices = useSubscriptionLimitNotices(enabled);
  const helpId = useId();
  return <section data-settings-search-target="subscription-limit-alerts" tabIndex={-1}
    className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--input-bg)]">
    <div className="flex items-center gap-3 p-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--border)] bg-[var(--muted)]">
        <Bell size={16} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-semibold text-[var(--foreground)]">Show subscription limit alerts</h4>
        <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted-foreground)]" id={helpId}>
          Get an alert when a connected subscription reports a limit. See the reset time when the provider shares it.
        </p>
      </div>
      <button type="button" role="switch" aria-checked={enabled} aria-label="Show subscription limit alerts" aria-describedby={helpId}
        onClick={() => setSubscriptionLimitAlertsEnabled(!enabled)}
        className={'relative h-6 w-11 shrink-0 rounded-full border border-[var(--border)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ' +
          (enabled ? 'bg-[#2F8BEF]' : 'bg-[var(--muted)]')}>
        <span aria-hidden="true" className={'absolute left-[2px] top-[2px] size-[18px] rounded-full transition-transform motion-reduce:transition-none ' +
          (enabled ? 'translate-x-5 bg-white' : 'bg-[var(--muted-foreground)]')} />
      </button>
    </div>
    {notices.length > 0 && <ul className="max-h-48 divide-y divide-[var(--border)] overflow-auto border-t border-[var(--border)]" aria-label="Current subscription limits">
      {notices.map(notice => <li key={notice.id} className="flex items-center gap-3 px-4 py-2.5">
        <ProviderIconAsset provider={notice.provider} className="size-4" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-[var(--foreground)]">{SUBSCRIPTION_PROVIDER_NAMES[notice.provider]} · {titles[notice.kind]}</p>
          <NoticeDetail notice={notice} />
        </div>
        <button type="button" aria-label={`Manage ${SUBSCRIPTION_PROVIDER_NAMES[notice.provider]} accounts`} onClick={() => onManage(notice.provider)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-xs hover:bg-[var(--muted)] focus-visible:outline-2">
          Accounts<ChevronRight size={13} aria-hidden="true" />
        </button>
      </li>)}
    </ul>}
  </section>;
}

export function SubscriptionLimitAlert({ visible, onManage }: { visible: boolean; onManage: (provider: SubscriptionProvider) => void }) {
  const enabled = useSubscriptionLimitAlertsEnabled();
  const notices = useSubscriptionLimitNotices(enabled && visible);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const notice = notices.find(item => !dismissed.includes(item.id));
  if (!notice) return null;
  const dismiss = () => setDismissed(previous => [...previous, notice.id].slice(-120));
  return <aside aria-label="Subscription limit alert"
    className="pointer-events-auto w-full shrink-0 rounded-xl border border-[var(--border)] bg-[var(--input-bg)] p-3.5 text-[var(--foreground)] shadow-lg [-webkit-app-region:no-drag]">
    <div className="flex items-start gap-2.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--muted)]">
        <ProviderIconAsset provider={notice.provider} className="size-[19px]" />
      </span>
      <div className="min-w-0 flex-1 pt-0.5" role="status" aria-live="polite" aria-atomic="true">
        <p className="text-[13px] font-semibold">{SUBSCRIPTION_PROVIDER_NAMES[notice.provider]} · {titles[notice.kind]}</p>
        <NoticeDetail notice={notice} />
      </div>
      <button type="button" aria-label="Dismiss subscription limit alert" onClick={dismiss}
        className="grid size-7 shrink-0 place-items-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] focus-visible:outline-2">
        <X size={15} aria-hidden="true" />
      </button>
    </div>
    <button type="button" onClick={() => { dismiss(); onManage(notice.provider); }}
      className="ml-[46px] mt-2.5 inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--muted)] focus-visible:outline-2">
      Manage subscription<ChevronRight size={13} aria-hidden="true" />
    </button>
  </aside>;
}
