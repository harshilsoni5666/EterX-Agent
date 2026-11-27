import type { ResolvedTheme } from './theme-config';

export const DIFF_PALETTE_OPTIONS = [
  { value: 'classic', label: 'Green & red' },
  { value: 'blue-orange', label: 'Blue & orange' },
  { value: 'teal-violet', label: 'Teal & violet' },
  { value: 'indigo-rose', label: 'Indigo & rose' },
] as const;

export type DiffPalette = typeof DIFF_PALETTE_OPTIONS[number]['value'];

export const UI_CONTRAST = { min: 100, max: 150, step: 5 } as const;

export type AppearancePreferences = {
  uiContrast: number;
  diffPalette: DiffPalette;
};

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  uiContrast: UI_CONTRAST.min,
  diffPalette: 'classic',
};

type DiffTone = {
  text: string;
  line: string;
  gutter: string;
  word: string;
};

type DiffColors = { added: DiffTone; removed: DiffTone };

const tone = (text: string, line: string, gutter: string, word: string): DiffTone => ({
  text, line, gutter, word,
});

const DIFF_COLORS: Record<DiffPalette, Record<ResolvedTheme, DiffColors>> = {
  classic: {
    dark: { added: tone('#00D26A', '#1B301E', '#122518', '#286D3880'), removed: tone('#FF514D', '#3B1D1B', '#301513', '#AF383C70') },
    light: { added: tone('#087536', '#E4F4E6', '#CDEACF', '#A8DDB2'), removed: tone('#CB302B', '#FCE8E6', '#F7D4D0', '#F5B9B3') },
  },
  'blue-orange': {
    dark: { added: tone('#80BDFF', '#192B40', '#142339', '#244971'), removed: tone('#FFAA67', '#3A271D', '#2F2019', '#633E2A') },
    light: { added: tone('#175FB1', '#E9F3FF', '#D8E9FC', '#BBD7F7'), removed: tone('#9C4117', '#FFF0E2', '#FAE2CB', '#F6CFAA') },
  },
  'teal-violet': {
    dark: { added: tone('#55D9C5', '#15332F', '#112823', '#24514A'), removed: tone('#C5A4FF', '#312342', '#281D35', '#4D3465') },
    light: { added: tone('#076D60', '#E1F5F0', '#CDEEE5', '#A9E3D3'), removed: tone('#6839A0', '#F3EBFF', '#E9DBFA', '#D8BEF3') },
  },
  'indigo-rose': {
    dark: { added: tone('#A4AEFF', '#252947', '#1C203A', '#373E6B'), removed: tone('#FF93B1', '#3B202C', '#301922', '#5C3043') },
    light: { added: tone('#4D50A1', '#EDEFFF', '#E1E5FF', '#CDD3F4'), removed: tone('#A52651', '#FCECF2', '#F9DBE6', '#F2C0D3') },
  },
};

export function normalizeDiffPalette(value: unknown): DiffPalette {
  return DIFF_PALETTE_OPTIONS.find(option => option.value === value)?.value ?? DEFAULT_APPEARANCE.diffPalette;
}

export function normalizeAppearancePreferences(value: unknown): AppearancePreferences {
  const stored = value && typeof value === 'object' ? value as Partial<AppearancePreferences> : {};
  const contrast = typeof stored.uiContrast === 'number' && Number.isFinite(stored.uiContrast)
    ? Math.round(stored.uiContrast / UI_CONTRAST.step) * UI_CONTRAST.step
    : DEFAULT_APPEARANCE.uiContrast;
  return {
    uiContrast: Math.min(UI_CONTRAST.max, Math.max(UI_CONTRAST.min, contrast)),
    diffPalette: normalizeDiffPalette(stored.diffPalette),
  };
}

export function getDiffColors(theme: ResolvedTheme, palette: DiffPalette = DEFAULT_APPEARANCE.diffPalette): DiffColors {
  return DIFF_COLORS[palette][theme];
}

export function appearanceVariables({ uiContrast, diffPalette }: AppearancePreferences) {
  const properties: Record<`--${string}`, string> = {
    '--ui-contrast-boost': `${uiContrast - UI_CONTRAST.min}%`,
  };
  for (const theme of ['light', 'dark'] as const) {
    const colors = getDiffColors(theme, diffPalette);
    for (const change of ['added', 'removed'] as const) {
      const prefix = `--diff-${theme}-${change}` as const;
      properties[prefix] = colors[change].text;
      properties[`${prefix}-bg`] = colors[change].line;
      properties[`${prefix}-gutter`] = colors[change].gutter;
      properties[`${prefix}-word`] = colors[change].word;
    }
  }
  return properties;
}
