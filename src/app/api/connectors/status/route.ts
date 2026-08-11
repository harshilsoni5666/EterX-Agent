import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_CONNECTOR_ENDPOINTS, testConnectorRecord } from '../../../../lib/connectors/runtime';
import {
  listConnectorRecords,
  getConnectorRecord,
  redactConnector,
  removeConnectorRecord,
  saveConnectorRecord,
  type ConnectorRecord,
} from '../../../../lib/connectors/store';
import { rejectCrossOrigin } from '../../agent/_shared';

export const dynamic = 'force-dynamic';

function publicStatus() {
  return Object.fromEntries(listConnectorRecords().map((record) => [record.id, redactConnector(record)]));
}
function cleanCredentials(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, item]) => /^[a-zA-Z0-9_.-]{1,80}$/.test(key) && typeof item === 'string' && item.length <= 10000)
    .map(([key, item]) => [key, String(item)]));
}

/** Returns redacted status only. Raw tokens never leave the server. */
export async function GET() {
  return NextResponse.json({ connectors: publicStatus(), defaults: DEFAULT_CONNECTOR_ENDPOINTS });
}

/** Save and verify a connector profile. A profile is connected only after its health request succeeds. */
export async function POST(request: NextRequest) {
  const originError = rejectCrossOrigin(request);
  if (originError) return originError;
  try {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || body.platform || '').trim().toLowerCase();
    if (!id || !/^[a-z0-9][a-z0-9_.-]{0,80}$/.test(id)) return NextResponse.json({ error: 'A valid connector id is required.' }, { status: 400 });
    const defaults = DEFAULT_CONNECTOR_ENDPOINTS[id] || {};
    const previous = getConnectorRecord(id);
    const submittedCredentials = cleanCredentials(body.credentials);
    const credentials = body.replaceCredentials === true
      ? submittedCredentials
      : { ...(previous?.credentials || {}), ...submittedCredentials };
    for (const [key, value] of Object.entries({ token: body.token, apiKey: body.apiKey, accessToken: body.accessToken, botToken: body.botToken })) {
      if (typeof value === 'string' && value.trim()) credentials[key] = value.trim();
    }
    const record: ConnectorRecord = {
      id,
      kind: body.kind === 'oauth' || body.kind === 'native' ? body.kind : 'rest',
      connected: false,
      baseUrl: String(body.baseUrl || defaults.baseUrl || '').trim().replace(/\/$/, '') || undefined,
      healthPath: String(body.healthPath || defaults.healthPath || '').trim() || undefined,
      authHeader: String(body.authHeader || defaults.authHeader || '').trim() || undefined,
      tokenPrefix: body.tokenPrefix === '' ? '' : String(body.tokenPrefix ?? defaults.tokenPrefix ?? '').trim() || undefined,
      credentials,
      metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
    };
    saveConnectorRecord(record);
    const tested = body.skipTest === true ? { ok: true, status: 200, message: 'Saved without a health check.' } : await testConnectorRecord(record);
    const saved = saveConnectorRecord({
      ...record,
      connected: tested.ok,
      connectedAt: tested.ok ? Date.now() : undefined,
      lastCheckedAt: Date.now(),
      lastError: tested.ok ? undefined : tested.message,
    });
    if (!tested.ok) return NextResponse.json({ ok: false, error: tested.message, connector: redactConnector(saved) }, { status: 422 });
    return NextResponse.json({ ok: true, connector: redactConnector(saved), message: tested.message });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/** Disconnect and remove the encrypted credential profile. */
export async function DELETE(request: NextRequest) {
  const originError = rejectCrossOrigin(request);
  if (originError) return originError;
  try {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || body.platform || '').trim().toLowerCase();
    if (!id) return NextResponse.json({ error: 'Missing connector id.' }, { status: 400 });
    return NextResponse.json({ ok: true, removed: removeConnectorRecord(id), connectors: publicStatus() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
