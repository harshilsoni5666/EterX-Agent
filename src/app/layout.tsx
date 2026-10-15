import type { Metadata } from 'next';
import type { CSSProperties } from 'react';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import '@xterm/xterm/css/xterm.css';
import './chat-terminal.css';
import './light-theme.generated.css';
import './light-theme.enterprise.css';
import './composer-menus.css';
import './light-theme.polish.css';
import './composer-responsive.css';
import './conversation-layout.css';
import './side-workspace.css';
import './turn-changes.css';
import './dropdown-polish.css';
import './code-review.css';
import './composer-surfaces.css';
import './chat-content.css';
import './activity-feed.css';
import '../../electron/splash.css';
import 'katex/dist/katex.min.css';
import './scrollbars.css';
import { ThemeBridge } from '../components/theme/theme-bridge';
import { ClipboardPasteBridge } from '../components/ui/clipboard-paste-bridge';
import { NativeTooltipSuppressor } from '../components/ui/native-tooltip-suppressor';
import { readInitialThemePreference, resolveInitialTheme } from '../lib/initial-theme';
import { DEFAULT_THEME } from '../lib/theme-config';

export const dynamic = 'force-dynamic';

// Keep the native app and offline development startup independent of a font CDN.
// Segoe UI is the app's primary UI font, with platform fallbacks for systems
// where it is not installed.
const localFontVariables: CSSProperties = {
  '--font-sans': '"Segoe UI", -apple-system, BlinkMacSystemFont, Arial, sans-serif',
  '--font-mono': '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  '--font-serif': 'Lora, Georgia, Cambria, "Times New Roman", serif',
} as CSSProperties;

export const metadata: Metadata = {
  title: 'EterX — Autonomous Agent OS',
  description: 'EterX is a next-generation autonomous agent workspace. Think deeper, build faster, work smarter.',
  icons: {
    icon: '/logo.png',
    shortcut: '/logo.png',
    apple: '/logo.png',
  },
};

const createThemeInitScript = (initialPreference: string) => `
(function () {
  try {
    var requested = ${JSON.stringify(initialPreference)};
    var desktopTheme = window.electronAPI && window.electronAPI.initialTheme;
    if (desktopTheme === 'dark' || desktopTheme === 'light') requested = desktopTheme;
    if (requested !== 'dark' && requested !== 'light' && requested !== 'system') requested = '${DEFAULT_THEME}';
    var resolved = requested === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : requested;
    if (resolved !== 'dark' && resolved !== 'light') resolved = '${DEFAULT_THEME}';
    var root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.classList.toggle('dark', resolved === 'dark');
    root.classList.toggle('light', resolved === 'light');
    root.style.colorScheme = resolved;
  } catch (_) {
    var root = document.documentElement;
    root.setAttribute('data-theme', '${DEFAULT_THEME}');
    root.classList.remove('light');
    root.classList.add('${DEFAULT_THEME}');
    root.style.colorScheme = '${DEFAULT_THEME}';
  }
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const initialPreference = readInitialThemePreference();
  const initialTheme = resolveInitialTheme(initialPreference);
  return (
    <html lang="en" className={`${initialTheme} ${GeistMono.variable}`} style={localFontVariables} data-theme={initialTheme} suppressHydrationWarning>
      <head>
        <script id="eterx-theme-init" dangerouslySetInnerHTML={{ __html: createThemeInitScript(initialPreference) }} />
      </head>
      <body className="font-sans antialiased min-h-screen selection:bg-white/20 selection:text-white">
        <ThemeBridge />
        <ClipboardPasteBridge />
        <NativeTooltipSuppressor />
        {children}
      </body>
    </html>
  );
}
