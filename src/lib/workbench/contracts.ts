export type WorkbenchView = 'runs' | 'services' | 'api' | 'devices';
export type RunKind = 'server' | 'test' | 'build' | 'command';
export type WorkbenchDeviceMode = 'devices' | 'windows';
export const workbenchActions = ['activity', 'publish', 'show_runs', 'browser', 'devices', 'select_device', 'start_device', 'stop_device', 'capture', 'input', 'install_app', 'launch_app', 'machines', 'start_machine'] as const;
export type WorkbenchAction = (typeof workbenchActions)[number];

export type WorkbenchTarget = {
  url: string;
  label?: string;
  kind: 'web' | 'api';
  taskId?: string;
};

export type WorkbenchFocus = { id: string; view: WorkbenchView; url?: string; deviceId?: string; taskId?: string };

export type WorkbenchDevice = {
  id: string;
  hostId: string;
  hostLabel?: string;
  name: string;
  platform: 'android' | 'ios' | 'ipados' | 'watchos' | 'tvos' | 'visionos';
  runtime?: string;
  formFactor?: 'tv' | 'watch' | 'tablet';
  detail?: string;
  transport: 'emulator' | 'simulator' | 'connected';
  status: 'ready' | 'off' | 'starting' | 'unauthorized' | 'offline';
  input: boolean;
  video: boolean;
};

export const localDeviceHostId = 'local';
export const deviceHostLimit = 8;

export type DeviceHostInput = { name: string; target: string; port?: number; identityFile?: string; enabled: boolean };
export type DeviceHostProfile = DeviceHostInput & { id: string };
export type DeviceHostStatus = {
  id: string;
  name: string;
  platform?: 'macos' | 'windows' | 'linux';
  state: 'ready' | 'setup' | 'offline' | 'paused' | 'idle';
  androidCount?: number;
  appleCount?: number;
  android?: string;
  apple?: string;
  detail?: string;
};
export const deviceHostStateLabel: Record<DeviceHostStatus['state'], string> = {
  ready: 'Ready',
  setup: 'Needs setup',
  offline: 'Unreachable',
  paused: 'Disabled',
  idle: 'Not checked',
};

export type DeviceCatalog = { devices: WorkbenchDevice[]; hosts: DeviceHostStatus[] };
export type DeviceConnectionSettings = {
  desktop: boolean;
  sshAvailable?: boolean;
  profiles: DeviceHostProfile[];
  hosts: DeviceHostStatus[];
};
export type VirtualMachine = { id: string; name: string; status: 'running' | 'starting' | 'off' };
export type MachineCatalog = { available: boolean; machines: VirtualMachine[] };
export type WorkbenchRuntime = { device: WorkbenchDevice | null; machine: VirtualMachine | null };

export const deviceKeys = ['home', 'back', 'enter', 'delete', 'up', 'down', 'left', 'right', 'select'] as const;
export type DeviceKey = (typeof deviceKeys)[number];
export type DeviceInput =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; x: number; y: number; endX: number; endY: number }
  | { kind: 'key'; key: DeviceKey }
  | { kind: 'text'; text: string }
  | { kind: 'appearance'; appearance: 'light' | 'dark' }
  | { kind: 'rotation'; rotation: 'portrait' | 'landscape' | 'auto' };

export function supportsDeviceAppearance(device: WorkbenchDevice) {
  return device.platform === 'ios' || device.platform === 'ipados' ||
    (device.platform === 'android' && device.formFactor !== 'tv' && device.formFactor !== 'watch');
}

export type ProjectScript = { name: string; command: string; kind: RunKind };
export type ApiResult = { url: string; status: number; statusText: string; elapsedMs: number; headers: [string, string][]; body: string; truncated: boolean };
export const previewKeys = ['Tab', 'Enter', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'] as const;
export type PreviewAction =
  | { kind: 'status' | 'snapshot' | 'reload' }
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; x: number; y: number }
  | { kind: 'scroll'; x: number; y: number; deltaY: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: (typeof previewKeys)[number] };
export type PreviewJob = { id: string; action: PreviewAction };
export type PreviewResult = {
  success: boolean;
  error?: string;
  url?: string;
  title?: string;
  loading?: boolean;
  actionStatus?: 'sent';
  vision?: { inlineData: { data: string; mimeType: 'image/jpeg' } };
};

export function localWorkbenchUrl(input: string): URL {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!value || value.length > 2048) throw new Error('Enter a loopback HTTP address such as http://localhost:3000.');
  const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Enter a loopback HTTP address such as http://localhost:3000.');
  }
  return url;
}

export function workbenchRunKind(script: string): RunKind {
  if (/(?:^|[\s:/_.-])(?:test|tests|pytest|vitest|jest|playwright|cypress|check|lint)(?=$|[\s:/_.-])/i.test(script)) return 'test';
  if (/(?:^|[\s:/_.-])(?:dev|serve|server|start|preview)(?=$|[\s:/_.-])/i.test(script)) return 'server';
  if (/(?:^|[\s:/_.-])(?:build|compile|package)(?=$|[\s:/_.-])/i.test(script)) return 'build';
  return 'command';
}
