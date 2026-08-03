'use client';

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

type SettingsTab =
  | 'general'
  | 'profile'
  | 'appearance'
  | 'configuration'
  | 'personalization'
  | 'shortcuts'
  | 'mcp'
  | 'hooks'
  | 'models'
  | 'api'
  | 'live-convo'
  | 'git'
  | 'environments'
  | 'worktrees'
  | 'browser'
  | 'computer'
  | 'archives';

const TAB_ALIASES: Record<string, SettingsTab> = {
  account: 'profile',
  agent: 'configuration',
  connections: 'models',
  advanced: 'environments',
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
  'models',
  'api',
  'live-convo',
  'git',
  'environments',
  'worktrees',
  'browser',
  'computer',
  'archives',
]);

const SettingsLoadingShell = () => (
  <div
    aria-hidden="true"
    className="fixed inset-0"
    style={{
      background: 'var(--eterx-settings-shell-bg, #FAFAF8)',
      color: 'var(--eterx-settings-shell-fg, #1F1F1D)',
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
  const initialTab = useMemo<SettingsTab>(() => {
    const requested = String(searchParams.get('tab') || 'general').toLowerCase();
    const tab = (TAB_ALIASES[requested] || requested) as SettingsTab;
    return VALID_TABS.has(tab) ? tab : 'general';
  }, [searchParams]);

  return (
    <SettingsPanel
      isOpen
      initialTab={initialTab}
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
