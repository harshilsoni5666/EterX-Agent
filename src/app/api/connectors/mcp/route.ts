import { NextRequest, NextResponse } from 'next/server';
import { listConnectedMcpTools } from '../../../../lib/connectors/runtime';
import {
  listMcpServerRecords,
  redactConnector,
  removeMcpServerRecord,
  saveMcpServerRecord,
  type McpServerRecord,
} from '../../../../lib/connectors/store';

export const dynamic = 'force-dynamic';

function publicServers() {
  return listMcpServerRecords().map(redactConnector);
}

export async function GET() {
  return NextResponse.json({ servers: publicServers() });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || body.name || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
    const name = String(body.name || id).trim();
    const transport = body.transport === 'stdio' ? 'stdio' : 'streamable-http';
    if (!id || !name) return NextResponse.json({ ok: false, error: 'MCP server name is required.' }, { status: 400 });
    if (transport === 'streamable-http' && !String(body.endpoint || '').trim()) return NextResponse.json({ ok: false, error: 'An MCP HTTP endpoint is required.' }, { status: 400 });
    if (transport === 'stdio' && !String(body.command || '').trim()) return NextResponse.json({ ok: false, error: 'A stdio MCP command is required.' }, { status: 400 });
    const record: McpServerRecord = {
      id,
      name,
      transport,
      endpoint: transport === 'streamable-http' ? String(body.endpoint).trim() : undefined,
      command: transport === 'stdio' ? String(body.command).trim() : undefined,
      args: transport === 'stdio' ? (Array.isArray(body.args) ? body.args.map(String).slice(0, 100) : String(body.args || '').split(/\s+/).filter(Boolean).slice(0, 100)) : undefined,
      headers: body.headers && typeof body.headers === 'object' ? Object.fromEntries(Object.entries(body.headers).map(([key, value]) => [String(key), String(value)])) : undefined,
      env: body.env && typeof body.env === 'object' ? Object.fromEntries(Object.entries(body.env).map(([key, value]) => [String(key), String(value)])) : undefined,
      enabled: body.enabled !== false,
      connectedAt: Date.now(),
    };
    const saved = saveMcpServerRecord(record);
    let tools: unknown = undefined;
    if (body.verify !== false) {
      try { tools = await listConnectedMcpTools(saved.id); } catch (error) {
        saveMcpServerRecord({ ...saved, enabled: false, lastCheckedAt: Date.now(), lastError: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error), server: redactConnector(saved) }, { status: 422 });
      }
    }
    const verified = saveMcpServerRecord({ ...saved, enabled: true, lastCheckedAt: Date.now(), lastError: undefined });
    return NextResponse.json({ ok: true, server: redactConnector(verified), tools, servers: publicServers() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const id = String(body.id || '').trim().toLowerCase();
  if (!id) return NextResponse.json({ ok: false, error: 'MCP server id is required.' }, { status: 400 });
  return NextResponse.json({ ok: true, removed: removeMcpServerRecord(id), servers: publicServers() });
}
