import { isCancelled } from './roles/sub_agent';

export class ToolCancelledError extends Error {
  constructor(chatId?: string) {
    super(chatId ? `Tool execution cancelled for ${chatId}` : 'Tool execution cancelled');
    this.name = 'ToolCancelledError';
  }
}

export function isToolCancellationError(error: any): boolean {
  return error instanceof ToolCancelledError ||
    error?.name === 'AbortError' ||
    error?.name === 'ToolCancelledError' ||
    error?.message === 'CANCELLED_BY_USER' ||
    /tool execution cancelled|aborted/i.test(String(error?.message || ''));
}

export function createToolExecutionContext(baseContext: any = {}, onTrace?: (trace: any) => void): {
  context: any;
  signal: AbortSignal;
  throwIfCancelled: () => void;
  dispose: () => void;
} {
  const chatId = String(baseContext?.projectId || baseContext?.chatId || '');
  const controller = new AbortController();
  const upstream = baseContext?.abortSignal as AbortSignal | undefined;

  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new ToolCancelledError(chatId));
    }
  };

  const throwIfCancelled = () => {
    if (controller.signal.aborted || isCancelled(chatId)) {
      abort();
      throw new ToolCancelledError(chatId);
    }
  };

  if (upstream?.aborted || isCancelled(chatId)) abort();

  const onUpstreamAbort = () => abort();
  upstream?.addEventListener('abort', onUpstreamAbort, { once: true });

  const pollTimer = setInterval(() => {
    if (isCancelled(chatId)) abort();
  }, 250);
  pollTimer.unref?.();

  return {
    context: {
      ...baseContext,
      _onTrace: onTrace || baseContext?._onTrace,
      abortSignal: controller.signal,
      signal: controller.signal,
      isCancelled: () => controller.signal.aborted || isCancelled(chatId),
    },
    signal: controller.signal,
    throwIfCancelled,
    dispose: () => {
      clearInterval(pollTimer);
      upstream?.removeEventListener('abort', onUpstreamAbort);
    },
  };
}
