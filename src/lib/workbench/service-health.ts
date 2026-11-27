'use client';

import { useEffect, useState } from 'react';
import { workbenchAction } from './client';
import type { WorkbenchTarget } from './contracts';

const probesByTarget = new Map<string, { expires: number; result: Promise<boolean | null> }>();
function probeTarget(chatId: string, url: string) {
  const key = JSON.stringify([chatId, url]);
  const previous = probesByTarget.get(key);
  if (previous && previous.expires > Date.now()) return previous.result;
  const entry: { expires: number; result: Promise<boolean | null> } = {
    expires: Number.POSITIVE_INFINITY,
    result: workbenchAction<{ online: boolean }>(chatId, 'check-service', { url }, undefined, 4000)
      .then(result => result.online, () => null)
      .finally(() => { entry.expires = Date.now() + 3500; }),
  };
  probesByTarget.delete(key);
  probesByTarget.set(key, entry);
  if (probesByTarget.size > 128) {
    const stale = [...probesByTarget].find(([, value]) => value.expires <= Date.now());
    if (stale) probesByTarget.delete(stale[0]);
  }
  return entry.result;
}

export function useWorkbenchServiceHealth(chatId: string, targets: WorkbenchTarget[], visible: boolean): Record<string, boolean | null> {
  const [data, setData] = useState<{ chatId: string; probes: Record<string, boolean | null> }>();
  const signature = JSON.stringify([...new Set(targets.map(target => target.url))].slice(0, 12));
  useEffect(() => {
    if (!visible) return;
    const urls: string[] = JSON.parse(signature);
    if (!urls.length) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const probe = async () => {
      const status = await Promise.all(urls.map(url => probeTarget(chatId, url).then(online => [url, online] as const)));
      if (controller.signal.aborted) return;
      setData({ chatId, probes: Object.fromEntries(status) });
      timer = setTimeout(probe, 5000);
    };
    void probe();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [chatId, visible, signature]);
  return data?.chatId === chatId ? data.probes : {};
}
