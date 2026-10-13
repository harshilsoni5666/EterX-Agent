'use client';

import type { Terminal, ITerminalOptions, ITerminalInitOnlyOptions } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

type TerminalRuntime = { Terminal: typeof Terminal; FitAddon: typeof FitAddon };
let loading: Promise<TerminalRuntime> | undefined;

export function loadTerminalRuntime(): Promise<TerminalRuntime> {
  if (!loading) {
    loading = Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([xterm, addon]) => {
      // Webpack can expose the prebuilt CommonJS exports either directly or
      // under default. Keep both terminal entry points on the same loader.
      const TerminalClass = xterm.Terminal || (xterm as unknown as { default?: typeof xterm }).default?.Terminal;
      const FitClass = addon.FitAddon || (addon as unknown as { default?: typeof addon }).default?.FitAddon;
      if (typeof TerminalClass !== 'function' || typeof FitClass !== 'function') throw new Error('The terminal display library did not load. Restart EterX after updating.');
      return { Terminal: TerminalClass, FitAddon: FitClass };
    }).catch(error => {
      loading = undefined;
      throw error;
    });
  }
  return loading;
}

export function createTerminalSurface(runtime: TerminalRuntime, options: ITerminalOptions & ITerminalInitOnlyOptions) {
  const terminal = new runtime.Terminal(options);
  try {
    const fit = new runtime.FitAddon();
    terminal.loadAddon(fit);
    const element = document.createElement('div');
    element.className = 'eterx-terminal-surface';
    terminal.open(element);
    return { terminal, fit, element };
  } catch (error) {
    terminal.dispose();
    throw error;
  }
}

// Match the native PTY's limits so large/zoomed displays never render more
// columns than the shell receives. Hidden terminals cannot be measured yet.
export function fitTerminalSurface(tab: { terminal: Terminal; fit: FitAddon; element: HTMLElement }): boolean {
  if (!tab.element.isConnected || !tab.element.clientWidth || !tab.element.clientHeight) return false;
  const dimensions = tab.fit.proposeDimensions();
  if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return false;
  const cols = Math.max(2, Math.min(500, dimensions.cols));
  const rows = Math.max(1, Math.min(300, dimensions.rows));
  if (tab.terminal.cols !== cols || tab.terminal.rows !== rows) tab.terminal.resize(cols, rows);
  return true;
}
