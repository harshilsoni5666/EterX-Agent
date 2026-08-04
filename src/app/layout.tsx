import type { Metadata } from 'next';
import type { CSSProperties } from 'react';
import './globals.css';
import './light-theme.generated.css';
import './light-theme.enterprise.css';
import './scrollbars.css';
import 'katex/dist/katex.min.css';
import { ThemeBridge } from '../components/theme/theme-bridge';

// Keep the native app and offline development startup independent of Google's
// font CDN. next/font/google fetches font files during the first Next compile,
// which makes an otherwise local desktop app fail or retry when networking is
// unavailable. These system stacks render consistently on Windows, macOS, and
// Linux without a network request.
const localFontVariables: CSSProperties = {
  '--font-sans': 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  '--font-mono': '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  '--font-serif': 'Lora, Georgia, Cambria, "Times New Roman", serif',
} as CSSProperties;

export const metadata: Metadata = {
  title: 'EterX — Autonomous Agent OS',
  description: 'EterX is a next-generation autonomous agent workspace. Think deeper, build faster, work smarter.',
  icons: {
    icon: '/logo.png',
  },
};

const themeInitScript = `
(function () {
  try {
    var settings = {};
    var requested = settings.theme || 'light';
    var resolved = requested === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : requested;
    if (resolved !== 'dark') resolved = 'light';
    var root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.classList.toggle('dark', resolved === 'dark');
    root.classList.toggle('light', resolved === 'light');
    root.style.colorScheme = resolved;
    if (window.electronAPI && window.electronAPI.setNativeTheme) {
      window.electronAPI.setNativeTheme(resolved);
    }
  } catch (_) {
    var root = document.documentElement;
    root.setAttribute('data-theme', 'light');
    root.classList.remove('dark');
    root.classList.add('light');
    root.style.colorScheme = 'light';
    if (window.electronAPI && window.electronAPI.setNativeTheme) {
      window.electronAPI.setNativeTheme('light');
    }
  }
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="light" style={localFontVariables} data-theme="light" suppressHydrationWarning>
      <body className="font-sans antialiased min-h-screen selection:bg-white/20 selection:text-white">
        <script id="eterx-theme-init" dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <ThemeBridge />
        {children}
      </body>
    </html>
  );
}
