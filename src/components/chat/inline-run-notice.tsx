import type { ReactNode } from 'react';
import { CircleAlert, CircleStop, Info, Terminal } from 'lucide-react';

/** One quiet, left-aligned style for run, interruption and API notices. */
export function InlineRunNotice({ children, kind = 'info', title, compact = false }: {
  children: ReactNode;
  kind?: 'stopped' | 'error' | 'info' | 'terminal';
  title?: string;
  compact?: boolean;
}) {
  const Icon = kind === 'stopped' ? CircleStop : kind === 'error' ? CircleAlert : kind === 'terminal' ? Terminal : Info;
  return <div role={kind === 'error' ? 'alert' : 'status'} aria-label={title}
    className={`eterx-agent-run-notice flex w-full items-start gap-2 py-1 text-left text-[13px] font-normal leading-5 ${compact ? 'my-1' : 'my-2'}`}>
    <Icon aria-hidden="true" className="eterx-agent-run-notice-icon mt-[2.5px] h-[15px] w-[15px] shrink-0" strokeWidth={1.7} />
    <span className="eterx-agent-run-notice-detail min-w-0 whitespace-pre-wrap break-words">{children}</span>
  </div>;
}
