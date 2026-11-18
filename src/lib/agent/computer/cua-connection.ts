import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { driverCommand } from './cua-driver';
import { CuaToolError, cuaDiagnostic, decodeCuaToolResult, type CuaResponse } from './cua-response';

type Schema = { properties?: Record<string, unknown>; required?: string[] };
type Reply = { resolve: (value: any) => void; reject: (reason: Error) => void };
type Options = { signal?: AbortSignal; timeout: number };
type Scope = 'desktop' | 'window';

/** The MCP connection owns the driver's snapshot cache and preserves its isError flag. */
export class CuaConnection {
  private readonly child = spawn(driverCommand(), ['mcp'], { stdio: 'pipe', windowsHide: true });
  private readonly replies = new Map<number, Reply>();
  private readonly tools = new Map<string, Schema>();
  private nextId = 0;
  private failure?: Error;
  private started = false;
  private startingSession = false;

  private constructor(private readonly session: string) {
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const reply = this.replies.get(message?.id);
      if (!reply) return;
      if (message.error) {
        const reason = String(message.error.message || 'Cua Driver rejected the request.');
        if (message.error.code === -32603 && /daemon transport error|internal join error forwarding/i.test(reason)) {
          this.disconnect(new Error(reason));
        } else {
          reply.reject(new CuaToolError(reason, [-32601, -32602].includes(message.error.code)));
        }
      } else if ('result' in message) reply.resolve(message.result);
    });
    let startupDiagnostic = '';
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (!this.started) startupDiagnostic = (startupDiagnostic + chunk).slice(-1200);
    });
    this.child.on('error', error => this.disconnect(error));
    this.child.stdin.on('error', error => this.disconnect(error));
    this.child.on('close', () => {
      const detail = this.started ? '' : cuaDiagnostic(startupDiagnostic);
      this.disconnect(new Error(detail || 'The native desktop connection closed. Observe the target before sending more input.'));
    });
  }

  get closed() { return Boolean(this.failure); }

  private disconnect(error: Error, cancelId?: number) {
    if (this.failure) return;
    this.failure = error;
    for (const reply of this.replies.values()) reply.reject(error);
    if (cancelId != null && !this.child.stdin.destroyed && this.child.stdin.writable) {
      const cancelled = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: cancelId, reason: 'Desktop request stopped' } };
      let finalMessages = JSON.stringify(cancelled) + '\n';
      if (this.started || this.startingSession) {
        finalMessages += JSON.stringify({ jsonrpc: '2.0', id: ++this.nextId, method: 'tools/call',
          params: { name: 'end_session', arguments: { session: this.session } } }) + '\n';
      }
      this.child.stdin.end(finalMessages);
      const timer = setTimeout(() => this.child.kill(), 1500);
      timer.unref();
      this.child.once('close', () => clearTimeout(timer));
      return;
    }
    this.child.stdin.end();
    this.child.kill();
  }

  private request(method: string, params: Record<string, unknown>, { signal, timeout }: Options, onDispatch?: () => void): Promise<any> {
    signal?.throwIfAborted();
    if (this.failure) throw this.failure;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const stop = () => this.disconnect(signal?.reason instanceof Error ? signal.reason : new Error('Desktop request stopped.'), id);
      const timer = setTimeout(() => this.disconnect(new Error('Cua Driver timed out. Observe again before repeating input.'), id), timeout);
      const finish = () => {
        this.replies.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
      };
      this.replies.set(id, {
        resolve: value => { finish(); resolve(value); },
        reject: error => { finish(); reject(error); },
      });
      signal?.addEventListener('abort', stop, { once: true });
      try {
        const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
        onDispatch?.();
        this.child.stdin.write(line);
      } catch (error) {
        finish();
        reject(error);
      }
    });
  }

  static async open(session: string, scope: Scope, options: Options) {
    options.signal?.throwIfAborted();
    const connection = new CuaConnection(session);
    try {
      await connection.request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eterx-desktop', version: '1' },
      }, options);
      connection.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      let cursor: string | undefined;
      do {
        const page = await connection.request('tools/list', cursor ? { cursor } : {}, options);
        if (!Array.isArray(page?.tools)) throw new Error('Cua Driver did not provide its native tool definitions.');
        for (const tool of page.tools) connection.tools.set(tool.name, tool.inputSchema ?? tool.input_schema ?? {});
        cursor = page.nextCursor;
      } while (cursor);
      const scoped = connection.supports('start_session', 'capture_scope');
      connection.startingSession = true;
      await connection.call('start_session', scoped ? { capture_scope: scope } : {}, options);
      connection.startingSession = false;
      connection.started = true;
      return connection;
    } catch (error) {
      connection.disconnect(new Error('Native desktop session setup stopped.'));
      throw error;
    }
  }

  supports(tool: string, field: string) {
    return Object.hasOwn(this.tools.get(tool)?.properties || {}, field);
  }

  requires(tool: string, field: string) {
    return this.tools.get(tool)?.required?.includes(field) === true;
  }

  async call(tool: string, args: Record<string, unknown>, options: Options, onDispatch?: () => void): Promise<CuaResponse> {
    if (!this.tools.has(tool)) throw new CuaToolError(`This installation of Cua Driver does not expose ${tool}.`, true);
    try {
      const result = await this.request('tools/call', { name: tool, arguments: { ...args, session: this.session } }, options, onDispatch);
      if (!Array.isArray(result?.content)) throw new Error(`Cua Driver returned an unreadable ${tool} response.`);
      return decodeCuaToolResult(result);
    } catch (error) {
      if (error instanceof Error) {
        const detail = cuaDiagnostic(error.message, args);
        if (detail !== error.message) {
          const sanitized = new CuaToolError(detail, error instanceof CuaToolError && error.inputRefused);
          sanitized.name = error.name;
          throw sanitized;
        }
      }
      throw error;
    }
  }

  async close() {
    try {
      if (this.started && !this.closed) {
        this.started = false;
        await this.call('end_session', {}, { timeout: 2000 });
      }
    } finally {
      this.disconnect(new Error('Native desktop session ended.'));
    }
  }
}
