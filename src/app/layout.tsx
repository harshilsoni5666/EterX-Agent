import type { Metadata } from 'next';
import { DM_Sans } from 'next/font/google';
import './globals.css';
import 'katex/dist/katex.min.css';

const dmSans = DM_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-dm-sans',
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
      <body className={`${dmSans.variable} font-sans antialiased min-h-screen selection:bg-[#E2765A]/30 selection:text-white`}>
        {children}
      </body>
    </html>
  );
}
