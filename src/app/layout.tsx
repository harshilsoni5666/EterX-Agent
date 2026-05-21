import type { Metadata } from 'next';
import './globals.css';
import 'katex/dist/katex.min.css';

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
      <body className="font-sans antialiased min-h-screen selection:bg-[#E2765A]/30 selection:text-white">
        {children}
      </body>
    </html>
  );
}
