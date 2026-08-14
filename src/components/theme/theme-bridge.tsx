'use client';

import React, { useEffect } from 'react';
import { appStorage, appStorageReady, FOLDER_STORAGE_READY_EVENT } from '../../lib/client-storage';
import { DEFAULT_THEME, isThemePreference, type ResolvedTheme, type ThemePreference } from '../../lib/theme-config';

const SETTINGS_STORAGE_KEY = 'eterx_settings';
const SETTINGS_CHANNEL = 'eterx-settings';

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

const syncThemeIcons = (theme: ResolvedTheme) => {
  if (typeof document === 'undefined') return;
  const icon = theme === 'dark' ? '/logo-white.png' : '/logo-whitetheme.png';
  // Metadata emits media-qualified links for the initial system theme. Keep
  // the active favicon synchronized too when the user switches the app theme
  // manually while the OS theme stays unchanged.
  document
    .querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')
    .forEach((link) => {
      link.href = icon;
      link.media = '';
    });
};

export const applyEterxTheme = (theme: ThemePreference = readThemePreference()): ResolvedTheme => {
  if (typeof window === 'undefined') return 'dark';
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.classList.toggle('dark', resolved === 'dark');
  root.classList.toggle('light', resolved === 'light');
  root.style.colorScheme = resolved;
  syncThemeIcons(resolved);
  (window as any).electronAPI?.setNativeTheme?.(resolved);
  return resolved;
};

export const transitionEterxTheme = (theme: ThemePreference): ResolvedTheme => {
  if (typeof window === 'undefined') return 'dark';

  const documentWithViewTransition = document as Document & {
    startViewTransition?: (callback: () => void) => { finished: Promise<unknown> };
  };

  try {
    if (documentWithViewTransition.startViewTransition) {
      const transition = documentWithViewTransition.startViewTransition(() => {
        applyEterxTheme(theme);
      });
      transition.finished.catch(() => undefined);
    } else {
      return applyEterxTheme(theme);
    }
  } catch {
    // A second switch can arrive while a View Transition is still active.
    // The theme must still be applied synchronously in that case.
    return applyEterxTheme(theme);
  }

  return resolveTheme(theme);
};

export const broadcastEterxSettingsUpdate = (settings: unknown) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('eterx-settings-updated', { detail: settings }));
  try {
    const channel = new BroadcastChannel(SETTINGS_CHANNEL);
    channel.postMessage({ type: 'settings-updated', settings });
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
      channel.onmessage = () => {
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
