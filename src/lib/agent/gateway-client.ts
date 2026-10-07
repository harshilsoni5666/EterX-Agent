import fs from 'fs-extra';
import path from 'path';
import { getEterxDataDir } from './storage-paths';

// Keep the local transport separate from the tool/agent graph. Background
// schedule discovery must not load the execution engine just to check a timer.
const GATEWAY_CONTROL_FILE = path.join(getEterxDataDir(), 'gateways', 'control.json');

export async function callGateway(name: string, args: Record<string, unknown>) {
  if (!await fs.pathExists(GATEWAY_CONTROL_FILE)) throw new Error('The EterX gateway is not configured or running. Open Channels → Go to gateway.');
  const connection = await fs.readJson(GATEWAY_CONTROL_FILE);
  const response = await fetch(String(connection.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.token}` },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(['files_send', 'bot_attachments'].includes(name) ? 180000 : name === 'bot_access_check' ? 5000 : name === 'events_wait' ? 35000 : 45000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(String(payload.error || `Gateway request failed (${response.status}).`)), { code: payload.code, statusCode: response.status });
  return payload;
}
