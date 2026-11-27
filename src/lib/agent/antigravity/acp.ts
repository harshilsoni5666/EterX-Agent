import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export class AntigravityRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

type Pending = { resolve: (result: any) => void; reject: (error: Error) => void };
type ClientOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  name?: string;
  initializeMeta?: Record<string, unknown>;
  cancelMeta?: Record<string, unknown>;
  onUpdate?: (update: any, meta?: any) => void;
  onPermission?: (params: any) => Promise<unknown>;
};

const CANCELLED = { outcome: { outcome: 'cancelled' } };

export class AntigravityAcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed: Error | null = null;
  sessionId = '';
  private get name() { return this.options.name || 'Antigravity'; }

  constructor(private readonly options: ClientOptions) {
    options.signal.throwIfAborted();
    this.child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, windowsHide: true });
    this.exited = new Promise(resolve => {
      this.child.once('exit', () => resolve());
      this.child.once('error', () => resolve());
    });
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', line => this.read(line));
    this.child.stdin.on('error', () => this.close(new Error(this.name + ' stopped accepting requests.')));
    this.child.on('error', () => this.close(new Error('Could not start ' + this.name + '.')));
    this.child.on('close', () => this.close(new Error(this.name + ' exited before responding.')));
    options.signal.addEventListener('abort', this.abort, { once: true });
  }

  private abort = () => {
    this.cancelPrompt();
    this.close(this.options.signal.reason instanceof Error ? this.options.signal.reason : new Error('CANCELLED_BY_USER'));
  };

  private cancelPrompt() {
    if (this.sessionId && !this.closed) this.write({ method: 'session/cancel',
      params: { sessionId: this.sessionId, _meta: this.options.cancelMeta } });
  }

  private write(message: Record<string, unknown>) {
    if (!this.closed && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  private read(line: string) {
    if (this.closed || !line.trimStart().startsWith('{')) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.jsonrpc !== '2.0') return;
    if (typeof message.method === 'string') {
      const params = message.params;
      const forSession = this.sessionId && params?.sessionId === this.sessionId;
      if (message.method === 'session/update') {
        if (forSession && params.update) this.options.onUpdate?.(params.update, params._meta);
      } else if (message.id != null) {
        const id = message.id;
        if (message.method === 'session/request_permission') {
          const handler = forSession ? this.options.onPermission : undefined;
          void Promise.resolve().then(() => handler?.(params) ?? CANCELLED).then(
            result => this.write({ id, result }),
            () => this.write({ id, result: CANCELLED }),
          );
        } else {
          this.write({ id, error: { code: -32601, message: 'This ACP client does not provide that capability.' } });
        }
      }
      return;
    }
    const call = this.pending.get(message.id);
    if (!call) return;
    if (message.error) {
      call.reject(new AntigravityRpcError(Number(message.error.code), String(message.error.message || this.name + ' request failed.')));
    } else {
      call.resolve(message.result);
    }
  }

  request<T = any>(method: string, params: Record<string, unknown>, timeout = 90_000): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        const error = new Error(`${this.name} did not respond to ${method} in time.`);
        // A timed-out prompt may still own tools or a permission request.
        if (method === 'session/prompt') this.cancelPrompt();
        this.close(error);
      }, timeout);
      timer.unref();
      this.pending.set(id, {
        resolve: result => { settle(); resolve(result); },
        reject: error => { settle(); reject(error); },
      });
      this.write({ id, method, params });
    });
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'eterx', title: 'EterX', version: '1.0.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      _meta: this.options.initializeMeta,
    });
    if (result?.protocolVersion !== 1) throw new Error(this.name + ' does not support ACP version 1.');
    return result;
  }

  async newSession(systemInstruction?: string, mcpServers: unknown[] = []) {
    const session = await this.request('session/new', {
      cwd: this.options.cwd, mcpServers,
      ...(systemInstruction ? { _meta: { antigravity: { systemPrompt: { append: systemInstruction } } } } : {}),
    });
    if (typeof session?.sessionId !== 'string' || !session.sessionId) throw new Error(this.name + ' did not open a session.');
    this.sessionId = session.sessionId;
    return session;
  }

  close(error = new Error(this.name + ' closed the session.')) {
    if (this.closed) return;
    this.closed = error;
    this.options.signal.removeEventListener('abort', this.abort);
    for (const call of this.pending.values()) call.reject(error);
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill(), 1_000);
    terminate.unref();
    this.child.once('close', () => clearTimeout(terminate));
  }

  async dispose() {
    this.close();
    await this.exited;
  }
}
