'use client';

import type { CSSProperties } from 'react';
import { Check } from 'lucide-react';
import { DEFAULT_APPEARANCE, DIFF_PALETTE_OPTIONS, getDiffColors, UI_CONTRAST, type DiffPalette } from '../../lib/appearance-preferences';
import styles from './appearance-controls.module.css';

export function ContrastControl({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const fill = ((value - UI_CONTRAST.min) / (UI_CONTRAST.max - UI_CONTRAST.min)) * 100;
  return (
    <div className={styles.contrastControl} style={{ '--contrast-fill': `${fill}%` } as CSSProperties}>
      <input
        type="range"
        aria-label="Contrast"
        aria-valuetext={`${value}%`}
        min={UI_CONTRAST.min}
        max={UI_CONTRAST.max}
        step={UI_CONTRAST.step}
        value={value}
        onChange={event => onChange(event.currentTarget.valueAsNumber)}
      />
      <output className={styles.contrastValue} aria-hidden="true">{value}%</output>
    </div>
  );
}

export function DiffPalettePicker({ value, onChange }: { value: DiffPalette; onChange: (value: DiffPalette) => void }) {
  return (
    <div className={styles.paletteGrid} role="group" aria-label="Diff colors">
      {DIFF_PALETTE_OPTIONS.map(option => {
        const light = getDiffColors('light', option.value);
        const dark = getDiffColors('dark', option.value);
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={styles.paletteOption}
            aria-pressed={selected}
            aria-label={option.value === DEFAULT_APPEARANCE.diffPalette ? `${option.label} (default)` : option.label}
            onClick={() => onChange(option.value)}
            style={{
              '--sample-dark-added': dark.added.text,
              '--sample-dark-added-bg': dark.added.line,
              '--sample-dark-removed': dark.removed.text,
              '--sample-dark-removed-bg': dark.removed.line,
              '--sample-light-added': light.added.text,
              '--sample-light-added-bg': light.added.line,
              '--sample-light-removed': light.removed.text,
              '--sample-light-removed-bg': light.removed.line,
            } as CSSProperties}
          >
            <span className={styles.paletteSample} aria-hidden="true">
              <span data-change="added">+</span>
              <span data-change="removed">−</span>
            </span>
            <span className={styles.paletteLabel}>
              {option.label}
              {selected && <Check className={styles.selectionIcon} size={13} aria-hidden="true" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
