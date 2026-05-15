import { z } from 'zod';
import { ToolDefinition } from '../../schemas';

/**
 * Ask User Tool v1.0
 * 
 * A powerful interaction tool that lets the agent PAUSE and ask the user
 * for information when it doesn't have enough context to proceed.
 * 
 * FEATURES:
 * - Presents a question to the user in a clean UI
 * - Can provide multiple choice options for quick selection  
 * - Can ask for free-text input
 * - Supports urgent/normal priority levels
 * - Returns the user's answer so the agent can continue
 * 
 * This makes the agent MUCH smarter — instead of guessing wrong,
 * it asks when unsure, like a real team member would.
 */
export const askUserTool: ToolDefinition = {
  name: 'ask_user',
  description: `Ask the user a clarifying question when you need more information to proceed. 
  
USE THIS WHEN:
- You don't have enough information to make a good decision
- There are multiple valid approaches and user preference matters
- The task is ambiguous and guessing wrong would waste time
- You need a file path, API key, preference, or specific detail

DO NOT USE FOR:
- Things you can figure out yourself (file names, code structure, etc.)
- Simple yes/no decisions where you should just pick the better option
- Stalling or being lazy — only ask when it truly matters

MODES:
- "choice": Present 2-5 options for the user to pick from. Best for clear alternatives.
- "text": Ask an open-ended question. Best for paths, names, details.
- "confirm": Yes/No confirmation before a potentially impactful action.

The response will contain the user's answer. Continue your work based on it.`,
  category: 'core',
  inputSchema: z.object({
    question: z.string().describe('The question to ask the user. Be clear and concise.'),
    mode: z.enum(['choice', 'text', 'confirm']).describe('Type of question: choice (pick from options), text (free input), or confirm (yes/no)'),
    options: z.array(z.object({
      label: z.string().describe('Short label for this option (e.g., "Desktop")'),
      description: z.string().optional().describe('Optional longer description of what this option means'),
      value: z.string().describe('The value returned if this option is selected')
    })).optional().describe('Options for "choice" mode. Provide 2-5 clear alternatives.'),
    context: z.string().optional().describe('Brief context about WHY you need this information (shown to user)'),
    defaultValue: z.string().optional().describe('Default value or option if user just wants to proceed quickly'),
    urgent: z.boolean().optional().default(false).describe('If true, marks as high priority — agent is blocked without this info')
  }),
  outputSchema: z.object({ 
    answer: z.string(),
    selectedOption: z.any().optional()
  }),
  execute: async (input: any, ctx?: any) => {
    const { question, mode, options, context, defaultValue, urgent } = input;
    
    // Build the ask_user event payload for the frontend
    const askEvent = {
      type: 'ask_user',
      question,
      mode: mode || 'text',
      options: options || [],
      context: context || '',
      defaultValue: defaultValue || '',
      urgent: !!urgent,
      timestamp: Date.now()
    };
    
    // Emit the event to the frontend via the trace callback
    if (ctx?._onTrace) {
      ctx._onTrace(askEvent);
    }
    
    // Wait for the user's response
    // The frontend will send back an answer via a special API endpoint
    // For now, we use a polling mechanism with a global response store
    const responseKey = `ask_user_${askEvent.timestamp}`;
    
    // Store the pending question globally so the API can match responses
    if (typeof globalThis !== 'undefined') {
      (globalThis as any).__pendingAskUser = (globalThis as any).__pendingAskUser || {};
      (globalThis as any).__pendingAskUser[responseKey] = {
        question,
        mode,
        options,
        status: 'pending',
        answer: null,
        createdAt: Date.now()
      };
    }
    
    // Poll for response with timeout (max 5 minutes)
    const MAX_WAIT_MS = 5 * 60 * 1000;
    const POLL_INTERVAL_MS = 500;
    const startTime = Date.now();
    
    while (Date.now() - startTime < MAX_WAIT_MS) {
      // Check if user has responded
      const pending = (globalThis as any).__pendingAskUser?.[responseKey];
      
      if (pending?.status === 'answered' && pending?.answer !== null) {
        // Clean up
        delete (globalThis as any).__pendingAskUser[responseKey];
        
        console.log(`[Tool: ask_user] ✅ User answered: "${pending.answer}"`);
        
        return {
          answer: pending.answer,
          selectedOption: pending.selectedOption || null,
          respondedInMs: Date.now() - startTime
        };
      }
      
      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    
    // Timeout — use default or inform agent
    // Clean up
    if ((globalThis as any).__pendingAskUser?.[responseKey]) {
      delete (globalThis as any).__pendingAskUser[responseKey];
    }
    
    if (defaultValue) {
      console.log(`[Tool: ask_user] ⏰ Timeout, using default: "${defaultValue}"`);
      return {
        answer: defaultValue,
        timedOut: true,
        usedDefault: true
      };
    }
    
    return {
      answer: '',
      timedOut: true,
      error: 'User did not respond within 5 minutes. Proceed with best judgment or try a different approach.'
    };
  }
};
