/** Yield queued work to input/paint without a timer's background clamping. */
let channel: MessageChannel | undefined;
let pending: Array<() => void> = [];

export function yieldToMainThread(): Promise<void> {
  if (typeof window === 'undefined' || typeof MessageChannel === 'undefined') {
    return new Promise(resolve => setTimeout(resolve, 0));
  }
  channel ||= new MessageChannel();
  channel.port1.onmessage ||= () => {
    const callbacks = pending;
    pending = [];
    callbacks.forEach(resolve => resolve());
  };
  return new Promise(resolve => {
    pending.push(resolve);
    if (pending.length === 1) channel!.port2.postMessage(null);
  });
}
