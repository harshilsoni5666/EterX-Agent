import path from 'node:path';
import fs from 'node:fs/promises';
import { findExecutable } from '../agent/tools/core/shell_resolver';
import type { DeviceHostProfile } from './contracts';
import { splitSshTarget } from './device-connections';
import { runHostProgram, type DeviceHost, type HostCommand } from './host-program';

export function findSshClient() {
  const system = process.platform === 'win32' && process.env.SystemRoot;
  return findExecutable(system ? [path.join(system, 'System32', 'OpenSSH', 'ssh.exe'), 'ssh.exe'] : ['/usr/bin/ssh', 'ssh']);
}

export function quoteDeviceHostArgument(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

const deviceEnvironment = [
  'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"',
  'sdk=$ANDROID_HOME',
  'if [ -z "$sdk" ]; then sdk=$ANDROID_SDK_ROOT; fi',
  'if [ -z "$sdk" ]; then',
  '  if [ -d "$HOME/Library/Android/sdk" ]; then sdk="$HOME/Library/Android/sdk";',
  '  elif [ -d "$HOME/Android/Sdk" ]; then sdk="$HOME/Android/Sdk"; fi',
  'fi',
  'if [ -n "$sdk" ]; then export ANDROID_HOME="$sdk" PATH="$sdk/platform-tools:$sdk/emulator:$PATH"; fi',
].join('\n');

const probeScript = [
  'system=$(uname -s)',
  'printf "eterx-os=%s\\n" "$system"',
  'for tool in adb emulator; do',
  '  tool_path=$(command -v "$tool") || continue',
  '  printf "eterx-%s=%s\\n" "$tool" "$tool_path"',
  'done',
  'if [ "$system" = Darwin ]; then',
  '  if [ -x /usr/bin/xcrun ]; then printf "eterx-xcrun=/usr/bin/xcrun\\n"; fi',
  '  idb_path=$(command -v idb) && command -v idb_companion >/dev/null && printf "eterx-idb=%s\\n" "$idb_path"',
  'fi',
  'exit 0',
].join('\n');

function sshError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/identification has changed/i.test(detail)) {
    return 'The SSH host key changed. Verify the new fingerprint on the machine before updating your SSH known hosts.';
  }
  if (/host key verification failed|no .* host key is known/i.test(detail)) {
    return 'SSH has no trusted host key for this machine. Connect once from a terminal and verify its fingerprint before accepting it.';
  }
  if (/permission denied|authentication failed|too many authentication/i.test(detail)) {
    return 'SSH could not sign in. Set up key authentication or unlock the key in your SSH agent, then try again.';
  }
  if (/could not resolve hostname|name or service not known/i.test(detail)) {
    return 'This SSH address could not be resolved. Check the address or SSH alias and your network.';
  }
  if (/connection timed out|connection refused|no route to host|did not respond in time/i.test(detail)) {
    return 'The SSH server did not respond. Check that the machine is on, reachable, and listening on the configured port.';
  }
  if (/not recognized.*command|\/bin\/sh.*not found|not found.*\/bin\/sh/i.test(detail)) {
    return 'This device connection needs an SSH host running macOS or Linux.';
  }
  return detail.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 390);
}

export async function connectSshDeviceHost(profile: DeviceHostProfile, signal: AbortSignal): Promise<DeviceHost> {
  const program = findSshClient();
  if (!program) throw new Error('Install the OpenSSH client on this computer to connect to another machine.');
  const target = splitSshTarget(profile.target);
  if (!target) throw new Error('Enter a valid SSH destination.');
  if (profile.identityFile) {
    const stat = await fs.stat(profile.identityFile).catch(() => null);
    if (!stat?.isFile()) throw new Error('The SSH key file could not be found. Edit this machine and choose its key file.');
  }
  const args = [
    '-n', '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'ConnectionAttempts=1',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'RemoteCommand=none',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'PermitLocalCommand=no',
    '-o', 'ControlPath=none',
    ...(profile.identityFile ? ['-o', 'IdentitiesOnly=yes', '-i', profile.identityFile] : []),
    ...(target.username ? ['-l', target.username] : []),
    ...(profile.port ? ['-p', String(profile.port)] : []),
    target.hostname,
  ];
  const shell = (script: string): HostCommand => ({
    program, args: [...args, '/bin/sh -c ' + quoteDeviceHostArgument(deviceEnvironment + '\n' + script)],
  });
  const invocation = shell(probeScript);
  let output: string;
  try {
    output = (await runHostProgram(invocation.program, invocation.args, 9000, 64_000, signal)).toString();
  } catch (error) {
    throw new Error(sshError(error));
  }

  const fields = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^eterx-(os|adb|emulator|xcrun|idb)=(.+)$/.exec(line);
    if (match) fields.set(match[1], match[2]);
  }
  const platform = fields.get('os') === 'Darwin' ? 'macos' : fields.get('os') === 'Linux' ? 'linux' : undefined;
  if (!platform) throw new Error('This device connection needs an SSH host running macOS or Linux.');
  const tool = (name: string) => {
    const value = fields.get(name);
    return value && value.startsWith('/') && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
  };
  return {
    id: profile.id, name: profile.name, platform, signal,
    tools: { adb: tool('adb'), emulator: tool('emulator'), xcrun: tool('xcrun'), idb: tool('idb') },
    shell,
    command: (binary, parameters) => shell('exec ' + [binary, ...parameters].map(quoteDeviceHostArgument).join(' ')),
  };
}
