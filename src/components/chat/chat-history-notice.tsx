import { LoaderCircle } from 'lucide-react';

export type ChatHistoryStatus = 'loading' | 'unavailable' | 'ready';

export function ChatHistoryNotice({ status, onRetry, conversation, className = '' }: {
  status: ChatHistoryStatus;
  onRetry: () => void;
  conversation?: boolean;
  className?: string;
}) {
  if (status === 'ready') return null;
  const loading = status === 'loading';
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${className}`}>
      <p role="status" className="flex min-w-0 items-center gap-2">
        {loading && <span className="inline-flex h-4 w-4 shrink-0 motion-safe:animate-spin" aria-hidden="true">
          <LoaderCircle className="h-full w-full" strokeWidth={1.75} />
        </span>}
        {loading
          ? conversation ? 'Loading conversation…' : 'Loading saved chats…'
          : conversation ? 'Couldn’t load this conversation.' : 'Couldn’t load saved chats.'}
      </p>
      {!loading && (
        <button type="button" onClick={onRetry} aria-label={conversation ? 'Retry loading conversation' : 'Retry loading saved chats'}
          className="shrink-0 rounded px-2 py-1 font-medium underline underline-offset-2 hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-1">
          Retry
        </button>
      )}
    </div>
  );
}
