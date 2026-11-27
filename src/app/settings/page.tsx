'use client';

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { isAccountModelProvider } from '../../lib/agent/model-selector-store';

type SettingsTab =
  | 'general'
  | 'profile'
  | 'appearance'
  | 'configuration'
  | 'personalization'
  | 'shortcuts'
  | 'mcp'
  | 'hooks'
  | 'subscription'
  | 'api'
  | 'live-convo'
  | 'git'
  | 'environments'
  | 'connections'
  | 'worktrees'
  | 'browser'
  | 'computer'
  | 'updates'
  | 'archives';

const TAB_ALIASES: Record<string, SettingsTab> = {
  account: 'profile',
  agent: 'configuration',
  advanced: 'environments',
  models: 'api',
  live: 'live-convo',
  liveconvo: 'live-convo',
};

const VALID_TABS = new Set<SettingsTab>([
  'general',
  'profile',
  'appearance',
  'configuration',
  'personalization',
  'shortcuts',
  'mcp',
  'hooks',
  'subscription',
  'api',
  'live-convo',
  'git',
  'environments',
  'connections',
  'worktrees',
  'browser',
  'computer',
  'updates',
  'archives',
]);

const SettingsLoadingShell = () => (
  <div
    aria-hidden="true"
    className="fixed inset-0"
    style={{
      background: 'var(--eterx-settings-shell-bg, #151515)',
      color: 'var(--eterx-settings-shell-fg, #F4F4F4)',
    }}
  />
);

const SettingsPanel = dynamic(
  () => import('../../components/layout/settings-panel').then(mod => mod.SettingsPanel),
  {
    ssr: false,
    loading: () => <SettingsLoadingShell />,
  },
);

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const subscriptionProvider = searchParams.get('provider');
  const initialTab = useMemo<SettingsTab>(() => {
    const requested = String(searchParams.get('tab') || 'general').toLowerCase();
    const tab = (TAB_ALIASES[requested] || requested) as SettingsTab;
    return VALID_TABS.has(tab) ? tab : 'general';
  }, [searchParams]);

  return (
    <SettingsPanel
      isOpen
      initialTab={initialTab}
      initialSubscriptionProvider={isAccountModelProvider(subscriptionProvider) ? subscriptionProvider : 'codex'}
      standalone
      onClose={() => {
        if (window.opener) {
          window.close();
          return;
        }
        router.push('/');
      }}
    />
  );
}
