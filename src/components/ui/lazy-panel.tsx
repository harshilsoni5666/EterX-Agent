"use client";

import React, { useEffect, useState, type ComponentType } from 'react';
import { reloadApp } from '../../lib/reload-app';

/** Load optional screens without throwing a failed chunk into the app root.
 * Cache successful modules, but release rejected imports so Retry can request
 * the chunk again after a development rebuild or a temporary connection loss. */
export function createLazyPanel<Props extends object>(label: string, loader: () => Promise<ComponentType<Props>>) {
  let loaded: ComponentType<Props> | null = null;
  let pending: Promise<ComponentType<Props>> | null = null;
  const load = () => {
    if (loaded) return Promise.resolve(loaded);
    if (!pending) {
      pending = loader().then(component => { loaded = component; return component; })
        .finally(() => { pending = null; });
    }
    return pending;
  };

  return function LazyPanel(props: Props) {
    const [Panel, setPanel] = useState<ComponentType<Props> | null>(() => loaded);
    const [attempt, setAttempt] = useState(0);
    const [failed, setFailed] = useState(false);
    const [slow, setSlow] = useState(false);
    const [reloading, setReloading] = useState(false);
    useEffect(() => {
      let active = true;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      setFailed(false); setSlow(false);
      const slowTimer = setTimeout(() => { if (active) setSlow(true); }, 15000);
      const open = async (retry: boolean) => {
        try {
          const component = await load();
          if (active) { clearTimeout(slowTimer); setPanel(() => component); }
        } catch (error: any) {
          if (!active) return;
          const chunkFailure = /ChunkLoadError|Loading (?:CSS )?chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(String(error?.name || '') + ' ' + String(error?.message || ''));
          if (retry && chunkFailure) retryTimer = setTimeout(() => void open(false), 1000);
          else setFailed(true);
        }
      };
      void open(true);
      return () => { active = false; clearTimeout(slowTimer); clearTimeout(retryTimer); };
    }, [attempt]);

    if (Panel) return <Panel {...props} />;
    return <div className="flex h-full min-h-[240px] w-full items-center justify-center bg-[var(--eterx-channel-surface)] px-6 text-[#353230] dark:text-white/90" aria-busy={!failed}>
      <div className="max-w-sm text-center">
        {!failed && <span className="mx-auto mb-4 block h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent opacity-50" aria-hidden="true" />}
        <p role="status" aria-live="polite" className="text-sm font-medium">{failed ? `${label} couldn’t open` : `Opening ${label}…`}</p>
        {(failed || slow) && <>
          <p className="mt-2 text-xs leading-5 text-black/50 dark:text-white/50">{failed ? 'The page download was interrupted. Try again, or reload the app to get its latest version.' : 'This is taking longer than usual. You can keep waiting or reload the app.'}</p>
          <div className="mt-4 flex justify-center gap-2">
            {failed && <button type="button" onClick={() => setAttempt(value => value + 1)} className="rounded-xl border border-black/10 px-4 py-2 text-xs dark:border-white/15">Try again</button>}
            <button type="button" disabled={reloading} onClick={async () => {
              setReloading(true);
              try { await reloadApp(); } catch { setFailed(true); } finally { setReloading(false); }
            }} className="rounded-xl bg-[#302f2c] px-4 py-2 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-black">{reloading ? 'Reloading…' : 'Reload app'}</button>
          </div>
        </>}
      </div>
    </div>;
  };
}
