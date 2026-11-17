'use client';

import { ArrowUp, Loader2 } from 'lucide-react';
import type { ModelSelectorEntry } from '../../lib/agent/model-selector-store';
import type { DictationPhase } from '../../lib/microphone';
import { ProxyChatModelPicker } from '../layout/proxy-runtime-model-picker';
import { DictationButton } from '../ui/dictation-button';

export function ProxyChatActions({ selection, entries, onSelect, dictationPhase, onDictation, busy, sendDisabled }: {
  selection: string;
  entries: ModelSelectorEntry[];
  onSelect: (selection: string) => void;
  dictationPhase: DictationPhase;
  onDictation: () => void;
  busy: boolean;
  sendDisabled: boolean;
}) {
  return <div className="eterx-proxy-composer-actions">
    <ProxyChatModelPicker selection={selection} entries={entries} onSelect={onSelect} />
    <DictationButton compact phase={dictationPhase} onClick={onDictation} disabled={busy && dictationPhase === 'idle'} />
    <button
      type="submit"
      aria-label={busy ? 'Proxy agent is responding' : 'Send proxy message'}
      aria-busy={busy}
      disabled={busy || sendDisabled}
      className="eterx-proxy-send-button"
    >
      {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={16} />}
    </button>
  </div>;
}
