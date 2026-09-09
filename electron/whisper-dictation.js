'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');

const SAMPLE_RATE = 16000;
const INFERENCE_INTERVAL_SAMPLES = Math.round(SAMPLE_RATE * 2.4);
const MAX_WINDOW_SAMPLES = SAMPLE_RATE * 14;
const MIN_RMS = 0.006;
const MODEL_NAME = 'ggml-base.bin';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const MODEL_BYTES = 147951465;
const MODEL_SHA256 = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe';

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function normalizeLanguage(value) {
  const language = String(value || '').trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(language) ? language : 'auto';
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

function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    const failed = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once('timeout', failed);
    socket.once('error', failed);
  });
}

function samplesHaveSpeech(samples) {
  if (!samples.length) return false;
  const stride = Math.max(1, Math.floor(samples.length / 12000));
  let energy = 0;
  let count = 0;
  for (let index = 0; index < samples.length; index += stride) {
    const value = samples[index] / 32768;
    energy += value * value;
    count += 1;
  }
  return Math.sqrt(energy / Math.max(1, count)) >= MIN_RMS;
}

class WhisperDictation {
  constructor({ app, spawn, log, send }) {
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
    this.modelDownload = null;
  }

  runtimeDirectory() {
    const relative = path.join('runtime', 'assets', 'native', 'whisper', `${process.platform}-${process.arch}`);
    const candidates = this.app.isPackaged
      ? [
          path.join(process.resourcesPath, 'app.asar.unpacked', relative),
          path.join(this.app.getAppPath(), relative),
        ]
      : [path.join(this.app.getAppPath(), 'desktop-runtime', 'assets', 'native', 'whisper', `${process.platform}-${process.arch}`)];
    return candidates.find(candidate => fs.existsSync(path.join(candidate, process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'))) || null;
  }

  modelPath() {
    return path.join(this.app.getPath('userData'), 'models', 'whisper.cpp', MODEL_NAME);
  }

  bundledModelPath() {
    const relative = path.join('runtime', 'assets', 'native', 'whisper', 'models', MODEL_NAME);
    const candidates = this.app.isPackaged
      ? [
          path.join(process.resourcesPath, 'app.asar.unpacked', relative),
          path.join(this.app.getAppPath(), relative),
        ]
      : [path.join(this.app.getAppPath(), 'desktop-runtime', 'assets', 'native', 'whisper', 'models', MODEL_NAME)];
    return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).size === MODEL_BYTES) || null;
  }

  async verifyFile(filePath, expectedBytes, expectedHash) {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size !== expectedBytes) return false;
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest('hex') === expectedHash;
  }

  async ensureModel(owner) {
    const bundled = this.bundledModelPath();
    if (bundled) return bundled;
    const destination = this.modelPath();
    if (await this.verifyFile(destination, MODEL_BYTES, MODEL_SHA256)) return destination;
    if (this.modelDownload) return this.modelDownload;

    this.modelDownload = (async () => {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.download`;
      fs.rmSync(temporary, { force: true });
      this.send(owner, { type: 'loading', text: 'Preparing local speech model…', progress: 0 });
      const response = await fetch(MODEL_URL, { redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`Speech model download failed (${response.status}).`);
      let received = 0;
      let lastProgress = -1;
      const progressStream = new TransformStream({
        transform: (chunk, controller) => {
          received += chunk.byteLength;
          const progress = Math.min(99, Math.floor((received / MODEL_BYTES) * 100));
          if (progress >= lastProgress + 2) {
            lastProgress = progress;
            this.send(owner, { type: 'loading', text: `Preparing local speech model… ${progress}%`, progress });
          }
          controller.enqueue(chunk);
        },
      });
      await pipeline(response.body.pipeThrough(progressStream), fs.createWriteStream(temporary));
      if (!(await this.verifyFile(temporary, MODEL_BYTES, MODEL_SHA256))) {
        fs.rmSync(temporary, { force: true });
        throw new Error('The downloaded speech model did not pass verification.');
      }
      fs.rmSync(destination, { force: true });
      fs.renameSync(temporary, destination);
      return destination;
    })().finally(() => {
      this.modelDownload = null;
    });
    return this.modelDownload;
  }

  async ensureServer(owner) {
    if (this.server && this.server.exitCode === null && this.serverPort) return;
    if (this.serverStarting) return this.serverStarting;
    this.serverStarting = (async () => {
      const runtime = this.runtimeDirectory();
      if (!runtime) throw new Error('The local whisper.cpp runtime is missing from this EterX build.');
      const model = await this.ensureModel(owner);
      const executable = path.join(runtime, process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server');
      const port = await findAvailablePort();
      const requestPath = `/eterx-${crypto.randomBytes(18).toString('hex')}`;
      const threadCount = Math.max(2, Math.min(8, Math.floor(os.cpus().length * 0.65)));
      const environment = { ...process.env };
      if (process.platform === 'linux') environment.LD_LIBRARY_PATH = [runtime, environment.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
      if (process.platform === 'darwin') environment.DYLD_LIBRARY_PATH = [runtime, environment.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
      const child = this.spawn(executable, [
        '--model', model,
        '--host', '127.0.0.1',
        '--port', String(port),
        '--request-path', requestPath,
        '--threads', String(threadCount),
        '--no-timestamps',
        '--suppress-nst',
      ], { cwd: runtime, env: environment, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      this.server = child;
      this.serverPort = port;
      this.serverRequestPath = requestPath;
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        const message = String(chunk || '').trim();
        if (message) this.log(`[whisper.cpp] ${message.slice(0, 800)}`);
      });
      child.once('exit', code => {
        if (this.server !== child) return;
        this.server = null;
        this.serverPort = 0;
        this.serverRequestPath = '';
        const active = this.session;
        if (active) {
          this.session = null;
          this.send(active.owner, { type: 'error', code: 'whisper-exit', text: `Local speech recognition stopped unexpectedly${code == null ? '.' : ` (${code}).`}` });
        }
      });
      child.once('error', error => this.log(`[whisper.cpp] ${String(error?.message || error)}`));
      const startedAt = Date.now();
      while (!(await canConnect(port))) {
        if (child.exitCode !== null) throw new Error('The local speech engine could not load.');
        if (Date.now() - startedAt > 90000) throw new Error('The local speech engine took too long to load.');
        await delay(250);
      }
    })().finally(() => {
      this.serverStarting = null;
    });
    return this.serverStarting;
  }

  async start(owner, language, sessionId = crypto.randomUUID()) {
    const previousStop = this.stop(null, false, null, true);
    const request = { ownerId: owner.id, sessionId, revision: 0 };
    this.pendingStart = request;
    await previousStop;
    await this.ensureServer(owner);
    if (this.pendingStart !== request || owner.isDestroyed()) return { started: false, cancelled: true };
    this.pendingStart = null;
    this.session = {
      owner, ownerId: owner.id, sessionId, revision: request.revision,
      language: normalizeLanguage(language), chunks: [], sampleCount: 0,
      samplesSinceInference: 0, inferenceRunning: false, inferencePending: false,
      committedText: '', transcript: '', stopping: false, cancelled: false,
    };
    this.emit(this.session, { type: 'ready' });
    return { started: true, sessionId, supported: true, engine: 'whisper.cpp', local: true };
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
  }

  push(owner, payload, sessionId, revision) {
    const active = this.session;
    if (!active || active.ownerId !== owner.id || active.stopping || active.sessionId !== sessionId || active.revision !== revision) return;
    const bytes = Buffer.from(payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload || []);
    if (bytes.length < 2) return;
    const copy = new Int16Array(Math.floor(bytes.length / 2));
    for (let index = 0; index < copy.length; index++) copy[index] = bytes.readInt16LE(index * 2);
    active.chunks.push(copy);
    active.sampleCount += copy.length;
    active.samplesSinceInference += copy.length;
    // Keep unprocessed audio instead of silently dropping the oldest words.
    if (active.sampleCount > SAMPLE_RATE * 60) {
      this.emit(active, { type: 'error', text: 'Dictation could not keep up. Please restart recording.' });
      void this.stop(owner, true, sessionId, true);
      return;
    }
    if (active.samplesSinceInference >= INFERENCE_INTERVAL_SAMPLES) {
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
    const commitWindow = final || samples.length >= MAX_WINDOW_SAMPLES;
    if (samples.length < SAMPLE_RATE / 2 || !samplesHaveSpeech(samples)) {
      if (commitWindow) this.consumeSamples(active, samples.length);
      return;
    }
    active.inferenceRunning = true;
    const controller = new AbortController();
    active.inferenceController = controller;
    const timeout = setTimeout(() => controller.abort(), 120000);
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
        this.emit(active, { type: 'error', code: 'whisper-inference', text: String(error?.message || error) });
        active.cancelled = true;
      }
    } finally {
      clearTimeout(timeout);
      active.inferenceController = null;
      active.inferenceRunning = false;
      if (active.inferencePending && !active.stopping && !active.cancelled) {
        active.inferencePending = false;
        void this.infer(active, false);
      }
    }
  }

  async stop(owner = null, emitStopped = true, sessionId = null, discard = false) {
    const pending = this.pendingStart;
    if (pending && (!owner || pending.ownerId === owner.id) && (!sessionId || pending.sessionId === sessionId)) this.pendingStart = null;
    if (!owner && discard) {
      for (const draining of this.drainingSessions.values()) {
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
