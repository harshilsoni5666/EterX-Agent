export function microphoneConstraints(deviceId?: string, extra: MediaTrackConstraints = {}): MediaTrackConstraints {
  return {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...extra,
    ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
  };
}

export async function captureMicrophone(deviceId?: string, extra: MediaTrackConstraints = {}): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable in this app session.');
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(deviceId, extra) });
  } catch (error) {
    if (deviceId && deviceId !== 'default' && error instanceof DOMException && ['NotFoundError', 'OverconstrainedError'].includes(error.name)) {
      throw new Error('The selected microphone is unavailable. Reconnect it or choose another microphone in Settings → General.');
    }
    throw error;
  }
}

// Construct during the user's click so resuming audio is permitted, even if
// preparing the selected local model takes time before capture begins.
export function createDictationCapture(onAudio: (pcm: ArrayBuffer) => void, onEnded: () => void) {
  let context: AudioContext;
  try { context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' }); }
  catch { context = new AudioContext({ latencyHint: 'interactive' }); }
  let stopped = false;
  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let gain: GainNode | null = null;
  const ready = context.resume();
  const stop = () => {
    stopped = true;
    if (processor) processor.onaudioprocess = null;
    try { processor?.disconnect(); } catch {}
    try { source?.disconnect(); } catch {}
    try { gain?.disconnect(); } catch {}
    stream?.getTracks().forEach(track => track.stop());
    if (context.state !== 'closed') void context.close().catch(() => {});
  };
  return {
    ready,
    stop,
    async start(deviceId?: string) {
      if (stopped) return false;
      stream = await captureMicrophone(deviceId);
      if (stopped) { stream.getTracks().forEach(track => track.stop()); return false; }
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      gain = context.createGain();
      gain.gain.value = 0;
      let sum = 0;
      let weight = 0;
      const ratio = context.sampleRate / 16000;
      processor.onaudioprocess = event => {
        if (stopped) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(Math.ceil(input.length / ratio) + 1);
        let length = 0;
        for (let index = 0; index < input.length; index++) {
          const value = input[index];
          let remaining = 1;
          while (remaining > 1e-8) {
            const portion = Math.min(remaining, ratio - weight);
            sum += value * portion;
            weight += portion;
            remaining -= portion;
            if (weight >= ratio - 1e-8) {
              const sample = Math.max(-1, Math.min(1, sum / weight));
              pcm[length++] = sample < 0 ? sample * 32768 : sample * 32767;
              sum = 0;
              weight = 0;
            }
          }
        }
        if (length) onAudio(pcm.slice(0, length).buffer as ArrayBuffer);
      };
      source.connect(processor);
      processor.connect(gain);
      gain.connect(context.destination);
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (!stopped) onEnded(); }, { once: true }));
      await context.resume();
      return !stopped;
    },
  };
}
