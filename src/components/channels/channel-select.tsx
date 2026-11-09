"use client";

import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import styles from './channels.module.css';

export function ChannelSelect({ value, onChange, options, label, disabled = false }: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger className={styles.selectTrigger} aria-label={label}>
        <Select.Value placeholder="Choose an option" />
        <Select.Icon><ChevronDown size={16} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className={styles.selectContent} position="popper" sideOffset={6} collisionPadding={12}>
          <Select.ScrollUpButton className={styles.selectScroll}><ChevronUp size={15} /></Select.ScrollUpButton>
          <Select.Viewport className={styles.selectViewport}>
            {options.map(option => (
              <Select.Item key={option.value} value={option.value} disabled={option.disabled} className={styles.selectItem}>
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator><Check size={15} /></Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className={styles.selectScroll}><ChevronDown size={15} /></Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
