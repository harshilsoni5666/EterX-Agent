import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { findExecutable } from '../agent/tools/core/shell_resolver';
import { deviceKeys, localDeviceHostId, supportsDeviceAppearance, type DeviceCatalog, type DeviceHostProfile, type DeviceHostStatus, type DeviceInput, type WorkbenchDevice } from './contracts';
import { deviceConnectionSignal, listDeviceConnections } from './device-connections';
import { runDeviceProgram as run, runHostProgram, type DeviceHost } from './host-program';
import { connectSshDeviceHost, quoteDeviceHostArgument } from './ssh-device-host';

const fraction = z.number().min(0).max(1);
export const deviceInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tap'), x: fraction, y: fraction }),
  z.object({ kind: z.literal('swipe'), x: fraction, y: fraction, endX: fraction, endY: fraction }),
  z.object({ kind: z.literal('key'), key: z.enum(deviceKeys) }),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/) }),
  z.object({ kind: z.literal('appearance'), appearance: z.enum(['light', 'dark']) }),
  z.object({ kind: z.literal('rotation'), rotation: z.enum(['portrait', 'landscape', 'auto']) }),
]);

type Device = WorkbenchDevice & { serial?: string; avd?: string; udid?: string };
type Discovery = { devices: Device[]; host?: DeviceHost; status: DeviceHostStatus; probedAt?: number };
type Scan = { result: Promise<Discovery>; finished?: Discovery; at: number };
type Frame = { png: Buffer; width: number; height: number };
type Start = { until: number; promise: Promise<void> };

const host = globalThis as typeof globalThis & {
  __eterxDeviceWorkbench?: {
    local?: Scan;
    remote?: WeakMap<DeviceHostProfile, Scan>;
    starts: Map<string, Start>;
    bootErrors: Map<string, { message: string; until: number }>;
    frames: Map<string, Promise<Frame>>;
    dimensions: Map<string, { width: number; height: number; at: number; signal?: AbortSignal }>;
    inputs: Map<string, Promise<void>>;
  };
};
const runtime: NonNullable<typeof host.__eterxDeviceWorkbench> = host.__eterxDeviceWorkbench ??= {
  starts: new Map(), bootErrors: new Map(), frames: new Map(), dimensions: new Map(), inputs: new Map(),
};
const remote = runtime.remote ??= new WeakMap();
const scales = new WeakMap<DeviceHost, Map<string, number>>();
const appleFileCapture = new WeakSet<DeviceHost>();
const maxDeviceIdLength = 220;
const displayLimit = 20_000_000;
const detailText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 390);

function hostDeviceId(host: DeviceHost, id: string) {
  return host.id === localDeviceHostId ? id : host.id + '/' + id;
}

function deviceOrigin(host: DeviceHost) {
  return { hostId: host.id, hostLabel: host.id === localDeviceHostId ? undefined : host.name };
}

function sdkTool(name: string, directory: string) {
  const windows = process.platform === 'win32';
  const binary = windows ? name + '.exe' : name;
  const platformRoot = windows ? process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
    : process.platform === 'darwin' ? path.join(homedir(), 'Library', 'Android', 'sdk') : path.join(homedir(), 'Android', 'Sdk');
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, platformRoot].filter((root): root is string => Boolean(root && path.isAbsolute(root)));
  return findExecutable([...roots.map(root => path.join(root, directory, binary)), binary]);
}

function androidFormFactor(name: string): Device['formFactor'] {
  if (/\b(?:android[\s_-]*tv|television|google[\s_-]*tv)\b/i.test(name.replace(/_/g, ' '))) return 'tv';
  if (/\b(?:wear|watch)\b/i.test(name.replace(/_/g, ' '))) return 'watch';
  if (/\btablet\b/i.test(name.replace(/_/g, ' '))) return 'tablet';
  return undefined;
}

function sorted(devices: Device[]) {
  const rank = { ready: 0, starting: 1, unauthorized: 2, offline: 3, off: 4 };
  return devices.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}

async function discoverAndroid(host: DeviceHost): Promise<{ devices: Device[]; android?: string }> {
  const { adb, emulator } = host.tools;
  if (!adb) return { devices: [], android: 'Install Android SDK Platform-Tools for Android devices and emulators.' };
  const [devicesReply, avdReply] = await Promise.allSettled([
    run(host, adb, ['devices', '-l'], 9000),
    emulator ? run(host, emulator, ['-list-avds'], 9000) : Promise.resolve(Buffer.alloc(0)),
  ]);
  const avds = avdReply.status === 'fulfilled' ? avdReply.value.toString().split(/\r?\n/).map(line => line.trim()).filter(name => /^[\w.-]{1,120}$/.test(name) && !name.startsWith('-')).slice(0, 80) : [];
  const devices = new Map<string, Device>();
  if (devicesReply.status === 'fulfilled') {
    const attached = devicesReply.value.toString().split(/\r?\n/).slice(1, 81);
    await Promise.all(attached.map(async line => {
      const match = /^([A-Za-z0-9_.:[\]-]{1,160})\s+(device|offline|unauthorized|no permissions)(?:\s|$)/.exec(line);
      if (!match) return;
      const [, serial, status] = match;
      const virtual = /^emulator-\d+$/.test(serial);
      const info = virtual && status === 'device' && avds.length
        ? await run(host, adb, ['-s', serial, 'emu', 'avd', 'name'], 5000).then(buffer => buffer.toString().split(/\r?\n/)[0].trim(), () => '') : '';
      const avd = avds.find(name => name === info);
      const model = /\bmodel:(\S+)/.exec(line)?.[1];
      const id = hostDeviceId(host, avd ? 'avd:' + avd : 'adb:' + serial);
      const pendingBoot = avd && (runtime.starts.get(id)?.until ?? 0) > Date.now();
      const ready = status === 'device' && (!pendingBoot || await run(host, adb, ['-s', serial, 'exec-out', 'getprop', 'sys.boot_completed'], 5000)
        .then(output => output.toString().trim() === '1', () => false));
      devices.set(id, {
        ...deviceOrigin(host), id, serial, avd, platform: 'android', name: (avd || model || serial).replace(/_/g, ' ').slice(0, 120),
        formFactor: androidFormFactor((avd || '') + ' ' + (model || '')),
        transport: virtual ? 'emulator' : 'connected',
        status: ready ? 'ready' : pendingBoot ? 'starting' : status === 'offline' ? 'offline' : 'unauthorized',
        input: ready, video: ready,
      });
      if (avd && ready) runtime.starts.delete(id);
    }));
  }
  for (const avd of avds) {
    const id = hostDeviceId(host, 'avd:' + avd);
    const bootError = runtime.bootErrors.get(id);
    if (!devices.has(id)) devices.set(id, {
      ...deviceOrigin(host), id, avd, name: avd.replace(/_/g, ' '), platform: 'android', transport: 'emulator',
      formFactor: androidFormFactor(avd), detail: bootError && bootError.until > Date.now() ? bootError.message : undefined,
      status: (runtime.starts.get(id)?.until ?? 0) > Date.now() ? 'starting' : 'off', input: false, video: false,
    });
  }
  const error = devicesReply.status === 'rejected' ? detailText(devicesReply.reason) : avdReply.status === 'rejected' ? detailText(avdReply.reason) : undefined;
  const list = [...devices.values()];
  const guidance = list.some(device => device.status === 'unauthorized') ? 'Accept the USB debugging prompt on the connected Android device.'
    : list.length ? undefined : 'Create an emulator in Android Studio or connect a phone with USB debugging enabled.';
  return { devices: list, android: error || guidance };
}

type SimDevice = { name?: string; udid?: string; state?: string; isAvailable?: boolean };
async function discoverApple(host: DeviceHost): Promise<{ devices: Device[]; apple?: string }> {
  const { xcrun, idb } = host.tools;
  if (!xcrun) return { devices: [], apple: host.platform === 'macos'
    ? 'Install Xcode and select it under Xcode → Settings → Locations.'
    : host.id === localDeviceHostId ? 'Add a Mac in Connections to use Apple simulators from this computer.' : undefined };
  try {
    const text = (await run(host, xcrun, ['simctl', 'list', '-j', 'devices', 'available'], 10_000, 2_097_152)).toString();
    const data = JSON.parse(text) as { devices?: Record<string, SimDevice[]> };
    const devices = Object.entries(data.devices || {}).flatMap(([runtimeName, rows]): Device[] => {
      const os = /\.(iOS|watchOS|tvOS|visionOS)-([\d-]+)$/i.exec(runtimeName);
      if (!os || !Array.isArray(rows)) return [];
      return rows.flatMap(row => {
        if (!row || typeof row.udid !== 'string' || !/^[a-f0-9-]{36}$/i.test(row.udid) || row.isAvailable === false) return [];
        const name = typeof row.name === 'string' ? row.name.slice(0, 120) : 'Simulator';
        const platform = os[1].toLowerCase() === 'ios' && /ipad/i.test(name) ? 'ipados' : os[1].toLowerCase() as Device['platform'];
        const id = hostDeviceId(host, 'sim:' + row.udid);
        if (row.state === 'Booted') runtime.starts.delete(id);
        const booting = (runtime.starts.get(id)?.until ?? 0) > Date.now();
        const status = row.state === 'Booted' ? 'ready' : row.state === 'Shutdown' && !booting ? 'off' : 'starting';
        return [{
          ...deviceOrigin(host), id, udid: row.udid, name, platform, runtime: os[1] + ' ' + os[2].replace(/-/g, '.'),
          formFactor: platform === 'tvos' ? 'tv' : platform === 'watchos' ? 'watch' : platform === 'ipados' ? 'tablet' : undefined,
          transport: 'simulator', status, input: Boolean(idb && ['ios', 'ipados', 'tvos'].includes(platform) && status === 'ready'),
          video: Boolean(idb && ['ios', 'ipados'].includes(platform) && status === 'ready'),
        }];
      });
    });
    const apple = devices.length
      ? idb ? undefined : 'Install idb and idb_companion on this Mac to enable simulator video and controls.'
      : 'Install a simulator runtime in Xcode → Settings → Components and create a simulator.';
    return { devices: devices.slice(0, 100), apple };
  } catch (error) {
    return { devices: [], apple: 'Open Xcode and finish its setup, select it under Locations, and install a simulator runtime. ' + detailText(error) };
  }
}

async function scanHost(host: DeviceHost, probedAt?: number): Promise<Discovery> {
  const [android, apple] = await Promise.all([discoverAndroid(host), discoverApple(host)]);
  const devices = sorted([...android.devices, ...apple.devices]);
  return { devices, host, probedAt, status: {
    id: host.id, name: host.name, platform: host.platform,
    state: devices.some(device => !['offline', 'unauthorized'].includes(device.status)) ? 'ready' : 'setup',
    androidCount: android.devices.length, appleCount: apple.devices.length,
    android: android.android, apple: apple.apple,
  } };
}

function makeScan(load: () => Promise<Discovery>) {
  const scan: Scan = { at: 0, result: Promise.resolve().then(load).then(result => {
    scan.finished = result;
    return result;
  }).finally(() => { scan.at = Date.now(); }) };
  return scan;
}

function discoverLocal(force = false) {
  const cached = runtime.local;
  if (cached && (!cached.at || (!force && Date.now() - cached.at < 2600))) return cached.result;
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : process.platform === 'win32' ? 'windows' : undefined;
  const macTool = (name: string) => findExecutable([name, '/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, path.join(homedir(), '.local/bin', name)]);
  runtime.local = makeScan(() => scanHost({
    id: localDeviceHostId, name: 'This computer', platform,
    tools: {
      adb: sdkTool('adb', 'platform-tools'), emulator: sdkTool('emulator', 'emulator'),
      xcrun: platform === 'macos' ? findExecutable(['/usr/bin/xcrun']) : null,
      idb: platform === 'macos' && macTool('idb_companion') ? macTool('idb') : null,
    },
    command: (program, args) => ({ program, args }),
  }));
  return runtime.local.result;
}

function unconnected(profile: DeviceHostProfile): DeviceHostStatus {
  return { id: profile.id, name: profile.name, state: profile.enabled ? 'idle' : 'paused' };
}

function discoverRemote(profile: DeviceHostProfile, force = false) {
  const cached = remote.get(profile);
  const validity = cached?.finished?.status.state === 'offline' ? 25_000
    : cached?.finished?.devices.some(device => device.status === 'starting') ? 1600 : 7500;
  if (cached && (!cached.at || (!force && Date.now() - cached.at < validity))) return cached.result;
  const previous = cached?.finished;
  const signal = deviceConnectionSignal(profile);
  const scan = makeScan(async () => {
    try {
      if (signal.aborted) return { devices: [], status: unconnected(profile) };
      const reuse = !force && previous?.host && Date.now() - (previous.probedAt || 0) < 35_000;
      const host = reuse ? previous.host! : await connectSshDeviceHost(profile, signal);
      const result = await scanHost(host, reuse ? previous.probedAt : Date.now());
      if (signal.aborted) return { devices: [], status: unconnected(profile) };
      // A reused tool path cannot prove SSH is still reachable if both catalogs fail.
      const diagnostics = [result.status.android, result.status.apple].join(' ');
      if (reuse && !result.devices.length && /ssh:|broken pipe|connection (?:closed|reset)|did not respond in time/i.test(diagnostics)) {
        await connectSshDeviceHost(profile, signal);
      }
      return result;
    } catch (error) {
      return { devices: [], status: { ...unconnected(profile), state: 'offline', detail: detailText(error) } };
    }
  });
  remote.set(profile, scan);
  return scan.result;
}

export function readDeviceHostStatus(profiles: DeviceHostProfile[]) {
  return profiles.map(profile => profile.enabled ? remote.get(profile)?.finished?.status || unconnected(profile) : unconnected(profile));
}

export async function inspectDeviceHost(profile: DeviceHostProfile) {
  if (!profile.enabled) return unconnected(profile);
  return (await discoverRemote(profile, true)).status;
}

export async function inspectLocalDeviceHost(force = false) {
  return (await discoverLocal(force)).status;
}

export async function listWorkbenchDevices(force = false, localOnly = false): Promise<DeviceCatalog> {
  const local = discoverLocal(force);
  const profiles = localOnly ? [] : await listDeviceConnections();
  const discoveries = await Promise.all([local, ...profiles.map(profile =>
    profile.enabled ? discoverRemote(profile, force) : Promise.resolve({ devices: [], status: unconnected(profile) }),
  )]);
  return {
    devices: discoveries.flatMap(item => item.devices.map(publicDevice)),
    hosts: discoveries.map(item => item.status),
  };
}

async function getDevice(id: string) {
  if (typeof id !== 'string' || id.length > maxDeviceIdLength) throw new Error('Select a device first.');
  const separator = id.indexOf('/');
  const profile = separator < 0 ? undefined : (await listDeviceConnections()).find(item => item.id === id.slice(0, separator) && item.enabled);
  if (separator >= 0 && !profile) throw new Error('This remote connection is disabled or removed. Open Connections to manage it.');
  const cached = profile ? remote.get(profile) : runtime.local;
  const existing = cached?.finished?.devices.find(device => device.id === id && device.status === 'ready');
  if (existing && cached?.finished?.host && !cached.finished.host.signal?.aborted && Date.now() - cached.at < 10_000) {
    return { host: cached.finished.host, device: existing, profile };
  }
  const load = (force: boolean) => profile ? discoverRemote(profile, force) : discoverLocal(force);
  let catalog = await load(false);
  let device = catalog.devices.find(item => item.id === id);
  if (!device && catalog.status.state !== 'offline') {
    catalog = await load(true);
    device = catalog.devices.find(item => item.id === id);
  }
  if (!device || !catalog.host || catalog.host.signal?.aborted) {
    throw new Error(catalog.status.detail || 'This device is no longer available. Refresh devices to reconnect.');
  }
  const bootError = runtime.bootErrors.get(id);
  if (bootError && bootError.until < Date.now()) runtime.bootErrors.delete(id);
  return { host: catalog.host, device, profile };
}

function publicDevice({ serial, avd, udid, ...device }: Device): WorkbenchDevice {
  return device;
}

export async function resolveWorkbenchDevice(id: string) {
  return publicDevice((await getDevice(id)).device);
}

function markDeviceCatalogStale(profile?: DeviceHostProfile) {
  const scan = profile ? remote.get(profile) : runtime.local;
  if (scan?.at) scan.at = Number.NEGATIVE_INFINITY;
}

export async function startWorkbenchDevice(id: string) {
  const { device, host, profile } = await getDevice(id);
  const { tools } = host;
  if (device.status === 'ready') return 'ready';
  const existing = runtime.starts.get(id);
  if (existing && existing.until > Date.now()) {
    await existing.promise;
    return 'requested';
  }
  if (device.status !== 'off') throw new Error('Wait for this device to become ready or reconnect it.');
  const promise = (async () => {
    if (device.udid && tools.xcrun) {
      await run(host, tools.xcrun, ['simctl', 'boot', device.udid], 18_000);
      return;
    }
    const { avd } = device;
    const { emulator } = tools;
    if (!avd || !emulator) throw new Error('Start this virtual device in Android Studio.');
    if (host.shell) {
      const command = host.shell(
        'nohup ' + [emulator, '-avd', avd, '-no-window', '-no-audio'].map(quoteDeviceHostArgument).join(' ') +
        ' </dev/null >/dev/null 2>&1 &\npid=$!\nsleep 1\nkill -0 "$pid" 2>/dev/null || { echo "The emulator stopped during startup. Check this AVD and hardware acceleration on the host." >&2; exit 1; }',
      );
      await runHostProgram(command.program, command.args, 15_000, undefined, host.signal);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(emulator, ['-avd', avd], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
      child.once('exit', code => {
        runtime.starts.delete(id);
        if (code) runtime.bootErrors.set(id, { until: Date.now() + 45_000, message: 'The Android Emulator exited with code ' + code + '. Open Device Manager for its startup diagnostics.' });
        markDeviceCatalogStale();
      });
    });
  })().catch(error => { runtime.starts.delete(id); throw error; }).finally(() => markDeviceCatalogStale(profile));
  runtime.bootErrors.delete(id);
  runtime.starts.set(id, { until: Date.now() + 90_000, promise });
  await promise;
  return 'requested';
}

export async function stopWorkbenchDevice(id: string) {
  const { device, host, profile } = await getDevice(id);
  if (device.transport === 'connected') throw new Error('Only simulators and emulators can be powered off here.');
  if (device.status === 'off') return 'off';
  requireReady(device);
  if (device.udid && host.tools.xcrun) {
    await run(host, host.tools.xcrun, ['simctl', 'shutdown', device.udid], 18_000);
  } else if (device.serial && host.tools.adb) {
    await run(host, host.tools.adb, ['-s', device.serial, 'emu', 'kill'], 10_000);
  } else {
    throw new Error('This emulator is no longer available.');
  }
  runtime.starts.delete(id);
  runtime.dimensions.delete(id);
  markDeviceCatalogStale(profile);
  return 'requested';
}

export async function openNativeSimulator(id: string) {
  const { device, host } = await getDevice(id);
  if (host.signal) throw new Error('Open Simulator on the Mac that hosts this device.');
  if (!device.udid) throw new Error('Use the Android Emulator window or the connected device.');
  const app = device.platform === 'watchos' ? 'Simulator (Watch)' : 'Simulator';
  try { await run(host, '/usr/bin/open', ['-a', app, '--args', '-CurrentDeviceUDID', device.udid]); }
  catch (error) {
    if (app === 'Simulator') throw error;
    await run(host, '/usr/bin/open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', device.udid]);
  }
}

function requireReady(device: Device) {
  if (device.status === 'ready') return;
  if (device.status === 'unauthorized') throw new Error('Authorize USB debugging on the connected device.');
  const startup = runtime.bootErrors.get(device.id);
  throw new Error(startup?.message || 'This device is ' + device.status + '. Start or reconnect it to continue.');
}

const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function readPng(output: Buffer) {
  const start = output.indexOf(pngMagic);
  if (start < 0 || start > 8192 || output.length < start + 24 || output.toString('ascii', start + 12, start + 16) !== 'IHDR') return null;
  return output.subarray(start);
}

async function captureApple(host: DeviceHost, program: string, udid: string) {
  const args = ['simctl', 'io', udid, 'screenshot', '--type=png'];
  if (!appleFileCapture.has(host)) {
    const output = await run(host, program, [...args, '-'], 10_000, displayLimit).catch(error => {
      if (host.signal?.aborted || !/(?:usage|invalid|unknown|not support|file name)/i.test(detailText(error))) throw error;
      return null;
    });
    if (output && readPng(output)) return output;
    appleFileCapture.add(host);
  }
  if (host.shell) {
    const invocation = [program, ...args].map(quoteDeviceHostArgument).join(' ');
    const command = host.shell([
      'folder=$(mktemp -d) || exit 1',
      'clean() { rm -f "$folder/device.png"; rmdir "$folder"; }',
      'trap clean EXIT',
      invocation + ' "$folder/device.png" >/dev/null && cat "$folder/device.png"',
    ].join('\n'));
    return runHostProgram(command.program, command.args, 10_000, displayLimit, host.signal);
  }
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'eterx-display-'));
  const file = path.join(directory, 'screen.png');
  try {
    await run(host, program, [...args, file], 6500);
    if ((await fs.stat(file)).size > displayLimit) throw new Error('The simulator frame is too large.');
    return await fs.readFile(file);
  } finally {
    await fs.unlink(file).catch(() => undefined);
    await fs.rmdir(directory).catch(() => undefined);
  }
}

export async function captureWorkbenchDevice(id: string): Promise<Frame> {
  const pending = runtime.frames.get(id);
  if (pending) return pending;
  const capture = (async () => {
    const { device, host } = await getDevice(id);
    const { tools } = host;
    requireReady(device);
    const output = device.serial && tools.adb
      ? await run(host, tools.adb, ['-s', device.serial, 'exec-out', 'screencap', '-p'], host.signal ? 10_000 : 5500, displayLimit)
      : await captureApple(host, tools.xcrun!, device.udid!);
    const png = readPng(output);
    if (!png) {
      throw new Error('The device returned no display frame. Unlock it or wait for the simulator to finish booting.');
    }
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (!width || !height || width > 16384 || height > 16384) throw new Error('The device returned an invalid display size.');
    runtime.dimensions.set(id, { width, height, at: Date.now(), signal: host.signal });
    if (runtime.dimensions.size > 100) runtime.dimensions.delete(runtime.dimensions.keys().next().value!);
    return { png, width, height };
  })().finally(() => { runtime.frames.delete(id); });
  runtime.frames.set(id, capture);
  return capture;
}

const androidKeys = { home: 3, back: 4, enter: 66, delete: 67, up: 19, down: 20, left: 21, right: 22, select: 23 };
const appleKeys = { back: 41, enter: 40, delete: 42, up: 82, down: 81, left: 80, right: 79, select: 40 };

async function appleScale(device: Device, host: DeviceHost) {
  const byDevice = scales.get(host) ?? new Map<string, number>();
  scales.set(host, byDevice);
  const cached = byDevice.get(device.id);
  if (cached) return cached;
  const envScale = await run(host, host.tools.xcrun!, ['simctl', 'getenv', device.udid!, 'SIMULATOR_MAINSCREEN_SCALE'])
    .then(value => Number(value.toString().trim()), () => 0);
  let scale = envScale;
  if (!(scale >= 1)) {
    const report = JSON.parse((await run(host, host.tools.idb!, ['describe', '--json', '--udid', device.udid!], 12_000)).toString());
    const dimensions = report?.screen_dimensions;
    scale = dimensions?.width_points ? dimensions.width / dimensions.width_points : Number(dimensions?.density);
  }
  if (!Number.isFinite(scale) || scale < 1 || scale > 5) throw new Error('The simulator display scale is unavailable. Use the native Simulator window for touch input.');
  byDevice.set(device.id, scale);
  return scale;
}

function quoteAdbText(text: string) {
  if (/[^\x20-\x7e]|%s/.test(text)) throw new Error('Android shell input supports printable ASCII. Use the native device keyboard for this text.');
  return "'" + text.replace(/ /g, '%s').replace(/'/g, "'\\''") + "'";
}

async function applyDeviceInput(id: string, input: DeviceInput) {
  const { device, host } = await getDevice(id);
  const { tools } = host;
  requireReady(device);
  if (input.kind === 'appearance') {
    if (!supportsDeviceAppearance(device)) throw new Error('This device does not support appearance controls.');
    if (device.serial && tools.adb) {
      await run(host, tools.adb, ['-s', device.serial, 'shell', 'cmd', 'uimode', 'night', input.appearance === 'dark' ? 'yes' : 'no'], 9000);
    } else {
      await run(host, tools.xcrun!, ['simctl', 'ui', device.udid!, 'appearance', input.appearance], 10_000);
    }
    return;
  }
  if (!device.input) throw new Error('This device does not have input controls in the Workbench. Use the Simulator on its host.');
  const adb = device.serial && tools.adb;
  const apple = (args: string[]) => run(host, tools.idb!, ['ui', ...args, '--udid', device.udid!], 12_000);
  const android = (args: string[]) => run(host, tools.adb!, ['-s', device.serial!, 'shell', ...args], 9000);
  if (input.kind === 'key') {
    if (adb) await android(['input', 'keyevent', String(androidKeys[input.key])]);
    else await apple(input.key === 'home' ? ['button', 'HOME'] : ['key', String(appleKeys[input.key])]);
    return;
  }
  if (input.kind === 'text') {
    if (adb) await android(['input', 'text', quoteAdbText(input.text)]);
    else await run(host, tools.idb!, ['ui', 'text', '--udid', device.udid!, '--', input.text], 12_000);
    return;
  }
  if (input.kind === 'rotation') {
    if (!adb) {
      if (input.rotation === 'auto') throw new Error('Set automatic orientation from the native Simulator.');
      await apple(['rotate', input.rotation === 'portrait' ? 'PORTRAIT' : 'LANDSCAPE_LEFT']);
    } else {
      await android(['cmd', 'window', 'user-rotation', ...(input.rotation === 'auto' ? ['free'] : ['lock', input.rotation === 'portrait' ? '0' : '1'])]);
    }
    runtime.dimensions.delete(id);
    return;
  }
  if (device.formFactor === 'tv') throw new Error('Use arrow and select controls for this TV.');
  const cached = runtime.dimensions.get(id);
  const { width, height } = cached && cached.signal === host.signal && Date.now() - cached.at < 3000 ? cached : await captureWorkbenchDevice(id);
  const scale = adb ? 1 : await appleScale(device, host);
  const point = (x: number, y: number) => [String(Math.floor(x * (width / scale - 1))), String(Math.floor(y * (height / scale - 1)))];
  const first = point(input.x, input.y);
  const action = input.kind === 'tap' ? ['tap', ...first]
    : ['swipe', ...first, ...point(input.endX, input.endY), ...(adb ? ['280'] : ['--duration', '0.28'])];
  if (adb) await android(['input', ...action]);
  else await apple(action);
}

export function sendWorkbenchDeviceInput(id: string, input: DeviceInput): Promise<void> {
  const previous = runtime.inputs.get(id);
  const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => applyDeviceInput(id, input)).finally(() => {
    if (runtime.inputs.get(id) === next) runtime.inputs.delete(id);
  });
  runtime.inputs.set(id, next);
  return next;
}

const appIdentifier = /^[a-zA-Z0-9][\w.-]{1,199}$/;

export async function launchWorkbenchDeviceApp(id: string, appId: string) {
  if (!appIdentifier.test(appId)) throw new Error('Enter an installed app package or bundle identifier.');
  const { device, host } = await getDevice(id);
  const { tools } = host;
  requireReady(device);
  if (device.udid) {
    await run(host, tools.xcrun!, ['simctl', 'launch', device.udid, appId], 15_000);
    return;
  }
  const reply = await run(host, tools.adb!, ['-s', device.serial!, 'shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1'], 12_000);
  if (!/Events injected:\s+1\b/i.test(reply.toString())) throw new Error('No launchable Android app was found for ' + appId + '.');
}

export async function installWorkbenchDeviceApp(id: string, value: string, appId?: string) {
  const { device, host } = await getDevice(id);
  requireReady(device);
  if (appId !== undefined && !appIdentifier.test(appId)) throw new Error('Enter a valid package or bundle identifier.');
  const hostPath = host.platform === 'windows' ? path.win32 : path.posix;
  const artifactInput = value.trim().replace(/[\\/]+$/, '');
  const artifact = hostPath.normalize(artifactInput);
  const extension = device.udid ? '.app' : '.apk';
  if (artifact.length > 4096 || !hostPath.isAbsolute(artifact) || /^[\\/]{2}/.test(artifactInput) ||
      (host.platform === 'windows' && !/^[a-z]:[\\/]/i.test(artifact)) ||
      /[\x00-\x1f\x7f]/.test(artifact) || hostPath.extname(artifact).toLowerCase() !== extension) {
    throw new Error('Enter the absolute path to a ' + extension + ' build on ' + (device.hostLabel || 'this computer') + '.');
  }
  if (device.udid) {
    await run(host, host.tools.xcrun!, ['simctl', 'install', device.udid, artifact], 90_000);
    const bundle = (await run(host, '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', hostPath.join(artifact, 'Info.plist')])
      .then(output => output.toString().trim(), () => ''));
    return appIdentifier.test(bundle) ? bundle : appId;
  }
  const output = (await run(host, host.tools.adb!, ['-s', device.serial!, 'install', '-r', artifact], 90_000)).toString();
  if (!/(?:^|\n)Success\s*$/m.test(output)) throw new Error(detailText(output) || 'The Android app could not be installed.');
  return appId;
}

export async function workbenchDeviceVideoCommand(id: string) {
  const { device, host } = await getDevice(id);
  requireReady(device);
  if (!device.video) throw new Error('Video is unavailable for this device. Use live screenshots.');
  const command = device.serial && host.tools.adb
    ? host.command(host.tools.adb, ['-s', device.serial, 'exec-out', 'screenrecord', '--output-format=h264', '--bit-rate', '4000000', '--time-limit', '180', '-'])
    : host.command(host.tools.idb!, ['video-stream', '--udid', device.udid!, '--format', 'h264', '--fps', '24']);
  return { command, signal: host.signal };
}
