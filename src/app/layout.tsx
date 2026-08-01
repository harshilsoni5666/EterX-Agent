import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, Lora } from 'next/font/google';
import './globals.css';
import './light-theme.generated.css';
import './light-theme.enterprise.css';
import './scrollbars.css';
import 'katex/dist/katex.min.css';
import { ThemeBridge } from '../components/theme/theme-bridge';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

const lora = Lora({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-serif',
});

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
    var saved = localStorage.getItem('eterx_settings');
    var settings = saved ? JSON.parse(saved) : {};
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
    <html lang="en" className={`light ${inter.variable} ${jetbrainsMono.variable} ${lora.variable}`} data-theme="light" suppressHydrationWarning>
      <body className="font-sans antialiased min-h-screen selection:bg-white/20 selection:text-white">
        <script id="eterx-theme-init" dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <ThemeBridge />
        {children}
      </body>
    </html>
  );
}
