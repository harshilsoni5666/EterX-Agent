import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { getEterxDataDir } from '../agent/storage-paths';
import { deviceHostLimit, type DeviceHostInput, type DeviceHostProfile } from './contracts';

export function splitSshTarget(value: string) {
  const parts = value.split('@');
  if (parts.length > 2) return null;
  const username = parts.length === 2 ? parts[0] : undefined;
  const host = parts[parts.length - 1];
  const hostname = host.replace(/^\[(.+)\]$/, '$1');
  if (username !== undefined && !/^[a-z0-9_][a-z0-9_.-]{0,63}$/i.test(username)) return null;
  const ipv6 = isIP(hostname) === 6 && /^[a-z0-9:_.%-]+$/i.test(hostname);
  if (!ipv6 && (host !== hostname || !/^[a-z0-9_][a-z0-9_.-]*$/i.test(hostname))) return null;
  return { hostname, username };
}

export const deviceHostIdSchema = z.string().uuid();
export const deviceHostInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name for this machine.').max(64).regex(/^[^\x00-\x1f\x7f]+$/),
  target: z.string().trim().min(1).max(255).refine(value => splitSshTarget(value) !== null, 'Enter an SSH alias or user@host without a command.'),
  port: z.number().int().min(1).max(65535).optional(),
  identityFile: z.string().trim().max(4096).refine(value =>
    path.isAbsolute(value) && !/^[\\/]{2}|[\x00-\x1f\x7f%]/.test(value) && !/\.pub$/i.test(value) &&
    (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value)),
  'Choose the absolute path to a private SSH key file.').optional(),
  enabled: z.boolean(),
});

const persistedSchema = z.object({
  version: z.literal(1),
  profiles: z.array(deviceHostInputSchema.extend({ id: deviceHostIdSchema })).max(deviceHostLimit),
});
const directory = path.join(getEterxDataDir(), 'settings');
const filename = path.join(directory, 'device-connections.json');

type Store = {
  profiles?: Promise<DeviceHostProfile[]>;
  current?: DeviceHostProfile[];
  writes: Promise<void>;
  lifetimes: Map<string, { profile: DeviceHostProfile; controller: AbortController }>;
};
const host = globalThis as typeof globalThis & { __eterxDeviceConnections?: Store };
const store: Store = host.__eterxDeviceConnections ??= { writes: Promise.resolve(), lifetimes: new Map() };

export function listDeviceConnections(): Promise<DeviceHostProfile[]> {
  return store.profiles ??= fs.readFile(filename, 'utf8').then(
    raw => persistedSchema.parse(JSON.parse(raw)).profiles,
    error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  ).then(profiles => {
    store.current = profiles;
    return profiles;
  }).catch(error => {
    store.profiles = undefined;
    throw error;
  });
}

export function deviceConnectionSignal(profile: DeviceHostProfile) {
  if (!store.current?.includes(profile) || !profile.enabled) return AbortSignal.abort();
  const current = store.lifetimes.get(profile.id);
  if (current?.profile === profile) return current.controller.signal;
  current?.controller.abort();
  const controller = new AbortController();
  store.lifetimes.set(profile.id, { profile, controller });
  return controller.signal;
}

async function persist(profiles: DeviceHostProfile[]) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, profiles }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  store.current = profiles;
  store.profiles = Promise.resolve(profiles);
  for (const [id, lifetime] of store.lifetimes) {
    if (!profiles.includes(lifetime.profile)) {
      store.lifetimes.delete(id);
      lifetime.controller.abort();
    }
  }
}

function updateConnections(update: (profiles: DeviceHostProfile[]) => DeviceHostProfile[]) {
  const written = store.writes.then(async () => {
    const profiles = update(await listDeviceConnections());
    await persist(profiles);
    return profiles;
  });
  store.writes = written.then(() => undefined, () => undefined);
  return written;
}

export function saveDeviceConnection(input: DeviceHostInput, id?: string) {
  const values = deviceHostInputSchema.parse(input);
  let saved: DeviceHostProfile;
  return updateConnections(profiles => {
    const existing = profiles.find(item => item.id === id);
    if (id && !existing) throw new Error('This connection was removed. Refresh the list to continue.');
    if (!id && profiles.length >= deviceHostLimit) throw new Error('Remove a saved connection before adding another.');
    if (profiles.some(item => item.id !== id && item.target === values.target && item.port === values.port)) {
      throw new Error('This SSH destination is already saved.');
    }
    // A device ID from the previous endpoint must never select a device on a different machine.
    const stableId = existing && existing.target === values.target && existing.port === values.port ? existing.id : randomUUID();
    saved = { ...values, id: stableId };
    return id ? profiles.map(item => item.id === id ? saved : item) : [...profiles, saved];
  }).then(() => saved);
}

export function setDeviceConnectionEnabled(id: string, enabled: boolean) {
  return updateConnections(profiles => {
    if (!profiles.some(item => item.id === id)) throw new Error('This connection was removed. Refresh the list to continue.');
    return profiles.map(item => item.id === id && item.enabled !== enabled ? { ...item, enabled } : item);
  });
}

export function removeDeviceConnection(id: string) {
  return updateConnections(profiles => profiles.filter(item => item.id !== id));
}
