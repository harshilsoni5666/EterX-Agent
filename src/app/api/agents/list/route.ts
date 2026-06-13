/**
 * Agent List API — Lists all server-side agent profiles
 * 
 * GET /api/agents/list — Returns all agent profiles from .workspaces/agent-builder/agents/
 * 
 * Response: { agents: [{ agentId, name, status, mission, toolCount, createdAt }] }
 */
import { NextRequest } from 'next/server';
import fs from 'fs-extra';
import path from 'path';
import { isSafeAgentId, jsonError, readJsonObject, rejectCrossOrigin } from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const AGENTS_ROOT = path.resolve(process.cwd(), '.workspaces', 'agent-builder', 'agents');

const resolveAgentDir = (agentId: string) => {
  const safeId = String(agentId || '').trim();
  if (!isSafeAgentId(safeId)) return null;
  const resolved = path.resolve(AGENTS_ROOT, safeId);
  if (resolved === AGENTS_ROOT || !resolved.startsWith(AGENTS_ROOT + path.sep)) return null;
  return { safeId, resolved };
};

export async function GET(_req: NextRequest) {
  try {
    if (!await fs.pathExists(AGENTS_ROOT)) {
      return Response.json({ agents: [] });
    }

    const entries = await fs.readdir(AGENTS_ROOT, { withFileTypes: true });
    const agents: any[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const profilePath = path.join(AGENTS_ROOT, entry.name, 'profile.json');
      if (!await fs.pathExists(profilePath)) continue;

      try {
        const profile = await fs.readJson(profilePath);
        agents.push({
          agentId: profile.agentId || entry.name,
          name: profile.name || entry.name,
          status: profile.status || 'draft',
          mission: profile.mission || '',
          toolCount: (profile.directMainTools?.length || 0) + (profile.customTools?.length || 0),
          createdAt: profile.createdAt || '',
          updatedAt: profile.updatedAt || '',
          hasPrompt: !!profile.professionalPrompt && profile.professionalPrompt.length > 100,
        });
      } catch {
        // Skip corrupted profiles
      }
    }

    // Sort by updatedAt descending
    agents.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    return Response.json({ agents });
  } catch (err: any) {
    return Response.json({ agents: [], error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    let agentId = req.nextUrl.searchParams.get('agentId') || '';
    if (!agentId) {
      const body = await readJsonObject(req);
      agentId = body?.agentId || '';
    }

    const target = resolveAgentDir(agentId);
    if (!target) {
      return jsonError('Valid agentId is required.', 400);
    }

    if (await fs.pathExists(target.resolved)) {
      await fs.remove(target.resolved);
    }

    return Response.json({ success: true, agentId: target.safeId, deleted: true });
  } catch (err: any) {
    return Response.json({ success: false, error: err.message || 'Failed to delete agent.' }, { status: 500 });
  }
}
