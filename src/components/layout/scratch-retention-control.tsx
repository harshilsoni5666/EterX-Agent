'use client';

import { useEffect, useState } from 'react';
import { normalizeScratchRetention } from '../../lib/managed-workspaces';

export function ScratchRetentionControl({ value, onChange }: { value: number; onChange: (days: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = draft.trim() ? normalizeScratchRetention(draft) : value;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return <div className="eterx-retention-stepper" role="group" aria-label="Scratch workspace retention">
    <button type="button" aria-label="Decrease retention by one day" disabled={value <= 1} onClick={() => onChange(value - 1)}>−</button>
    <input type="number" min={1} max={365} step={1} inputMode="numeric" aria-label="Scratch workspace retention in days" value={draft}
      onChange={event => setDraft(event.target.value)} onBlur={commit} onFocus={event => event.target.select()}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
    <span>{value === 1 ? 'day' : 'days'}</span>
    <button type="button" aria-label="Increase retention by one day" disabled={value >= 365} onClick={() => onChange(value + 1)}>+</button>
  </div>;
}
