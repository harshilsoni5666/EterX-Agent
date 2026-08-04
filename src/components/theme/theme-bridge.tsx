'use client';

import React, { useEffect } from 'react';
import { appStorage, appStorageReady, FOLDER_STORAGE_READY_EVENT } from '../../lib/client-storage';

type ThemePreference = 'dark' | 'light' | 'system';
type ResolvedTheme = 'dark' | 'light';

const SETTINGS_STORAGE_KEY = 'eterx_settings';
const SETTINGS_CHANNEL = 'eterx-settings';

const readThemePreference = (): ThemePreference => {
  try {
    const saved = appStorage.getItem(SETTINGS_STORAGE_KEY);
    const settings = saved ? JSON.parse(saved) : {};
    if (settings.theme === 'dark' || settings.theme === 'light' || settings.theme === 'system') {
      return settings.theme;
    }
    // The settings model defaults to light. Keeping the bridge on the same
    // default prevents an OS dark-mode preference from racing the persisted
    // app preference during the first render.
    return 'light';
  } catch {
    return 'light';
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
  if (typeof window === 'undefined') return 'light';
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
  if (typeof window === 'undefined') return 'light';

  const documentWithViewTransition = document as Document & {
    startViewTransition?: (callback: () => void) => { finished: Promise<unknown> };
  };

  if (documentWithViewTransition.startViewTransition) {
    const transition = documentWithViewTransition.startViewTransition(() => {
      applyEterxTheme(theme);
    });
    transition.finished.catch(() => undefined);
  } else {
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
    applyStoredTheme();
    void appStorageReady.then(applyStoredTheme);

    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onSystemThemeChange = () => {
      if (readThemePreference() === 'system') applyStoredTheme();
    };
    const onLocalSettingsUpdate = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      // Theme callers already perform the animated update. Reapplying it here
      // would interrupt the View Transition with a second raw DOM update.
      if (detail && typeof detail === 'object' && 'theme' in detail) return;
      applyStoredTheme();
    };

    window.addEventListener('eterx-settings-updated', onLocalSettingsUpdate);
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, applyStoredTheme);
    media?.addEventListener('change', onSystemThemeChange);

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(SETTINGS_CHANNEL);
      channel.onmessage = applyStoredTheme;
    } catch {
      channel = null;
    }

    return () => {
      window.removeEventListener('eterx-settings-updated', onLocalSettingsUpdate);
      window.removeEventListener(FOLDER_STORAGE_READY_EVENT, applyStoredTheme);
      media?.removeEventListener('change', onSystemThemeChange);
      channel?.close();
    };
  }, []);

  return null;
});
