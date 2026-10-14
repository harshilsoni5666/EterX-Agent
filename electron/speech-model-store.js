'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { MODELS, LANGUAGES, DEFAULT_MODEL, getModel } = require('./whisper-config');

class SpeechModelStore {
  constructor({ app, onState }) {
    this.app = app;
    this.onState = onState;
    this.tasks = new Map();
    this.states = new Map();
    this.verified = new Map();
    this.closed = false;
  }

  model(id) {
    if (typeof id !== 'string' || !Object.hasOwn(MODELS, id)) throw new Error('Unknown speech model. Refresh the model list and try again.');
    return getModel(id);
  }

  destination(model) {
    return path.join(this.app.getPath('userData'), 'models', 'whisper.cpp', model.file);
  }

  bundledPaths(model) {
    const relative = path.join('runtime', 'assets', 'native', 'whisper', 'models', model.file);
    return this.app.isPackaged ? [
      path.join(process.resourcesPath, relative),
      path.join(process.resourcesPath, 'app.asar.unpacked', relative),
      path.join(this.app.getAppPath(), relative),
    ] : [path.join(this.app.getAppPath(), 'desktop-runtime', 'assets', 'native', 'whisper', 'models', model.file)];
  }

  present(file, model) {
    try { return fs.statSync(file).size === model.bytes; } catch { return false; }
  }

  state(model) {
    const known = this.states.get(model.id);
    if (this.tasks.has(model.id) || known?.status === 'error' || known?.status === 'cancelled') return known || { status: 'preparing', progress: 0 };
    const bundled = this.bundledPaths(model).some(file => this.present(file, model));
    const installed = bundled || this.present(this.destination(model), model);
    return { status: installed ? 'installed' : 'available', progress: installed ? 100 : 0, bundled };
  }

  catalog() {
    return {
      defaultModel: DEFAULT_MODEL,
      languages: Object.entries(LANGUAGES).map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
      models: Object.keys(MODELS).map(id => {
        const { name, family, bytes, englishOnly, precision } = getModel(id);
        return { id, name, family, bytes, englishOnly, precision, ...this.state(getModel(id)) };
      }).sort((a, b) => Number(b.id === DEFAULT_MODEL) - Number(a.id === DEFAULT_MODEL) || a.bytes - b.bytes),
    };
  }

  publish(id, state) {
    const next = { ...state, id };
    this.states.set(id, next);
    this.onState?.(next);
  }

  async verify(file, model, signal) {
    if (!this.present(file, model)) return false;
    const stat = fs.statSync(file);
    const fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${model.sha256}`;
    if (this.verified.get(file) === fingerprint) return true;
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(file), hash, { signal });
    const valid = hash.digest('hex') === model.sha256;
    if (valid) this.verified.set(file, fingerprint);
    return valid;
  }

  ensure(id, { background = false } = {}) {
    if (this.closed) return Promise.reject(new Error('Local speech recognition is shutting down.'));
    const model = this.model(id);
    const existing = this.tasks.get(id);
    if (existing) {
      if (background) existing.background = true;
      // A cancelled task must finish deleting its temporary file before a
      // rapid Retry can open a new file with the same name.
      if (existing.controller.signal.aborted) return existing.promise.catch(() => {}).then(() => this.ensure(id, { background }));
      return existing.promise;
    }
    const task = { controller: new AbortController(), background, promise: null, reason: '' };
    this.tasks.set(id, task);
    this.publish(id, { status: 'preparing', progress: 0 });
    task.promise = this.prepare(model, task).then(file => {
      this.publish(id, { status: 'installed', progress: 100, bundled: this.bundledPaths(model).includes(file) });
      return file;
    }).catch(error => {
      const cancelled = task.reason === 'cancelled' || this.closed;
      const message = cancelled ? 'Download cancelled.'
        : error?.code === 'ENOSPC' ? 'Not enough free disk space. Free some space and retry.'
        : error?.code === 'EACCES' || error?.code === 'EPERM' ? 'EterX cannot write to its model folder. Allow access and retry.'
        : task.reason === 'stalled' ? 'Download stalled. Check your connection and retry.'
        : /fetch failed|network|ENOTFOUND|ECONNRESET/i.test(String(error?.message || error)) ? 'Download failed. Check your connection and retry.'
        : String(error?.message || 'Could not prepare this speech model.');
      this.publish(id, { status: cancelled ? 'cancelled' : 'error', progress: 0, error: message });
      throw new Error(message);
    }).finally(() => { if (this.tasks.get(id) === task) this.tasks.delete(id); });
    return task.promise;
  }

  async prepare(model, task) {
    const signal = task.controller.signal;
    const destination = this.destination(model);
    for (const file of [destination, ...this.bundledPaths(model)]) {
      if (!(await this.verify(file, model, signal))) continue;
      signal.throwIfAborted();
      if (!/\.asar[\\/]/i.test(file)) return file;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.copy`;
      try {
        await pipeline(fs.createReadStream(file), fs.createWriteStream(temporary), { signal });
        signal.throwIfAborted();
        fs.rmSync(destination, { force: true });
        fs.renameSync(temporary, destination);
        return destination;
      } finally { fs.rmSync(temporary, { force: true }); }
    }

    signal.throwIfAborted();
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.download`;
    let idleTimer;
    const heartbeat = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        task.reason = 'stalled';
        task.controller.abort();
      }, 90000);
      idleTimer.unref?.();
    };
    try {
      heartbeat();
      this.publish(model.id, { status: 'downloading', progress: 0, received: 0 });
      const response = await fetch(model.url, { redirect: 'follow', signal });
      if (!response.ok || !response.body) throw new Error(`Speech model download failed (${response.status}). Retry when the connection is available.`);
      const hash = crypto.createHash('sha256');
      let received = 0;
      let lastPercent = -1;
      const meter = new Transform({ transform: (chunk, _encoding, callback) => {
        heartbeat();
        received += chunk.length;
        if (received > model.bytes) return callback(new Error('The model download has an unexpected size. Please retry.'));
        hash.update(chunk);
        const progress = Math.min(99, Math.floor(received / model.bytes * 100));
        if (progress !== lastPercent) {
          lastPercent = progress;
          this.publish(model.id, { status: 'downloading', progress, received });
        }
        callback(null, chunk);
      } });
      await pipeline(response.body, meter, fs.createWriteStream(temporary), { signal });
      clearTimeout(idleTimer);
      this.publish(model.id, { status: 'verifying', progress: 99, received });
      if (received !== model.bytes || hash.digest('hex') !== model.sha256) throw new Error('The downloaded model is incomplete or damaged. Please retry.');
      signal.throwIfAborted();
      fs.rmSync(destination, { force: true });
      fs.renameSync(temporary, destination);
      const stat = fs.statSync(destination);
      this.verified.set(destination, `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${model.sha256}`);
      return destination;
    } finally {
      clearTimeout(idleTimer);
      fs.rmSync(temporary, { force: true });
    }
  }

  cancel(id, { preserveBackground = false } = {}) {
    this.model(id);
    const task = this.tasks.get(id);
    if (!task || (preserveBackground && task.background)) return false;
    task.reason = 'cancelled';
    task.controller.abort();
    return true;
  }

  shutdown() {
    this.closed = true;
    for (const task of this.tasks.values()) task.controller.abort();
  }
}

module.exports = { SpeechModelStore };
