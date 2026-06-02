import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Settings',
  icons: {
    icon: '/logo.png',
  },
};

const settingsShellScript = `
(function () {
  try {
    var saved = localStorage.getItem('eterx_settings');
    var settings = saved ? JSON.parse(saved) : {};
    var requested = settings.theme === 'dark' || settings.theme === 'system' ? settings.theme : 'light';
    var resolved = requested === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : requested;
    var bg = resolved === 'dark' ? '#151515' : '#FAFAF8';
    var fg = resolved === 'dark' ? '#F4F4F4' : '#1F1F1D';
    document.documentElement.style.setProperty('--eterx-settings-shell-bg', bg);
    document.documentElement.style.setProperty('--eterx-settings-shell-fg', fg);
    document.documentElement.style.background = bg;
    if (document.body) document.body.style.background = bg;
  } catch (_) {
    document.documentElement.style.setProperty('--eterx-settings-shell-bg', '#151515');
    document.documentElement.style.setProperty('--eterx-settings-shell-fg', '#F4F4F4');
    document.documentElement.style.background = '#151515';
    if (document.body) document.body.style.background = '#151515';
  }
})();
`;

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script id="eterx-settings-shell-init" dangerouslySetInnerHTML={{ __html: settingsShellScript }} />
      <div
        style={{
          minHeight: '100vh',
          background: 'var(--eterx-settings-shell-bg, #151515)',
          color: 'var(--eterx-settings-shell-fg, #F4F4F4)',
        }}
      >
        {children}
      </div>
    </>
  );
}
