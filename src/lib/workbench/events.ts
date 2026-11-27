import { randomUUID } from 'node:crypto';
import type { VirtualMachine, WorkbenchDevice, WorkbenchFocus, WorkbenchTarget } from './contracts';

type ChatWorkbench = {
  targets: WorkbenchTarget[];
  deviceId?: string;
  device?: WorkbenchDevice;
  machine?: VirtualMachine;
  focus?: WorkbenchFocus;
};

const host = globalThis as typeof globalThis & {
  __eterxWorkbench?: { chats: Map<string, ChatWorkbench>; listeners: Map<string, Set<() => void>> };
};
const { chats, listeners } = host.__eterxWorkbench ??= {
  chats: new Map<string, ChatWorkbench>(),
  listeners: new Map<string, Set<() => void>>(),
};

export function readWorkbench(chatId: string): ChatWorkbench {
  return chats.get(chatId) || { targets: [] };
}

export function notifyWorkbench(chatId?: string) {
  if (chatId) listeners.get(chatId)?.forEach(listener => listener());
}

export function subscribeWorkbench(chatId: string, listener: () => void) {
  const set = listeners.get(chatId) || new Set<() => void>();
  set.add(listener);
  listeners.set(chatId, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(chatId);
  };
}

export function hasWorkbenchListeners(chatId: string) {
  return Boolean(listeners.get(chatId)?.size);
}

function update(chatId: string, patch: Partial<ChatWorkbench>) {
  const next = { ...readWorkbench(chatId), ...patch };
  chats.delete(chatId);
  chats.set(chatId, next);
  // Selections are session data. The terminal archive separately preserves runs and discovered URLs.
  if (chats.size > 500) {
    const stale = [...chats.keys()].find(id => !listeners.has(id));
    if (stale) chats.delete(stale);
  }
  notifyWorkbench(chatId);
  return next;
}

export function setWorkbenchDevice(chatId: string, device?: WorkbenchDevice, reveal = false) {
  const deviceId = device?.id;
  update(chatId, { deviceId, device, ...(reveal && { focus: { id: randomUUID(), view: 'devices', deviceId } }) });
}

export function setWorkbenchMachine(chatId: string, machine: VirtualMachine) {
  update(chatId, { machine });
}

export function publishWorkbenchTarget(chatId: string, target: WorkbenchTarget, reveal: boolean) {
  const previous = readWorkbench(chatId).targets;
  return update(chatId, {
    targets: [target, ...previous.filter(item => item.url !== target.url || item.kind !== target.kind)].slice(0, 20),
    ...(reveal && { focus: { id: randomUUID(), view: target.kind === 'api' ? 'api' : 'services', url: target.url } }),
  });
}

export function forgetWorkbenchTarget(chatId: string, url: string) {
  return update(chatId, { targets: readWorkbench(chatId).targets.filter(item => item.url !== url) });
}

export function revealWorkbenchRuns(chatId: string, taskId?: string) {
  return update(chatId, { focus: { id: randomUUID(), view: 'runs', taskId } });
}

const loopbackOutput = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::[0-9]{1,5})?(?:\/[^\s\u001b"'<>]*)?(?=[\s\u001b"'<>),;]|$)/gi;

export function terminalWorkbenchUrls(text: string): string[] {
  const clean = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const urls = new Set<string>();
  for (const line of clean.split(/[\r\n]/)) {
    if (/\b(?:error|failed|refused|fallback)\b/i.test(line)) continue;
    if (!/\b(?:local|listen\w*|running|ready|serv(?:er|ing)|available|started)\b/i.test(line) && !/^\s*https?:/i.test(line)) continue;
    for (const match of line.matchAll(loopbackOutput)) {
      try {
        const url = new URL(match[0].replace(/[.,);]+$/, ''));
        if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
        url.search = '';
        url.hash = '';
        urls.add(url.href);
      } catch { /* Invalid console hints are ignored. */ }
      if (urls.size >= 8) return [...urls];
    }
  }
  return [...urls];
}
