import { spawn } from 'node:child_process';
import { workbenchDeviceVideoCommand } from './devices';

const state = globalThis as typeof globalThis & { __eterxActiveDeviceVideo?: Set<() => void> };
const activeStreams = state.__eterxActiveDeviceVideo ??= new Set();

export async function streamDeviceVideo(id: string, requestSignal: AbortSignal) {
  const { command, signal: hostSignal } = await workbenchDeviceVideoCommand(id);
  const signal = hostSignal ? AbortSignal.any([requestSignal, hostSignal]) : requestSignal;
  signal.throwIfAborted();
  if (activeStreams.size >= 6) throw new Error('Too many device screens are open.');

  const child = spawn(command.program, command.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const output = child.stdout[Symbol.asyncIterator]();
  let processError: Error | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disconnect: (() => void) | undefined;
  child.on('error', error => { processError = error; });
  child.stderr.resume();

  function stop() {
    if (stopped) return;
    stopped = true;
    activeStreams.delete(stop);
    clearTimeout(timer);
    if (disconnect) signal.removeEventListener('abort', disconnect);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    child.stdout.destroy();
  }
  activeStreams.add(stop);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      disconnect = () => {
        if (stopped) return;
        stop();
        controller.close();
      };
      signal.addEventListener('abort', disconnect, { once: true });
      timer = setTimeout(disconnect, 4 * 60_000);
      if (signal.aborted) disconnect();
    },
    async pull(controller) {
      if (stopped) return;
      try {
        const next = await output.next();
        if (stopped) return;
        if (next.done) {
          if (processError) throw processError;
          stop();
          controller.close();
        } else {
          controller.enqueue(next.value as Uint8Array);
        }
      } catch (error) {
        if (stopped) return;
        stop();
        controller.error(error);
      }
    },
    cancel: stop,
  });
}
