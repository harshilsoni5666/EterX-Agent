import type { Metadata } from 'next';
import { readInitialThemePreference, resolveInitialTheme } from '../../lib/initial-theme';

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

const createSettingsShellScript = (initialPreference: string) => `
(function () {
  try {
    var requested = ${JSON.stringify(initialPreference)};
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
  const initialPreference = readInitialThemePreference();
  const initialTheme = resolveInitialTheme(initialPreference);
  return (
    <>
      <script id="eterx-settings-shell-init" dangerouslySetInnerHTML={{ __html: createSettingsShellScript(initialPreference) }} />
      <div
        style={{
          minHeight: '100vh',
          background: `var(--eterx-settings-shell-bg, ${initialTheme === 'dark' ? '#151515' : '#FAFAF8'})`,
          color: `var(--eterx-settings-shell-fg, ${initialTheme === 'dark' ? '#F4F4F4' : '#1F1F1D'})`,
        }}
      >
        {children}
      </div>
    </>
  );
}
