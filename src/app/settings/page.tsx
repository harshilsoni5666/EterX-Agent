'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo } from 'react';
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
  useEffect(() => {
    document.title = 'Settings';
    try {
      const saved = window.localStorage.getItem('eterx_settings');
      const settings = saved ? JSON.parse(saved) : {};
      const requested = settings.theme === 'dark' || settings.theme === 'system' ? settings.theme : 'light';
      const resolved = requested === 'system'
        ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : requested;
      const bg = resolved === 'dark' ? '#151515' : '#FAFAF8';
      const fg = resolved === 'dark' ? '#F4F4F4' : '#1F1F1D';
      document.documentElement.style.setProperty('--eterx-settings-shell-bg', bg);
      document.documentElement.style.setProperty('--eterx-settings-shell-fg', fg);
      document.documentElement.style.background = bg;
      document.body.style.background = bg;
      (window as any).electronAPI?.setNativeTheme?.(resolved);
    } catch {
      document.documentElement.style.setProperty('--eterx-settings-shell-bg', '#151515');
      document.documentElement.style.setProperty('--eterx-settings-shell-fg', '#F4F4F4');
      document.documentElement.style.background = '#151515';
      document.body.style.background = '#151515';
    }
  }, []);
  const initialTab = useMemo<SettingsTab>(() => {
    const requested = String(searchParams.get('tab') || 'models').toLowerCase();
    const tab = (TAB_ALIASES[requested] || requested) as SettingsTab;
    return VALID_TABS.has(tab) ? tab : 'models';
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
