'use client';

import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, ChevronRight, Circle, ExternalLink, ListTodo, X } from 'lucide-react';

export type LiveMissionEntryKind = 'step' | 'task' | 'evidence' | 'decision' | 'blocker';
export type LiveMissionEntryStatus = 'queued' | 'active' | 'done' | 'blocked';

export interface LiveMissionEntry {
  id: string;
  kind: LiveMissionEntryKind;
  label: string;
  detail?: string;
  status: LiveMissionEntryStatus;
  chatId?: string;
  updatedAt: number;
}

export interface LiveMissionState {
  id: string;
  goal: string;
  entries: LiveMissionEntry[];
  updatedAt: number;
}

interface LiveMissionStripProps {
  mission: LiveMissionState | null;
  visible: boolean;
  onOpenChat?: (chatId: string) => void;
}

const entryTone = (entry: LiveMissionEntry) => {
  if (entry.status === 'done') return 'text-emerald-300/80';
  if (entry.status === 'blocked') return 'text-amber-300/85';
  if (entry.status === 'active') return 'text-[#F0EEE9]';
  return 'text-white/50';
};

const EntryIcon = ({ entry }: { entry: LiveMissionEntry }) => {
  if (entry.status === 'done') return <Check className="h-3.5 w-3.5" strokeWidth={2.2} />;
  if (entry.status === 'active') {
    return <span className="h-2 w-2 rounded-full bg-sky-300/90 ring-4 ring-sky-300/10" />;
  }
  if (entry.status === 'blocked') {
    return <span className="h-2 w-2 rounded-full bg-amber-300/90 ring-4 ring-amber-300/10" />;
  }
  return <Circle className="h-3 w-3 opacity-50" strokeWidth={1.7} />;
};

export const LiveMissionStrip: React.FC<LiveMissionStripProps> = ({
  mission,
  visible,
  onOpenChat,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const entries = useMemo(
    () => (mission?.entries || []).slice().sort((left, right) => right.updatedAt - left.updatedAt),
    [mission?.entries],
  );
  const doneCount = entries.filter(entry => entry.status === 'done').length;
  const activeEntry = entries.find(entry => entry.status === 'active' || entry.status === 'blocked') || entries[0];

  if (!visible || !mission?.goal.trim()) return null;

  if (dismissed) {
    return (
      <button
        type="button"
        onClick={() => setDismissed(false)}
        className="pointer-events-auto fixed bottom-[116px] left-[calc(50%+92px)] z-[999990] flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.10] bg-[#111110]/[0.96] text-white/55 backdrop-blur-xl transition-colors hover:bg-[#1A1918] hover:text-white/80 max-sm:bottom-[188px] max-sm:left-1/2 max-sm:-translate-x-1/2"
        aria-label="Reopen Live mission map"
      >
        <ListTodo className="h-3.5 w-3.5" strokeWidth={1.8} />
      </button>
    );
  }

  return (
    <div className="pointer-events-none fixed bottom-[116px] left-[calc(50%+92px)] z-[999990] max-sm:bottom-[188px] max-sm:left-1/2 max-sm:-translate-x-1/2">
      <motion.div
        layout
        className="pointer-events-auto overflow-hidden rounded-[14px] border border-white/[0.10] bg-[#111110]/[0.96] text-[#F2F0EC] backdrop-blur-xl"
        transition={{ type: 'spring', stiffness: 430, damping: 36, mass: 0.72 }}
      >
        <div className="flex h-9 w-[238px] items-center transition-colors hover:bg-white/[0.035]">
          <button
            type="button"
            onClick={() => setExpanded(current => !current)}
            className="flex h-full min-w-0 flex-1 items-center gap-2 pl-3 text-left"
            aria-expanded={expanded}
            aria-label="Toggle Live mission map"
          >
            <ListTodo className="h-3.5 w-3.5 shrink-0 text-white/55" strokeWidth={1.8} />
            <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium tracking-[-0.005em]">
              {activeEntry?.label || mission.goal}
            </span>
            {entries.length > 0 && (
              <span className="shrink-0 text-[10px] tabular-nums text-white/38">
                {doneCount}/{entries.length}
              </span>
            )}
            {expanded
              ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-white/40" />
              : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/40" />}
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setExpanded(false);
              setDismissed(true);
            }}
            className="mx-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white/28 transition-colors hover:bg-white/[0.06] hover:text-white/65"
            aria-label="Close Live mission map"
          >
            <X className="h-3 w-3" />
          </button>
        </div>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              className="w-[316px] overflow-hidden border-t border-white/[0.07]"
            >
              <div className="px-3 pb-2.5 pt-2.5">
                <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-white/32">
                  Mission
                </div>
                <div className="mb-3 text-[12px] leading-[1.45] text-white/78">
                  {mission.goal}
                </div>
                <div className="space-y-1">
                  {entries.slice(0, 6).map(entry => (
                    <button
                      key={entry.id}
                      type="button"
                      disabled={!entry.chatId}
                      onClick={() => entry.chatId && onOpenChat?.(entry.chatId)}
                      className={`flex w-full items-start gap-2 rounded-[9px] px-2 py-1.5 text-left ${entry.chatId ? 'transition-colors hover:bg-white/[0.045]' : 'cursor-default'}`}
                    >
                      <span className={`mt-[2px] flex h-4 w-4 shrink-0 items-center justify-center ${entryTone(entry)}`}>
                        <EntryIcon entry={entry} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-[11.5px] font-medium ${entryTone(entry)}`}>
                          {entry.label}
                        </span>
                        {entry.detail && (
                          <span className="mt-0.5 block line-clamp-2 text-[10.5px] leading-[1.35] text-white/38">
                            {entry.detail}
                          </span>
                        )}
                      </span>
                      {entry.chatId && <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-white/28" />}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
};
