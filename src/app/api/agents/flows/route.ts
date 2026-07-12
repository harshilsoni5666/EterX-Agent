/**
 * Flow profiles API.
 *
 * A flow is a saved, executable orchestration of the General agent and/or
 * ready custom agents.  Keeping this separate from agent profiles prevents a
 * flow from being mistaken for a single agent at discovery time.
 */
import { NextRequest } from 'next/server';
import {
  deleteAgentFlowProfile,
  listAgentFlowProfiles,
  readAgentFlowProfile,
  sanitizeFlowId,
  writeAgentFlowProfile,
  type AgentFlowProfile,
  type AgentFlowStep,
} from '../../../../lib/agent/builder-agent';
import { cleanString, isSafeAgentId, jsonError, readJsonObject, rejectCrossOrigin } from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_STEPS = 12;
const MAX_PROMPT_TEMPLATE_CHARS = 12_000;
const MAX_DESCRIPTION_CHARS = 2_000;
const STEP_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const toSummary = (flow: AgentFlowProfile) => ({
  flowId: flow.flowId,
  name: flow.name,
  description: flow.description,
  status: flow.status,
  stepCount: flow.steps.length,
  maxIterations: flow.maxIterations || 20,
  createdAt: flow.createdAt,
  updatedAt: flow.updatedAt,
});

const isValidStepAgent = (value: unknown) => value === 'default-1' || isSafeAgentId(value);

function normalizeSteps(raw: unknown): { steps?: AgentFlowStep[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'A flow needs at least one step.' };
  }
  if (raw.length > MAX_STEPS) {
    return { error: `A flow is limited to ${MAX_STEPS} steps.` };
  }

  const seenIds = new Set<string>();
  const steps: AgentFlowStep[] = [];

  for (const [index, rawStep] of raw.entries()) {
    const stepId = cleanString(rawStep?.stepId, 64);
    const agentId = cleanString(rawStep?.agentId, 96);
    const promptTemplate = cleanString(rawStep?.promptTemplate, MAX_PROMPT_TEMPLATE_CHARS);
    const nextStepId = cleanString(rawStep?.nextStepId, 64);

    if (!STEP_ID_PATTERN.test(stepId) || seenIds.has(stepId)) {
      return { error: `Step ${index + 1} needs a unique ID made of letters, numbers, hyphens, or underscores.` };
    }
    if (!isValidStepAgent(agentId)) {
      return { error: `Step "${stepId}" has an invalid agent selection.` };
    }
    if (!promptTemplate) {
      return { error: `Step "${stepId}" needs instructions for its agent.` };
    }

    seenIds.add(stepId);
    const step: AgentFlowStep = { stepId, agentId, promptTemplate };
    if (nextStepId) step.nextStepId = nextStepId;

    const reflection = rawStep?.reflection;
    if (reflection && typeof reflection === 'object') {
      const evaluatorAgentId = cleanString(reflection.evaluatorAgentId, 96);
      const criteria = cleanString(reflection.criteria, 4_000);
      const maxRetries = Math.max(1, Math.min(5, Number.parseInt(String(reflection.maxRetries ?? 2), 10) || 2));
      if (!isValidStepAgent(evaluatorAgentId) || !criteria) {
        return { error: `Step "${stepId}" has an incomplete review gate.` };
      }
      step.reflection = { evaluatorAgentId, criteria, maxRetries };
    }

    steps.push(step);
  }

  for (const step of steps) {
    if (step.nextStepId && !seenIds.has(step.nextStepId)) {
      return { error: `Step "${step.stepId}" routes to a step that does not exist.` };
    }
  }

  return { steps };
}

function normalizeProfile(body: Record<string, any>, existing?: AgentFlowProfile): { profile?: AgentFlowProfile; error?: string } {
  const rawId = cleanString(body.flowId || existing?.flowId, 96);
  if (!isSafeAgentId(rawId)) return { error: 'A valid flow ID is required.' };

  const flowId = sanitizeFlowId(rawId);
  if (flowId !== rawId) return { error: 'Flow ID contains unsupported characters.' };

  const name = cleanString(body.name, 120) || existing?.name || flowId;
  const description = cleanString(body.description, MAX_DESCRIPTION_CHARS);
  const normalizedSteps = normalizeSteps(body.steps);
  if (normalizedSteps.error || !normalizedSteps.steps) return { error: normalizedSteps.error || 'Invalid flow steps.' };

  const maxIterationsValue = Number.parseInt(String(body.maxIterations ?? existing?.maxIterations ?? 20), 10);
  const maxIterations = Number.isFinite(maxIterationsValue)
    ? Math.max(1, Math.min(100, maxIterationsValue))
    : 20;

  return {
    profile: {
      flowId,
      name,
      description,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: body.status === 'draft' ? 'draft' : 'ready',
      steps: normalizedSteps.steps,
      maxIterations,
      notes: Array.isArray(body.notes)
        ? body.notes.map((note: unknown) => cleanString(note, 500)).filter(Boolean).slice(0, 20)
        : (existing?.notes || []),
    },
  };
}

export async function GET(req: NextRequest) {
  try {
    const flowId = req.nextUrl.searchParams.get('flowId');
    if (flowId) {
      if (!isSafeAgentId(flowId)) return jsonError('A valid flowId is required.', 400);
      const flow = await readAgentFlowProfile(flowId);
      if (flow.status !== 'ready' || flow.steps.length === 0) {
        return jsonError('Flow profile not found.', 404);
      }
      return Response.json({ success: true, flow });
    }

    const flows = await listAgentFlowProfiles();
    return Response.json({ success: true, flows: flows.map(toSummary) });
  } catch (error: any) {
    return Response.json({ success: false, flows: [], error: error?.message || 'Could not read flows.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const body = await readJsonObject(req);
    const normalized = normalizeProfile(body);
    if (normalized.error || !normalized.profile) return jsonError(normalized.error || 'Invalid flow.', 400);

    const existing = await readAgentFlowProfile(normalized.profile.flowId);
    if (existing.status === 'ready' && existing.steps.length > 0) {
      return jsonError('A flow with this ID already exists.', 409);
    }

    await writeAgentFlowProfile(normalized.profile);
    return Response.json({ success: true, flow: await readAgentFlowProfile(normalized.profile.flowId) }, { status: 201 });
  } catch (error: any) {
    return Response.json({ success: false, error: error?.message || 'Could not create flow.' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const body = await readJsonObject(req);
    const flowId = cleanString(body.flowId, 96);
    if (!isSafeAgentId(flowId)) return jsonError('A valid flow ID is required.', 400);

    const existing = await readAgentFlowProfile(flowId);
    if (existing.status !== 'ready' || existing.steps.length === 0) {
      return jsonError('Flow profile not found.', 404);
    }
    const normalized = normalizeProfile(body, existing);
    if (normalized.error || !normalized.profile) return jsonError(normalized.error || 'Invalid flow.', 400);

    await writeAgentFlowProfile(normalized.profile);
    return Response.json({ success: true, flow: await readAgentFlowProfile(flowId) });
  } catch (error: any) {
    return Response.json({ success: false, error: error?.message || 'Could not update flow.' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const flowId = req.nextUrl.searchParams.get('flowId') || '';
    if (!isSafeAgentId(flowId)) return jsonError('A valid flowId is required.', 400);
    const deleted = await deleteAgentFlowProfile(flowId);
    return Response.json({ success: true, flowId, deleted });
  } catch (error: any) {
    return Response.json({ success: false, error: error?.message || 'Could not delete flow.' }, { status: 500 });
  }
}
