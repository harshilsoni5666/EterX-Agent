import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { NativeProviderSetupError, type NativeProfile } from './types';

const win = process.platform === 'win32';
const executableName = (name: string) => name + (win ? '.exe' : '');
export const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function resolveProviderCli(name: 'grok' | 'claude', configured = '') {
  const filename = executableName(name);
  const home = homedir();
  const directories = [
    ...String(process.env.PATH || '').split(path.delimiter), path.join(home, '.local', 'bin'),
    path.join(home, '.' + name, 'bin'), ...(name === 'grok' && process.env.GROK_HOME ? [path.join(process.env.GROK_HOME, 'bin')] : []),
  ];
  const candidates = configured ? [configured] : directories.filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, filename));
  return candidates.find(file => {
    if (!path.isAbsolute(file) || /^\\\\/.test(file) || (win && path.extname(file).toLowerCase() !== '.exe')) return false;
    try {
      accessSync(file, win ? constants.R_OK : constants.X_OK);
      return statSync(file).isFile();
    } catch { return false; }
  });
}

export function requireProviderCli(name: 'grok' | 'claude', configured?: string) {
  const file = resolveProviderCli(name, configured);
  if (!file) throw new NativeProviderSetupError('Install the provider’s official CLI and set its executable path in Subscription settings.');
  return file;
}

// A new account must not pick up an API key, account token, bridge credential,
// or alternate model host from the environment that started EterX.
export function providerEnvironment(name: 'grok' | 'claude', profile: NativeProfile): NodeJS.ProcessEnv {
  const allowed = /^(?:path|home|userprofile|appdata|localappdata|systemroot|windir|comspec|pathext|temp|tmp|tmpdir|lang|lc_\w+|username|user|shell|xdg_(?:runtime|config|data|cache)_home|xdg_runtime_dir|display|wayland_display|dbus_session_bus_address|https?_proxy|all_proxy|no_proxy|node_extra_ca_certs|ssl_cert_(?:file|dir)|claude_code_git_bash_path)$/i;
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))),
    NODE_ENV: process.env.NODE_ENV,
  };
  return name === 'grok' ? { ...env, GROK_HOME: profile.directory, NO_COLOR: '1' }
    : { ...env, CLAUDE_CONFIG_DIR: profile.directory, DISABLE_AUTOUPDATER: '1', NO_COLOR: '1' };
}

export async function runProviderCli(
  command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; signal: AbortSignal; onOutput?: (output: string) => void },
) {
  options.signal.throwIfAborted();
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, signal: options.signal,
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let tail = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const observe = (chunk: string) => {
      if (!options.onOutput) return;
      tail = (tail + chunk).slice(-8192);
      options.onOutput(tail.replace(ANSI, ''));
    };
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk).slice(-1024 * 1024);
      observe(chunk);
    });
    child.stderr.on('data', observe);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: stdout.replace(ANSI, '') }));
  });
}

export async function cliVersion(name: 'grok' | 'claude', configured: string, signal: AbortSignal) {
  const command = resolveProviderCli(name, configured);
  if (!command) return null;
  const { code, stdout } = await runProviderCli(command, ['--version'], { signal });
  return code === 0 ? stdout.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0] ?? null : null;
}
