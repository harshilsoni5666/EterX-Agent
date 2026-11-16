import { browserEngine, type LaunchOptions } from './engine';
import { nativeCurrentBrowser, type NativeBrowserResult } from './native-current-browser';
import { networkMonitor } from './network';
import { domSnapshot } from './snapshot';

// Route handlers and agent bundles must queue against the same browser. A
// Settings mode switch must not close a page while an agent is using it.
const browserRuntime = globalThis as typeof globalThis & {
  __eterxBrowserActionQueue?: Promise<void>;
};

export async function withBrowserSessionLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = browserRuntime.__eterxBrowserActionQueue || Promise.resolve();
  let release!: () => void;
  const acquired = new Promise<void>(resolve => { release = resolve; });
  browserRuntime.__eterxBrowserActionQueue = previous.then(() => acquired);
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

type BrowserLaunchResult = { page: any; nativeResult?: never } | { page?: never; nativeResult: NativeBrowserResult };

export async function launchBrowserSession(options: LaunchOptions = {}, signal?: AbortSignal): Promise<BrowserLaunchResult> {
  signal?.throwIfAborted();
  const mode = !options.mode && !options.cdpEndpoint && !options.wsEndpoint && !options.profile && !options.userDataDir
    && nativeCurrentBrowser.connected && !browserEngine.connected
    ? 'cdp' : browserEngine.resolveLaunchMode(options);
  const allowNative = mode === 'cdp' && !options.cdpEndpoint && process.env.ETERX_ALLOW_USER_CHROME !== '0';
  if (mode !== 'cdp') nativeCurrentBrowser.disconnect();
  if (allowNative && nativeCurrentBrowser.connected && !browserEngine.connected) {
    const nativeResult = await nativeCurrentBrowser.connect();
    signal?.throwIfAborted();
    if (nativeResult.success) return { nativeResult };
    nativeCurrentBrowser.disconnect();
  }

  try {
    const previousContext = browserEngine.browserContext;
    const page = await browserEngine.launch({ ...options, mode }, signal);
    if (browserEngine.browserContext !== previousContext) {
      await networkMonitor.stopAll();
      domSnapshot.invalidate();
    }
    nativeCurrentBrowser.disconnect();
    return { page };
  } catch (error) {
    signal?.throwIfAborted();
    if (!allowNative) throw error;
    if (!browserEngine.connected) await networkMonitor.stopAll();
    const nativeResult = await nativeCurrentBrowser.connect();
    signal?.throwIfAborted();
    if (!nativeResult.success) {
      nativeCurrentBrowser.disconnect();
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason} ${String(nativeResult.result || '')} ${nativeResult.recovery || ''}`.trim());
    }
    return { nativeResult };
  }
}

export async function disconnectBrowserSession(): Promise<void> {
  await networkMonitor.stopAll();
  nativeCurrentBrowser.disconnect();
  await browserEngine.disconnect();
  domSnapshot.invalidate();
}
