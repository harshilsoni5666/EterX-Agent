'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { appStorage, appStorageReady } from './client-storage';
import { createDictationCapture } from './microphone';

type Recording = {
  id: string; revision: number; base: string; rendered: string; stopping: boolean;
  capture: ReturnType<typeof createDictationCapture> | null;
};

export function useLocalDictation(options: { getText: () => string; onText: (value: string) => void; onError: (message: string) => void }) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const session = useRef<Recording | null>(null);
  const mounted = useRef(false);
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState('');

  const stop = useCallback((discard = true) => {
    const active = session.current;
    if (!active) return;
    active.stopping = true;
    active.capture?.stop();
    if (discard) session.current = null;
    if (mounted.current) { setIsRecording(false); setStatus(discard ? '' : 'Finishing transcription…'); }
    void Promise.resolve((window as any).electronAPI?.stopSpeechDictation(active.id, discard)).catch(() => {}).finally(() => {
      if (session.current !== active) return;
      session.current = null;
      if (mounted.current) setStatus('');
    });
  }, []);

  const reset = useCallback((value: string) => {
    const active = session.current;
    if (!active || value === active.rendered) return;
    active.base = value;
    active.rendered = value;
    active.revision++;
    (window as any).electronAPI?.resetSpeechDictation(active.id, active.revision);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = (window as any).electronAPI?.onSpeechDictationEvent?.((event: any) => {
      const active = session.current;
      if (!active || event?.sessionId !== active.id) return;
      if (event.type === 'loading') setStatus(event.text || 'Preparing speech recognition…');
      else if (event.type === 'capture-limit') stop(false);
      else if (event.type === 'error') { stop(); callbacks.current.onError(event.text || 'Local dictation stopped. Try the microphone again.'); }
      else if (event.type === 'stopped') { active.capture?.stop(); session.current = null; setIsRecording(false); setStatus(''); }
      else if ((event.type === 'partial' || event.type === 'final') && event.revision === active.revision) {
        if (callbacks.current.getText() !== active.rendered) { reset(callbacks.current.getText()); return; }
        const text = String(event.text || '').trim();
        active.rendered = text ? `${active.base}${active.base && !/\s$/.test(active.base) ? ' ' : ''}${text}` : active.base;
        callbacks.current.onText(active.rendered);
      }
    });
    return () => { mounted.current = false; unsubscribe?.(); stop(); };
  }, [reset, stop]);

  const toggle = useCallback(async () => {
    if (session.current && !session.current.stopping) { stop(false); return; }
    stop();
    const api = (window as any).electronAPI;
    if (!api?.startSpeechDictation) { callbacks.current.onError('Local microphone dictation is available in the EterX desktop app.'); return; }
    const base = callbacks.current.getText();
    const active: Recording = { id: crypto.randomUUID(), revision: 0, base, rendered: base, stopping: false, capture: null };
    session.current = active;
    setIsRecording(true);
    setStatus('Preparing speech recognition…');
    const current = () => mounted.current && session.current === active && !active.stopping;
    try {
      active.capture = createDictationCapture(pcm => { if (current()) api.pushSpeechDictationAudio(pcm, active.id, active.revision); }, () => stop(false));
      await active.capture.ready;
      if (!current()) return;
      const permission = await api.requestLiveMediaPermissions?.();
      if (!current()) return;
      if (['denied', 'restricted'].includes(permission?.microphone)) throw new Error('Microphone access is blocked. Allow EterX in system settings.');
      await appStorageReady;
      if (!current()) return;
      let settings: Record<string, unknown> = {};
      try { settings = JSON.parse(appStorage.getItem('eterx_settings') || '{}'); } catch {}
      const model = typeof settings.dictationModel === 'string' ? settings.dictationModel : 'large-v3-q5_0';
      const language = typeof settings.dictationLanguage === 'string' ? settings.dictationLanguage : 'auto';
      const device = typeof settings.microphoneDeviceId === 'string' ? settings.microphoneDeviceId : 'default';
      const result = await api.startSpeechDictation(language, active.id, model);
      if (!current()) { void api.stopSpeechDictation(active.id, true).catch(() => {}); return; }
      if (result?.cancelled) { stop(); return; }
      if (!result?.started) throw new Error(result?.error || 'Local dictation could not start.');
      api.resetSpeechDictation(active.id, active.revision);
      setStatus('Opening microphone…');
      if (await active.capture.start(device) && current()) setStatus('Listening…');
    } catch (error) {
      active.capture?.stop();
      if (session.current !== active) return;
      stop();
      if (mounted.current) callbacks.current.onError(error instanceof Error ? error.message : 'Local dictation could not start.');
    }
  }, [stop]);

  return { isRecording, status, toggle, stop, reset };
}
