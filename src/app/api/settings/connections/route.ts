import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { jsonError, readJsonObject, rejectCrossOrigin } from '../../agent/_shared';
import { localDeviceHostId } from '@/lib/workbench/contracts';
import { deviceHostIdSchema, deviceHostInputSchema, listDeviceConnections, removeDeviceConnection, saveDeviceConnection, setDeviceConnectionEnabled } from '@/lib/workbench/device-connections';
import { inspectDeviceHost, inspectLocalDeviceHost, readDeviceHostStatus } from '@/lib/workbench/devices';
import { desktopWorkbenchEnabled } from '@/lib/workbench/host-program';
import { findSshClient } from '@/lib/workbench/ssh-device-host';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };
const reply = (data: object) => NextResponse.json(data, { headers });
const actions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), id: deviceHostIdSchema.optional(), profile: deviceHostInputSchema }),
  z.object({ action: z.literal('set-enabled'), id: deviceHostIdSchema, enabled: z.boolean() }),
  z.object({ action: z.literal('remove'), id: deviceHostIdSchema }),
  z.object({ action: z.literal('inspect'), id: z.union([z.literal(localDeviceHostId), deviceHostIdSchema]) }),
]);

function isDesktop(req: NextRequest) {
  return desktopWorkbenchEnabled() && ['localhost', '127.0.0.1', '[::1]'].includes(req.nextUrl.hostname);
}

function authorize(req: NextRequest) {
  const origin = rejectCrossOrigin(req);
  const site = req.headers.get('sec-fetch-site');
  if (origin) return origin;
  if ((site && site !== 'same-origin' && site !== 'none') || req.headers.get('x-eterx-workbench') !== 'connections') {
    return jsonError('Open Connections from this EterX window.', 403);
  }
  return null;
}

async function settings() {
  const [profiles, local] = await Promise.all([listDeviceConnections(), inspectLocalDeviceHost()]);
  return reply({ desktop: true, sshAvailable: Boolean(findSshClient()), profiles, hosts: [local, ...readDeviceHostStatus(profiles)] });
}

export async function GET(req: NextRequest) {
  const denied = authorize(req);
  if (denied) return denied;
  if (!isDesktop(req)) return reply({ desktop: false, profiles: [], hosts: [] });
  try {
    return await settings();
  } catch {
    return jsonError('Could not read the saved device connections.', 500);
  }
}

export async function POST(req: NextRequest) {
  const denied = authorize(req);
  if (denied) return denied;
  if (!isDesktop(req)) return jsonError('Open EterX Desktop to manage machine connections.', 403);
  if (!/^application\/json(?:;|$)/i.test(req.headers.get('content-type') || '')) return jsonError('Send JSON connection settings.', 415);
  if (Number(req.headers.get('content-length')) > 10_000) return jsonError('Connection settings are too large.', 413);
  const parsed = actions.safeParse(await readJsonObject(req));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message || 'Invalid connection settings.');
  const input = parsed.data;
  try {
    if (input.action === 'save') {
      const saved = await saveDeviceConnection(input.profile, input.id);
      if (saved.enabled) await inspectDeviceHost(saved);
    }
    if (input.action === 'set-enabled') {
      const profiles = await setDeviceConnectionEnabled(input.id, input.enabled);
      const target = profiles.find(profile => profile.id === input.id && profile.enabled);
      if (target) await inspectDeviceHost(target);
    }
    if (input.action === 'remove') await removeDeviceConnection(input.id);
    if (input.action === 'inspect') {
      if (input.id === localDeviceHostId) await inspectLocalDeviceHost(true);
      else {
        const profile = (await listDeviceConnections()).find(item => item.id === input.id);
        if (!profile) return jsonError('This connection was removed. Refresh the list to continue.', 404);
        await inspectDeviceHost(profile);
      }
    }
    return await settings();
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'The connection could not be updated.');
  }
}
