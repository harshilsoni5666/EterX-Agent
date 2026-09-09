'use client';

import React, { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isFeedTurnBoundary } from '../../lib/chat-feed-lifecycle';

export const getTextPlaybackId = (log: any): string => {
  const id = log?._feedPresentationId ?? log?.traceId ?? log?.id ?? log?._traceIdx;
  return `${log?.type || 'text'}:${id ?? log?.startTime ?? log?.timestamp ?? ''}`;
};

type PlaybackHistory = { ids: Set<string>; texts: Map<string, string> };
const PlaybackContext = createContext<{ history: PlaybackHistory; owners: Map<string, string> } | null>(null);
const textHistoryKey = (owner: string, text: string) => JSON.stringify([owner, text.replace(/\r\n?/g, '\n').trim()]);

/** The initial transcript and anything received while details were closed are
 * already read. Only text first mounted in its arrival commit can type in. */
export function TextPlaybackScope({ logs, children }: { logs: any[]; children: React.ReactNode }) {
  const entries = useMemo(() => {
    let owner = 'preamble';
    let turn = 0;
    return logs.flatMap(log => {
      if (isFeedTurnBoundary(log)) { owner = `turn:${++turn}`; return []; }
      if (log?.type !== 'answer' && log?.type !== 'work_note') return [];
      return [{ id: getTextPlaybackId(log), owner, text: String(log.text || '') }];
    });
  }, [logs]);
  const [history] = useState<PlaybackHistory>(() => ({
    ids: new Set(entries.map(entry => entry.id)),
    texts: new Map(entries.filter(entry => entry.text.trim()).map(entry => [entry.id, textHistoryKey(entry.owner, entry.text)])),
  }));
  const owners = useMemo(() => new Map(entries.map(entry => [entry.id, entry.owner])), [entries]);
  useLayoutEffect(() => {
    for (const entry of entries) {
      history.ids.add(entry.id);
      // Replace cumulative snapshots; retaining every prefix grows quadratically.
      if (entry.text.trim()) history.texts.set(entry.id, textHistoryKey(entry.owner, entry.text));
    }
  }, [entries, history]);
  const value = useMemo(() => ({ history, owners }), [history, owners]);
  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>;
}

type PlaybackJob = (now: number) => boolean;
const jobs = new Set<PlaybackJob>();
let frame: number | null = null;
let lastFrame = 0;

// A single frame source for visible prose, capped at 30 updates/second. No
// per-character timers, DOM measurements, or animation queues per agent.
function tick(now: number) {
  frame = null;
  if (now - lastFrame >= 32) {
    lastFrame = now;
    for (const job of jobs) if (!job(now)) jobs.delete(job);
  }
  if (jobs.size) frame = window.requestAnimationFrame(tick);
}

function schedule(job: PlaybackJob) {
  jobs.add(job);
  if (frame === null) frame = window.requestAnimationFrame(tick);
}

function cancel(job: PlaybackJob) {
  jobs.delete(job);
  if (!jobs.size && frame !== null) {
    window.cancelAnimationFrame(frame);
    frame = null;
  }
}

// Preserve surrogate pairs and avoid momentarily turning an unfinished link
// target into a different URL. These boundaries concern display only.
function safePrefixEnd(text: string, end: number) {
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
  const link = text.lastIndexOf('](', end);
  if (link >= 0) {
    const closing = text.indexOf(')', link + 2);
    if (closing >= end) end = closing + 1;
  }
  return end;
}

export function usePacedText(text: string, live: boolean, enabled: boolean, playbackId?: string) {
  const playback = useContext(PlaybackContext);
  const rootRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(() => enabled && playbackId && playback && !playback.history.ids.has(playbackId)
    && !Array.from(playback.history.texts.values()).includes(textHistoryKey(playback.owners.get(playbackId) || 'preamble', text))
    ? text.slice(0, safePrefixEnd(text, Math.min(2, text.length))) : text);
  const state = useRef({ target: text, shown, revealed: shown, animate: live || shown !== text, visible: null as boolean | null, reduced: false, last: 0, carry: 0 });
  const job = useMemo<PlaybackJob>(() => now => {
    const current = state.current;
    if (current.visible === null && !document.hidden && !current.reduced) return true;
    if (!current.visible || current.reduced || document.hidden) {
      current.shown = current.target;
      if (!current.revealed.startsWith(current.target)) current.revealed = current.target;
      setShown(current.target);
      return false;
    }
    const remaining = current.target.length - current.shown.length;
    if (remaining <= 0) return false;
    if (current.target.length > 6000 && now - current.last < 64) return true;
    const elapsed = current.last ? Math.min(48, Math.max(0, now - current.last)) : 32;
    current.last = now;
    // Advance a bounded number of glyphs each frame, including after source
    // completion. A blocked frame or expired deadline must never dump the tail.
    const rate = Math.min(2400, 150 + remaining * 1.6);
    current.carry += rate * elapsed / 1000;
    const budget = Math.floor(current.carry);
    current.carry -= budget;
    if (budget < 1) return true;
    const end = safePrefixEnd(current.target, Math.min(current.target.length, current.shown.length + budget));
    current.shown = current.target.slice(0, end);
    current.revealed = current.shown;
    setShown(current.shown);
    return end < current.target.length;
  }, []);

  useLayoutEffect(() => {
    const current = state.current;
    const wasCaughtUp = current.target === current.shown;
    current.animate ||= live;
    current.target = text;
    if (!enabled) { cancel(job); current.shown = text; return; }
    // A shorter snapshot may be authoritative for this frame, but previously
    // displayed glyphs must not type again when its cumulative text returns.
    if (text.startsWith(current.revealed) && current.revealed.length > current.shown.length) {
      current.shown = current.revealed;
      setShown(current.shown);
    }
    // Corrections/replacements are authoritative; never type across stale text.
    if (!current.animate || !text.startsWith(current.shown) || current.reduced || document.hidden || current.visible === false) {
      cancel(job);
      current.shown = text;
      if (!current.revealed.startsWith(text)) current.revealed = text;
      setShown(text);
    } else if (text !== current.shown) {
      if (wasCaughtUp) { current.last = 0; current.carry = 0; }
      schedule(job);
    }
  }, [text, live, enabled, job]);

  const watching = enabled && (live || shown !== text);
  useLayoutEffect(() => {
    if (!watching) return;
    const root = rootRef.current;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      state.current.reduced = media.matches;
      if (document.hidden || media.matches || !state.current.visible) {
        cancel(job);
        state.current.shown = state.current.target;
        if (!state.current.revealed.startsWith(state.current.target)) state.current.revealed = state.current.target;
        setShown(state.current.target);
      }
    };
    // Visibility is browser-observed, not measured on every streamed token.
    const observer = root && typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(entries => {
        state.current.visible = entries[0]?.isIntersecting ?? false;
        sync();
        if (state.current.visible && state.current.shown !== state.current.target) schedule(job);
      }, {
        root: root.closest('.eterx-chat-feed-scroll'),
        // A newly inserted tail can be one line below the scrollport until
        // auto-follow's queued frame. Do not flush its reveal in that handoff.
        rootMargin: '0px 0px 96px 0px',
      }) : null;
    if (root && observer) observer.observe(root);
    else state.current.visible = true;
    state.current.reduced = media.matches;
    if (document.hidden || media.matches) sync();
    document.addEventListener('visibilitychange', sync);
    media.addEventListener('change', sync);
    return () => {
      cancel(job);
      state.current.visible = null;
      observer?.disconnect();
      document.removeEventListener('visibilitychange', sync);
      media.removeEventListener('change', sync);
    };
  }, [watching, job]);

  const visibleText = enabled && text.startsWith(shown) ? shown : text;
  return { text: visibleText, revealing: visibleText !== text, rootRef };
}
