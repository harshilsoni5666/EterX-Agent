'use client';

import React, { useEffect } from 'react';

type ThemePreference = 'dark' | 'light' | 'system';
type ResolvedTheme = 'dark' | 'light';

const SETTINGS_STORAGE_KEY = 'eterx_settings';
const SETTINGS_CHANNEL = 'eterx-settings';

const readThemePreference = (): ThemePreference => {
  try {
    const saved = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    const settings = saved ? JSON.parse(saved) : {};
    return settings.theme === 'dark' || settings.theme === 'system' ? settings.theme : 'light';
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

export const applyEterxTheme = (theme: ThemePreference = readThemePreference()): ResolvedTheme => {
  if (typeof window === 'undefined') return 'light';
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.classList.toggle('dark', resolved === 'dark');
  root.classList.toggle('light', resolved === 'light');
  root.style.colorScheme = resolved;
  (window as any).electronAPI?.setNativeTheme?.(resolved);
  return resolved;
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

    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onSystemThemeChange = () => {
      if (readThemePreference() === 'system') applyStoredTheme();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === SETTINGS_STORAGE_KEY) applyStoredTheme();
    };

    window.addEventListener('eterx-settings-updated', applyStoredTheme);
    window.addEventListener('storage', onStorage);
    media?.addEventListener('change', onSystemThemeChange);

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(SETTINGS_CHANNEL);
      channel.onmessage = applyStoredTheme;
    } catch {
      channel = null;
    }

    return () => {
      window.removeEventListener('eterx-settings-updated', applyStoredTheme);
      window.removeEventListener('storage', onStorage);
      media?.removeEventListener('change', onSystemThemeChange);
      channel?.close();
    };
  }, []);

  return null;
});
