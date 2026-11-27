import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
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

type Choice = { label: string; icon: ReactNode };
type UsageChoice = Choice & { value: string };

const allValue = 'all';
const choicePrefix = 'choice:';

function UsageSelectItem({ label, icon, value }: UsageChoice) {
  return <Select.Item className={styles.selectItem} value={value} textValue={label}>
    <span className={styles.selectIcon} aria-hidden="true">{icon}</span>
    <Select.ItemText>{label}</Select.ItemText>
    <Select.ItemIndicator className={styles.selectCheck}><Check size={13} strokeWidth={2} /></Select.ItemIndicator>
  </Select.Item>;
}

export function UsageSelect({ label, value, all, options, onSelect, align = 'start', className }: {
  label: string;
  value: string | null;
  all: Choice;
  options: UsageChoice[];
  onSelect: (value: string | null) => void;
  align?: 'start' | 'end';
  className?: string;
}) {
  const choice = options.find(option => option.value === value);
  const selected = choice ?? all;

  return <Select.Root value={choice ? choicePrefix + choice.value : allValue} disabled={!options.length}
    onValueChange={next => onSelect(next === allValue ? null : next.slice(choicePrefix.length))}>
    <Select.Trigger className={className ? styles.selectTrigger + ' ' + className : styles.selectTrigger}
      aria-label={label + ', ' + selected.label}>
      <span className={styles.selectIcon} aria-hidden="true">{selected.icon}</span>
      <span className={styles.selectLabel}><Select.Value>{selected.label}</Select.Value></span>
      <Select.Icon asChild><ChevronDown className={styles.selectChevron} size={13} /></Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content className={styles.selectMenu} position="popper" side="bottom" align={align} sideOffset={5}
        collisionPadding={12} aria-label={label} onCloseAutoFocus={event => {
          // A provider selection can move focus to the heading of the new view.
          if (document.activeElement && document.activeElement !== document.body) event.preventDefault();
        }}>
        <Select.Viewport className={styles.selectViewport}>
          <UsageSelectItem {...all} value={allValue} />
          <Select.Separator className={styles.selectDivider} />
          {options.map(option => <UsageSelectItem key={option.value} label={option.label} icon={option.icon}
            value={choicePrefix + option.value} />)}
        </Select.Viewport>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}
