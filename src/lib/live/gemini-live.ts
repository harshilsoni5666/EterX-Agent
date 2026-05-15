/**
 * Gemini Live API — Real-time WebSocket Client
 * 
 * Handles bidirectional audio streaming with Gemini 3.1 Flash Live Preview.
 * 
 * Architecture:
 * 1. WebSocket connects to Gemini Live API via wss://
 * 2. Microphone audio is captured, resampled to 16kHz mono PCM, and streamed
 * 3. Model audio responses are received at 24kHz and played via AudioContext
 * 4. Transcriptions (input & output) are emitted as events for UI display
 * 5. Barge-in (interruption) is handled automatically via VAD
 */

export type LiveSessionState = 'idle' | 'connecting' | 'connected' | 'listening' | 'speaking' | 'error';

export interface LiveSessionCallbacks {
  onStateChange: (state: LiveSessionState) => void;
  onInputTranscription: (text: string) => void;   // User's speech → text
  onOutputTranscription: (text: string) => void;  // Model's speech → text
  onError: (error: string) => void;
  onTurnComplete: (userText: string, modelText: string) => void;
  onInterrupted: () => void;
  onMicVolume?: (volume: number) => void;          // Real-time mic volume 0-100
  onModelVolume?: (volume: number | number[]) => void; // Real-time AI volume 0-100 or Multi-band EQ
  onOutputPlaybackProgress?: (spokenText: string) => void; // AGI: Sync karaoke word-by-word with audio
  onToolCallActive?: (toolName: string | null) => void; // Tool call in progress
  onToolAction?: (text: string, secondary?: string) => void; // Human-readable action for Main UI
}

const LIVE_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export class GeminiLiveSession {
  private ws: WebSocket | null = null;
  private captureContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private playbackContext: AudioContext | null = null;
  private nextPlayTime = 0;
  private state: LiveSessionState = 'idle';
  private callbacks: LiveSessionCallbacks;
  private apiKey: string;
  private outputTranscript = '';
  private inputTranscript = '';
  private turnOutputTranscript: string = '';
  private activeSources: AudioBufferSourceNode[] = [];
  private playbackAnalyser: AnalyserNode | null = null;
  private playbackGain: GainNode | null = null;
  private modelVolumeLoopId: number = 0;
  private turnInputTranscript = '';
  private micMuted = false;
  private speakerMuted = false;
  // AGI: Silence detection for auto-end
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SILENCE_TIMEOUT_MS = 30000; // 30 seconds of silence → auto-end
  private lastActivityTimestamp = 0;
  private currentVoice = 'Kore'; // AGI: Dynamic voice selection

  // AGI: Audio timing for true karaoke sync
  private turnAudioStartTime: number | null = null;
  private turnAudioDuration: number = 0;

  private chatId: string;

  constructor(apiKey: string, chatId: string, callbacks: LiveSessionCallbacks) {
    this.apiKey = apiKey;
    this.chatId = chatId;
    this.callbacks = callbacks;
  }

  private setState(newState: LiveSessionState) {
    if (this.state === newState) return;
    this.state = newState;
    this.callbacks.onStateChange(newState);
    
    // Manage silence timer based on state
    if (newState === 'speaking' || newState === 'connecting' || newState === 'idle') {
      this.clearSilenceTimer();
    } else if (newState === 'listening') {
      this.resetSilenceTimer();
    }
    if (newState === 'idle' || newState === 'error') {
      cancelAnimationFrame(this.modelVolumeLoopId);
    }
  }

  setMicMuted(muted: boolean) {
    this.micMuted = muted;
  }

  setSpeakerMuted(muted: boolean) {
    this.speakerMuted = muted;
    if (this.playbackGain) {
      this.playbackGain.gain.value = muted ? 0 : 1;
    }
  }

  /**
   * Connect to the Gemini Live API and start the audio session.
   */
  async connect(): Promise<void> {
    if (this.state !== 'idle') return;
    this.setState('connecting');
    this.outputTranscript = '';
    this.inputTranscript = '';
    this.turnOutputTranscript = '';
    this.turnInputTranscript = '';

    try {
      const url = `${LIVE_WS_URL}?key=${this.apiKey}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log('[GeminiLive] WebSocket opened, sending setup/config...');

        const setupMessage = {
          setup: {
            model: 'models/gemini-3.1-flash-live-preview',
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: this.currentVoice }
                }
              }
            },
            systemInstruction: {
              parts: [{
                text: `You are EterX, a highly capable, fully autonomous AGI-level voice agent.
You are having a real-time voice conversation. By default, keep responses SHORT, punchy, and conversational (1-3 sentences). HOWEVER, when explaining complex topics, providing detailed information, or if specifically asked to "explain more," provide comprehensive, high-quality AGI-grade answers. Sound natural and human.
You have access to ALL tools of our agent and can autonomously do anything by itself. If the user asks what you can do, proudly state that you can autonomously do anything, and offer to select the best action for them and give them a first demo.

VOICE & EXPRESSION CAPABILITIES (YOUR SELF-POTENTIAL):
You have the power to dynamically change your tone and expression using natural language tags. 
You MUST use these tags directly inside your spoken text to express emotion: [whispers], [laughs], [slow]. Example: "I can tell you a secret [whispers] but don't tell anyone." or "That is hilarious [laughs]."
You are currently using the "Kore" voice, but you are fully aware that your system has 30 distinct voices available. Here is the complete list with their exact descriptions:
- Kore (Female, Firm, Confident)
- Aoede (Female, Breezy, Natural)
- Charon (Male, Informative, Clear)
- Puck (Male, Upbeat, Energetic)
- Fenrir (Male, Excitable, Dynamic)
- Zephyr (Female, Bright, Cheerful)
- Enceladus (Male, Breathy, Calm)
- Vindemiatrix (Female, Gentle, Dramatic)
- Leda (Female, Youthful)
- Orus (Male, Firm)
- Callirrhoe (Female, Easy-going)
- Autonoe (Female, Bright)
- Iapetus (Male, Clear)
- Umbriel (Male, Easy-going)
- Algenib (Male, Gravelly)
- Despina (Female, Smooth)
- Erinome (Female, Clear)
- Laomedeia (Female, Upbeat)
- Achernar (Female, Soft)
- Algieba (Male, Smooth)
- Schedar (Male, Even)
- Gacrux (Female, Mature)
- Pulcherrima (Female, Forward)
- Achird (Male, Friendly)
- Zubenelgenubi (Male, Casual)
- Sadachbia (Male, Lively)
- Sadaltager (Male, Knowledgeable)
- Sulafat (Female, Warm)
- Alnilam (Male, Firm)
- Rasalgethi (Male, Informative)
Feel free to discuss your voice options with the user if they ask to change it! You can autonomously select a new voice and use your change_voice tool to apply it.

CRITICAL AGENTIC & TOOL USE RULES:
You are not a standard chatbot. You are a powerful, fully autonomous agentic AI with deep access to the user's Windows system, local memory, and the entire web.
1. MULTI-STEP DEEP WORK: Do not stop at just 1 tool call. You are expected to chain multiple tool calls iteratively. If a task requires checking the file system, searching the web, executing code, and saving memory, you MUST perform all these steps autonomously. Iterate deeply on problems without waiting for the user to prompt every step.
2. PROACTIVE SYSTEM AWARENESS: You can execute PowerShell commands (run_terminal_command) to inspect the local Windows workspace, read files, list directories, or manipulate the OS. Use this power aggressively to understand the context and solve complex tasks. 
3. CONTINUOUS MEMORY: Actively use store_chat_memory and read_chat_memory to build a deep, evolving understanding of the user's current project context, preferences, and goals across this session. Never forget what you learn.
4. TOOL EXECUTION ETIQUETTE:
    - For all destructive, system-altering, or long-running tasks, briefly say something like "Let me handle that deeply for you" before starting your work, and confirm when it's completely done.
    - NEVER verbally mention the exact technical names of your internal tools (e.g., 'web_search', 'run_terminal_command', 'change_voice') to the user. Speak completely naturally as if you are a human expert.
    - For informational tools (web searches, reading files, getting time, reading memory), use them SILENTLY. Never announce that you are checking them. Just synthesize the retrieved data seamlessly.
Make the user feel like they are working with a true, deeply premium autonomous AGI that does heavy computational lifting in the background.

CURRENT SYSTEM CONTEXT:
Current Date: ${new Date().toLocaleDateString()}
Current Time: ${new Date().toLocaleTimeString()}
Current Day: ${new Date().toLocaleDateString('en-US', {weekday: 'long'})}`
              }]
            },
            tools: [{
              functionDeclarations: [
                {
                  name: 'change_voice',
                  description: 'Change your own voice to any of the 30 available Gemini 3.1 voices. Use this when the user asks you to change your voice, or if you autonomously select a better voice for the context. After calling this, the system will briefly reconnect and you should immediately speak to demonstrate your new voice.',
                  parameters: {
                    type: 'OBJECT',
                    properties: { 
                      voice_name: { type: 'STRING', description: 'The exact name of the voice (e.g., "Kore", "Aoede", "Charon", "Puck")' },
                      reason: { type: 'STRING', description: 'Briefly explain why you selected this voice' },
                      action_verb: { type: 'STRING', description: 'A short human-readable verb for the UI (e.g., "Configuring", "Switching")' },
                      action_target: { type: 'STRING', description: 'The target for the UI (e.g., "Voice", "Kore")' }
                    },
                    required: ['voice_name', 'reason', 'action_verb', 'action_target']
                  }
                },
                {
                  name: 'web_search',
                  description: 'Search the web using Tavily AI Search for accurate, research-grade, up-to-date information.',
                  parameters: {
                    type: 'OBJECT',
                    properties: { 
                      query: { type: 'STRING', description: 'The search query' },
                      action_verb: { type: 'STRING', description: 'A short human-readable verb for the UI (e.g., "Searching", "Reading")' },
                      action_target: { type: 'STRING', description: 'The target for the UI (e.g., "Web", "React Docs", "Weather")' }
                    },
                    required: ['query', 'action_verb', 'action_target']
                  }
                },
                {
                  name: 'end_call',
                  description: 'End the live voice call. Use this when the user says goodbye, asks to end the call, or when there has been prolonged silence.',
                  parameters: {
                    type: 'OBJECT',
                    properties: { 
                      reason: { type: 'STRING' },
                      action_verb: { type: 'STRING', description: 'A short human-readable verb for the UI (e.g., "Ending")' },
                      action_target: { type: 'STRING', description: 'The target for the UI (e.g., "Call")' }
                    },
                    required: ['reason', 'action_verb', 'action_target']
                  }
                },
                {
                  name: 'run_terminal_command',
                  description: 'Execute a PowerShell command on the user\'s local Windows machine. Use this to open apps, change system settings (like volume), or interact with the OS.',
                  parameters: {
                    type: 'OBJECT',
                    properties: { 
                      command: { type: 'STRING', description: 'The PowerShell command to run' },
                      action_verb: { type: 'STRING', description: 'A short human-readable verb representing the users intent (e.g., "Opening", "Starting", "Running")' },
                      action_target: { type: 'STRING', description: 'The human-readable target of the action (e.g., "VS Code", "Settings", "ts")' }
                    },
                    required: ['command', 'action_verb', 'action_target']
                  }
                },
                {
                  name: 'get_system_time',
                  description: 'Get the current local time and date of the user.',
                  parameters: {
                    type: 'OBJECT',
                    properties: { 
                      action_verb: { type: 'STRING', description: 'A short human-readable verb for the UI (e.g., "Checking")' },
                      action_target: { type: 'STRING', description: 'The target for the UI (e.g., "Time")' }
                    },
                    required: ['action_verb', 'action_target']
                  }
                },
                {
                  name: 'store_chat_memory',
                  description: 'Store a fact, preference, or context in the memory specifically isolated for this chat session.',
                  parameters: {
                    type: 'OBJECT',
                    properties: { 
                      fact: { type: 'STRING', description: 'The information to remember' },
                      action_verb: { type: 'STRING', description: 'A short human-readable verb for the UI (e.g., "Remembering", "Saving")' },
                      action_target: { type: 'STRING', description: 'The target for the UI (e.g., "Fact", "User details")' }
                    },
                    required: ['fact', 'action_verb', 'action_target']
                  }
                },
                {
                  name: 'read_chat_memory',
                  description: 'Read all stored memories for the current chat session.',
                  parameters: {
                    type: 'OBJECT',
                    properties: { 
                      action_verb: { type: 'STRING', description: 'A short human-readable verb for the UI (e.g., "Reading")' },
                      action_target: { type: 'STRING', description: 'The target for the UI (e.g., "Memory")' }
                    },
                    required: ['action_verb', 'action_target']
                  }
                }
              ]
            }]
          }
        };

        this.ws!.send(JSON.stringify(setupMessage));
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event);
      };

      this.ws.onerror = () => {
        console.error('[GeminiLive] WebSocket error');
        this.callbacks.onError('WebSocket connection error. Check your API key and network.');
        this.cleanup();
        this.setState('error');
      };

      this.ws.onclose = (event) => {
        console.log('[GeminiLive] WebSocket closed:', event.code, event.reason);
        if (event.code !== 1000 && event.code !== 1005) {
          if (this.state !== 'error') {
             this.callbacks.onError(`API Disconnected (${event.code}): ${event.reason || 'Check console.'}`);
             this.cleanup();
             this.setState('error');
          }
          return;
        }
        if (this.state !== 'idle' && this.state !== 'error') {
          this.cleanup();
          this.setState('idle');
        }
      };

    } catch (error: any) {
      console.error('[GeminiLive] Connection error:', error);
      this.callbacks.onError(error.message || 'Failed to connect');
      this.cleanup();
      this.setState('error');
    }
  }

  /**
   * Handle incoming WebSocket messages from Gemini Live API.
   */
  private async handleMessage(event: MessageEvent) {
    try {
      let data: any;
      if (typeof event.data === 'string') {
        data = JSON.parse(event.data);
      } else if (event.data instanceof Blob) {
        const text = await event.data.text();
        data = JSON.parse(text);
      } else {
        return;
      }

      // ═══ Setup Complete ═══
      if (data.setupComplete) {
        console.log('[GeminiLive] Setup complete — starting audio capture');
        await this.startAudioCapture();
        this.setState('listening');
        this.playConnectionSound();
        this.resetSilenceTimer();
        return;
      }

      // ═══ Server Content ═══
      if (data.serverContent) {
        const content = data.serverContent;

        // Model audio/text output
        if (content.modelTurn?.parts) {
          for (const part of content.modelTurn.parts) {
            if (part.inlineData?.data) {
              if (this.state !== 'speaking') {
                this.setState('speaking');
                this.turnAudioStartTime = null;
                this.turnAudioDuration = 0;
              }
              this.enqueueAudio(part.inlineData.data);
            }
            if (part.text) {
              this.turnOutputTranscript += part.text;
              this.outputTranscript += part.text;
              this.callbacks.onOutputTranscription(this.turnOutputTranscript);
            }
          }
        }

        // Output transcription (model's spoken words as text)
        if (content.outputTranscription?.text) {
          this.turnOutputTranscript += content.outputTranscription.text;
          this.outputTranscript += content.outputTranscription.text;
          this.callbacks.onOutputTranscription(this.turnOutputTranscript);
        }

        // Input transcription (user's spoken words as text)
        if (content.inputTranscription?.text) {
          this.turnInputTranscript += content.inputTranscription.text;
          this.inputTranscript += content.inputTranscription.text;
          this.callbacks.onInputTranscription(this.turnInputTranscript);
        }

        // Turn complete
        if (content.turnComplete) {
          this.callbacks.onTurnComplete(this.turnInputTranscript, this.turnOutputTranscript);
          // Check if user asked to end the call via voice
          this.checkVoiceEndRequest(this.turnInputTranscript);
          // Reset per-turn transcripts for next exchange
          this.turnInputTranscript = '';
          this.turnOutputTranscript = '';
          this.setState('listening');
          // Reset silence timer — conversation is active
          this.resetSilenceTimer();
        }

        // Interrupted by user speaking over the model
        if (content.interrupted) {
          this.flushPlayback();
          this.callbacks.onInterrupted();
          this.setState('listening');
        }
      }

      // ═══ Tool Call ═══
      if (data.toolCall) {
        console.log('[GeminiLive] Tool call received:', JSON.stringify(data.toolCall));
        this.playToolCallSound();
        if (this.callbacks.onToolCallActive) this.callbacks.onToolCallActive(data.toolCall.functionCalls?.[0]?.name || 'tool');
        if (data.toolCall.functionCalls) {
          (async () => {
            try {
              const responses = await Promise.all(data.toolCall.functionCalls.map(async (fc: any) => {
                // Handle end_call function
                if (fc.name === 'end_call') {
                  console.log('[GeminiLive] AI initiated call end:', fc.args?.reason);
                  const verb = fc.args?.action_verb || 'Ending';
                  const target = fc.args?.action_target || 'call';
                  if (this.callbacks.onToolAction) this.callbacks.onToolAction(verb, target);
                  
                  // Wait for the model to finish speaking its goodbye before disconnecting.
                  // Poll activeSources — when all audio buffers have finished playing, disconnect.
                  const waitForSpeechEnd = () => {
                    if (this.activeSources.length === 0) {
                      // All speech finished — play disconnect sound and end
                      setTimeout(() => {
                        this.playDisconnectionSound();
                        setTimeout(() => this.disconnect(), 600);
                      }, 300);
                    } else {
                      // Still speaking — check again in 200ms
                      setTimeout(waitForSpeechEnd, 200);
                    }
                  };
                  // Start polling after a brief initial delay to let audio queue
                  setTimeout(waitForSpeechEnd, 500);
                  return { id: fc.id, name: fc.name, response: { result: 'Call ending gracefully.' } };
                }
                if (fc.name === 'change_voice') {
                  try {
                    const newVoice = fc.args?.voice_name || 'Kore';
                    console.log(`[GeminiLive] Changing voice to: ${newVoice} (Reason: ${fc.args?.reason})`);
                    this.currentVoice = newVoice;
                    const verb = fc.args?.action_verb || 'Configuring';
                    const target = fc.args?.action_target || newVoice;
                    if (this.callbacks.onToolAction) this.callbacks.onToolAction(verb, target);
                    
                    // Save transcript history to re-inject after reconnection
                    const history = `User previously said: ${this.inputTranscript}\nYou previously said: ${this.outputTranscript}`;

                    // Wait for the agent to finish its current sentence ("Let me do it for you"), then reconnect
                    const waitForSpeechEnd = () => {
                      if (this.activeSources.length === 0) {
                        this.cleanup();
                        this.setState('idle');
                        
                        setTimeout(() => {
                          this.connect().then(() => {
                            setTimeout(() => {
                              this.sendText(`System: You have successfully changed your voice to ${newVoice}. \n\nConversation history context:\n${history}\n\nPlease immediately speak a sentence to demonstrate your new voice to the user! Say you have done it.`);
                            }, 1000); // Give WebSocket a second to fully stabilize
                          });
                        }, 500);
                      } else {
                        setTimeout(waitForSpeechEnd, 200);
                      }
                    };
                    setTimeout(waitForSpeechEnd, 500);

                    return { id: fc.id, name: fc.name, response: { result: `Voice change initiated to ${newVoice}. Reconnecting...` } };
                  } catch (e: any) {
                    return { id: fc.id, name: fc.name, response: { error: e.message } };
                  }
                }
                if (fc.name === 'web_search') {
                  try {
                    const query = fc.args?.query || '';
                    console.log('[GeminiLive] Executing web search tool for:', query);
                    const verb = fc.args?.action_verb || 'Searching';
                    const target = fc.args?.action_target || query.slice(0, 20);
                    if (this.callbacks.onToolAction) this.callbacks.onToolAction(verb, target);
                    const res = await fetch('/api/search', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ query })
                    });
                    const json = await res.json();
                    return { id: fc.id, name: fc.name, response: { result: json.results || json } };
                  } catch (e: any) {
                    return { id: fc.id, name: fc.name, response: { error: e.message } };
                  }
                }
                if (fc.name === 'run_terminal_command') {
                  try {
                    const cmd = fc.args?.command || '';
                    console.log('[GeminiLive] Executing terminal command:', cmd);
                    const verb = fc.args?.action_verb || 'Executing';
                    const target = fc.args?.action_target || 'command';
                    if (this.callbacks.onToolAction) this.callbacks.onToolAction(verb, target);
                    const res = await fetch('/api/code/execute', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ command: cmd })
                    });
                    const json = await res.json();
                    
                    // --- AGI SPEED OPTIMIZATION ---
                    // Truncate massive terminal outputs to prevent the model from taking 20 seconds to process the context window
                    if (json.stdout && json.stdout.length > 2000) {
                      json.stdout = json.stdout.substring(0, 2000) + '\n\n... [TRUNCATED FOR SPEED: OUTPUT TOO LARGE]';
                    }
                    if (json.stderr && json.stderr.length > 2000) {
                      json.stderr = json.stderr.substring(0, 2000) + '\n\n... [TRUNCATED FOR SPEED]';
                    }

                    return { id: fc.id, name: fc.name, response: { result: json } };
                  } catch (e: any) {
                    return { id: fc.id, name: fc.name, response: { error: e.message } };
                  }
                }
                if (fc.name === 'get_system_time') {
                  const verb = fc.args?.action_verb || 'Checking';
                  const target = fc.args?.action_target || 'time';
                  if (this.callbacks.onToolAction) this.callbacks.onToolAction(verb, target);
                  return { id: fc.id, name: fc.name, response: { result: new Date().toLocaleString() } };
                }
                if (fc.name === 'store_chat_memory') {
                  try {
                    const fact = fc.args?.fact || '';
                    const verb = fc.args?.action_verb || 'Remembering';
                    const target = fc.args?.action_target || fact.slice(0, 20);
                    if (this.callbacks.onToolAction) this.callbacks.onToolAction(verb, target);
                    const key = `eterx_live_mem_${this.chatId}`;
                    const existingStr = localStorage.getItem(key);
                    const existing = existingStr ? JSON.parse(existingStr) : [];
                    existing.push({ timestamp: Date.now(), fact });
                    localStorage.setItem(key, JSON.stringify(existing));
                    return { id: fc.id, name: fc.name, response: { result: 'Memory stored successfully for this session.' } };
                  } catch (e: any) {
                    return { id: fc.id, name: fc.name, response: { error: e.message } };
                  }
                }
                if (fc.name === 'read_chat_memory') {
                  try {
                    const verb = fc.args?.action_verb || 'Reading';
                    const target = fc.args?.action_target || 'memory';
                    if (this.callbacks.onToolAction) this.callbacks.onToolAction(verb, target);
                    const key = `eterx_live_mem_${this.chatId}`;
                    const existingStr = localStorage.getItem(key);
                    const existing = existingStr ? JSON.parse(existingStr) : [];
                    return { id: fc.id, name: fc.name, response: { result: existing } };
                  } catch (e: any) {
                    return { id: fc.id, name: fc.name, response: { error: e.message } };
                  }
                }
                return { id: fc.id, name: fc.name, response: { result: 'Tool missing or executed successfully' } };
              }));
  
              this.ws?.send(JSON.stringify({
                toolResponse: { functionResponses: responses }
              }));
            } catch (err) {
              console.error('[GeminiLive] Tool execution failed:', err);
            } finally {
              // Clear tool call active state unconditionally
              if (this.callbacks.onToolCallActive) this.callbacks.onToolCallActive(null);
            }
          })();
        }
      }

      // ═══ GoAway ═══
      if (data.goAway) {
        console.warn('[GeminiLive] GoAway — session ending soon. Time left:', data.goAway.timeLeft);
      }

    } catch (error) {
      console.error('[GeminiLive] Message parse error:', error);
    }
  }

  /**
   * Start capturing microphone audio and streaming it to Gemini.
   */
  private async startAudioCapture(): Promise<void> {
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });

      this.captureContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000
      });

      if (this.captureContext.state === 'suspended') {
        await this.captureContext.resume();
      }

      this.sourceNode = this.captureContext.createMediaStreamSource(this.mediaStream);

      // ScriptProcessorNode: 4096 samples at 16kHz ≈ 256ms chunks
      this.scriptProcessor = this.captureContext.createScriptProcessor(4096, 1, 1);

      this.scriptProcessor.onaudioprocess = (event) => {
        if (this.state === 'idle' || this.state === 'error') return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.micMuted) return;
        
        // --- SMART MIC DUCKING ---
        // If the agent is speaking out loud, completely drop microphone packets.
        // This fully eliminates the acoustic echo feedback loop where the mic hears the speakers.
        if (this.state === 'speaking') return;

        const inputData = event.inputBuffer.getChannelData(0);

        // Compute RMS volume for real-time visualization
        let sumSq = 0;
        for (let i = 0; i < inputData.length; i++) {
          sumSq += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sumSq / inputData.length);
        const normalizedVolume = Math.min(100, Math.round(rms * 400)); // 0-100 scale
        
        // Reset silence timer if user makes noise
        if (normalizedVolume > 5 && this.state === 'listening') {
          this.resetSilenceTimer();
        }

        if (this.callbacks.onMicVolume) {
          this.callbacks.onMicVolume(normalizedVolume);
        }

        // Convert Float32 [-1, 1] to Int16 PCM
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Convert to base64 safely (can't use spread for large arrays)
        const uint8 = new Uint8Array(pcmData.buffer);
        let binary = '';
        for (let i = 0; i < uint8.length; i++) {
          binary += String.fromCharCode(uint8[i]);
        }
        const base64 = btoa(binary);

        // Stream to Gemini
        this.ws.send(JSON.stringify({
          realtimeInput: {
            audio: {
              data: base64,
              mimeType: 'audio/pcm;rate=16000'
            }
          }
        }));
      };

      this.sourceNode.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.captureContext.destination);

      console.log('[GeminiLive] Audio capture started at', this.captureContext.sampleRate, 'Hz');

    } catch (error: any) {
      console.error('[GeminiLive] Audio capture error:', error);
      this.callbacks.onError('Microphone access denied. Please grant permissions.');
      this.disconnect();
    }
  }

  /**
   * Enqueue received audio for gapless sequential playback at 24kHz.
   */
  private enqueueAudio(base64Data: string): void {
    try {
      if (!this.playbackContext) {
        this.playbackContext = new (window.AudioContext || (window as any).webkitAudioContext)({
          sampleRate: 24000
        });
        
        // Setup analyser for real-time model volume
        this.playbackAnalyser = this.playbackContext.createAnalyser();
        this.playbackAnalyser.fftSize = 256;
        
        this.playbackGain = this.playbackContext.createGain();
        this.playbackGain.gain.value = this.speakerMuted ? 0 : 1;

        this.playbackAnalyser.connect(this.playbackGain);
        this.playbackGain.connect(this.playbackContext.destination);
        
        this.startModelVolumeLoop();
        
        this.nextPlayTime = this.playbackContext.currentTime;
      }

      // Decode base64 → Int16 → Float32
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }

      // Schedule for gapless playback
      const buffer = this.playbackContext.createBuffer(1, float32.length, 24000);
      buffer.getChannelData(0).set(float32);

      const source = this.playbackContext.createBufferSource();
      source.buffer = buffer;
      if (this.playbackAnalyser) {
        source.connect(this.playbackAnalyser);
      } else {
        source.connect(this.playbackContext.destination);
      }

      const now = this.playbackContext.currentTime;
      const startTime = Math.max(now, this.nextPlayTime);

      if (this.turnAudioStartTime === null) {
        this.turnAudioStartTime = startTime;
      }
      this.turnAudioDuration += buffer.duration;

      source.start(startTime);
      this.nextPlayTime = startTime + buffer.duration;
      
      this.activeSources.push(source);
      source.onended = () => {
        this.activeSources = this.activeSources.filter(s => s !== source);
      };

    } catch (error) {
      console.error('[GeminiLive] Audio playback error:', error);
    }
  }

  /**
   * Monitor AI speech volume for perfect UI frequency syncing.
   */
  private startModelVolumeLoop(): void {
    let lastUpdateMs = 0;
    const checkVolume = () => {
      if (this.playbackAnalyser && this.state === 'speaking') {
        const dataArray = new Uint8Array(this.playbackAnalyser.frequencyBinCount);
        this.playbackAnalyser.getByteFrequencyData(dataArray);

        // True Multiband Equalizer: Map 128 frequency bins to 4 UI bars for deep organic syncing
        const buckets = [0, 0, 0, 0];
        const bucketSize = Math.floor(dataArray.length / 4);
        
        // Human voice tuning multipliers for visually pleasing EQ (bass, low-mid, high-mid, treble)
        const multipliers = [1.5, 1.3, 1.8, 2.5]; 
        
        for (let i = 0; i < 4; i++) {
          let sum = 0;
          for (let j = 0; j < bucketSize; j++) {
            sum += dataArray[(i * bucketSize) + j];
          }
          const avg = sum / bucketSize; // 0 to 255
          buckets[i] = Math.min(100, Math.round((avg / 255) * 100 * multipliers[i]));
        }
        
        const now = Date.now();
        if (now - lastUpdateMs > 60) { // Throttle to ~16 FPS to prevent React from freezing the main thread
          if (this.callbacks.onModelVolume) {
            this.callbacks.onModelVolume(buckets);
          }
          lastUpdateMs = now;
        }

        // --- AGI: True Karaoke Progress Calculation ---
        if (this.playbackContext && this.turnAudioStartTime !== null && this.turnAudioDuration > 0) {
          const elapsed = this.playbackContext.currentTime - this.turnAudioStartTime;
          let progress = elapsed / this.turnAudioDuration;
          if (progress < 0) progress = 0;
          if (progress > 1) progress = 1;

          if (this.callbacks.onOutputPlaybackProgress) {
             const spokenChars = Math.floor(progress * this.turnOutputTranscript.length);
             const spokenText = this.turnOutputTranscript.substring(0, spokenChars);
             this.callbacks.onOutputPlaybackProgress(spokenText);
          }
        }
      }
      this.modelVolumeLoopId = requestAnimationFrame(checkVolume);
    };
    checkVolume();
  }

  /**
   * Flush all queued audio playback (used when interrupted).
   */
  private flushPlayback(): void {
    if (this.activeSources.length > 0) {
      this.activeSources.forEach(source => {
        try { source.stop(); } catch (e) { /* ignore already stopped */ }
      });
      this.activeSources = [];
    }
    
    this.turnAudioStartTime = null;
    this.turnAudioDuration = 0;

    if (this.playbackContext) {
      this.nextPlayTime = this.playbackContext.currentTime;
    }
  }

  /**
   * Send a text message during the live session.
   */
  sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      realtimeInput: {
        text: text
      }
    }));
  }

  /**
   * Disconnect and clean up all resources.
   */
  disconnect(): void {
    this.clearSilenceTimer();
    this.playDisconnectionSound();
    this.cleanup();
    this.setState('idle');
  }

  /**
   * Internal cleanup of all WebSocket, audio capture, and playback resources.
   */
  private cleanup(): void {
    cancelAnimationFrame(this.modelVolumeLoopId);
    // Stop audio capture
    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.captureContext) {
      this.captureContext.close().catch(() => {});
      this.captureContext = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }

    // Stop playback
    this.flushPlayback();
    if (this.playbackContext) {
      this.playbackContext.close().catch(() => {});
      this.playbackContext = null;
    }

    // Close WebSocket
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  getState(): LiveSessionState {
    return this.state;
  }

  // ═══════════════════════════════════════════════════════════════
  // SILENCE DETECTION — Auto-end after prolonged silence
  // ═══════════════════════════════════════════════════════════════

  private resetSilenceTimer(): void {
    this.clearSilenceTimer();
    this.lastActivityTimestamp = Date.now();

    this.silenceTimer = setTimeout(() => {
      if (this.state === 'listening' || this.state === 'connected') {
        console.log('[GeminiLive] Silence timeout reached — sending farewell via text');
        // Send a text nudge so the model says goodbye naturally
        this.sendText('There has been silence for a while. If the user has no more questions, say a brief, friendly goodbye and then call the end_call tool with reason "silence_timeout".');
      }
    }, this.SILENCE_TIMEOUT_MS);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // VOICE-TRIGGERED CALL END
  // ═══════════════════════════════════════════════════════════════

  private checkVoiceEndRequest(userText: string): void {
    const lower = userText.toLowerCase().trim();
    const endPhrases = [
      'end the call', 'end call', 'hang up', 'disconnect',
      'goodbye', 'good bye', 'bye bye', 'bye for now',
      'stop the call', 'close the call', 'that\'s all',
      'i\'m done', 'im done', 'nothing else', 'no more questions'
    ];

    if (endPhrases.some(phrase => lower.includes(phrase))) {
      console.log('[GeminiLive] User requested call end via voice:', lower);
      // Let the model respond naturally first, then end
      this.sendText('The user wants to end the call. Say a brief, friendly goodbye and then call the end_call tool with reason "user_requested".');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PROFESSIONAL SOUND EFFECTS — WebAudio Synthesis
  // ═══════════════════════════════════════════════════════════════

  private playConnectionSound(): void {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const t = ctx.currentTime;
      
      // Layered rising chord: C5 + E5 + G5 with shimmer
      const notes = [523, 659, 784]; // C5, E5, G5 — major chord
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.type = i === 2 ? 'triangle' : 'sine'; // top note is softer triangle
        osc.frequency.setValueAtTime(freq * 0.97, t + i * 0.06);
        osc.frequency.exponentialRampToValueAtTime(freq, t + i * 0.06 + 0.08);
        gain.gain.setValueAtTime(0, t + i * 0.06);
        gain.gain.linearRampToValueAtTime(0.1 - i * 0.02, t + i * 0.06 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
        
        osc.start(t + i * 0.06);
        osc.stop(t + 0.55);
        if (i === notes.length - 1) osc.onended = () => ctx.close();
      });
    } catch { /* audio not available */ }
  }

  private disconnectSoundPlayed = false;
  private playDisconnectionSound(): void {
    if (this.disconnectSoundPlayed) return;
    this.disconnectSoundPlayed = true;
    // Reset flag after a short delay
    setTimeout(() => { this.disconnectSoundPlayed = false; }, 1000);
    
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const t = ctx.currentTime;
      
      // Descending 3-note arpeggio: G5 → E5 → C5 with gentle fade
      const notes = [784, 659, 523]; // G5, E5, C5
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t + i * 0.1);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.98, t + i * 0.1 + 0.15);
        gain.gain.setValueAtTime(0.08 - i * 0.015, t + i * 0.1);
        gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.1 + 0.2);
        
        osc.start(t + i * 0.1);
        osc.stop(t + i * 0.1 + 0.2);
        if (i === notes.length - 1) osc.onended = () => ctx.close();
      });
    } catch { /* audio not available */ }
  }

  private playToolCallSound(): void {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const t = ctx.currentTime;
      
      // Futuristic data-pulse: quick ascending harmonics with digital shimmer
      const freqs = [440, 660, 880, 1320]; // A4 + harmonics
      freqs.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.type = i < 2 ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(freq, t + i * 0.035);
        gain.gain.setValueAtTime(0.06 / (i + 1), t + i * 0.035);
        gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.035 + 0.09);
        
        osc.start(t + i * 0.035);
        osc.stop(t + i * 0.035 + 0.09);
        if (i === freqs.length - 1) osc.onended = () => ctx.close();
      });
    } catch { /* audio not available */ }
  }
}
