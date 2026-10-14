'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { getModel, LANGUAGES, RUNTIME_REVISION } = require('./whisper-config');
const { SpeechModelStore } = require('./speech-model-store');

const SAMPLE_RATE = 16000;
const INFERENCE_INTERVAL_SAMPLES = Math.round(SAMPLE_RATE * 2.4);
const MAX_WINDOW_SAMPLES = SAMPLE_RATE * 14;
const MIN_RMS = 0.006;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function normalizeLanguage(value) {
  const language = String(value || '').trim().toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(LANGUAGES, language) ? language : 'auto';
}

function wavFromPcm16(samples) {
  const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const wav = Buffer.allocUnsafe(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

function multipartInferenceBody(wav, language, prompt) {
  const boundary = `----eterx-whisper-${crypto.randomBytes(12).toString('hex')}`;
  const fields = [
    ['response_format', 'json'],
    ['temperature', '0.0'],
    ['temperature_inc', '0.2'],
    ['language', language],
    ['prompt', String(prompt || '').slice(-1200)],
    ['carry_initial_prompt', 'true'],
  ];
  const chunks = [];
  for (const [name, value] of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dictation.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
  chunks.push(wav);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(chunks) };
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function serverReady(port, requestPath) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${requestPath}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok && (await response.json()).status === 'ok';
  } catch {
    return false;
  }
}

function samplesHaveSpeech(samples) {
  if (!samples.length) return false;
  // Measure short frames so a brief word is not diluted by a long pause.
  const frameSize = Math.round(SAMPLE_RATE * 0.03);
  let speechFrames = 0;
  for (let start = 0; start < samples.length; start += frameSize) {
    const end = Math.min(samples.length, start + frameSize);
    let energy = 0;
    for (let index = start; index < end; index++) {
      const value = samples[index] / 32768;
      energy += value * value;
    }
    if (Math.sqrt(energy / (end - start)) >= MIN_RMS) {
      if (++speechFrames >= 2) return true;
    } else speechFrames = 0;
  }
  return false;
}

class WhisperDictation {
  constructor({ app, spawn, log, send, onModelState }) {
    this.app = app;
    this.spawn = spawn;
    this.log = log;
    this.send = send;
    this.server = null;
    this.serverPort = 0;
    this.serverRequestPath = '';
    this.serverStarting = null;
    this.session = null;
    this.drainingSessions = new Map();
    this.models = new SpeechModelStore({ app, onState: state => {
      onModelState?.(state);
      if (this.pendingStart?.modelId !== state.id) return;
      if (state.status === 'downloading') this.loading(`Downloading ${getModel(state.id).name}… ${state.progress}%`, state.progress);
      else if (state.status === 'preparing' || state.status === 'verifying') this.loading(`Preparing ${getModel(state.id).name}…`, state.progress);
    } });
    this.serverModel = null;
    this.pendingStart = null;
    this.closed = false;
  }

  runtimeDirectory() {
    const relative = path.join('runtime', 'assets', 'native', 'whisper', `${process.platform}-${process.arch}`);
    const candidates = this.app.isPackaged
      ? [
          path.join(process.resourcesPath, relative),
          path.join(process.resourcesPath, 'app.asar.unpacked', relative),
        ]
      : [path.join(this.app.getAppPath(), 'desktop-runtime', 'assets', 'native', 'whisper', `${process.platform}-${process.arch}`)];
    const executable = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
    const available = candidates.find(candidate => fs.existsSync(path.join(candidate, executable)));
    if (available) return available;
    if (!this.app.isPackaged) return null;

    // Older installers stored the executable and its DLLs inside app.asar.
    // Electron's fs can read those files, but the OS cannot spawn them there
    // (nor use an archive directory as cwd). Materialize the entire runtime.
    const archived = path.join(this.app.getAppPath(), relative);
    if (!fs.existsSync(path.join(archived, executable))) return null;
    const destination = path.join(this.app.getPath('userData'), 'speech-runtime', `${this.app.getVersion()}-${RUNTIME_REVISION}`, `${process.platform}-${process.arch}`);
    const marker = path.join(destination, '.complete');
    if (!fs.existsSync(marker) || !fs.existsSync(path.join(destination, executable))) {
      const copyDirectory = (source, target) => {
        fs.mkdirSync(target, { recursive: true });
        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
          const output = path.join(target, entry.name);
          if (entry.isDirectory()) copyDirectory(path.join(source, entry.name), output);
          else fs.copyFileSync(path.join(source, entry.name), output);
        }
      };
      copyDirectory(archived, destination);
      if (process.platform !== 'win32') fs.chmodSync(path.join(destination, executable), 0o755);
      fs.writeFileSync(marker, RUNTIME_REVISION);
    }
    return destination;
  }

  loading(text, progress) {
    const pending = this.pendingStart;
    if (pending) this.send(pending.owner, { type: 'loading', text, progress, sessionId: pending.sessionId });
  }

  ensureModel(model) {
    return this.models.ensure(model.id);
  }

  async terminateServer() {
    const child = this.server;
    this.server = null;
    this.serverPort = 0;
    this.serverRequestPath = '';
    this.serverModel = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); child.removeListener('exit', finish); resolve(); };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish();
      }, 2000);
      child.once('exit', finish);
      try { child.kill(); } catch { finish(); }
    });
  }

  async launchServer(runtime, modelPath, model, cpuOnly) {
    const executable = path.join(runtime, process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server');
    if (/\.asar[\\/]/i.test(executable)) throw new Error('The speech engine must be installed outside the application archive. Reinstall EterX.');
    if (process.platform !== 'win32') fs.accessSync(executable, fs.constants.X_OK);
    const port = await findAvailablePort();
    if (this.closed) throw new Error('Local speech recognition is shutting down.');
    const requestPath = `/eterx-${crypto.randomBytes(18).toString('hex')}`;
    const cores = os.availableParallelism?.() || os.cpus().length || 1;
    const threadCount = Math.max(1, Math.min(8, Math.floor(cores * 0.75)));
    const environment = { ...process.env };
    if (process.platform === 'linux') environment.LD_LIBRARY_PATH = [runtime, environment.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
    if (process.platform === 'darwin') environment.DYLD_LIBRARY_PATH = [runtime, environment.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
    // DLLs and dynamically selected CPU backends live beside the executable.
    const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') || 'PATH';
    environment[pathKey] = [runtime, environment[pathKey]].filter(Boolean).join(path.delimiter);
    const child = this.spawn(executable, [
      '--model', modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--request-path', requestPath,
      '--threads', String(threadCount),
      '--language', 'auto',
      '--no-timestamps',
      '--suppress-nst',
      ...(cpuOnly ? ['--no-gpu'] : []),
    ], { cwd: runtime, env: environment, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.server = child;
    let startupError;
    let diagnostics = '';
    child.once('error', error => { startupError = error; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      diagnostics = (diagnostics + String(chunk || '')).slice(-4000);
      const message = String(chunk || '').trim();
      if (message) this.log(`[whisper.cpp] ${message.slice(0, 800)}`);
    });
    child.once('exit', (code, signal) => {
      if (this.server !== child) return;
      this.server = null;
      this.serverPort = 0;
      this.serverRequestPath = '';
      this.serverModel = null;
      this.log(`[whisper.cpp] Server exited: ${code ?? signal ?? 'unknown'}`);
      for (const active of [this.session, ...this.drainingSessions.values()]) {
        if (!active) continue;
        this.emit(active, { type: 'error', code: 'whisper-exit', text: 'Local speech recognition stopped. Your existing text is kept. Try the microphone again, or choose the lightweight speech model in Settings → General.' });
        active.cancelled = true;
        active.inferenceController?.abort();
      }
      this.session = null;
    });
    const startedAt = Date.now();
    try {
      while (true) {
        if (startupError) throw startupError;
        if (this.closed || child.exitCode !== null || child.signalCode !== null) throw new Error('The local speech engine could not load.');
        if (Date.now() - startedAt > 180000) throw new Error('The local speech engine took too long to load.');
        if (await serverReady(port, requestPath)) {
          if (this.closed || this.server !== child || child.exitCode !== null || child.signalCode !== null) throw new Error('The local speech engine stopped while loading.');
          this.serverPort = port;
          this.serverRequestPath = requestPath;
          this.serverModel = model.id;
          return;
        }
        await delay(250);
      }
    } catch (error) {
      if (this.server === child) await this.terminateServer();
      this.log(`[whisper.cpp] Startup failed: ${error?.message || error}\n${diagnostics}`);
      if (error?.code === 'ENOENT') throw new Error('The speech executable or a required library is missing. Reinstall EterX to restore its local speech runtime.');
      if (error?.code === 'EACCES' || error?.code === 'EPERM') throw new Error('The operating system blocked the speech engine. Allow EterX to run and try again.');
      if (/out of memory|alloc.*fail|bad_alloc/i.test(diagnostics)) throw new Error('There is not enough memory for this speech model. Choose Whisper Small in Settings → General.');
      throw error;
    }
  }

  async ensureServer(model) {
    if (this.closed) throw new Error('Local speech recognition is shutting down.');
    if (this.serverStarting) {
      await this.serverStarting.catch(() => {});
      return this.ensureServer(model);
    }
    if (this.server && this.server.exitCode === null && this.server.signalCode === null && this.serverPort && this.serverModel === model.id) return;
    this.serverStarting = (async () => {
      await this.terminateServer();
      if (this.closed) throw new Error('Local speech recognition is shutting down.');
      const runtime = this.runtimeDirectory();
      if (!runtime) throw new Error(`The local speech runtime for ${process.platform}/${process.arch} is missing. Reinstall EterX to restore it.`);
      this.loading(`Preparing ${model.name}…`);
      const modelPath = await this.ensureModel(model);
      if (this.closed) throw new Error('Local speech recognition is shutting down.');
      if (!this.pendingStart) return;
      this.loading(`Loading ${model.name}…`);
      try {
        await this.launchServer(runtime, modelPath, model, process.platform !== 'darwin');
      } catch (error) {
        if (process.platform !== 'darwin' || this.closed || !this.pendingStart) throw error;
        this.loading('Retrying local speech recognition on the CPU…');
        await this.launchServer(runtime, modelPath, model, true);
      }
    })().finally(() => {
      this.serverStarting = null;
    });
    return this.serverStarting;
  }

  async start(owner, language, sessionId = crypto.randomUUID(), modelId) {
    const model = getModel(modelId);
    const selectedLanguage = normalizeLanguage(language);
    if (model.englishOnly && selectedLanguage !== 'auto' && selectedLanguage !== 'en') {
      throw new Error('This speech model supports English only. Select a multilingual model or change the dictation language in Settings → General.');
    }
    if (this.session) this.emit(this.session, { type: 'stopped' });
    const previousStop = this.stop(null, false, null, true);
    const request = { owner, ownerId: owner.id, sessionId, modelId: model.id, revision: 0 };
    this.pendingStart = request;
    await previousStop;
    if (this.pendingStart !== request || owner.isDestroyed()) return { started: false, cancelled: true };
    try {
      await this.ensureServer(model);
    } catch (error) {
      if (this.pendingStart !== request || owner.isDestroyed()) return { started: false, cancelled: true };
      this.pendingStart = null;
      throw error;
    }
    if (this.pendingStart !== request || owner.isDestroyed()) return { started: false, cancelled: true };
    this.pendingStart = null;
    this.session = {
      owner, ownerId: owner.id, sessionId, revision: request.revision,
      modelId: model.id,
      language: model.englishOnly ? 'en' : selectedLanguage, chunks: [], sampleCount: 0,
      samplesSinceInference: 0, inferenceRunning: false, inferencePending: false,
      inferenceInterval: INFERENCE_INTERVAL_SAMPLES,
      committedText: '', transcript: '', stopping: false, cancelled: false,
    };
    this.emit(this.session, { type: 'ready' });
    return { started: true, sessionId, supported: true, engine: 'whisper.cpp', model: model.id, local: true };
  }

  emit(active, payload) {
    if (!active.cancelled) this.send(active.owner, {
      ...payload, sessionId: active.sessionId, revision: active.revision, engine: 'whisper.cpp',
    });
  }

  reset(owner, sessionId, revision) {
    if (!Number.isSafeInteger(revision) || revision < 0) return;
    const pending = this.pendingStart;
    if (pending?.ownerId === owner.id && pending.sessionId === sessionId) {
      pending.revision = Math.max(pending.revision, revision);
    }
    const active = this.session;
    if (!active || active.ownerId !== owner.id || active.sessionId !== sessionId || revision <= active.revision) return;
    active.revision = revision;
    active.chunks = [];
    active.sampleCount = 0;
    active.samplesSinceInference = 0;
    active.committedText = '';
    active.transcript = '';
    active.inferencePending = false;
    active.inferenceController?.abort();
  }

  push(owner, payload, sessionId, revision) {
    const active = this.session;
    if (!active || active.cancelled || active.ownerId !== owner.id || active.stopping || active.sessionId !== sessionId || active.revision !== revision) return;
    if (!(payload instanceof ArrayBuffer) && !ArrayBuffer.isView(payload)) return;
    if (payload.byteLength > SAMPLE_RATE * 2 * 5) return;
    const bytes = Buffer.from(payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload || []);
    if (bytes.length < 2) return;
    const copy = new Int16Array(Math.floor(bytes.length / 2));
    for (let index = 0; index < copy.length; index++) copy[index] = bytes.readInt16LE(index * 2);
    active.chunks.push(copy);
    active.sampleCount += copy.length;
    active.samplesSinceInference += copy.length;
    // Keep unprocessed audio instead of silently dropping the oldest words.
    if (active.sampleCount > SAMPLE_RATE * 120) {
      // Stop capture and drain the queue on slower hardware instead of
      // discarding spoken words when a large model falls behind real time.
      active.stopping = true;
      this.emit(active, { type: 'capture-limit', text: 'Finishing buffered dictation…' });
      return;
    }
    if (active.samplesSinceInference >= active.inferenceInterval) {
      active.samplesSinceInference = 0;
      void this.infer(active, false);
    }
  }

  flattenedSamples(active) {
    const output = new Int16Array(Math.min(active.sampleCount, MAX_WINDOW_SAMPLES));
    let offset = 0;
    for (const chunk of active.chunks) {
      const count = Math.min(chunk.length, output.length - offset);
      output.set(chunk.subarray(0, count), offset);
      offset += count;
      if (offset === output.length) break;
    }
    return output;
  }

  consumeSamples(active, count) {
    active.sampleCount -= count;
    while (count > 0 && active.chunks.length) {
      const chunk = active.chunks[0];
      if (chunk.length <= count) {
        count -= chunk.length;
        active.chunks.shift();
      } else {
        active.chunks[0] = chunk.slice(count);
        count = 0;
      }
    }
  }

  async infer(active, final) {
    if (active.cancelled) return;
    if (active.inferenceRunning) {
      active.inferencePending = true;
      return;
    }
    const revision = active.revision;
    const samples = this.flattenedSamples(active);
    if (!samples.length) return;
    const endsWithPause = samples.length >= INFERENCE_INTERVAL_SAMPLES
      && !samplesHaveSpeech(samples.subarray(samples.length - Math.round(SAMPLE_RATE * 0.6)));
    const commitWindow = final || samples.length >= MAX_WINDOW_SAMPLES || endsWithPause;
    if (samples.length < SAMPLE_RATE * 0.16 || !samplesHaveSpeech(samples)) {
      if (commitWindow) this.consumeSamples(active, samples.length);
      return;
    }
    active.inferenceRunning = true;
    const inferenceStarted = Date.now();
    const controller = new AbortController();
    active.inferenceController = controller;
    const timeout = setTimeout(() => controller.abort(), /^(large|medium)/.test(active.modelId) ? 300000 : 120000);
    try {
      const wav = wavFromPcm16(samples);
      const multipart = multipartInferenceBody(wav, active.language, active.committedText);
      const response = await fetch(
        'http://127.0.0.1:' + this.serverPort + this.serverRequestPath + '/inference', {
          method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=' + multipart.boundary },
          body: multipart.body, signal: controller.signal,
        });
      if (!response.ok) throw new Error('whisper.cpp inference failed (' + response.status + ').');
      const result = await response.json();
      if (active.cancelled || revision !== active.revision) return;
      if (result?.error || typeof result?.text !== 'string') throw new Error('The local speech engine returned an invalid transcription. Try the microphone again.');
      const text = String(result?.text || '').replace(/\s+/g, ' ').trim();
      // Every event is a full snapshot. A revised partial replaces the current
      // window; only non-overlapping audio windows are committed permanently.
      active.transcript = [active.committedText, text].filter(Boolean).join(' ');
      if (commitWindow) {
        active.committedText = active.transcript;
        this.consumeSamples(active, samples.length);
      }
      this.emit(active, { type: final ? 'final' : 'partial', text: active.transcript });
    } catch (error) {
      if (!active.cancelled && revision === active.revision) {
        const message = controller.signal.aborted
          ? 'Transcription took too long. Your existing text is kept. Try Whisper Small in Settings → General for faster CPU dictation.'
          : 'Local transcription failed. Your existing text is kept. Try the microphone again.';
        this.log(`[whisper.cpp] Inference failed: ${error?.message || error}`);
        this.emit(active, { type: 'error', code: 'whisper-inference', text: message });
        active.cancelled = true;
      }
    } finally {
      clearTimeout(timeout);
      active.inferenceController = null;
      active.inferenceRunning = false;
      // Slow CPUs should spend their time on new audio, rather than repeatedly
      // transcribing the same growing partial window every 2.4 seconds.
      active.inferenceInterval = Math.max(INFERENCE_INTERVAL_SAMPLES, Math.min(MAX_WINDOW_SAMPLES, Math.ceil((Date.now() - inferenceStarted) / 1000 * SAMPLE_RATE)));
      if (active.inferencePending && !active.stopping && !active.cancelled) {
        active.inferencePending = false;
        void this.infer(active, false);
      }
    }
  }

  async stop(owner = null, emitStopped = true, sessionId = null, discard = false) {
    const pending = this.pendingStart;
    if (pending && (!owner || pending.ownerId === owner.id) && (!sessionId || pending.sessionId === sessionId)) {
      this.pendingStart = null;
      this.models.cancel(pending.modelId, { preserveBackground: true });
    }
    if (discard) {
      for (const draining of this.drainingSessions.values()) {
        if ((owner && draining.ownerId !== owner.id) || (sessionId && draining.sessionId !== sessionId)) continue;
        draining.cancelled = true;
        draining.inferenceController?.abort();
      }
    }
    const active = sessionId ? (this.session?.sessionId === sessionId ? this.session : this.drainingSessions.get(sessionId)) : this.session;
    if (!active || (owner && active.ownerId !== owner.id) || (sessionId && active.sessionId !== sessionId)) return false;
    if (this.session === active) this.session = null;
    active.stopping = true;
    if (discard) {
      active.cancelled = true;
      active.inferenceController?.abort();
      return true;
    }
    if (this.drainingSessions.has(active.sessionId)) return false;
    this.drainingSessions.set(active.sessionId, active);
    try {
      while (active.inferenceRunning) await delay(50);
      active.inferencePending = false;
      while (active.sampleCount > 0 && !active.cancelled) await this.infer(active, true);
      if (emitStopped) this.emit(active, { type: 'stopped' });
      return true;
    } finally {
      this.drainingSessions.delete(active.sessionId);
    }
  }

  shutdown() {
    this.closed = true;
    this.models.shutdown();
    this.pendingStart = null;
    for (const draining of this.drainingSessions.values()) {
      draining.cancelled = true;
      draining.inferenceController?.abort();
    }
    if (this.session) {
      this.session.cancelled = true;
      this.session.inferenceController?.abort();
    }
    this.session = null;
    const child = this.server;
    this.server = null;
    this.serverPort = 0;
    this.serverRequestPath = '';
    try { child?.kill(); } catch { }
  }
}

module.exports = { WhisperDictation };
