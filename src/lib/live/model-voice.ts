import { createDictationCapture, DICTATION_FINISH_TIMEOUT_MS } from '../microphone';
import { parseModelEntryKey } from '../agent/model-selector-store';
import type { LiveSession, LiveSessionCallbacks, LiveSessionOptions, LiveSessionState, LiveSystemEvent } from './agent-live';
import { shouldAnnounceLiveEvent } from './live-behavior';
import { formatLiveSpeech } from './spoken-answer';

type LocalUtterance = {
  id: string;
  text: string;
  ready: boolean;
  draining: boolean;
  discard: boolean;
  speechMs: number;
  silenceMs: number;
  durationMs: number;
};

/** Speech is a client capability; reasoning and tools use the existing agent
 * runtime, with the exact provider/model and its saved credentials/base URL. */
export class ModelVoiceSession implements LiveSession {
  private state: LiveSessionState = 'idle';
  private generation = 0;
  private active = false;
  private micMuted: boolean;
  private speakerMuted: boolean;
  private capture: ReturnType<typeof createDictationCapture> | null = null;
  private local: LocalUtterance | null = null;
  private unsubscribe: (() => void) | null = null;
  private recognition: any = null;
  private recognitionRunning = false;
  private recognitionStarting = false;
  private recognitionFailures = 0;
  private recognitionRestart: ReturnType<typeof setTimeout> | null = null;
  private recognitionStartTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelRecognitionStart: (() => void) | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private browserText = '';
  private speaking: SpeechSynthesisUtterance | null = null;
  private spokenReply: { event: LiveSystemEvent; text: string } | null = null;
  private speechTimer: ReturnType<typeof setTimeout> | null = null;
  private replies: LiveSystemEvent[] = [];
  private eventIds = new Set<string>();
  private dispatches = 0;
  private requestedRunIds = new Set<string>();
  private endedRunIds = new Set<string>();

  constructor(
    private readonly chatId: string,
    private readonly callbacks: LiveSessionCallbacks,
    private readonly options: LiveSessionOptions = {},
  ) {
    this.micMuted = options.audioInputEnabled === false;
    this.speakerMuted = options.audioOutputEnabled === false;
  }

  private setState(state: LiveSessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onStateChange(state);
  }

  private fail(error: unknown): void {
    if (!this.active) return;
    const message = error instanceof Error ? error.message : String(error);
    this.disconnect();
    this.setState('error');
    this.callbacks.onError(message);
  }

  async connect(): Promise<void> {
    if (this.active) return;
    if (!parseModelEntryKey(this.options.workerModelSelection)) {
      throw new Error('Choose an added model in Live settings or select a model in the chat composer.');
    }
    if (!this.callbacks.onAppControlAction) throw new Error('The agent task connection is unavailable.');
    this.active = true;
    const generation = ++this.generation;
    this.setState('connecting');
    try {
      if (this.options.audioInputEnabled !== false) {
        const api = (window as any).electronAPI;
        if (api?.startSpeechDictation && api?.pushSpeechDictationAudio && api?.stopSpeechDictation && api?.onSpeechDictationEvent) {
          this.unsubscribe = api.onSpeechDictationEvent((event: any) => {
            const local = this.local;
            if (!this.active || !local || event?.sessionId !== local.id) return;
            if (event.type === 'partial' || event.type === 'final') {
              local.text = String(event.text || '').trim();
              if (!this.micMuted && !local.discard) this.callbacks.onInputTranscription(local.text);
            } else if (event.type === 'error') {
              this.fail(event.text || 'Local speech recognition failed. Choose a downloaded dictation model in Settings → General.');
            } else if (event.type === 'capture-limit') {
              void this.finishLocalUtterance();
            } else if (event.type === 'stopped' && !local.draining) {
              this.fail('Another microphone session took over local dictation. Restart Live when it is finished.');
            }
          });
          this.capture = createDictationCapture(pcm => this.onLocalAudio(pcm), () => this.fail('The microphone disconnected. Reconnect it and restart Live.'));
          await this.capture.ready;
          const permission = await api.requestLiveMediaPermissions?.();
          if (!this.active || generation !== this.generation) return;
          if (['denied', 'restricted'].includes(permission?.microphone)) throw new Error('Allow microphone access for EterX in system settings.');
          await this.startLocalUtterance(generation);
          if (!this.active || generation !== this.generation) return;
          if (!await this.capture!.start(this.options.microphoneDeviceId)) return;
        } else {
          await this.startBrowserRecognition(generation);
        }
      }
      if (this.active && generation === this.generation) this.setState('listening');
    } catch (error) {
      if (generation === this.generation) this.fail(error);
      throw error;
    }
  }

  private async startLocalUtterance(generation: number): Promise<void> {
    if (!this.active || generation !== this.generation) return;
    const local: LocalUtterance = {
      id: crypto.randomUUID(), text: '', ready: false, draining: false, discard: false,
      speechMs: 0, silenceMs: 0, durationMs: 0,
    };
    this.local = local;
    const api = (window as any).electronAPI;
    const result = await api.startSpeechDictation(
      this.options.dictationLanguage || 'auto', local.id, this.options.dictationModel || 'large-v3-q5_0',
    );
    if (!this.active || generation !== this.generation || this.local !== local) {
      void Promise.resolve(api.stopSpeechDictation(local.id, true)).catch(() => {});
      return;
    }
    if (!result?.started) throw new Error(result?.error || 'Local speech recognition could not start. Select a downloaded dictation model in Settings → General.');
    local.ready = true;
  }

  private onLocalAudio(pcm: ArrayBuffer): void {
    const local = this.local;
    if (!this.active || !local?.ready || local.draining || this.micMuted || this.speaking) return;
    const samples = new Int16Array(pcm);
    let energy = 0;
    for (const sample of samples) energy += (sample / 32768) ** 2;
    const rms = Math.sqrt(energy / Math.max(1, samples.length));
    const ms = samples.length / 16;
    this.callbacks.onMicVolume?.(Math.min(100, Math.round(rms * 400)));
    if (rms >= 0.012) { local.speechMs += ms; local.silenceMs = 0; }
    else local.silenceMs += ms;
    // Keep a short silence window for word boundaries without accumulating
    // unlimited silence in the local decoder while the user is idle.
    if (local.speechMs === 0 && local.silenceMs > 500) return;
    local.durationMs += ms;
    (window as any).electronAPI.pushSpeechDictationAudio(pcm, local.id, 0);
    if ((local.speechMs > 0 && local.silenceMs >= 900) || local.durationMs >= 30_000) {
      void this.finishLocalUtterance(local.speechMs < 160);
    }
  }

  private async finishLocalUtterance(discard = false): Promise<void> {
    const local = this.local;
    if (local) local.discard ||= discard;
    if (!this.active || !local?.ready || local.draining) return;
    local.draining = true;
    const generation = this.generation;
    this.callbacks.onMicVolume?.(0);
    this.setState('thinking');
    try {
      // Only dispatch after the engine has drained its final words. Partials
      // may be revised and must never cause duplicate or incomplete tasks.
      const finished = await Promise.race([
        Promise.resolve((window as any).electronAPI.stopSpeechDictation(local.id, local.discard)).then(() => true),
        new Promise<false>(resolve => {
          this.finishTimer = setTimeout(() => resolve(false), DICTATION_FINISH_TIMEOUT_MS);
        }),
      ]);
      if (this.finishTimer) clearTimeout(this.finishTimer);
      this.finishTimer = null;
      if (!this.active || generation !== this.generation || this.local !== local) return;
      if (!finished) throw new Error('Local transcription timed out. Try a smaller dictation model in Settings → General.');
      this.local = null;
      if (!this.micMuted && !local.discard && local.text) this.sendText(local.text);
      else this.callbacks.onInputTranscription('');
      await this.startLocalUtterance(generation);
      if (this.active && generation === this.generation) {
        this.setState('listening');
        this.playNextReply();
      }
    } catch (error) {
      if (this.active && generation === this.generation) this.fail(error);
    }
  }

  private async startBrowserRecognition(generation: number): Promise<void> {
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition) throw new Error('This browser has no speech recognition. Use the EterX desktop app for local dictation, or select a native Live provider.');
    if (this.options.microphoneDeviceId && this.options.microphoneDeviceId !== 'default') {
      throw new Error('Browser speech recognition uses the system microphone. Choose Default in Settings → General or use desktop Live for a specific microphone.');
    }
    const recognition = new Recognition();
    this.recognition = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.options.dictationLanguage && this.options.dictationLanguage !== 'auto'
      ? this.options.dictationLanguage : navigator.language;
    let resolveStarted: (() => void) | null = null;
    let rejectStarted: ((reason: Error) => void) | null = null;
    const started = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    const current = () => this.active && this.generation === generation && this.recognition === recognition;
    const settleStart = (error?: Error) => {
      if (this.recognitionStartTimer) clearTimeout(this.recognitionStartTimer);
      this.recognitionStartTimer = null;
      this.cancelRecognitionStart = null;
      if (error) rejectStarted?.(error); else resolveStarted?.();
      resolveStarted = null;
      rejectStarted = null;
    };
    this.cancelRecognitionStart = () => settleStart(new Error('Live connection cancelled.'));
    recognition.onstart = () => {
      this.recognitionStarting = false;
      if (!current()) { recognition.abort(); settleStart(new Error('Live connection cancelled.')); return; }
      this.recognitionRunning = true;
      settleStart();
      if (this.micMuted || this.speaking) recognition.abort();
    };
    recognition.onresult = (event: any) => {
      if (!current() || this.micMuted || this.speaking) return;
      this.recognitionFailures = 0;
      let final = '';
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const text = String(event.results[index][0]?.transcript || '').trim();
        if (event.results[index].isFinal) final += `${text} `; else interim += `${text} `;
      }
      this.browserText = interim.trim();
      if (final.trim()) this.sendText(final.trim());
      else if (interim.trim()) this.callbacks.onInputTranscription(interim.trim());
    };
    recognition.onerror = (event: any) => {
      if (!current() || event.error === 'aborted' || event.error === 'no-speech') return;
      const error = new Error(`Speech recognition failed (${String(event.error || 'unavailable')}). Use desktop local dictation or a native Live provider if this browser's speech service is unavailable.`);
      if (rejectStarted) settleStart(error);
      else if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error) || ++this.recognitionFailures >= 3) this.fail(error);
    };
    recognition.onend = () => {
      this.recognitionRunning = false;
      this.recognitionStarting = false;
      this.browserText = '';
      if (current()) { this.resumeRecognition(); this.playNextReply(); }
    };
    this.recognitionStartTimer = setTimeout(() => settleStart(new Error('Speech recognition did not start. Allow microphone access or use desktop Live.')), 20_000);
    this.recognitionStarting = true;
    try { recognition.start(); } catch (error) { settleStart(error instanceof Error ? error : new Error(String(error))); }
    await started;
  }

  private resumeRecognition(): void {
    if (!this.active || this.micMuted || this.speaking || !this.recognition || this.recognitionRunning || this.recognitionStarting || this.recognitionRestart) return;
    this.recognitionRestart = setTimeout(() => {
      this.recognitionRestart = null;
      if (!this.active || this.micMuted || this.speaking || !this.recognition || this.recognitionRunning || this.recognitionStarting) return;
      try { this.recognitionStarting = true; this.recognition.start(); }
      catch (error) { this.recognitionStarting = false; this.fail(error); }
    }, Math.min(4000, 250 * 2 ** this.recognitionFailures));
  }

  sendText(value: string, options?: { internal?: boolean }): boolean {
    const text = value.trim();
    if (!this.active || this.state === 'connecting' || !text || options?.internal) return false;
    if (this.dispatches >= 8) {
      this.callbacks.onError('Live is still submitting earlier requests. Wait for them to be accepted, then repeat your last request.', { recoverable: true });
      return false;
    }
    this.stopSpeaking();
    this.callbacks.onInputTranscription(text);
    // The main runtime persists this user turn and its answer. Do not also
    // write a second Live transcript entry for the same dispatch.
    this.callbacks.onTurnComplete(text, '', { internalEvent: true });
    void this.dispatch(text);
    return true;
  }

  private async dispatch(text: string): Promise<void> {
    const generation = this.generation;
    this.dispatches++;
    const id = `voice_task_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    this.callbacks.onAgentActivity?.({ id, kind: 'delegation', phase: 'started', label: 'Submitting request', detail: text, startedAt });
    try {
      const result = await this.callbacks.onAppControlAction!('send_prompt_to_main_agent', {
        prompt: text, chat_id: this.chatId, modelId: this.options.workerModelSelection,
        follow_up_mode: 'auto',
      });
      if (!this.active || generation !== this.generation) return;
      if (result?.error || result?.success !== true) throw new Error(result?.error || 'The agent did not accept the request.');
      const runId = String(result.runId || '').trim();
      if (runId && !this.endedRunIds.has(runId)) this.requestedRunIds.add(runId);
      // This activity describes admission. The main feed owns the worker's
      // lifecycle, so a later task result cannot finish a newer admission.
      this.callbacks.onAgentActivity?.({
        id, kind: 'delegation', phase: 'completed', label: 'Request delivered',
        detail: result.message || 'The request was accepted; its outcome is still pending.',
        startedAt, completedAt: Date.now(),
      });
    } catch (error) {
      if (!this.active || generation !== this.generation) return;
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onAgentActivity?.({ id, kind: 'delegation', phase: 'failed', label: 'Request not accepted', detail: message, startedAt, completedAt: Date.now() });
      this.replies.push({ id, type: 'task_failed', sourceChatId: this.chatId, summary: message });
    } finally {
      this.dispatches = Math.max(0, this.dispatches - 1);
      if (this.active && generation === this.generation) this.playNextReply();
    }
  }

  announceSystemEvent(event: LiveSystemEvent): boolean {
    if (!this.active || event.sourceChatId !== this.chatId || this.eventIds.has(event.id)) return false;
    this.eventIds.add(event.id);
    if (this.eventIds.size > 200) this.eventIds.delete(this.eventIds.values().next().value!);
    const requestedReply = event.type !== 'task_progress'
      && (Boolean(event.runId && this.requestedRunIds.has(event.runId)) || this.dispatches > 0);
    if (event.runId && ['task_completed', 'task_failed', 'task_stopped'].includes(event.type)) {
      this.requestedRunIds.delete(event.runId);
      this.endedRunIds.add(event.runId);
      if (this.endedRunIds.size > 200) this.endedRunIds.delete(this.endedRunIds.values().next().value!);
    }
    if (event.type === 'task_stopped') {
      this.replies = this.replies.filter(item =>
        item.sourceChatId !== event.sourceChatId || (item.runId && event.runId && item.runId !== event.runId));
      if (this.spokenReply?.event.sourceChatId === event.sourceChatId
        && (!event.runId || this.spokenReply.event.runId === event.runId)) this.stopSpeaking();
    }
    // A spoken answer to the user's request is not an unsolicited progress
    // notification. Quiet progress settings must not swallow that answer.
    if (!requestedReply && !shouldAnnounceLiveEvent(event, this.options.interactionPolicy)) return true;
    this.replies = this.replies.filter(item =>
      item.type !== 'task_progress' || item.sourceChatId !== event.sourceChatId
      || (item.runId && event.runId && item.runId !== event.runId));
    this.replies.push(event);
    this.replies = this.replies.slice(-20);
    this.playNextReply();
    return true;
  }

  private playNextReply(): void {
    if (!this.active || this.speaking || this.dispatches || this.browserText || this.local?.draining || (this.local?.speechMs || 0) > 0) return;
    const event = this.replies.shift();
    if (!event) return;
    const text = formatLiveSpeech(event.sourceMarkdown || event.summary, this.options.interactionPolicy?.responseDetail);
    this.callbacks.onOutputTranscription(text, { systemEvent: event });
    const complete = () => {
      if (!this.active) return;
      this.callbacks.onTurnComplete('', text, { systemEvent: event });
      this.setState('listening');
      this.resumeRecognition();
      this.playNextReply();
    };
    if (this.speakerMuted || !text || !window.speechSynthesis) { complete(); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = window.speechSynthesis.getVoices().find(item => item.voiceURI === this.options.voice);
    if (voice) utterance.voice = voice;
    else if (this.options.dictationLanguage && this.options.dictationLanguage !== 'auto') utterance.lang = this.options.dictationLanguage;
    this.speaking = utterance;
    this.spokenReply = { event, text };
    this.recognition?.abort();
    this.callbacks.onMicVolume?.(0);
    this.setState('speaking');
    const finish = () => {
      if (this.speaking !== utterance) return;
      this.speaking = null;
      this.spokenReply = null;
      if (this.speechTimer) clearTimeout(this.speechTimer);
      this.speechTimer = null;
      complete();
    };
    utterance.onboundary = event => {
      if (this.speaking === utterance) this.callbacks.onOutputPlaybackProgress?.(text.slice(0, event.charIndex + (event.charLength || 0)));
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    // Some system speech engines omit end/error events when an audio device
    // disappears. Never leave microphone capture permanently paused.
    this.speechTimer = setTimeout(() => { if (this.speaking === utterance) { window.speechSynthesis.cancel(); finish(); } }, Math.max(30_000, text.length * 120));
    try { window.speechSynthesis.speak(utterance); } catch { finish(); }
  }

  private stopSpeaking(): void {
    if (!this.speaking) return;
    this.speaking.onend = null;
    this.speaking.onerror = null;
    this.speaking = null;
    const reply = this.spokenReply;
    this.spokenReply = null;
    if (this.speechTimer) clearTimeout(this.speechTimer);
    this.speechTimer = null;
    window.speechSynthesis?.cancel();
    this.callbacks.onOutputPlaybackProgress?.('');
    if (this.active && reply) this.callbacks.onTurnComplete('', reply.text, { systemEvent: reply.event });
    if (this.active) { this.setState('listening'); this.resumeRecognition(); }
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    if (muted) {
      this.callbacks.onMicVolume?.(0);
      this.recognition?.abort();
      // Drain and discard a partial utterance so unmuting cannot dispatch
      // words spoken before the mute gesture as a new request.
      if (this.local && (this.local.draining || this.local.speechMs > 0)) void this.finishLocalUtterance(true);
      this.browserText = '';
      this.callbacks.onInputTranscription('');
    }
    else this.resumeRecognition();
  }
  isMicMuted(): boolean { return this.micMuted; }
  setSpeakerMuted(muted: boolean): void { this.speakerMuted = muted; if (muted) this.stopSpeaking(); this.playNextReply(); }
  isSpeakerMuted(): boolean { return this.speakerMuted; }
  getState(): LiveSessionState { return this.state; }
  isCameraEnabled(): boolean { return false; }
  isScreenShareEnabled(): boolean { return false; }
  async startCamera() { return { success: false, message: 'For continuous camera sharing, select a native Live provider with vision. Agent tools can still inspect supported attachments.' }; }
  async startScreenShare() { return { success: false, message: 'For continuous screen sharing, select a native Live provider with vision. Ask the agent to inspect the screen using its tools.' }; }
  stopCamera(): void {}
  stopScreenShare(): void {}

  disconnect(): void {
    this.active = false;
    this.generation++;
    this.cancelRecognitionStart?.();
    this.stopSpeaking();
    this.capture?.stop();
    this.capture = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.local) void Promise.resolve((window as any).electronAPI?.stopSpeechDictation?.(this.local.id, true)).catch(() => {});
    this.local = null;
    if (this.recognition) {
      this.recognition.onend = null;
      this.recognition.onerror = null;
      this.recognition.onresult = null;
      try { this.recognition.abort(); } catch {}
      this.recognition = null;
    }
    if (this.recognitionRestart) clearTimeout(this.recognitionRestart);
    this.recognitionRestart = null;
    this.recognitionRunning = false;
    this.recognitionStarting = false;
    this.browserText = '';
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
    this.replies = [];
    this.requestedRunIds.clear();
    this.endedRunIds.clear();
    this.eventIds.clear();
    this.callbacks.onMicVolume?.(0);
    this.callbacks.onModelVolume?.(0);
    this.setState('idle');
  }
}
