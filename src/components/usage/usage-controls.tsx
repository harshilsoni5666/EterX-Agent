import styles from './usage-dashboard.module.css';

export function Segments<T extends string | number>({ label, values, selected, onSelect }: {
  label: string;
  values: ReadonlyArray<readonly [T, string]>;
  selected: T;
  onSelect: (value: T) => void;
}) {
  return <div className={styles.segments} role="group" aria-label={label}>
    {values.map(([value, text]) => <button type="button" key={value} aria-pressed={value === selected}
      onClick={() => onSelect(value)}>{text}</button>)}
  </div>;
}
