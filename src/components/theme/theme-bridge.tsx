'use client';

import React, { useEffect } from 'react';
import { appStorage, appStorageReady, FOLDER_STORAGE_READY_EVENT } from '../../lib/client-storage';
import { isAppVisible } from '../../lib/app-visibility';
import { DEFAULT_THEME, isThemePreference, type ResolvedTheme, type ThemePreference } from '../../lib/theme-config';

const SETTINGS_STORAGE_KEY = 'eterx_settings';
const SETTINGS_CHANNEL = 'eterx-settings';
const SETTINGS_SOURCE_ID = `eterx-window-${Date.now()}-${Math.random().toString(36).slice(2)}`;

type EterxViewTransition = {
  finished: Promise<unknown>;
  ready?: Promise<unknown>;
  skipTransition?: () => void;
};

let activeThemeTransition: EterxViewTransition | null = null;
let themeTransitionRevision = 0;

const readThemePreference = (): ThemePreference => {
  try {
    const saved = appStorage.getItem(SETTINGS_STORAGE_KEY);
    const settings = saved ? JSON.parse(saved) : {};
    if (isThemePreference(settings.theme)) {
      return settings.theme;
    }
    return DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
};

const resolveTheme = (theme: ThemePreference): ResolvedTheme => {
  if (theme === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme === 'dark' ? 'dark' : 'light';
};

const applyThemeToDocument = (resolved: ResolvedTheme) => {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.classList.toggle('dark', resolved === 'dark');
  root.classList.toggle('light', resolved === 'light');
  root.style.colorScheme = resolved;
};

const syncNativeTheme = (resolved: ResolvedTheme) => {
  queueMicrotask(() => {
    if (document.documentElement.getAttribute('data-theme') !== resolved) return;
    // Native window integration does not belong in the critical snapshot path.
    // In Electron this call crosses IPC and can otherwise delay the first frame.
    (window as any).electronAPI?.setNativeTheme?.(resolved);
  });
};

export const applyEterxTheme = (theme: ThemePreference = readThemePreference()): ResolvedTheme => {
  if (typeof window === 'undefined') return 'dark';
  const resolved = resolveTheme(theme);
  applyThemeToDocument(resolved);
  syncNativeTheme(resolved);
  return resolved;
};

export const transitionEterxTheme = (
  theme: ThemePreference,
  updateThemeState?: () => void,
): ResolvedTheme => {
  if (typeof window === 'undefined') return 'dark';

  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  const revision = ++themeTransitionRevision;
  // A rapid second selection must cancel the old reveal even when the new
  // selection takes the non-animated path (same theme or a hidden window).
  activeThemeTransition?.skipTransition?.();
  activeThemeTransition = null;
  root.removeAttribute('data-eterx-theme-transition');
  root.style.removeProperty('--eterx-theme-wave-x');
  root.style.removeProperty('--eterx-theme-wave-y');
  root.style.removeProperty('--eterx-theme-wave-radius');
  const commitTheme = () => {
    applyThemeToDocument(resolved);
    updateThemeState?.();
  };
  const commitWithoutTransition = () => {
    commitTheme();
    syncNativeTheme(resolved);
    return resolved;
  };

  const documentWithViewTransition = document as Document & {
    startViewTransition?: (callback: () => void) => EterxViewTransition;
  };

  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const themeAlreadyVisible = root.getAttribute('data-theme') === resolved;

  if (
    !documentWithViewTransition.startViewTransition
    || prefersReducedMotion
    || !isAppVisible()
    || themeAlreadyVisible
  ) {
    return commitWithoutTransition();
  }

  // Use an exact pixel radius instead of a percentage so the circle always
  // reaches the farthest (bottom-left) corner at every window aspect ratio.
  const waveX = Math.max(0, window.innerWidth - 150);
  const waveY = 18;
  const farthestX = Math.max(waveX, window.innerWidth - waveX);
  const farthestY = Math.max(waveY, window.innerHeight - waveY);
  const waveRadius = Math.ceil(Math.hypot(farthestX, farthestY)) + 2;
  root.style.setProperty('--eterx-theme-wave-x', `${waveX}px`);
  root.style.setProperty('--eterx-theme-wave-y', `${waveY}px`);
  root.style.setProperty('--eterx-theme-wave-radius', `${waveRadius}px`);

  try {
    // Local component transitions must not be halfway between palettes when
    // Chromium captures the new page image. This marker is removed as soon as
    // both snapshots are ready, before the circular reveal runs visibly.
    root.setAttribute('data-eterx-theme-transition', 'true');
    const transition = documentWithViewTransition.startViewTransition(() => {
      if (revision === themeTransitionRevision) commitTheme();
    });
    activeThemeTransition = transition;

    void (transition.ready || Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        if (revision !== themeTransitionRevision) return;
        root.removeAttribute('data-eterx-theme-transition');
        syncNativeTheme(resolved);
      });

    void transition.finished
      .catch(() => undefined)
      .finally(() => {
        if (activeThemeTransition === transition) activeThemeTransition = null;
        if (revision === themeTransitionRevision) {
          root.removeAttribute('data-eterx-theme-transition');
          root.style.removeProperty('--eterx-theme-wave-x');
          root.style.removeProperty('--eterx-theme-wave-y');
          root.style.removeProperty('--eterx-theme-wave-radius');
        }
      });
  } catch {
    activeThemeTransition = null;
    root.removeAttribute('data-eterx-theme-transition');
    return commitWithoutTransition();
  }

  return resolved;
};

export const broadcastEterxSettingsUpdate = (settings: unknown) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('eterx-settings-updated', { detail: settings }));
  try {
    const channel = new BroadcastChannel(SETTINGS_CHANNEL);
    channel.postMessage({ type: 'settings-updated', settings, sourceId: SETTINGS_SOURCE_ID });
    channel.close();
  } catch {
    // BroadcastChannel is an enhancement for multi-window sync.
  }
};

export const ThemeBridge = React.memo(() => {
  useEffect(() => {
    const applyStoredTheme = () => applyEterxTheme();
    let storageLoaded = false;
    // The server-rendered root already contains the synchronous startup
    // preference. Do not read the empty in-memory store before hydration.
    void appStorageReady.then((loaded) => {
      if (loaded) {
        storageLoaded = true;
        applyStoredTheme();
      }
    });

    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onSystemThemeChange = () => {
      if (storageLoaded && readThemePreference() === 'system') applyStoredTheme();
    };
    const onLocalSettingsUpdate = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      // Theme callers already perform the animated update. Reapplying it here
      // would interrupt the View Transition with a second raw DOM update.
      if (detail && typeof detail === 'object' && 'theme' in detail) return;
      if (storageLoaded) applyStoredTheme();
    };

    window.addEventListener('eterx-settings-updated', onLocalSettingsUpdate);
    const onStorageReady = (event: Event) => {
      const loaded = (event as CustomEvent<{ loaded?: boolean }>).detail?.loaded;
      if (loaded !== false) {
        storageLoaded = true;
        applyStoredTheme();
      }
    };
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, onStorageReady);
    media?.addEventListener('change', onSystemThemeChange);

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(SETTINGS_CHANNEL);
      channel.onmessage = (event) => {
        // The local CustomEvent already handled this window. Ignore its
        // BroadcastChannel echo so it cannot bypass an active circular reveal.
        if (event.data?.sourceId === SETTINGS_SOURCE_ID) return;
        if (storageLoaded) applyStoredTheme();
      };
    } catch {
      channel = null;
    }

    return () => {
      window.removeEventListener('eterx-settings-updated', onLocalSettingsUpdate);
      window.removeEventListener(FOLDER_STORAGE_READY_EVENT, onStorageReady);
      media?.removeEventListener('change', onSystemThemeChange);
      channel?.close();
    };
  }, []);

  return null;
});
