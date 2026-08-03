/**
 * Agent List API — Lists all server-side agent profiles
 * 
 * GET /api/agents/list — Returns custom-agent profiles and saved flows.
 * 
 * Response: { agents: [{ agentId, name, status, mission, toolCount, createdAt }] }
 */
import { NextRequest } from 'next/server';
import fs from 'fs-extra';
import path from 'path';
import { isSafeAgentId, jsonError, readJsonObject, rejectCrossOrigin } from '../../agent/_shared';
import { getEterxWorkspaceDir } from '../../../../lib/agent/storage-paths';
import { deleteAgentFlowProfile, listAgentFlowProfiles, readAgentFlowProfile, writeAgentFlowProfile } from '../../../../lib/agent/builder-agent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Use the same persisted workspace root as the builder/runtime. The previous
// process.cwd() path worked in dev but could point at a packaged app's
// read-only bundle on Windows, macOS, or Linux.
const AGENTS_ROOT = getEterxWorkspaceDir('agent-builder', 'agents');

const resolveAgentDir = (agentId: string) => {
  const safeId = String(agentId || '').trim();
  if (!isSafeAgentId(safeId)) return null;
  const resolved = path.resolve(AGENTS_ROOT, safeId);
  if (resolved === AGENTS_ROOT || !resolved.startsWith(AGENTS_ROOT + path.sep)) return null;
  return { safeId, resolved };
};

export async function GET(req: NextRequest) {
  try {
    const agentIdParam = req.nextUrl.searchParams.get('agentId');
    if (agentIdParam) {
      const target = resolveAgentDir(agentIdParam);
      if (!target) {
        return Response.json({ error: 'Valid agentId is required.' }, { status: 400 });
      }
      const profilePath = path.join(target.resolved, 'profile.json');
      if (!await fs.pathExists(profilePath)) {
        const flow = await readAgentFlowProfile(agentIdParam);
        if (flow.status === 'ready' && flow.steps.length > 0) {
          return Response.json({ success: true, kind: 'flow', profile: flow });
        }
        return Response.json({ error: 'Agent profile not found.' }, { status: 404 });
      }
      const profile = await fs.readJson(profilePath);
      return Response.json({ success: true, kind: 'agent', profile });
    }

    const entries = await fs.pathExists(AGENTS_ROOT)
      ? await fs.readdir(AGENTS_ROOT, { withFileTypes: true })
      : [];
    const agents: any[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const profilePath = path.join(AGENTS_ROOT, entry.name, 'profile.json');
      if (!await fs.pathExists(profilePath)) continue;

      try {
        const profile = await fs.readJson(profilePath);
        agents.push({
          agentId: profile.agentId || entry.name,
          kind: 'agent',
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

    // Flows are first-class chat-selectable runtimes. Keep them in the same
    // response so the composer, Agent Room, and API-driven agent picker share
    // one source of truth.
    const flows = await listAgentFlowProfiles();
    for (const flow of flows) {
      agents.push({
        agentId: flow.flowId,
        name: flow.name || flow.flowId,
        status: flow.status,
        mission: flow.description || 'Multi-agent automation flow.',
        toolCount: 0,
        stepCount: flow.steps.length,
        createdAt: flow.createdAt || '',
        updatedAt: flow.updatedAt || '',
        hasPrompt: false,
        kind: 'flow',
      });
    }

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

    let deleted = false;
    if (await fs.pathExists(target.resolved)) {
      await fs.remove(target.resolved);
      deleted = true;
    }
    deleted = (await deleteAgentFlowProfile(target.safeId)) || deleted;

    return Response.json({ success: true, agentId: target.safeId, deleted });
  } catch (err: any) {
    return Response.json({ success: false, error: err.message || 'Failed to delete agent.' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const body = await readJsonObject(req);
    const agentId = body?.agentId || req.nextUrl.searchParams.get('agentId') || '';
    const requestedStatus = body?.status;

    const target = resolveAgentDir(agentId);
    if (!target) {
      return jsonError('Valid agentId is required.', 400);
    }

    const profilePath = path.join(target.resolved, 'profile.json');
    if (!await fs.pathExists(profilePath)) {
      const flow = await readAgentFlowProfile(target.safeId);
      if (flow.steps.length === 0 && flow.status !== 'ready') {
        return jsonError('Agent profile not found.', 404);
      }
      await writeAgentFlowProfile({
        ...flow,
        name: typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : flow.name,
        description: typeof body?.description === 'string' ? body.description : flow.description,
        status: requestedStatus === 'draft' ? 'draft' : flow.status,
      });
      const updatedFlow = await readAgentFlowProfile(target.safeId);
      return Response.json({ success: true, kind: 'flow', agentId: target.safeId, status: updatedFlow.status, profile: updatedFlow });
    }

    const profile = await fs.readJson(profilePath);
    if (requestedStatus === 'draft' || requestedStatus === 'ready') profile.status = requestedStatus;
    if (typeof body?.name === 'string' && body.name.trim()) profile.name = body.name.trim();
    if (typeof body?.mission === 'string') profile.mission = body.mission;
    if (typeof body?.description === 'string' && !String(body?.mission || '').trim()) profile.mission = body.description;
    if (typeof body?.professionalPrompt === 'string' && body.professionalPrompt.trim()) profile.professionalPrompt = body.professionalPrompt;
    profile.updatedAt = new Date().toISOString();

    await fs.writeJson(profilePath, profile, { spaces: 2 });

    return Response.json({ success: true, agentId: target.safeId, status: profile.status, profile });
  } catch (err: any) {
    return Response.json({ success: false, error: err.message || 'Failed to update agent profile.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const body = await readJsonObject(req);

    // Flows are packaged alongside agents, but must be written to the flow
    // store so their steps remain executable after import.
    if (body?.kind === 'flow') {
      const target = resolveAgentDir(body?.agentId || body?.flowId || '');
      if (!target) return jsonError('Valid flowId is required.', 400);
      if (!Array.isArray(body?.steps) || body.steps.length === 0) {
        return jsonError('A flow package must contain at least one step.', 400);
      }

      const now = new Date().toISOString();
      const flow = await writeAgentFlowProfile({
        flowId: target.safeId,
        name: body?.name || target.safeId,
        description: body?.description || '',
        createdAt: body?.createdAt || now,
        updatedAt: now,
        status: 'ready',
        steps: body.steps,
        maxIterations: Number.isFinite(Number(body?.maxIterations)) ? Number(body.maxIterations) : 20,
        notes: Array.isArray(body?.notes) ? body.notes : [],
      });

      return Response.json({ success: true, kind: 'flow', agentId: target.safeId, profile: flow });
    }

    const { 
      agentId, 
      name, 
      mission, 
      professionalPrompt, 
      behaviorRules = [], 
      safetyRules = [], 
      directMainTools = [], 
      customTools = [],
      skills = [],
      responseStyle = '',
      toolUsePolicy = '',
      completionCriteria = '',
      notes = [],
      description = '' 
    } = body;

    const target = resolveAgentDir(agentId);
    if (!target) {
      return jsonError('Valid agentId is required.', 400);
    }

    const agentDir = target.resolved;
    await fs.ensureDir(agentDir);

    const profilePath = path.join(agentDir, 'profile.json');
    const now = new Date().toISOString();

    const profile = {
      agentId: target.safeId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      name: name || target.safeId,
      mission: mission || description || '',
      professionalPrompt: professionalPrompt || `You are ${name || target.safeId}. Your mission is to: ${mission || description || ''}`,
      responseStyle: responseStyle || 'Professional, accurate, and direct.',
      behaviorRules: Array.isArray(behaviorRules) ? behaviorRules : [],
      safetyRules: Array.isArray(safetyRules) ? safetyRules : [],
      skills: Array.isArray(skills) ? skills : [],
      toolUsePolicy: toolUsePolicy || 'Use attached tools purposefully to achieve the mission.',
      completionCriteria: completionCriteria || 'All requirements of the user request have been successfully verified.',
      directMainTools: Array.isArray(directMainTools) ? directMainTools : [],
      customTools: Array.isArray(customTools) ? customTools : [],
      notes: Array.isArray(notes) ? notes : ['Profile created via Agent Wizard.']
    };

    await fs.writeJson(profilePath, profile, { spaces: 2 });

    return Response.json({ success: true, agentId: target.safeId, profile });
  } catch (err: any) {
    return Response.json({ success: false, error: err.message || 'Failed to create agent profile.' }, { status: 500 });
  }
}
