import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import {
  getContextFabricForChat,
  rotateContextFabric,
  type ContextEpistemicStatus,
  type ContextFactKind,
} from '../../context-fabric';

const factKinds = [
  'objective',
  'constraint',
  'decision',
  'state',
  'evidence',
  'artifact',
  'failure',
  'next_action',
  'reference',
  'preference',
  'milestone',
] as const;

const actions = [
  'remember',
  'search_memory',
  'open_page',
  'invalidate',
  'inspect_policy',
  'mark_decision',
  'mark_next_action',
  // Backward-compatible names used by older prompts and saved agents.
  'save_context',
  'get_context',
  'add_fact',
  'add_action',
  'add_error',
  'summarize',
  'reset',
] as const;

/**
 * Context Fabric access tool.
 *
 * This is deliberately a retrieval/control interface rather than another
 * free-form summary bucket. Exact observations are stored as immutable pages;
 * temporal facts and graph links remain queryable after prompt compaction.
 */
export const contextManagerTool: ToolDefinition = {
  name: 'context_manager',
  description: `Use the durable Context Fabric for long-horizon work. It stores exact source pages plus temporal, causal, epistemic facts instead of relying on a lossy summary.

Use search_memory just in time before decisions, open_page when exact source evidence matters, remember for durable decisions/constraints/state, invalidate when a formerly active belief is no longer valid, and inspect_policy to see learned retention rules. Context is always scoped to the executing chat; sessionId cannot redirect another chat's memory.`,
  category: 'core',
  inputSchema: z.object({
    action: z.enum(actions),
    sessionId: z.string().optional().default('default').describe('Legacy fallback only; the executing chat owns the scope'),
    content: z.string().optional().describe('Memory text, decision, error, or retrieval query'),
    query: z.string().optional().describe('Just-in-time retrieval query'),
    key: z.string().optional().describe('Stable semantic key used to supersede an older value'),
    kind: z.enum(factKinds).optional().describe('Memory type'),
    epistemic: z.enum(['observed', 'user_asserted', 'inferred']).optional().describe('How the claim is known'),
    importance: z.number().min(0).max(10).optional().describe('Initial retention importance; learned utility also affects retrieval'),
    targets: z.array(z.string()).max(32).optional().describe('Files, entities, URLs, or state targets connected to this memory'),
    factId: z.string().optional().describe('Context fact ID for invalidation'),
    pageRef: z.string().optional().describe('Exact page pointer returned by search_memory'),
    tokenBudget: z.number().int().min(256).max(12_000).optional().describe('Maximum approximate tokens for retrieval'),
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string(), data: z.any().optional() }),
  execute: async (input: any, runtimeContext?: any) => {
    const runtimeChatId = String(runtimeContext?.projectId || runtimeContext?.chatId || runtimeContext?.taskId || '').trim();
    const scopeId = runtimeChatId || String(input.sessionId || 'default').trim() || 'default';

    try {
      if (input.action === 'reset') {
        await rotateContextFabric(scopeId);
        return { success: true, message: `Context Fabric archived and rotated for scope "${scopeId}".` };
      }

      const fabric = await getContextFabricForChat(scopeId);
      switch (input.action) {
        case 'open_page': {
          if (!input.pageRef) return { success: false, message: 'pageRef is required.' };
          const page = await fabric.openPage(input.pageRef);
          return { success: true, message: `Recovered exact context page ${input.pageRef}.`, data: page };
        }
        case 'search_memory':
        case 'summarize': {
          const query = String(input.query || input.content || '').trim();
          const result = fabric.search(query, input.tokenBudget);
          return {
            success: true,
            message: `Retrieved ${result.facts.length} facts and ${result.episodes.length} exact-page pointers using fused lexical, semantic, graph, temporal, and learned-value search.`,
            data: result,
          };
        }
        case 'get_context': {
          const query = String(input.query || input.content || 'active objective constraints unresolved failures latest state').trim();
          return {
            success: true,
            message: 'Current temporal-epistemic working set.',
            data: {
              workingSet: fabric.compileWorkingSet(query, input.tokenBudget ? input.tokenBudget * 4 : undefined),
              policy: fabric.getMemoryPolicy(),
            },
          };
        }
        case 'inspect_policy':
          return { success: true, message: 'Learned memory policy.', data: fabric.getMemoryPolicy() };
        case 'invalidate': {
          if (!input.factId) return { success: false, message: 'factId is required.' };
          const fact = fabric.invalidateFact(input.factId, input.content || 'Invalidated by agent after new evidence.');
          await fabric.flush();
          return { success: true, message: `Closed the valid-time interval for ${fact.id}; history was preserved.`, data: fact };
        }
        case 'remember':
        case 'save_context':
        case 'add_fact':
        case 'add_action':
        case 'add_error':
        case 'mark_decision':
        case 'mark_next_action': {
          const content = String(input.content || '').trim();
          if (!content) return { success: false, message: 'content is required.' };
          const compatibilityKind: ContextFactKind = input.action === 'add_error'
            ? 'failure'
            : input.action === 'mark_decision'
              ? 'decision'
              : input.action === 'mark_next_action' || input.action === 'add_action'
                ? 'next_action'
                : input.action === 'save_context'
                  ? 'reference'
                  : (input.kind || 'reference');
          const fact = fabric.remember({
            text: content,
            kind: compatibilityKind,
            key: input.key,
            importance: input.importance ?? (['decision', 'failure', 'next_action'].includes(compatibilityKind) ? 9 : 7),
            epistemic: (input.epistemic || 'inferred') as ContextEpistemicStatus,
            targets: input.targets,
          });
          await fabric.flush();
          const pageRef = fact.provenance[fact.provenance.length - 1]?.pageRef;
          return {
            success: true,
            message: `Stored ${fact.network}/${fact.kind} memory ${fact.id} with temporal validity${pageRef ? ` and exact page ${pageRef}` : ''}.`,
            data: fact,
          };
        }
        default:
          return { success: false, message: 'Unknown context action.' };
      }
    } catch (error: any) {
      return { success: false, message: `Context Fabric error: ${error?.message || String(error)}` };
    }
  },
};
