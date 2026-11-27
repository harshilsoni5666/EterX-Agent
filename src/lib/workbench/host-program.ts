import { execFile } from 'node:child_process';
import path from 'node:path';

export const desktopWorkbenchEnabled = () =>
  process.env.ETERX_DESKTOP_DEV === '1' || Boolean(process.env.ETERX_DESKTOP_PARENT_PID);

export type DeviceTools = { adb: string | null; emulator: string | null; xcrun: string | null; idb: string | null };
export type HostCommand = { program: string; args: string[] };
export type DeviceHost = {
  id: string;
  name: string;
  platform?: 'macos' | 'windows' | 'linux';
  tools: DeviceTools;
  signal?: AbortSignal;
  command: (program: string, args: string[]) => HostCommand;
  shell?: (script: string) => HostCommand;
};

export function runHostProgram(program: string, args: string[], timeout = 6000, maxBuffer = 1_048_576, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { encoding: 'buffer', timeout, maxBuffer, windowsHide: true, signal }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const detail = stderr.toString().trim().slice(0, 500);
      reject(new Error(signal?.aborted ? 'The device connection was closed.' : detail || (error.killed ? 'The runtime did not respond in time.' : path.basename(program) + ' did not complete (' + (error.code ?? 'unknown error') + ').')));
    });
  });
}

export function runDeviceProgram(host: DeviceHost, program: string, args: string[], timeout?: number, maxBuffer?: number) {
  const command = host.command(program, args);
  return runHostProgram(command.program, command.args, timeout, maxBuffer, host.signal);
}
