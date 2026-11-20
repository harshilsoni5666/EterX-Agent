'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, Hand, Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import { readChatPermissionPreference, subscribeChatPermissionPreference, writeChatPermissionMode } from '../../lib/chat-permission-preferences';
import { isChatPermissionMode, type ChatPermissionMode, type PendingToolApproval, type ToolApprovalDecision } from '../../lib/chat-permissions';
import { requestJson } from '../../lib/request-json';
import styles from './composer-permissions.module.css';

const MODES = {
  ask: { label: 'Ask for approval', description: 'Ask before running commands, editing files, or searching the web.', Icon: Hand },
  review: { label: 'Approve for me', description: 'Handle routine searches and workspace edits, and ask about other actions.', Icon: ShieldCheck },
  full: { label: 'Full access', description: 'Use EterX’s full access to files, commands, and the internet.', Icon: ShieldAlert },
} satisfies Record<ChatPermissionMode, { label: string; description: string; Icon: typeof Shield }>;

const MODE_ORDER: ChatPermissionMode[] = ['ask', 'review', 'full'];

export function ComposerPermissionSelector({ chatId, onOpenSettingsTab }: {
  chatId?: string | null;
  onOpenSettingsTab?: (tab: 'api' | 'models' | 'general') => void;
}) {
  const mode = useSyncExternalStore(subscribeChatPermissionPreference, () => readChatPermissionPreference(chatId), () => 'full' as const);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const { Icon, label } = MODES[mode];

  const selectMode = async (nextMode: ChatPermissionMode) => {
    if (savingRef.current) return;
    setSaveFailed(false);
    if (!chatId) {
      writeChatPermissionMode(chatId, nextMode);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const response = await requestJson('/api/agent/approval', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, mode: nextMode }),
      }, 10_000);
      if (!response.ok) throw new Error('Permission update failed.');
      writeChatPermissionMode(chatId, nextMode);
    } catch {
      setSaveFailed(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={`Permissions, ${label}${saveFailed ? ', update failed' : ''}`} aria-busy={saving} title={saveFailed ? 'Permission update failed. Reopen to try again.' : `${label} · Applies to subsequent tool actions`} className={styles.trigger} data-mode={mode}>
          <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content aria-label="EterX permissions" side="top" align="start" sideOffset={10} collisionPadding={12} className={styles.menu}>
          <div className={styles.menuHeading}>
            <DropdownMenu.Label className={styles.menuTitle}>Select Permission for this agent</DropdownMenu.Label>
            {onOpenSettingsTab && <button type="button" className={styles.learnMore} onClick={() => onOpenSettingsTab('general')}>Learn more</button>}
          </div>
          <DropdownMenu.RadioGroup value={mode} onValueChange={value => {
            if (isChatPermissionMode(value)) void selectMode(value);
          }}>
            {MODE_ORDER.map(value => {
              const option = MODES[value];
              return (
                <DropdownMenu.RadioItem key={value} value={value} disabled={saving} textValue={option.label} className={styles.option} data-mode={value}>
                  <span className={styles.optionIcon}><option.Icon size={19} strokeWidth={1.8} aria-hidden="true" /></span>
                  <span className={styles.optionText}>
                    <span className={styles.optionLabel}>{option.label}</span>
                    <span className={styles.optionDetail}>{option.description}</span>
                  </span>
                  <span className={styles.optionCheck}>
                    <DropdownMenu.ItemIndicator><Check size={15} strokeWidth={2.25} aria-hidden="true" /></DropdownMenu.ItemIndicator>
                  </span>
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const APPROVAL_ENDPOINT = '/api/agent/approval';
const APPROVAL_ACTIONS = [
  { decision: 'approve-once', label: 'Approve once' },
  { decision: 'approve-session', label: 'Approve this session', title: 'Allow this exact action for the rest of the current run' },
  { decision: 'reject', label: 'Reject' },
] as const;

function ApprovalCard({ approval, decide }: {
  approval: PendingToolApproval;
  decide: (decision: ToolApprovalDecision) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(decision: ToolApprovalDecision) {
    setError('');
    setSubmitting(true);
    try {
      await decide(decision);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not send your decision. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={styles.card} aria-label={`Approval for ${approval.label}`} aria-busy={submitting}>
      <div className={styles.cardHeading} role="status">
        <span className={styles.cardIcon}><Shield size={16} strokeWidth={1.9} aria-hidden="true" /></span>
        <div className={styles.cardTitle}>
          <strong>Waiting for approval</strong>
          <span>{[approval.label, approval.agent].filter(Boolean).join(' · ')}</span>
        </div>
      </div>
      {approval.workspace && approval.tool !== 'workspace_run_command' && <div className={styles.workspace} title={approval.workspace}>{approval.workspace}</div>}
      <pre className={styles.preview} tabIndex={0} aria-label={`${approval.label} details`}><code>{approval.preview}</code></pre>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        {APPROVAL_ACTIONS.map(action => (
          <button key={action.decision} type="button" data-decision={action.decision} disabled={submitting}
            title={'title' in action ? action.title : undefined} onClick={() => void submit(action.decision)}>
            {action.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export function ComposerToolApprovals({ chatId }: { chatId: string }) {
  const [pending, setPending] = useState<PendingToolApproval[]>([]);
  const [decided, setDecided] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    async function refresh() {
      try {
        const response = await requestJson(`${APPROVAL_ENDPOINT}?chatId=${encodeURIComponent(chatId)}`, {
          cache: 'no-store', signal: controller.signal,
        }, 5000);
        if (response.ok) {
          const data = await response.json();
          if (!controller.signal.aborted && Array.isArray(data.pending)) setPending(data.pending);
        }
      } catch { /* Keep the last pending view during a temporary disconnect. */ }
      if (!controller.signal.aborted) timer = window.setTimeout(refresh, 1200);
    }
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [chatId]);

  async function decide(id: string, decision: ToolApprovalDecision) {
    const response = await requestJson(APPROVAL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, id, decision }),
    }, 8000);
    if (!response.ok && response.status !== 404 && response.status !== 409) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Could not send your decision. Try again.');
    }
    setDecided(previous => new Set([...previous, id]));
  }

  const actionable = pending.filter(approval => !decided.has(approval.id));
  return actionable.length ? (
    <div className={styles.approvals} aria-label="Pending tool approvals">
      {actionable.map(approval => <ApprovalCard key={approval.id} approval={approval} decide={decision => decide(approval.id, decision)} />)}
    </div>
  ) : null;
}
