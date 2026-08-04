import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Settings',
  icons: {
    icon: [
      { url: '/logo-whitetheme.png', media: '(prefers-color-scheme: light)' },
      { url: '/logo-white.png', media: '(prefers-color-scheme: dark)' },
    ],
    shortcut: [
      { url: '/logo-whitetheme.png', media: '(prefers-color-scheme: light)' },
      { url: '/logo-white.png', media: '(prefers-color-scheme: dark)' },
    ],
    apple: [
      { url: '/logo-whitetheme.png', media: '(prefers-color-scheme: light)' },
      { url: '/logo-white.png', media: '(prefers-color-scheme: dark)' },
    ],
  },
};

const settingsShellScript = `
(function () {
  try {
    var settings = {};
    try {
      // Keep compatibility with older browser-local preferences when opening
      // the standalone settings route. The current desktop store is hydrated
      // by ThemeBridge after the document is ready.
      settings = JSON.parse(window.localStorage.getItem('eterx_settings') || '{}');
    } catch (_) {}
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
    document.documentElement.style.setProperty('--eterx-settings-shell-bg', '#FAFAF8');
    document.documentElement.style.setProperty('--eterx-settings-shell-fg', '#1F1F1D');
    document.documentElement.style.background = '#FAFAF8';
    if (document.body) document.body.style.background = '#FAFAF8';
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
