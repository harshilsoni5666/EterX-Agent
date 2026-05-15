import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import 'katex/dist/katex.min.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'EterX — Autonomous Agent OS',
  description: 'EterX is a next-generation autonomous agent workspace. Think deeper, build faster, work smarter.',
  icons: {
    icon: '/logo.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${ inter.variable } ${ jetbrainsMono.variable } font-sans antialiased min-h-screen selection:bg-[#E2765A]/30 selection:text-white`}>
        {children}
      </body>
    </html>
  );
}
