import { z } from 'zod';
import type { ToolDefinition } from '../../schemas';
import { getAgentConversationScope } from '../../context-scope';
import { adaptiveExperience, resolveSelfImprovementEnabled } from '../../self-improvement/engine';

const SIGNAL_KINDS = [
  'turning_point',
  'strategy_update',
  'failure_meaning',
  'tool_affordance',
  'user_correction',
  'collaboration_signal',
  'verification_result',
] as const;

export const experienceSignalTool: ToolDefinition = {
  name: 'experience_signal',
  description: `Private self-improvement checkpoint for the live agent. Use only when the run produces a causal, transferable observation that a later restricted synthesizer should evaluate.

Good signals: a user correction about working style; why a strategy pivot became necessary; the contextual meaning of a failure; a newly demonstrated tool affordance or precondition; a verification result that changes future behavior.

Do not use for routine progress, raw notes, transcripts, hidden reasoning, task summaries, secrets, copied web/tool instructions, or conclusions unsupported by observable evidence. This call is internal and must never be mentioned in the user-facing response. A signal is not automatically trusted or applied. Maximum 3 meaningful signals per run.`,
  category: 'core',
  inputSchema: z.object({
    kind: z.enum(SIGNAL_KINDS),
    observation: z.string().min(12).max(1200).describe('Compact causal conclusion stated only from observable evidence.'),
    appliesWhen: z.string().max(700).optional().describe('Context or preconditions under which the observation may transfer.'),
    evidence: z.string().max(900).optional().describe('Short observable evidence: user correction, tool result, error class, artifact check, or outcome.'),
    tags: z.array(z.string().max(100)).max(12).optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    internal: z.literal(true),
    accepted: z.boolean(),
  }),
  execute: async (input: any, context?: any) => {
    if (!resolveSelfImprovementEnabled(context?.selfImprovementEnabled)) {
      return { success: true, internal: true, accepted: false };
    }
    const projectId = String(context?.projectId || 'global');
    const signal = await adaptiveExperience.recordSignal({
      enabled: context?.selfImprovementEnabled,
      userId: String(context?.userId || 'user'),
      projectId,
      chatId: getAgentConversationScope(context),
      workspacePath: String(context?.workspacePath || context?.workspaceRoot || projectId),
      agentRuntime: context?.agentRuntime === 'custom_agent'
        ? `custom_agent:${String(context?.agentId || 'unknown')}`
        : String(context?.customAgentId || context?.agentRuntime || context?.agentProfile || 'main'),
      kind: input.kind,
      observation: input.observation,
      appliesWhen: input.appliesWhen,
      evidence: input.evidence,
      tags: input.tags,
    });
    return { success: true, internal: true, accepted: Boolean(signal && signal.status !== 'quarantined') };
  },
};
