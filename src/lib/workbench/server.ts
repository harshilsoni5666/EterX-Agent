import fs from 'node:fs/promises';
import { createConnection, isIP } from 'node:net';
import path from 'node:path';
import { listTerminalBackgroundTasks } from '../agent/tools/core/terminal_background';
import { workspaceRunCommandTool } from '../agent/tools/workspace/execution';
import { localWorkbenchUrl, workbenchRunKind, type ApiResult, type ProjectScript, type WorkbenchTarget } from './contracts';
import { readWorkbench } from './events';

export { desktopWorkbenchEnabled } from './host-program';

export async function workbenchActivity(chatId: string) {
  const tasks = (await listTerminalBackgroundTasks(chatId)).filter(task => task.outputKind !== 'read' || task.status === 'running');
  tasks.sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt);
  const state = readWorkbench(chatId);
  const targets = new Map<string, WorkbenchTarget>();
  state.targets.forEach(target => targets.set(target.kind + target.url, target));
  for (const task of tasks) {
    if (task.status !== 'running' || !Array.isArray(task.previewUrls)) continue;
    for (const value of task.previewUrls) {
      try {
        const url = localWorkbenchUrl(value).href;
        if (!targets.has('web' + url)) targets.set('web' + url, { url, kind: 'web', taskId: task.id });
      } catch { /* Older records may contain invalid hints. */ }
    }
  }
  return { ...state, tasks: tasks.slice(0, 120), targets: [...targets.values()].slice(0, 30) };
}

const managers = ['npm', 'pnpm', 'yarn', 'bun'] as const;
const lockfiles = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']] as const;
const scriptName = /^[a-z0-9][a-z0-9:._-]{0,79}$/i;

async function projectManifest(root: string) {
  if (typeof root !== 'string' || root.length > 4096 || !path.isAbsolute(root) || /[\0\r\n]/.test(root)) {
    throw new Error('Choose a project folder to use its package scripts.');
  }
  const cwd = await fs.realpath(root).catch(() => { throw new Error('The selected project folder is unavailable.'); });
  const manifest = path.join(cwd, 'package.json');
  const stat = await fs.stat(manifest).catch(() => null);
  if (!stat?.isFile()) return { cwd, scripts: [] as ProjectScript[] };
  if (stat.size > 1_048_576) throw new Error('package.json is too large to read in the workbench.');
  const data = JSON.parse(await fs.readFile(manifest, 'utf8')) as { scripts?: Record<string, unknown>; packageManager?: string };
  const declared = typeof data.packageManager === 'string' ? data.packageManager.split('@')[0] : '';
  const installedLocks = await Promise.all(lockfiles.map(([file]) => fs.access(path.join(cwd, file)).then(() => true, () => false)));
  const manager = managers.find(item => item === declared) || lockfiles[installedLocks.indexOf(true)]?.[1] || 'npm';
  const scripts = Object.entries(data.scripts || {})
    .filter(([name, body]) => scriptName.test(name) && typeof body === 'string' && body.trim())
    .map(([name]) => ({ name, command: manager + ' run ' + name, kind: workbenchRunKind(name) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)).slice(0, 120);
  return { cwd, scripts };
}

export async function readProjectScripts(root: string) {
  return (await projectManifest(root)).scripts;
}

const launching = new Map<string, Promise<string>>();
export async function runProjectScript(chatId: string, root: string, name: string) {
  const project = await projectManifest(root);
  const script = project.scripts.find(item => item.name === name);
  if (!script) throw new Error('This script is no longer in the selected package.json.');
  const key = JSON.stringify([chatId, project.cwd, script.name]);
  const pending = launching.get(key);
  if (pending) return pending;
  const request = (async () => {
    const task = (await listTerminalBackgroundTasks(chatId)).find(item => item.status === 'running'
      && item.cwd === project.cwd && item.command === script.command);
    if (task) return task.id as string;
    const result = await workspaceRunCommandTool.execute({
      command: script.command, cwd: project.cwd, shell: process.platform === 'win32' ? 'cmd' : 'sh', background: true, outputKind: 'log',
    }, { chatId, workspacePath: project.cwd, workspaceRoot: project.cwd });
    if (result.taskId) return result.taskId as string;
    throw new Error(String(result.stderr || 'The project script did not start.'));
  })().finally(() => launching.delete(key));
  launching.set(key, request);
  return request;
}

function localDestination(input: string, applicationUrl: string) {
  const url = localWorkbenchUrl(input);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const app = new URL(applicationUrl);
  if (port === Number(app.port || (app.protocol === 'https:' ? 443 : 80)) ||
      [process.env.PORT, process.env.ETERX_PORT].some(value => value && Number(value) === port)) {
    throw new Error('Choose a project service on a different port from EterX.');
  }
  return { url, port };
}

export async function checkWorkbenchService(input: string, applicationUrl: string, signal?: AbortSignal) {
  const { url, port } = localDestination(input, applicationUrl);
  const started = Date.now();
  const online = await new Promise<boolean>(resolve => {
    if (signal?.aborted) return resolve(false);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const socket = createConnection({ host: hostname, port, ...(isIP(hostname) === 0 && { autoSelectFamily: true }) });
    const finish = (ready: boolean) => {
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      resolve(ready);
    };
    const abort = () => finish(false);
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(1100, abort);
    socket.once('connect', () => finish(true));
    socket.once('error', abort);
  });
  return { online, elapsedMs: Date.now() - started };
}

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const excludedHeaders = /^(?:host|connection|cookie|content-length|transfer-encoding|upgrade|keep-alive|te|trailer|origin|referer|proxy-.*|sec-.*|forwarded|x-forwarded-.*)$/i;
const API_BODY_LIMIT = 384_000;

export async function callWorkbenchApi(input: { url: string; method: string; headers?: string; body?: string }, applicationUrl: string, signal?: AbortSignal): Promise<ApiResult> {
  const { url } = localDestination(input.url, applicationUrl);
  if (!methods.has(input.method)) throw new Error('Unsupported HTTP method.');
  if ((input.headers?.length || 0) > 8192 || (input.body?.length || 0) > API_BODY_LIMIT) throw new Error('The request is too large.');
  const headers = new Headers();
  for (const line of (input.headers || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    const key = line.slice(0, Math.max(0, colon)).trim();
    if (colon < 1 || !key || excludedHeaders.test(key)) throw new Error('Use one allowed request header per line in Name: value format.');
    headers.append(key, line.slice(colon + 1).trim());
  }
  const started = Date.now();
  const timeout = AbortSignal.timeout(12_000);
  const response = await fetch(url, {
    method: input.method, headers, body: ['GET', 'HEAD'].includes(input.method) ? undefined : input.body || undefined,
    redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const elapsedMs = Date.now() - started;
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let body = '';
  let truncated = false;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = API_BODY_LIMIT - received;
        body += decoder.decode(value.subarray(0, remaining), { stream: true });
        received += value.length;
        if (received > API_BODY_LIMIT) { truncated = true; break; }
      }
      body += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  return { url: url.href, status: response.status, statusText: response.statusText, elapsedMs, headers: [...response.headers], body, truncated };
}
