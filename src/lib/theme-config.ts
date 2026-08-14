export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

/** EterX opens in the dark theme unless the user has chosen another theme. */
export const DEFAULT_THEME: ThemePreference = 'dark';

export const isThemePreference = (value: unknown): value is ThemePreference => (
  value === 'dark' || value === 'light' || value === 'system'
);

