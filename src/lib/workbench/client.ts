'use client';

import type { ManagedTerminalTask } from '../managed-terminal-client';
import type { VirtualMachine, WorkbenchFocus, WorkbenchTarget } from './contracts';

export const workbenchChangedEvent = 'eterx-workbench-changed';
const deviceConnectionsChangedEvent = 'eterx-device-connections-changed';
export type WorkbenchActivity = {
  desktop: boolean;
  tasks: ManagedTerminalTask[];
  targets: WorkbenchTarget[];
  deviceId?: string;
  machine?: VirtualMachine;
  focus?: WorkbenchFocus;
};

export const workbenchUrl = (chatId: string, view: string, query: Record<string, string> = {}) =>
  '/api/agent/workbench?' + new URLSearchParams({ chatId, view, ...query });

export async function workbenchJson<T>(url: string, options: RequestInit = {}, timeout = options.method === 'POST' ? 40_000 : 20_000): Promise<T> {
  const deadline = AbortSignal.timeout(timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const response = await fetch(url, { ...options, signal, cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Workbench request failed (' + response.status + ').');
  return data;
}

export function workbenchAction<T = { success: true }>(chatId: string, action: string, input: object, signal?: AbortSignal, timeout?: number) {
  return workbenchJson<T>('/api/agent/workbench', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, chatId, action }), signal,
  }, timeout);
}

export function notifyWorkbenchClient(chatId: string) {
  window.dispatchEvent(new CustomEvent(workbenchChangedEvent, { detail: { chatId } }));
}

export function notifyDeviceConnectionsChanged() {
  window.dispatchEvent(new Event(deviceConnectionsChangedEvent));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(deviceConnectionsChangedEvent);
    channel.postMessage('changed');
    channel.close();
  }
}

export function subscribeDeviceConnectionsChanged(listener: () => void) {
  window.addEventListener(deviceConnectionsChangedEvent, listener);
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(deviceConnectionsChangedEvent) : undefined;
  channel?.addEventListener('message', listener);
  return () => {
    window.removeEventListener(deviceConnectionsChangedEvent, listener);
    channel?.close();
  };
}
