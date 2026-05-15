import { useSyncExternalStore } from 'react';
import {
  isAgentFaceState,
  type AgentFaceReaction,
  type AgentFaceState,
} from './agent-face-model';

export type AgentFaceBurstType = 'none' | 'confetti' | 'stars' | 'sparks' | 'rain' | 'hearts' | 'dots';
export type AgentFaceWinkSide = 'left' | 'right' | 'random';
export type AgentFaceEventName = 'click' | 'statechange' | 'speechend' | 'idle' | 'pulse' | 'burst' | 'status';
export type AgentFaceAttention = 'center' | 'input' | 'scan' | 'work' | 'listen' | 'alert';

export type AgentFaceSnapshot = {
  state: AgentFaceState;
  previousState: AgentFaceState;
  status: string;
  progress: number;
  reaction: AgentFaceReaction;
  sequence: number;
  pulseToken: number;
  pulseColor?: string;
  pulseTimes: number;
  burst: AgentFaceBurstType;
  burstToken: number;
  winkSide: Exclude<AgentFaceWinkSide, 'random'> | null;
  winkToken: number;
  attention: AgentFaceAttention;
  attentionIntensity: number;
  attentionX: number;
  attentionY: number;
  attentionToken: number;
  lastInteractionAt: number;
};

type AgentFaceEventHandler = (...args: any[]) => void;
type TimerId = ReturnType<typeof setTimeout>;

export type AgentFacePublicApi = {
  setState: (name: AgentFaceState | string) => void;
  flash: (name: AgentFaceState | string, ms?: number) => void;
  revert: () => void;
  speak: (text?: string, wpm?: number) => Promise<void>;
  pulse: (color?: string, times?: number) => void;
  burst: (type?: AgentFaceBurstType) => void;
  setStatus: (status: string) => void;
  setProgress: (value: number) => void;
  setAttention: (target?: AgentFaceAttention, intensity?: number, ms?: number) => void;
  wink: (side?: AgentFaceWinkSide) => Promise<void>;
  on: (event: AgentFaceEventName, handler: AgentFaceEventHandler) => void;
  off: (event: AgentFaceEventName, handler: AgentFaceEventHandler) => void;
};

declare global {
  interface Window {
    AgentFace?: AgentFacePublicApi;
  }
}

const initialSnapshot: AgentFaceSnapshot = {
  state: 'idle',
  previousState: 'idle',
  status: '',
  progress: 0,
  reaction: 'none',
  sequence: 0,
  pulseToken: 0,
  pulseTimes: 1,
  burst: 'none',
  burstToken: 0,
  winkSide: null,
  winkToken: 0,
  attention: 'center',
  attentionIntensity: 0,
  attentionX: 0,
  attentionY: 0,
  attentionToken: 0,
  lastInteractionAt: Date.now(),
};

let snapshot = initialSnapshot;
let installed = false;
let latestInputValue = '';
let lastInputAt = Date.now();
let flashTimer: TimerId | null = null;
let speakTimer: TimerId | null = null;
let winkTimer: TimerId | null = null;
let attentionTimer: TimerId | null = null;
let pauseThinkingTimer: TimerId | null = null;
let pauseDeepThinkingTimer: TimerId | null = null;
let idleWaitingTimer: TimerId | null = null;
let idleSleepyTimer: TimerId | null = null;
let idleSleepingTimer: TimerId | null = null;
let lastActivityScheduleAt = Date.now();

const subscribers = new Set<() => void>();
const eventSubscribers = new Map<AgentFaceEventName, Set<AgentFaceEventHandler>>();

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const emitEvent = (event: AgentFaceEventName, ...args: any[]) => {
  eventSubscribers.get(event)?.forEach(handler => {
    try {
      handler(...args);
    } catch (error) {
      console.warn('[AgentFace] event handler failed', error);
    }
  });
};

const commit = (patch: Partial<AgentFaceSnapshot>) => {
  snapshot = {
    ...snapshot,
    ...patch,
    sequence: snapshot.sequence + 1,
  };
  subscribers.forEach(listener => listener());
};

const normalizeState = (name: AgentFaceState | string): AgentFaceState => {
  if (isAgentFaceState(name)) return name;
  if (name === 'acting') return 'working';
  if (name === 'searching' || name === 'reading') return 'thinking';
  if (name === 'running' || name === 'writing' || name === 'coding') return 'working';
  return 'idle';
};

const clearTimer = (timer: TimerId | null) => {
  if (timer) clearTimeout(timer);
};

const setAttentionInternal = (
  target: AgentFaceAttention = 'center',
  intensity = 0.6,
  ms?: number,
  point: { x?: number; y?: number } = {},
) => {
  clearTimer(attentionTimer);
  commit({
    attention: target,
    attentionIntensity: target === 'center' ? 0 : clamp(intensity, 0, 1),
    attentionX: clamp(point.x ?? 0, -1, 1),
    attentionY: clamp(point.y ?? 0, -1, 1),
    attentionToken: snapshot.attentionToken + 1,
    lastInteractionAt: Date.now(),
  });

  if (ms && target !== 'center') {
    attentionTimer = setTimeout(() => {
      commit({
        attention: 'center',
        attentionIntensity: 0,
        attentionX: 0,
        attentionY: 0,
        attentionToken: snapshot.attentionToken + 1,
      });
    }, Math.max(450, ms));
  }
};

const setStateInternal = (name: AgentFaceState | string, options?: { auto?: boolean; status?: string; reaction?: AgentFaceReaction }) => {
  const nextState = normalizeState(name);
  const oldState = snapshot.state;
  if (nextState === oldState && options?.status === undefined && options?.reaction === undefined) return;

  commit({
    state: nextState,
    previousState: oldState,
    status: options?.status ?? snapshot.status,
    reaction: options?.reaction ?? 'none',
    lastInteractionAt: options?.auto ? snapshot.lastInteractionAt : Date.now(),
  });
  emitEvent('statechange', oldState, nextState);
};

const scheduleIdle = () => {
  if (typeof window === 'undefined') return;
  clearTimer(idleWaitingTimer);
  clearTimer(idleSleepyTimer);
  clearTimer(idleSleepingTimer);

  idleWaitingTimer = setTimeout(() => {
    if (snapshot.state === 'idle' || snapshot.state === 'calm') {
      setAttentionInternal('scan', 0.34);
      setStateInternal('waiting', { auto: true, status: 'Ready when you are' });
      emitEvent('idle', 'waiting');
    }
  }, 20_000);

  idleSleepyTimer = setTimeout(() => {
    if (snapshot.state === 'waiting' || snapshot.state === 'idle' || snapshot.state === 'calm') {
      setAttentionInternal('scan', 0.46);
      setStateInternal('waiting', { auto: true, status: 'Still here' });
      commit({ reaction: 'settling' });
    }
  }, 45_000);

  idleSleepingTimer = setTimeout(() => {
    if (snapshot.state === 'waiting' || snapshot.state === 'idle' || snapshot.state === 'calm') {
      setStateInternal('sleeping', { auto: true, status: 'Resting' });
      emitEvent('idle', 'sleeping');
    }
  }, 120_000);
};

const userActivity = () => {
  const dormant = snapshot.state === 'sleeping' || snapshot.state === 'waiting';
  const now = Date.now();
  if (!dormant && now - lastActivityScheduleAt < 2500) return;
  lastActivityScheduleAt = now;
  commit({ lastInteractionAt: Date.now() });
  scheduleIdle();
  if (!dormant) return;
  setStateInternal('curious', { status: snapshot.status || 'I am here' });
  window.setTimeout(() => {
    if (snapshot.state === 'curious') setStateInternal('idle', { auto: true, status: '' });
  }, 900);
};

const api: AgentFacePublicApi = {
  setState(name) {
    clearTimer(flashTimer);
    setStateInternal(name);
    scheduleIdle();
  },

  flash(name, ms = 800) {
    const baseState = snapshot.state;
    clearTimer(flashTimer);
    setStateInternal(name);
    flashTimer = setTimeout(() => {
      setStateInternal(baseState, { auto: true });
      scheduleIdle();
    }, Math.max(80, ms));
  },

  revert() {
    setStateInternal(snapshot.previousState);
    scheduleIdle();
  },

  speak(text = '', wpm = 160) {
    clearTimer(speakTimer);
    const baseState = snapshot.state === 'speaking' ? snapshot.previousState : snapshot.state;
    const words = Math.max(1, text.trim().split(/\s+/).filter(Boolean).length);
    const duration = clamp((words / Math.max(80, wpm)) * 60_000, 900, 12_000);
    setStateInternal('speaking', { status: text ? 'Responding' : snapshot.status });
    return new Promise(resolve => {
      speakTimer = setTimeout(() => {
        emitEvent('speechend');
        setStateInternal(baseState === 'speaking' ? 'calm' : baseState, { auto: true });
        resolve();
      }, duration);
    });
  },

  pulse(color, times = 1) {
    commit({
      pulseToken: snapshot.pulseToken + 1,
      pulseColor: color,
      pulseTimes: clamp(Math.round(times), 1, 4),
      lastInteractionAt: Date.now(),
    });
    emitEvent('pulse', color, times);
    scheduleIdle();
  },

  burst(type = 'stars') {
    commit({
      burst: type,
      burstToken: snapshot.burstToken + 1,
      lastInteractionAt: Date.now(),
    });
    emitEvent('burst', type);
    scheduleIdle();
  },

  setStatus(status) {
    const nextStatus = status.trim();
    commit({ status: nextStatus });
    emitEvent('status', nextStatus);
  },

  setProgress(value) {
    commit({ progress: clamp(value, 0, 100) });
  },

  setAttention(target = 'center', intensity = 0.6, ms) {
    setAttentionInternal(target, intensity, ms);
    scheduleIdle();
  },

  wink(side = 'random') {
    const resolvedSide = side === 'random' ? (snapshot.winkToken % 2 === 0 ? 'left' : 'right') : side;
    clearTimer(winkTimer);
    commit({
      winkSide: resolvedSide,
      winkToken: snapshot.winkToken + 1,
      reaction: resolvedSide === 'left' ? 'wink-left' : 'wink-right',
      lastInteractionAt: Date.now(),
    });
    return new Promise(resolve => {
      winkTimer = setTimeout(() => {
        commit({ winkSide: null, reaction: 'none' });
        resolve();
      }, 360);
    });
  },

  on(event, handler) {
    const handlers = eventSubscribers.get(event) ?? new Set<AgentFaceEventHandler>();
    handlers.add(handler);
    eventSubscribers.set(event, handlers);
  },

  off(event, handler) {
    eventSubscribers.get(event)?.delete(handler);
  },
};

export const agentFaceController = {
  ...api,
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  },
};

const subscribeStaticSnapshot = () => () => {};
const getStaticSnapshot = () => initialSnapshot;

export function useAgentFaceSnapshot(enabled = true): AgentFaceSnapshot {
  return useSyncExternalStore(
    enabled ? agentFaceController.subscribe : subscribeStaticSnapshot,
    enabled ? agentFaceController.getSnapshot : getStaticSnapshot,
    enabled ? agentFaceController.getSnapshot : getStaticSnapshot,
  );
}

export function ensureAgentFaceController() {
  if (typeof window === 'undefined' || installed) return;
  installed = true;
  window.AgentFace = api;
  window.addEventListener('keydown', userActivity, { passive: true });
  window.addEventListener('pointermove', userActivity, { passive: true });
  window.addEventListener('focus', userActivity);
  scheduleIdle();
}

export function notifyAgentFaceInputChange(previousValue: string, nextValue: string) {
  const now = Date.now();
  const delta = nextValue.length - previousValue.length;
  const elapsedSeconds = Math.max(0.08, (now - lastInputAt) / 1000);
  const speed = Math.abs(delta) / elapsedSeconds;

  latestInputValue = nextValue;
  lastInputAt = now;
  clearTimer(pauseThinkingTimer);
  clearTimer(pauseDeepThinkingTimer);

  if (!nextValue.trim()) {
    setAttentionInternal('center');
    agentFaceController.setStatus('');
    agentFaceController.flash('calm', 520);
    return;
  }

  const lines = nextValue.split(/\r?\n/);
  const latestLine = lines[lines.length - 1] || '';
  const latestColumn = latestLine.length % 44;
  const latestX = clamp((latestColumn - 22) / 22, -0.9, 0.9);
  const latestY = clamp(-0.12 + Math.min(lines.length - 1, 5) * 0.18, -0.12, 0.78);
  setAttentionInternal('input', clamp(0.56 + speed / 18, 0.56, 0.9), 2600, {
    x: latestX,
    y: latestY,
  });

  if (!previousValue.trim() && nextValue.trim()) {
    agentFaceController.flash('curious', 620);
    agentFaceController.setStatus('Listening to your prompt');
  }

  if (delta < 0) {
    agentFaceController.flash(speed > 5 ? 'thinking' : 'skeptical', 560);
  } else if (speed > 5) {
    agentFaceController.flash('curious', 460);
  } else if (speed > 0 && speed < 1.2 && nextValue.length > 10) {
    agentFaceController.setState('thinking');
    agentFaceController.setStatus('Composing with you');
  }

  if (/\?\s*$/.test(nextValue)) {
    agentFaceController.flash('curious', 700);
    agentFaceController.pulse('rgba(141,214,255,0.4)', 1);
  }

  if (/!\s*$/.test(nextValue)) {
    agentFaceController.flash('excited', 320);
    agentFaceController.burst('stars');
  }

  if (/(\.\.\.)\s*$/.test(nextValue)) {
    agentFaceController.setState('thinking');
    agentFaceController.setStatus('Thinking through it');
  }

  pauseThinkingTimer = setTimeout(() => {
    if (latestInputValue.trim()) {
      agentFaceController.setState('thinking');
      agentFaceController.setStatus('Thinking with you');
    }
  }, 3_000);

  pauseDeepThinkingTimer = setTimeout(() => {
    if (latestInputValue.trim()) {
      agentFaceController.setState('thinking');
      agentFaceController.pulse('rgba(109,211,255,0.28)', 1);
      agentFaceController.setStatus('Holding the thread');
    }
  }, 8_000);
}

export function notifyAgentFaceSend() {
  clearTimer(pauseThinkingTimer);
  clearTimer(pauseDeepThinkingTimer);
  setAttentionInternal('work', 0.82, 2400);
  agentFaceController.flash('curious', 260);
  window.setTimeout(() => {
    agentFaceController.setState('working');
    agentFaceController.setStatus('Processing your message');
    agentFaceController.pulse('rgba(255,255,255,0.24)', 1);
  }, 230);
}

const codeExtensions = new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'cpp', 'c', 'cs', 'php', 'rb', 'swift', 'kt', 'json', 'css', 'scss', 'html', 'md', 'yml', 'yaml']);
const documentExtensions = new Set(['pdf', 'doc', 'docx', 'txt', 'rtf', 'ppt', 'pptx', 'xls', 'xlsx', 'csv']);

export function notifyAgentFaceFiles(files: Array<File | { name: string; type?: string }>) {
  if (!files.length) return;
  setAttentionInternal('scan', 0.78, 2400);

  if (files.length >= 3) {
    agentFaceController.flash('surprised', 300);
    window.setTimeout(() => {
      agentFaceController.setState('working');
      agentFaceController.setStatus(`Received ${files.length} files`);
      agentFaceController.burst('dots');
    }, 320);
    return;
  }

  const file = files[0];
  const mime = file.type || '';
  const ext = file.name.split('.').pop()?.toLowerCase() || '';

  if (mime.startsWith('image/')) {
    agentFaceController.flash('surprised', 260);
    window.setTimeout(() => {
      agentFaceController.setState('curious');
      agentFaceController.setStatus('Examining image');
      agentFaceController.pulse('rgba(141,214,255,0.38)', 1);
    }, 280);
    return;
  }

  if (codeExtensions.has(ext)) {
    agentFaceController.setState('thinking');
    agentFaceController.setStatus('Reading your code');
    agentFaceController.burst('dots');
    return;
  }

  if (documentExtensions.has(ext)) {
    agentFaceController.setState('thinking');
    agentFaceController.setStatus('Reviewing document');
    return;
  }

  if (mime.startsWith('audio/') || mime.startsWith('video/')) {
    setAttentionInternal('listen', 0.78, 2400);
    agentFaceController.setState('listening');
    agentFaceController.setStatus('Listening to media');
    return;
  }

  agentFaceController.flash('curious', 560);
  window.setTimeout(() => {
    agentFaceController.setState('curious');
    agentFaceController.setStatus('Checking attachment');
  }, 460);
}

export function notifyAgentFaceTraceLog(log: any, isThinking: boolean) {
  if (!log) return;
  const raw = `${log.type || ''} ${log.text || ''} ${log.secondary || ''} ${log.filename || ''}`.toLowerCase();

  if (log.type === 'user_action') {
    agentFaceController.pulse('rgba(255,255,255,0.22)', 1);
    return;
  }

  if (log.type === 'tool_error' || log.type === 'safety_warning' || /error|failed|denied|blocked|exception|invalid/.test(raw)) {
    setAttentionInternal('alert', 0.78, 2600);
    agentFaceController.setState('error');
    agentFaceController.setStatus('Something needs attention');
    return;
  }

  if (log.type === 'answer') {
    const text = String(log.text || '');
    if (log.isLiveTyping) {
      setAttentionInternal('listen', 0.58, 2200);
      agentFaceController.speak(text.slice(-500));
      return;
    }

    if (/error|failed|cannot|unable|broken|exception/i.test(text)) {
      agentFaceController.setState('sad');
      agentFaceController.setStatus('I hit an issue');
      return;
    }

    agentFaceController.setState('calm');
    agentFaceController.setStatus('');
    window.setTimeout(() => {
      if (!isThinking && agentFaceController.getSnapshot().state === 'calm') {
        agentFaceController.setState('idle');
      }
    }, 1400);
    return;
  }

  if (log.type === 'thought_stream' || log.type === 'work_note' || /search|scan|research|read|inspect|analyz/.test(raw)) {
    setAttentionInternal('scan', 0.66, 2400);
    agentFaceController.setState('thinking');
    agentFaceController.setStatus('Structuring next move');
    return;
  }

  if (isThinking) {
    setAttentionInternal('work', 0.62, 2400);
    agentFaceController.setState('working');
    agentFaceController.setStatus('Working through the task');
  }
}
