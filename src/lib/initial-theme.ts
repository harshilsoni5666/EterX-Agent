import fs from 'node:fs';
import path from 'node:path';
import { getEterxDataDir } from './agent/storage-paths';
import { DEFAULT_THEME, isThemePreference, type ResolvedTheme, type ThemePreference } from './theme-config';

const SETTINGS_KEY = 'eterx_settings';

/**
 * Read only the synchronous startup hint. The renderer still hydrates the
 * complete AppData preference store after boot; this prevents the first paint
 * from using a different theme while that request is in flight.
 */
export const readInitialThemePreference = (): ThemePreference => {
  const settingsDir = path.join(getEterxDataDir(), 'settings');
  for (const source of [path.join(settingsDir, 'preferences.json'), path.join(settingsDir, 'preferences.backup.json')]) {
    try {
      if (!fs.existsSync(source)) continue;
      const preferences = JSON.parse(fs.readFileSync(source, 'utf8'));
      const rawSettings = preferences?.[SETTINGS_KEY];
      if (typeof rawSettings !== 'string') continue;
      const settings = JSON.parse(rawSettings);
      if (isThemePreference(settings?.theme)) return settings.theme;
    } catch {
      // The client-side store owns recovery from malformed preference data.
    }
  }
  return DEFAULT_THEME;
};

/**
 * Server rendering cannot inspect the user's OS color scheme. Dark is the
 * stable first-paint value for an explicit System preference; the inline
 * client script resolves System immediately before the page is shown.
 */
export const resolveInitialTheme = (preference: ThemePreference): ResolvedTheme => (
  preference === 'light' ? 'light' : 'dark'
);

