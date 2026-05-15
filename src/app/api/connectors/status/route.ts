import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs-extra';
import path from 'path';

const CONNECTORS_FILE = path.resolve(process.cwd(), '.workspaces', '.connectors.json');

/**
 * GET /api/connectors/status
 * Returns the connection status of all connectors.
 */
export async function GET(req: NextRequest) {
  try {
    let connectors: Record<string, any> = {};
    if (await fs.pathExists(CONNECTORS_FILE)) {
      connectors = await fs.readJson(CONNECTORS_FILE);
    }

    // Sanitize — never expose raw tokens to the frontend
    const safe: Record<string, any> = {};
    for (const [key, val] of Object.entries(connectors)) {
      safe[key] = {
        connected: val.connected,
        teamName: val.teamName,
        teamIcon: val.teamIcon,
        connectedAt: val.connectedAt,
        scope: val.scope,
        authedUser: val.authedUser,
      };
    }

    return NextResponse.json({ connectors: safe });
  } catch (err: any) {
    return NextResponse.json({ connectors: {} });
  }
}

/**
 * DELETE /api/connectors/status
 * Disconnects a specific connector.
 */
export async function DELETE(req: NextRequest) {
  try {
    const { platform } = await req.json();
    if (!platform) return NextResponse.json({ error: 'Missing platform' }, { status: 400 });

    let connectors: Record<string, any> = {};
    if (await fs.pathExists(CONNECTORS_FILE)) {
      connectors = await fs.readJson(CONNECTORS_FILE);
    }

    delete connectors[platform];
    await fs.writeJson(CONNECTORS_FILE, connectors, { spaces: 2 });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
