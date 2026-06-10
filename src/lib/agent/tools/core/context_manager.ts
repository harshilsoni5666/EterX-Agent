import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { globalMemoryManager } from '../../memory/store';
import { globalSessionManager } from '../../session';

/**
 * Smart Context Manager — Session-Aware
 * 
 * Manages conversation context for long-running sessions.
 * Now syncs with SessionStateManager for cross-message persistence.
 */

const contextBuckets: Map<string, {
  summary: string;
  keyFacts: string[];
  recentActions: string[];
  errors: string[];
  updatedAt: number;
}> = new Map();

export const contextManagerTool: ToolDefinition = {
  name: 'context_manager',
  description: `Manage long-running conversation context. Summarize, compress, and track key information across extended sessions. Use this to:
  - Save important context before it gets lost in long conversations
  - Retrieve summarized context for decision making
  - Track key facts, recent actions, and errors
  - Reset context for new tasks`,
  category: 'core',
  inputSchema: z.object({
    action: z.enum(['save_context', 'get_context', 'add_fact', 'add_action', 'add_error', 'summarize', 'reset']),
    sessionId: z.string().optional().default('default').describe('Session identifier'),
    content: z.string().optional().describe('Content to save or summarize'),
    key: z.string().optional().describe('Key for facts')
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string(), data: z.any().optional() }),
  execute: async (input: any) => {
    const sid = input.sessionId || 'default';

    if (!contextBuckets.has(sid)) {
      contextBuckets.set(sid, { summary: '', keyFacts: [], recentActions: [], errors: [], updatedAt: Date.now() });
    }
    const ctx = contextBuckets.get(sid)!;

    try {
      switch (input.action) {
        case 'save_context': {
          if (!input.content) return { success: false, message: 'content required' };
          ctx.summary = input.content.substring(0, 2000);
          ctx.updatedAt = Date.now();
          globalMemoryManager.saveEpisodicMemory(sid, `Context saved: ${input.content.substring(0, 200)}`, 'conversation_summary', 7, ['context']);
          globalSessionManager.addAction(`Context saved: ${input.content.substring(0, 80)}`);
          return { success: true, message: `Context saved (${input.content.length} chars)` };
        }
        case 'get_context': {
          const sessionSummary = globalSessionManager.getSessionSummary();
          return {
            success: true,
            message: 'Current context (local + session)',
            data: {
              summary: ctx.summary,
              keyFacts: ctx.keyFacts,
              recentActions: ctx.recentActions.slice(-10),
              errors: ctx.errors.slice(-5),
              sessionState: sessionSummary || 'No session data',
              updatedAt: new Date(ctx.updatedAt).toISOString()
            }
          };
        }
        case 'add_fact': {
          if (!input.content) return { success: false, message: 'content required' };
          ctx.keyFacts.push(input.content);
          if (ctx.keyFacts.length > 50) ctx.keyFacts.shift();
          ctx.updatedAt = Date.now();
          return { success: true, message: `Fact added (${ctx.keyFacts.length} total)` };
        }
        case 'add_action': {
          if (!input.content) return { success: false, message: 'content required' };
          ctx.recentActions.push(`[${new Date().toISOString()}] ${input.content}`);
          if (ctx.recentActions.length > 30) ctx.recentActions.shift();
          ctx.updatedAt = Date.now();
          globalSessionManager.addAction(input.content);
          return { success: true, message: `Action logged (${ctx.recentActions.length} total)` };
        }
        case 'add_error': {
          if (!input.content) return { success: false, message: 'content required' };
          ctx.errors.push(`[${new Date().toISOString()}] ${input.content}`);
          if (ctx.errors.length > 20) ctx.errors.shift();
          ctx.updatedAt = Date.now();
          return { success: true, message: `Error logged (${ctx.errors.length} total)` };
        }
        case 'summarize': {
          const compact = [
            ctx.summary ? `Summary: ${ctx.summary.substring(0, 500)}` : '',
            ctx.keyFacts.length > 0 ? `Key facts: ${ctx.keyFacts.slice(-10).join('; ')}` : '',
            ctx.recentActions.length > 0 ? `Recent: ${ctx.recentActions.slice(-5).join('; ')}` : '',
            ctx.errors.length > 0 ? `Errors: ${ctx.errors.slice(-3).join('; ')}` : ''
          ].filter(Boolean).join('\n');
          return { success: true, message: 'Compressed context', data: compact };
        }
        case 'reset': {
          contextBuckets.delete(sid);
          return { success: true, message: `Context reset for session "${sid}"` };
        }
        default: return { success: false, message: 'Unknown action' };
      }
    } catch (err: any) {
      return { success: false, message: `Context error: ${err.message}` };
    }
  }
};
