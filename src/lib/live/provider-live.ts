import {
  AgentLiveSession,
  type LiveSession,
  type LiveSessionCallbacks,
  type LiveSessionOptions,
  type LiveSessionState,
  type LiveSystemEvent,
} from './agent-live';
import type { LiveProviderOption } from './live-provider';
import { appStorage } from '../client-storage';

const appendText = (current: string, next: string): string => {
  if (!current) return next;
  if (!next || next === current || current.endsWith(next)) return current;
  if (next.startsWith(current)) return next;
  if (current.startsWith(next)) return current;
  const maxOverlap = Math.min(current.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (current.slice(-overlap) === next.slice(0, overlap)) {
      return `${current}${next.slice(overlap)}`;
    }
  }
  const needsSpace = /[\p{L}\p{N}]$/u.test(current) && /^[\p{L}\p{N}]/u.test(next);
  return `${current}${needsSpace ? ' ' : ''}${next}`;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + step, bytes.length)));
  }
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const pcmBytesToFloat32 = (bytes: Uint8Array): Float32Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < result.length; index += 1) {
    result[index] = view.getInt16(index * 2, true) / 32768;
  }
  return result;
};

const resamplePcm = (input: Float32Array, sourceRate: number, targetRate: number): Int16Array => {
  const ratio = targetRate / sourceRate;
  const output = new Int16Array(Math.max(1, Math.round(input.length * ratio)));
  for (let index = 0; index < output.length; index += 1) {
    const sourceIndex = index / ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = sourceIndex - left;
    const sample = (input[left] || 0) * (1 - fraction) + (input[right] || 0) * fraction;
    const clamped = Math.max(-1, Math.min(1, sample));
    output[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return output;
};

const pcm16ToBase64 = (input: Float32Array, sourceRate: number, targetRate: number): string => {
  const pcm = resamplePcm(input, sourceRate, targetRate);
  return bytesToBase64(new Uint8Array(pcm.buffer));
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : String(error || '');
  return message || fallback;
};

const readSampleRate = (format: unknown, fallback: number): number => {
  const match = String(format || '').match(/(?:pcm|linear16)[_-]?(\d{4,6})/i);
  return match ? Number(match[1]) : fallback;
};

/**
 * Native adapters for providers whose documentation exposes a complete
 * realtime voice session. The browser never receives a long-lived provider
 * key: the server route mints an ephemeral credential or signed URL first.
 */
export class ProviderLiveSession implements LiveSession {
  private readonly chatId: string;
  private readonly provider: LiveProviderOption;
  private readonly callbacks: LiveSessionCallbacks;
  private readonly options: LiveSessionOptions;
  private ws: WebSocket | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private mediaStream: MediaStream | null = null;
  private captureContext: AudioContext | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private captureSink: GainNode | null = null;
  private playbackContext: AudioContext | null = null;
  private playbackAnalyser: AnalyserNode | null = null;
  private playbackGain: GainNode | null = null;
  private remotePlaybackSource: MediaStreamAudioSourceNode | null = null;
  private remotePlaybackSink: GainNode | null = null;
  private nextPlayTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private modelVolumeLoopId = 0;
  private audioElement: HTMLAudioElement | null = null;
  private state: LiveSessionState = 'idle';
  private micMuted = false;
  private speakerMuted = false;
  private audioReady = false;
  private captureReady = false;
  private inputTranscript = '';
  private outputTranscript = '';
  private internalTextTurn = false;
  private playbackSampleRate = 24000;
  private manualDisconnect = false;
  private lifecycleId = 0;
  private connectPromise: Promise<void> | null = null;
  private connectionWaiter: {
    attempt: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private pendingTextTurns: Array<{ text: string; internal: boolean }> = [];
  private activeToolCalls = new Map<string, AbortController>();
  private handledToolCallIds = new Set<string>();
  private awaitingToolContinuation = false;
  private pendingTurnCompletion: { input: string; output: string; internal: boolean } | null = null;

  constructor(
    _apiKey: string,
    chatId: string,
    provider: LiveProviderOption,
    callbacks: LiveSessionCallbacks,
    options: LiveSessionOptions = {},
  ) {
    this.chatId = chatId;
    this.provider = provider;
    this.callbacks = callbacks;
    this.options = options;
    this.micMuted = options.audioInputEnabled === false;
    this.speakerMuted = options.audioOutputEnabled === false;
    this.playbackSampleRate = provider.transport === 'elevenlabs-native' ? 16000 : 24000;
  }

  private setState(state: LiveSessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onStateChange(state);
    if (state === 'idle' || state === 'error') cancelAnimationFrame(this.modelVolumeLoopId);
  }

  private isCurrentAttempt(attempt: number): boolean {
    return !this.manualDisconnect &&
      this.lifecycleId === attempt &&
      this.state !== 'idle' &&
      this.state !== 'error';
  }

  private createConnectionWaiter(attempt: number): Promise<void> {
    if (this.connectionWaiter) {
      clearTimeout(this.connectionWaiter.timer);
      this.connectionWaiter.reject(new Error('Live provider connection was superseded.'));
      this.connectionWaiter = null;
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.connectionWaiter?.attempt !== attempt) return;
        this.connectionWaiter = null;
        reject(new Error(`${this.provider.label} Live did not become ready within 20 seconds.`));
      }, 20_000);
      this.connectionWaiter = { attempt, resolve, reject, timer };
    });
  }

  private resolveConnectionReady(attempt: number): boolean {
    const waiter = this.connectionWaiter;
    if (!waiter || waiter.attempt !== attempt) return false;
    clearTimeout(waiter.timer);
    this.connectionWaiter = null;
    waiter.resolve();
    this.flushPendingTextTurns();
    return true;
  }

  private rejectConnectionReady(attempt: number, error: Error): boolean {
    const waiter = this.connectionWaiter;
    if (!waiter || waiter.attempt !== attempt) return false;
    clearTimeout(waiter.timer);
    this.connectionWaiter = null;
    waiter.reject(error);
    return true;
  }

  private markTransportReady(attempt: number): void {
    if (!this.isCurrentAttempt(attempt)) return;
    this.audioReady = true;
    this.maybeResolveReady(attempt);
  }

  private markCaptureReady(attempt: number): void {
    if (!this.isCurrentAttempt(attempt)) return;
    this.captureReady = true;
    this.maybeResolveReady(attempt);
  }

  private maybeResolveReady(attempt: number): void {
    if (!this.isCurrentAttempt(attempt) || !this.audioReady || !this.captureReady) return;
    this.setState('listening');
    this.resolveConnectionReady(attempt);
  }

  private sendJson(payload: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      this.callbacks.onError(getErrorMessage(error, 'Live provider message could not be sent.'));
      return false;
    }
  }

  private sendDataChannel(payload: Record<string, unknown>): boolean {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') return false;
    try {
      this.dataChannel.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      this.callbacks.onError(getErrorMessage(error, 'OpenAI realtime message could not be sent.'));
      return false;
    }
  }

  private sessionInstructions(): string {
    const context = this.options.initialContext;
    const memory = context?.pastMemories?.slice(-20).join('\n- ') || '';
    const history = context?.chatHistory?.slice(-20).map(item => `${item.role}: ${item.text}`).join('\n') || '';
    return [
      'You are EterX Live, a realtime voice agent and task coordinator. Speak naturally and keep ordinary replies short enough for a live conversation.',
      'For action requests, own the requested outcome: inspect the current state, use the available tools, inspect the result, recover safely when needed, and continue until the outcome is grounded or a precise blocker requires the user. A tool call succeeding does not by itself prove the whole task is complete.',
      'Use send_prompt_to_main_agent for substantial coding, research, creation, debugging, or long-running multi-step work. Remain available while that worker runs. Do not claim delegated work is complete merely because it started.',
      'Use browser_control and computer_control only for authorized actions. Observe before meaningful interaction and verify afterward. Never bypass approval, MFA, CAPTCHA, paywalls, safety warnings, or permissions.',
      'Never invent tool results. Lead final spoken updates with the grounded outcome or the exact input still needed.',
      context?.systemNotes,
      context?.workspacePath ? `Workspace: ${context.workspacePath}` : '',
      memory ? `Relevant memory:\n- ${memory}` : '',
      history ? `Recent conversation:\n${history}` : '',
    ].filter(Boolean).join('\n\n');
  }

  private realtimeTools(): Array<Record<string, unknown>> {
    const tool = (
      name: string,
      description: string,
      properties: Record<string, unknown>,
      required: string[],
    ) => ({
      type: 'function',
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: true },
    });
    const uiFields = {
      action_verb: { type: 'string', description: 'Short present-tense UI verb.' },
      action_target: { type: 'string', description: 'Short human-readable UI target.' },
    };
    return [
      tool('send_prompt_to_main_agent', 'Start, steer, or queue substantive work in an EterX chat. Use a complete objective with constraints and completion evidence.', {
        prompt: { type: 'string' },
        chat_id: { type: 'string' },
        create_new_chat: { type: 'boolean' },
        chat_title: { type: 'string' },
        executionMode: { type: 'string', enum: ['general', 'coding', 'autonomous', 'team'] },
        follow_up_mode: { type: 'string', enum: ['auto', 'steer', 'queue'] },
        ...uiFields,
      }, ['prompt', 'action_verb', 'action_target']),
      tool('list_all_chats', 'List exact chat IDs, titles, and current run states before cross-chat work.', uiFields, ['action_verb', 'action_target']),
      tool('get_main_agent_status', 'Inspect fresh status for a background or active agent run.', {
        chat_id: { type: 'string' },
        ...uiFields,
      }, ['action_verb', 'action_target']),
      tool('read_chat_full_context', 'Read the bounded transcript and action context of an exact EterX chat.', {
        chat_id: { type: 'string' },
        ...uiFields,
      }, ['chat_id', 'action_verb', 'action_target']),
      tool('browser_control', 'Observe and control the authorized EterX browser. Inspect before and after meaningful actions.', {
        action: { type: 'string' }, url: { type: 'string' }, ref: { type: 'number' }, selector: { type: 'string' },
        text: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' }, direction: { type: 'string' },
        amount: { type: 'number' }, tabId: { type: 'string' }, mode: { type: 'string' }, ...uiFields,
      }, ['action', 'action_verb', 'action_target']),
      tool('computer_control', 'See and control the isolated EterX Computer. Observe before coordinate actions and inspect afterward.', {
        action: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
        text: { type: 'string' }, query: { type: 'string' }, direction: { type: 'string' }, amount: { type: 'number' }, ...uiFields,
      }, ['action', 'action_verb', 'action_target']),
      tool('web_search', 'Search the live web through the configured EterX search runtime.', {
        query: { type: 'string' }, ...uiFields,
      }, ['query', 'action_verb', 'action_target']),
      tool('run_terminal_command', 'Run an authorized command in the active workspace using the configured terminal shell.', {
        command: { type: 'string' }, ...uiFields,
      }, ['command', 'action_verb', 'action_target']),
      tool('read_workspace_file', 'Read a file in the active workspace.', {
        filePath: { type: 'string' }, ...uiFields,
      }, ['filePath', 'action_verb', 'action_target']),
      tool('write_workspace_file', 'Create or replace a file in the active workspace.', {
        filePath: { type: 'string' }, content: { type: 'string' }, ...uiFields,
      }, ['filePath', 'content', 'action_verb', 'action_target']),
      tool('switch_active_chat', 'Open an exact chat while keeping Live attached to its owner chat.', {
        chat_id: { type: 'string' }, ...uiFields,
      }, ['chat_id', 'action_verb', 'action_target']),
      tool('stop_main_agent_run', 'Stop a running main-agent task in an exact chat when the user asks.', {
        chat_id: { type: 'string' }, ...uiFields,
      }, ['chat_id', 'action_verb', 'action_target']),
      tool('control_app_ui', 'Navigate EterX or change an app setting requested by the user.', {
        view: { type: 'string' }, action: { type: 'string' }, mode: { type: 'string' }, thinkingLevel: { type: 'string' }, ...uiFields,
      }, ['action_verb', 'action_target']),
    ];
  }

  private async getSessionAuth(): Promise<Record<string, any>> {
    const response = await fetch('/api/live/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: this.provider.value,
        model: this.options.model || 'auto',
        voice: this.options.voice || 'auto',
        agentId: this.options.agentId || '',
        chatId: this.chatId,
        instructions: this.sessionInstructions(),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(String(payload?.error || `Could not authorize ${this.provider.label}.`));
    }
    return payload;
  }

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    if (this.state !== 'idle') return;
    const operation = this.openConnection();
    this.connectPromise = operation;
    try {
      await operation;
    } finally {
      if (this.connectPromise === operation) this.connectPromise = null;
    }
  }

  private async openConnection(): Promise<void> {
    this.manualDisconnect = false;
    const attempt = ++this.lifecycleId;
    this.audioReady = false;
    this.captureReady = this.options.audioInputEnabled === false;
    this.setState('connecting');
    const readyPromise = this.createConnectionWaiter(attempt);
    // Authorization can fail before the transport reaches the await below.
    // Keep the deferred rejection observed while the outer error path cleans up.
    void readyPromise.catch(() => { });
    try {
      if (this.provider.transport === 'openai-webrtc') await this.connectOpenAI(attempt);
      else if (this.provider.transport === 'xai-native') await this.connectXai(attempt);
      else if (this.provider.transport === 'deepgram-native') await this.connectDeepgram(attempt);
      else if (this.provider.transport === 'elevenlabs-native') await this.connectElevenLabs(attempt);
      else throw new Error(`No provider adapter is registered for ${this.provider.label}.`);
      await readyPromise;
    } catch (error) {
      const message = getErrorMessage(error, `Could not connect to ${this.provider.label}.`);
      if (this.lifecycleId === attempt) {
        this.callbacks.onError(message);
        this.cleanup();
        this.setState('error');
      }
      throw new Error(message);
    }
  }

  private async connectOpenAI(attempt: number): Promise<void> {
    const auth = await this.getSessionAuth();
    if (!this.isCurrentAttempt(attempt)) throw new Error('OpenAI Live connection was cancelled.');
    const token = String(auth.token || auth.value || '').trim();
    if (!token) throw new Error('OpenAI did not return an ephemeral realtime client secret.');

    const peer = new RTCPeerConnection();
    this.peerConnection = peer;
    const audio = document.createElement('audio');
    audio.autoplay = true;
    // `playsInline` is exposed on HTMLVideoElement in TypeScript's DOM types,
    // but the attribute is also valid and required for the hidden audio
    // element used by the WebRTC transport.
    audio.setAttribute('playsinline', '');
    audio.muted = this.speakerMuted;
    audio.setAttribute('aria-hidden', 'true');
    audio.style.display = 'none';
    document.body.appendChild(audio);
    this.audioElement = audio;

    if (this.options.audioInputEnabled !== false) {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!this.isCurrentAttempt(attempt) || this.peerConnection !== peer) {
        mediaStream.getTracks().forEach(track => track.stop());
        throw new Error('OpenAI Live microphone capture was cancelled.');
      }
      this.mediaStream = mediaStream;
      this.mediaStream.getAudioTracks().forEach(track => { track.enabled = !this.micMuted; });
      this.mediaStream.getTracks().forEach(track => peer.addTrack(track, this.mediaStream as MediaStream));
      this.markCaptureReady(attempt);
      try {
        await this.startWebRtcMicMeter(this.mediaStream, attempt);
      } catch {
        this.callbacks.onMicVolume?.(0);
      }
    } else {
      peer.addTransceiver('audio', { direction: 'recvonly' });
    }
    peer.ontrack = event => {
      if (!this.isCurrentAttempt(attempt) || this.peerConnection !== peer) return;
      const remoteStream = event.streams[0];
      if (remoteStream) {
        audio.srcObject = remoteStream;
        if (!this.playbackContext) {
          this.playbackContext = new (window.AudioContext || (window as any).webkitAudioContext)();
          this.playbackAnalyser = this.playbackContext.createAnalyser();
          this.playbackAnalyser.fftSize = 256;
          this.remotePlaybackSource = this.playbackContext.createMediaStreamSource(remoteStream);
          this.remotePlaybackSink = this.playbackContext.createGain();
          this.remotePlaybackSink.gain.value = 0;
          this.remotePlaybackSource.connect(this.playbackAnalyser);
          this.playbackAnalyser.connect(this.remotePlaybackSink);
          this.remotePlaybackSink.connect(this.playbackContext.destination);
          this.startModelVolumeLoop();
          if (this.playbackContext.state === 'suspended') {
            void this.playbackContext.resume().catch(() => undefined);
          }
        }
      }
      void audio.play().catch(() => undefined);
    };

    const channel = peer.createDataChannel('oai-events');
    this.dataChannel = channel;
    channel.onmessage = event => {
      if (!this.isCurrentAttempt(attempt) || this.dataChannel !== channel) return;
      this.handleProviderMessage(event.data, attempt);
    };
    channel.onopen = () => {
      if (!this.isCurrentAttempt(attempt) || this.dataChannel !== channel) return;
      const sent = this.sendDataChannel({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: this.options.model && this.options.model !== 'auto' ? this.options.model : 'gpt-realtime-2.1',
          instructions: this.sessionInstructions(),
           audio: {
            input: {
              transcription: { model: 'gpt-4o-mini-transcribe' },
              turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true },
            },
             output: { voice: this.options.voice && this.options.voice !== 'auto' ? this.options.voice : 'marin' },
           },
           tools: this.realtimeTools(),
           tool_choice: 'auto',
         },
      });
      if (!sent) this.rejectConnectionReady(attempt, new Error('OpenAI realtime session setup could not be sent.'));
    };
    channel.onclose = () => {
      if (!this.isCurrentAttempt(attempt) || this.dataChannel !== channel) return;
      const error = new Error('OpenAI realtime data channel closed.');
      if (this.rejectConnectionReady(attempt, error)) return;
      if (this.state !== 'idle' && this.state !== 'error') {
        this.callbacks.onError(error.message);
        this.cleanup();
        this.setState('error');
      }
    };
    channel.onerror = () => {
      if (!this.isCurrentAttempt(attempt) || this.dataChannel !== channel) return;
      this.rejectConnectionReady(attempt, new Error('OpenAI realtime data channel failed.'));
    };
    peer.onconnectionstatechange = () => {
      if (!this.isCurrentAttempt(attempt) || this.peerConnection !== peer) return;
      if (['failed', 'closed'].includes(peer.connectionState) && this.state !== 'error') {
        const error = new Error('OpenAI realtime audio connection closed.');
        if (this.rejectConnectionReady(attempt, error)) return;
        this.callbacks.onError(error.message);
        this.cleanup();
        this.setState('error');
      }
    };

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/sdp' },
      body: offer.sdp,
    });
    if (!response.ok) throw new Error(`OpenAI realtime call failed (${response.status}).`);
    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    if (!this.isCurrentAttempt(attempt) || this.peerConnection !== peer) {
      throw new Error('OpenAI Live connection was cancelled.');
    }
  }

  private async connectXai(attempt: number): Promise<void> {
    const auth = await this.getSessionAuth();
    if (!this.isCurrentAttempt(attempt)) throw new Error('xAI Live connection was cancelled.');
    const token = String(auth.token || auth.value || '').trim();
    if (!token) throw new Error('xAI did not return an ephemeral realtime client secret.');
    const model = encodeURIComponent(this.options.model && this.options.model !== 'auto' ? this.options.model : 'grok-voice-latest');
    const socket = new WebSocket(`wss://api.x.ai/v1/realtime?model=${model}`, [`xai-client-secret.${token}`]);
    this.ws = socket;
    socket.onopen = () => {
      if (!this.isCurrentAttempt(attempt) || this.ws !== socket) return;
      void (async () => {
        this.sendJson({
          type: 'session.update',
          session: {
            instructions: this.sessionInstructions(),
            voice: this.options.voice && this.options.voice !== 'auto' ? this.options.voice : 'eve',
            audio: {
              input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'grok-transcribe' }, turn_detection: { type: 'server_vad' } },
              output: { format: { type: 'audio/pcm', rate: 24000 } },
            },
            tools: this.realtimeTools(),
            tool_choice: 'auto',
          },
        });
        if (this.options.audioInputEnabled !== false) await this.startPcmCapture(24000, attempt);
      })().catch(error => {
        if (!this.isCurrentAttempt(attempt) || this.ws !== socket) return;
        const message = getErrorMessage(error, 'xAI microphone capture could not start.');
        if (!this.rejectConnectionReady(attempt, new Error(message))) {
          this.callbacks.onError(message);
          this.cleanup();
          this.setState('error');
        }
      });
    };
    socket.onmessage = event => {
      if (!this.isCurrentAttempt(attempt) || this.ws !== socket) return;
      this.handleProviderMessage(event.data, attempt);
    };
    socket.onerror = () => {
      if (!this.isCurrentAttempt(attempt) || this.ws !== socket) return;
      this.rejectConnectionReady(attempt, new Error('xAI realtime WebSocket error.'));
    };
    socket.onclose = event => {
      if (!this.isCurrentAttempt(attempt) || this.ws !== socket) return;
      const message = `xAI realtime connection closed${event.reason ? `: ${event.reason}` : '.'}`;
      if (this.rejectConnectionReady(attempt, new Error(message))) return;
      if (this.state !== 'idle' && this.state !== 'error') {
        this.callbacks.onError(message);
        this.cleanup();
        this.setState('error');
      }
    };
  }

  private async connectDeepgram(attempt: number): Promise<void> {
    const auth = await this.getSessionAuth();
    if (!this.isCurrentAttempt(attempt)) throw new Error('Deepgram Live connection was cancelled.');
    const token = String(auth.token || auth.accessToken || '').trim();
    if (!token) throw new Error('Deepgram did not return a temporary Voice Agent token.');
    const socket = new WebSocket('wss://agent.deepgram.com/v1/agent/converse', ['token', token]);
    this.ws = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (this.isCurrentAttempt(attempt) && this.ws === socket) this.setState('connecting');
    };
    socket.onmessage = event => {
      if (!this.isCurrentAttempt(attempt) || this.ws !== socket) return;
      if (typeof event.data === 'string') this.handleProviderMessage(event.data, attempt);
      else if (event.data instanceof ArrayBuffer) this.enqueuePcm(new Uint8Array(event.data), 24000);
      else if (event.data instanceof Blob) void event.data.arrayBuffer().then(buffer => {
        if (this.isCurrentAttempt(attempt) && this.ws === socket) this.enqueuePcm(new Uint8Array(buffer), 24000);
      });
    };
    socket.onerror = () => {
      if (!this.isCurrentAttempt(attempt) || this.ws !== socket) return;
      this.rejectConnectionReady(attempt, new Error('Deepgram Voice Agent WebSocket error.'));
    };
    socket.onclose = event => {
      if (!this.isCurrentAttempt(attempt) || this.ws !== socket) return;
      const message = `Deepgram Voice Agent connection closed${event.reason ? `: ${event.reason}` : '.'}`;
      if (this.rejectConnectionReady(attempt, new Error(message))) return;
      if (this.state !== 'idle' && this.state !== 'error') {
        this.callbacks.onError(message);
        this.cleanup();
        this.setState('error');
      }
    };
  }

  private async connectElevenLabs(attempt: number): Promise<void> {
    const auth = await this.getSessionAuth();
    if (!this.isCurrentAttempt(attempt)) throw new Error('ElevenLabs Live connection was cancelled.');
    const signedUrl = String(auth.signedUrl || '').trim();
    if (!signedUrl) throw new Error('ElevenLabs did not return a signed conversation URL. Set an agent ID in Live settings.');
    const socket = new WebSocket(signedUrl);
    this.ws = socket;
    socket.onopen = () => {
      if (!this.isCurrentAttempt(attempt) || this.ws !== socket) return;
      void (async () => {
        const voice = this.options.voice && !['auto', 'agent-default'].includes(this.options.voice)
          ? this.options.voice
          : '';
        this.sendJson({
          type: 'conversation_initiation_client_data',
          ...(voice ? { conversation_config_override: { tts: { voice_id: voice } } } : {}),
        });
        if (this.options.audioInputEnabled !== false) await this.startPcmCapture(16000, attempt);
      })().catch(error => {
        if (!this.isCurrentAttempt(attempt) || this.ws !== socket) return;
        const message = getErrorMessage(error, 'ElevenLabs microphone capture could not start.');
        if (!this.rejectConnectionReady(attempt, new Error(message))) {
          this.callbacks.onError(message);
          this.cleanup();
          this.setState('error');
        }
      });
    };
    socket.onmessage = event => {
      if (!this.isCurrentAttempt(attempt) || this.ws !== socket) return;
      this.handleProviderMessage(event.data, attempt);
    };
    socket.onerror = () => {
      if (!this.isCurrentAttempt(attempt) || this.ws !== socket) return;
      this.rejectConnectionReady(attempt, new Error('ElevenLabs Conversational Agent WebSocket error.'));
    };
    socket.onclose = event => {
      if (!this.isCurrentAttempt(attempt) || this.ws !== socket) return;
      const message = `ElevenLabs conversation closed${event.reason ? `: ${event.reason}` : '.'}`;
      if (this.rejectConnectionReady(attempt, new Error(message))) return;
      if (this.state !== 'idle' && this.state !== 'error') {
        this.callbacks.onError(message);
        this.cleanup();
        this.setState('error');
      }
    };
  }

  private async startWebRtcMicMeter(stream: MediaStream, attempt: number): Promise<void> {
    if (this.captureContext || !this.isCurrentAttempt(attempt)) return;
    const context = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (context.state === 'suspended') await context.resume();
    if (!this.isCurrentAttempt(attempt) || this.mediaStream !== stream) {
      void context.close().catch(() => undefined);
      return;
    }
    this.captureContext = context;
    this.captureSource = context.createMediaStreamSource(stream);
    this.scriptProcessor = context.createScriptProcessor(1024, 1, 1);
    this.captureSink = context.createGain();
    this.captureSink.gain.value = 0;
    this.scriptProcessor.onaudioprocess = event => {
      if (this.micMuted || !this.audioReady) {
        this.callbacks.onMicVolume?.(0);
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let index = 0; index < input.length; index += 1) sum += input[index] * input[index];
      this.callbacks.onMicVolume?.(Math.min(100, Math.round(Math.sqrt(sum / Math.max(1, input.length)) * 400)));
    };
    this.captureSource.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.captureSink);
    this.captureSink.connect(context.destination);
  }

  private async startPcmCapture(targetSampleRate: number, attempt: number): Promise<void> {
    if (this.mediaStream && this.captureContext && this.scriptProcessor) {
      this.markCaptureReady(attempt);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable in this desktop runtime.');
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (!this.isCurrentAttempt(attempt)) {
      mediaStream.getTracks().forEach(track => track.stop());
      throw new Error(`${this.provider.label} microphone capture was cancelled.`);
    }
    this.mediaStream = mediaStream;
    this.mediaStream.getAudioTracks().forEach(track => { track.enabled = !this.micMuted; });
    this.captureContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (this.captureContext.state === 'suspended') await this.captureContext.resume();
    this.captureSource = this.captureContext.createMediaStreamSource(this.mediaStream);
    this.scriptProcessor = this.captureContext.createScriptProcessor(2048, 1, 1);
    const sourceRate = this.captureContext.sampleRate;
    this.scriptProcessor.onaudioprocess = event => {
      if (this.micMuted || !this.audioReady) return;
      const input = event.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let index = 0; index < input.length; index += 1) sum += input[index] * input[index];
      this.callbacks.onMicVolume?.(Math.min(100, Math.round(Math.sqrt(sum / input.length) * 400)));
      const base64 = pcm16ToBase64(input, sourceRate, targetSampleRate);
      if (this.provider.transport === 'deepgram-native') {
        if (this.ws?.readyState === WebSocket.OPEN && this.audioReady) {
          const bytes = base64ToBytes(base64);
          this.ws.send(bytes.buffer as ArrayBuffer);
        }
      } else if (this.provider.transport === 'xai-native') {
        this.sendJson({ type: 'input_audio_buffer.append', audio: base64 });
      } else if (this.provider.transport === 'elevenlabs-native') {
        this.sendJson({ user_audio_chunk: base64 });
      }
    };
    this.captureSource.connect(this.scriptProcessor);
    // ScriptProcessorNode must be connected to stay active, but the captured
    // microphone must never be routed back to the speakers as an audible echo.
    this.captureSink = this.captureContext.createGain();
    this.captureSink.gain.value = 0;
    this.scriptProcessor.connect(this.captureSink);
    this.captureSink.connect(this.captureContext.destination);
    this.markCaptureReady(attempt);
  }

  private sendDeepgramSettings(): void {
    this.sendJson({
      type: 'Settings',
      audio: {
        input: { encoding: 'linear16', sample_rate: 24000 },
        output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
      },
      agent: {
        language: 'en',
        context: { messages: this.options.initialContext?.chatHistory?.slice(-20).map(item => ({ type: 'History', role: item.role === 'model' ? 'assistant' : item.role, content: item.text })) || [] },
        listen: { provider: { type: 'deepgram', model: this.options.model && this.options.model !== 'auto' ? this.options.model : 'flux-general-en', version: 'v2' } },
        think: { prompt: this.sessionInstructions() },
        speak: { provider: { type: 'deepgram', model: this.options.voice && this.options.voice !== 'auto' ? this.options.voice : 'aura-2-thalia-en' } },
      },
    });
  }

  private interruptCurrentTurn(): void {
    this.pendingTurnCompletion = null;
    this.flushPlayback();
    this.callbacks.onInterrupted();
    this.internalTextTurn = false;
    this.inputTranscript = '';
    this.outputTranscript = '';
    this.callbacks.onModelVolume?.(0);
    this.setState('listening');
  }

  private completeCurrentTurn(): void {
    const completion = {
      input: this.inputTranscript.trim(),
      output: this.outputTranscript.trim(),
      internal: this.internalTextTurn,
    };
    if (this.activeSources.length > 0) {
      this.pendingTurnCompletion = completion;
      this.setState('speaking');
      return;
    }
    this.finalizeCompletedTurn(completion);
  }

  private finalizeCompletedTurn(
    completion = this.pendingTurnCompletion,
  ): void {
    if (!completion || this.activeSources.length > 0) return;
    this.pendingTurnCompletion = null;
    const { input, output, internal } = completion;
    this.internalTextTurn = false;
    this.setState('listening');
    if (internal) {
      this.inputTranscript = '';
      this.outputTranscript = '';
      this.callbacks.onModelVolume?.(0);
      queueMicrotask(() => this.flushPendingTextTurns());
      return;
    }
    if (!input && !output) {
      queueMicrotask(() => this.flushPendingTextTurns());
      return;
    }
    this.callbacks.onTurnComplete(input, output);
    this.inputTranscript = '';
    this.outputTranscript = '';
    this.callbacks.onModelVolume?.(0);
    queueMicrotask(() => this.flushPendingTextTurns());
  }

  private failProvider(attempt: number, message: string): void {
    const error = new Error(message);
    if (this.rejectConnectionReady(attempt, error)) return;
    if (!this.isCurrentAttempt(attempt) || this.state === 'idle' || this.state === 'error') return;
    this.callbacks.onError(message);
    this.cleanup();
    this.setState('error');
  }

  private async executeRealtimeTool(
    name: string,
    args: Record<string, any>,
    signal: AbortSignal,
    activityId: string,
  ): Promise<any> {
    const { action_verb: _verb, action_target: _target, ...toolInput } = args || {};
    if (name === 'browser_control' || name === 'computer_control') {
      const response = await fetch('/api/live/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          chatId: this.chatId,
          toolName: name === 'computer_control' ? 'screen_agent' : 'browser_control',
          input: toolInput,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.success === false) {
        throw new Error(payload?.error || `${name} failed (${response.status}).`);
      }
      const result = payload.result;
      if (result?.vision?.inlineData) {
        delete result.vision;
        result.visualEvidenceCaptured = true;
      }
      return result;
    }
    if (name === 'web_search') {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ query: String(args.query || '') }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `Web search failed (${response.status}).`);
      return payload.results || payload;
    }
    if (name === 'run_terminal_command') {
      let terminalShell = 'auto';
      try {
        terminalShell = JSON.parse(appStorage.getItem('eterx_settings') || '{}')?.terminalShell || 'auto';
      } catch { }
      const response = await fetch('/api/code/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          command: String(args.command || ''),
          terminalShell,
          chatId: this.chatId,
          ownerTraceId: activityId,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.success === false) {
        throw new Error(payload?.error || payload?.stderr || `Command failed (${response.status}).`);
      }
      if (typeof payload.stdout === 'string' && payload.stdout.length > 4_000) {
        payload.stdout = `${payload.stdout.slice(0, 4_000)}\n... [output truncated]`;
      }
      if (typeof payload.stderr === 'string' && payload.stderr.length > 2_000) {
        payload.stderr = `${payload.stderr.slice(0, 2_000)}\n... [stderr truncated]`;
      }
      return payload;
    }
    if (name === 'read_workspace_file') {
      const response = await fetch(`/api/code/files?filePath=${encodeURIComponent(String(args.filePath || ''))}`, { signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.success === false) {
        throw new Error(payload?.error || `File read failed (${response.status}).`);
      }
      return payload;
    }
    if (name === 'write_workspace_file') {
      const response = await fetch('/api/code/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ filePath: String(args.filePath || ''), content: String(args.content || '') }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.success === false) {
        throw new Error(payload?.error || `File write failed (${response.status}).`);
      }
      return payload;
    }
    const appActions = new Set([
      'send_prompt_to_main_agent',
      'list_all_chats',
      'get_main_agent_status',
      'read_chat_full_context',
      'switch_active_chat',
      'stop_main_agent_run',
      'control_app_ui',
    ]);
    if (appActions.has(name)) {
      if (!this.callbacks.onAppControlAction) throw new Error('Live app control is unavailable.');
      const result = await this.callbacks.onAppControlAction(name, args);
      if (result?.error) throw new Error(String(result.error));
      return result;
    }
    throw new Error(`Unsupported realtime Live tool: ${name}`);
  }

  private serializeToolOutput(value: unknown): string {
    try {
      const serialized = JSON.stringify(value ?? null);
      if (serialized.length <= 16_000) return serialized;
      return JSON.stringify({
        truncated: true,
        preview: serialized.slice(0, 15_500),
        note: 'The tool result was truncated to protect realtime context.',
      });
    } catch (error) {
      return JSON.stringify({ error: getErrorMessage(error, 'Tool output could not be serialized.') });
    }
  }

  private sendRealtimeToolOutput(callId: string, value: unknown): boolean {
    const event = {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: this.serializeToolOutput(value),
      },
    };
    if (this.provider.transport === 'openai-webrtc') {
      return this.sendDataChannel(event) && this.sendDataChannel({ type: 'response.create' });
    }
    return this.sendJson(event) && this.sendJson({ type: 'response.create' });
  }

  private async handleRealtimeFunctionCall(
    callIdValue: unknown,
    nameValue: unknown,
    argumentsValue: unknown,
    attempt: number,
  ): Promise<void> {
    const callId = String(callIdValue || '').trim();
    const name = String(nameValue || '').trim();
    if (!callId || !name || !this.isCurrentAttempt(attempt) || this.handledToolCallIds.has(callId)) return;
    this.awaitingToolContinuation = true;
    this.handledToolCallIds.add(callId);
    if (this.handledToolCallIds.size > 200) {
      const oldest = this.handledToolCallIds.values().next().value;
      if (oldest) this.handledToolCallIds.delete(oldest);
    }
    let args: Record<string, any> = {};
    try {
      args = typeof argumentsValue === 'string'
        ? JSON.parse(argumentsValue || '{}')
        : argumentsValue && typeof argumentsValue === 'object'
          ? { ...(argumentsValue as Record<string, any>) }
          : {};
    } catch {
      args = {};
    }

    const controller = new AbortController();
    this.activeToolCalls.set(callId, controller);
    const startedAt = Date.now();
    const activityId = `provider_live_tool_${callId}`;
    const label = `${String(args.action_verb || 'Working')} ${String(args.action_target || name)}`.trim().slice(0, 100);
    this.callbacks.onToolCallActive?.(name);
    this.callbacks.onToolAction?.(String(args.action_verb || 'Working'), String(args.action_target || name));
    this.callbacks.onAgentActivity?.({
      id: activityId,
      kind: name === 'send_prompt_to_main_agent' ? 'delegation' : 'tool',
      phase: 'started',
      label,
      detail: name,
      toolName: name,
      toolArgs: args,
      startedAt,
    });
    this.setState('thinking');

    let output: any;
    let failed = false;
    const timeout = setTimeout(() => controller.abort(new Error(`${name} timed out after 90 seconds.`)), 90_000);
    try {
      output = { result: await this.executeRealtimeTool(name, args, controller.signal, activityId) };
    } catch (error) {
      failed = true;
      output = { error: getErrorMessage(error, `${name} failed.`) };
    } finally {
      clearTimeout(timeout);
    }

    if (!this.isCurrentAttempt(attempt) || this.activeToolCalls.get(callId) !== controller) return;
    this.activeToolCalls.delete(callId);
    this.callbacks.onAgentActivity?.({
      id: activityId,
      kind: name === 'send_prompt_to_main_agent' ? 'delegation' : 'tool',
      phase: failed ? 'failed' : 'completed',
      label: failed ? `${label} failed` : label,
      detail: name,
      toolName: name,
      toolArgs: args,
      resultSummary: String(output.error || output.result?.message || (failed ? 'Action failed' : 'Action completed')).slice(0, 240),
      startedAt,
      completedAt: Date.now(),
    });
    this.callbacks.onToolCallActive?.(this.activeToolCalls.size > 0 ? 'tool' : null);
    if (!this.sendRealtimeToolOutput(callId, output)) {
      this.failProvider(attempt, `${this.provider.label} could not receive the ${name} tool result.`);
    }
  }

  private handleProviderMessage(raw: unknown, attempt = this.lifecycleId): void {
    if (!this.isCurrentAttempt(attempt)) return;
    if (typeof raw !== 'string') return;
    let message: any;
    try { message = JSON.parse(raw); } catch { return; }
    const type = String(message?.type || '');

    const functionCall = type === 'response.function_call_arguments.done'
      ? {
          callId: message.call_id || message.item_id,
          name: message.name,
          arguments: message.arguments,
        }
      : type === 'response.output_item.done' && message.item?.type === 'function_call'
        ? {
            callId: message.item.call_id || message.item.id,
            name: message.item.name,
            arguments: message.item.arguments,
          }
        : null;
    if (functionCall) {
      void this.handleRealtimeFunctionCall(
        functionCall.callId,
        functionCall.name,
        functionCall.arguments,
        attempt,
      );
      return;
    }

    if (this.provider.transport === 'deepgram-native') {
      if (type === 'Welcome') {
        this.sendDeepgramSettings();
        return;
      }
      if (type === 'SettingsApplied') {
        this.markTransportReady(attempt);
        if (this.options.audioInputEnabled !== false) {
          void this.startPcmCapture(24000, attempt).catch(error => {
            this.failProvider(attempt, getErrorMessage(error, 'Deepgram microphone capture could not start.'));
          });
        }
        return;
      }
      if (type === 'UserStartedSpeaking') {
        this.interruptCurrentTurn();
        return;
      }
      if (type === 'ConversationText') {
        const content = String(message.content || '');
        if (!content.trim()) return;
        if (message.role === 'user') {
          if (!this.internalTextTurn) {
            this.inputTranscript = appendText(this.inputTranscript, content);
            this.callbacks.onInputTranscription(this.inputTranscript);
          }
        } else {
          this.outputTranscript = appendText(this.outputTranscript, content);
          this.callbacks.onOutputTranscription(this.outputTranscript);
        }
      }
      if (type === 'AgentThinking') this.setState('thinking');
      if (type === 'AgentStartedSpeaking') this.setState('speaking');
      if (type === 'AgentAudioDone') {
        this.setState('listening');
        this.completeCurrentTurn();
      }
      if (type === 'Error') this.failProvider(attempt, String(message.description || 'Deepgram Voice Agent error.'));
      return;
    }

    if (this.provider.transport === 'elevenlabs-native') {
      if (type === 'conversation_initiation_metadata') {
        const metadata = message.conversation_initiation_metadata_event || {};
        this.playbackSampleRate = readSampleRate(metadata.agent_output_audio_format, 16000);
        this.markTransportReady(attempt);
      } else if (type === 'user_transcript') {
        const text = String(message.user_transcription_event?.user_transcript || '').trim();
        if (!this.internalTextTurn) {
          this.inputTranscript = appendText(this.inputTranscript, text);
          this.callbacks.onInputTranscription(this.inputTranscript);
        }
      } else if (type === 'agent_response') {
        const text = String(message.agent_response_event?.agent_response || '').trim();
        this.outputTranscript = appendText(this.outputTranscript, text);
        this.callbacks.onOutputTranscription(this.outputTranscript);
        this.setState('speaking');
      } else if (type === 'audio') {
        const audio = String(message.audio_event?.audio_base_64 || '');
        if (audio) this.enqueuePcm(base64ToBytes(audio), this.playbackSampleRate);
      } else if (type === 'interruption') {
        this.interruptCurrentTurn();
      } else if (type === 'agent_response_complete' || type === 'agent_response_done') {
        this.setState('listening');
        this.completeCurrentTurn();
      } else if (type === 'ping') {
        this.sendJson({ type: 'pong', event_id: message.ping_event?.event_id });
      } else if (type === 'error') {
        this.failProvider(attempt, String(message.message || message.error || 'ElevenLabs conversation error.'));
      }
      return;
    }

    if (type === 'session.updated') {
      this.markTransportReady(attempt);
    } else if (type === 'input_audio_buffer.speech_started') {
      this.interruptCurrentTurn();
    } else if (type === 'response.created') {
      if (this.awaitingToolContinuation && this.activeToolCalls.size === 0) {
        this.awaitingToolContinuation = false;
      }
      this.setState('thinking');
    } else if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta' || type === 'response.output_text.delta') {
      const delta = String(message.delta || '');
      this.outputTranscript = appendText(this.outputTranscript, delta);
      this.callbacks.onOutputTranscription(this.outputTranscript);
      this.setState('speaking');
    } else if (type === 'conversation.item.input_audio_transcription.updated' || type === 'conversation.item.input_audio_transcription.completed') {
      const text = String(message.transcript || '').trim();
      if (text && !this.internalTextTurn) {
        this.inputTranscript = text;
        this.callbacks.onInputTranscription(text);
      }
    } else if (type === 'response.output_audio.delta') {
      const audio = String(message.delta || '');
      if (audio) this.enqueuePcm(base64ToBytes(audio), 24000);
      this.setState('speaking');
    } else if (type === 'response.done') {
      const responseHasFunctionCall = Array.isArray(message.response?.output) &&
        message.response.output.some((item: any) => item?.type === 'function_call');
      if (responseHasFunctionCall || this.awaitingToolContinuation || this.activeToolCalls.size > 0) {
        this.setState('thinking');
        return;
      }
      this.setState('listening');
      this.completeCurrentTurn();
    } else if (type === 'error') {
      this.failProvider(attempt, String(message.error?.message || message.message || 'Realtime provider error.'));
    }
  }

  private ensurePlayback(): void {
    if (this.playbackContext) return;
    this.playbackContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.playbackAnalyser = this.playbackContext.createAnalyser();
    this.playbackAnalyser.fftSize = 256;
    this.playbackGain = this.playbackContext.createGain();
    this.playbackGain.gain.value = this.speakerMuted ? 0 : 1;
    this.playbackAnalyser.connect(this.playbackGain);
    this.playbackGain.connect(this.playbackContext.destination);
    this.nextPlayTime = this.playbackContext.currentTime;
    this.startModelVolumeLoop();
    if (this.playbackContext.state === 'suspended') void this.playbackContext.resume().catch(() => undefined);
  }

  private enqueuePcm(bytes: Uint8Array, sampleRate: number): void {
    if (this.speakerMuted || !bytes.length) return;
    try {
      this.ensurePlayback();
      const context = this.playbackContext as AudioContext;
      const buffer = context.createBuffer(1, Math.floor(bytes.byteLength / 2), sampleRate);
      buffer.getChannelData(0).set(pcmBytesToFloat32(bytes));
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.playbackAnalyser as AnalyserNode);
      const start = Math.max(context.currentTime, this.nextPlayTime);
      source.start(start);
      this.nextPlayTime = start + buffer.duration;
      this.activeSources.push(source);
      source.onended = () => {
        this.activeSources = this.activeSources.filter(item => item !== source);
        if (this.activeSources.length === 0 && this.pendingTurnCompletion) {
          queueMicrotask(() => this.finalizeCompletedTurn());
        }
      };
    } catch (error) {
      this.callbacks.onError(getErrorMessage(error, 'Realtime audio playback failed.'));
    }
  }

  private startModelVolumeLoop(): void {
    if (this.modelVolumeLoopId) cancelAnimationFrame(this.modelVolumeLoopId);
    const tick = () => {
      if (!this.playbackAnalyser || this.manualDisconnect || this.state === 'idle' || this.state === 'error') {
        this.modelVolumeLoopId = 0;
        this.callbacks.onModelVolume?.(0);
        return;
      }
      if (this.playbackAnalyser && this.state === 'speaking' && !this.speakerMuted) {
        const values = new Uint8Array(this.playbackAnalyser.frequencyBinCount);
        this.playbackAnalyser.getByteFrequencyData(values);
        const buckets = [0, 0, 0, 0];
        const size = Math.max(1, Math.floor(values.length / buckets.length));
        for (let bucket = 0; bucket < buckets.length; bucket += 1) {
          let total = 0;
          for (let index = bucket * size; index < Math.min(values.length, (bucket + 1) * size); index += 1) total += values[index];
          buckets[bucket] = Math.min(100, Math.round((total / size / 255) * 100));
        }
        this.callbacks.onModelVolume?.(buckets);
      } else if (this.speakerMuted) {
        this.callbacks.onModelVolume?.(0);
      }
      this.modelVolumeLoopId = requestAnimationFrame(tick);
    };
    tick();
  }

  private flushPlayback(): void {
    this.activeSources.forEach(source => { try { source.stop(); } catch { } });
    this.activeSources = [];
    if (this.playbackContext) this.nextPlayTime = this.playbackContext.currentTime;
    this.callbacks.onModelVolume?.(0);
    if (this.pendingTurnCompletion) queueMicrotask(() => this.finalizeCompletedTurn());
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    this.mediaStream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
    if (muted) this.callbacks.onMicVolume?.(0);
    if (muted && this.provider.transport === 'xai-native') this.sendJson({ type: 'input_audio_buffer.clear' });
  }

  isMicMuted(): boolean { return this.micMuted; }

  setSpeakerMuted(muted: boolean): void {
    this.speakerMuted = muted;
    if (this.audioElement) this.audioElement.muted = muted;
    if (this.playbackGain) this.playbackGain.gain.value = muted ? 0 : 1;
    if (muted) this.flushPlayback();
    else if (this.playbackContext?.state === 'suspended') void this.playbackContext.resume().catch(() => undefined);
  }

  isSpeakerMuted(): boolean { return this.speakerMuted; }

  announceSystemEvent(event: LiveSystemEvent): boolean {
    if (!event?.id || this.state === 'idle' || this.state === 'error') return false;
    const policy = this.options.interactionPolicy || {};
    if (policy.proactiveUpdates === false) return false;
    if ((policy.silenceUntilImportant || policy.notificationLevel === 'important') && event.type === 'task_progress') return false;
    if (policy.notificationLevel === 'critical' && (event.type === 'task_progress' || event.type === 'task_completed')) return false;
    const text = `[System update] ${event.summary}`;
    this.sendText(text, { internal: true });
    return true;
  }

  sendText(text: string, options: { internal?: boolean } = {}): boolean {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    const internal = options.internal === true;
    if (
      !this.audioReady ||
      this.state === 'connecting' ||
      (internal && (this.state === 'thinking' || this.state === 'speaking'))
    ) {
      if (this.state !== 'connecting' && !this.audioReady) return false;
      if (this.pendingTextTurns.length >= 8) {
        const internalIndex = this.pendingTextTurns.findIndex(turn => turn.internal);
        this.pendingTextTurns.splice(internalIndex >= 0 ? internalIndex : 0, 1);
      }
      this.pendingTextTurns.push({ text: trimmed, internal });
      return true;
    }
    return this.sendTextNow(trimmed, internal);
  }

  private flushPendingTextTurns(): void {
    if (!this.audioReady || this.state === 'connecting' || this.pendingTextTurns.length === 0) return;
    const turn = this.pendingTextTurns.shift()!;
    if (!this.sendTextNow(turn.text, turn.internal)) this.pendingTextTurns.unshift(turn);
  }

  private sendTextNow(trimmed: string, internal: boolean): boolean {
    let sent = false;
    if (this.provider.transport === 'deepgram-native') {
      sent = this.sendJson({ type: 'InjectUserMessage', content: trimmed });
    } else if (this.provider.transport === 'elevenlabs-native') {
      sent = this.sendJson({ type: 'user_message', text: trimmed });
    } else {
      const event = {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: trimmed }] },
      };
      if (this.provider.transport === 'openai-webrtc') {
        sent = this.sendDataChannel(event) && this.sendDataChannel({ type: 'response.create' });
      } else {
        sent = this.sendJson(event) && this.sendJson({ type: 'response.create' });
      }
    }
    if (!sent) return false;
    if (this.state === 'speaking' || this.activeSources.length > 0) this.interruptCurrentTurn();
    this.internalTextTurn = internal;
    this.inputTranscript = internal ? '' : trimmed;
    this.outputTranscript = '';
    if (!internal) this.callbacks.onInputTranscription(trimmed);
    return true;
  }

  isCameraEnabled(): boolean { return false; }
  isScreenShareEnabled(): boolean { return false; }

  async startCamera(_facingMode?: 'user' | 'environment'): Promise<{ success: boolean; message: string }> {
    return { success: false, message: `${this.provider.label} documents audio input only; camera is unavailable for this selected transport.` };
  }

  stopCamera(): void { this.callbacks.onCameraStateChange?.(false); }

  async startScreenShare(): Promise<{ success: boolean; message: string }> {
    return { success: false, message: `${this.provider.label} documents audio input only; screen sharing is unavailable for this selected transport.` };
  }

  stopScreenShare(): void { this.callbacks.onScreenShareStateChange?.(false); }

  getState(): LiveSessionState { return this.state; }

  disconnect(): void {
    this.manualDisconnect = true;
    if (this.connectionWaiter) {
      const waiter = this.connectionWaiter;
      clearTimeout(waiter.timer);
      this.connectionWaiter = null;
      waiter.reject(new Error(`${this.provider.label} Live connection was cancelled.`));
    }
    this.lifecycleId += 1;
    this.cleanup();
    this.setState('idle');
  }

  private cleanup(): void {
    if (this.connectionWaiter) {
      const waiter = this.connectionWaiter;
      clearTimeout(waiter.timer);
      this.connectionWaiter = null;
      waiter.reject(new Error(`${this.provider.label} Live connection ended before becoming ready.`));
    }
    cancelAnimationFrame(this.modelVolumeLoopId);
    this.modelVolumeLoopId = 0;
    this.audioReady = false;
    this.captureReady = false;
    this.internalTextTurn = false;
    this.awaitingToolContinuation = false;
    this.pendingTurnCompletion = null;
    this.pendingTextTurns = [];
    this.inputTranscript = '';
    this.outputTranscript = '';
    this.callbacks.onMicVolume?.(0);
    this.callbacks.onModelVolume?.(0);
    this.callbacks.onToolCallActive?.(null);
    this.activeToolCalls.forEach(controller => controller.abort());
    this.activeToolCalls.clear();
    this.handledToolCallIds.clear();
    if (this.scriptProcessor) { this.scriptProcessor.disconnect(); this.scriptProcessor = null; }
    if (this.captureSource) { this.captureSource.disconnect(); this.captureSource = null; }
    if (this.captureSink) { this.captureSink.disconnect(); this.captureSink = null; }
    if (this.captureContext) { void this.captureContext.close().catch(() => undefined); this.captureContext = null; }
    if (this.mediaStream) { this.mediaStream.getTracks().forEach(track => track.stop()); this.mediaStream = null; }
    this.flushPlayback();
    if (this.playbackContext) { void this.playbackContext.close().catch(() => undefined); this.playbackContext = null; }
    if (this.remotePlaybackSource) { try { this.remotePlaybackSource.disconnect(); } catch { } this.remotePlaybackSource = null; }
    if (this.remotePlaybackSink) { try { this.remotePlaybackSink.disconnect(); } catch { } this.remotePlaybackSink = null; }
    this.playbackAnalyser = null;
    this.playbackGain = null;
    this.nextPlayTime = 0;
    if (this.audioElement) { this.audioElement.srcObject = null; this.audioElement.remove(); this.audioElement = null; }
    if (this.dataChannel) { try { this.dataChannel.close(); } catch { } this.dataChannel = null; }
    if (this.peerConnection) { try { this.peerConnection.close(); } catch { } this.peerConnection = null; }
    if (this.ws) { try { this.ws.close(); } catch { } this.ws = null; }
  }
}

export const createLiveSession = (
  apiKey: string,
  chatId: string,
  provider: LiveProviderOption,
  callbacks: LiveSessionCallbacks,
  options?: LiveSessionOptions,
): LiveSession => provider.transport === 'gemini-native'
  ? new AgentLiveSession(apiKey, chatId, callbacks, options)
  : new ProviderLiveSession(apiKey, chatId, provider, callbacks, options);
