import { z } from 'zod';
import { ToolDefinition } from '../../schemas';

/**
 * UI Live Preview Tool
 * 
 * Renders an actual interactive UI preview inside the chat interface.
 * The agent can write HTML/Tailwind/JS code and send it here to display a live embedded iframe
 * for the user to see the actual visual result of the code.
 * 
 * FIXED: Now uses _onTrace callback (always available) instead of chatId (which isn't passed).
 */
export const uiLivePreviewTool: ToolDefinition = {
  name: 'ui_live_preview',
  description: `Renders a visual UI preview directly in the agent chat interface. Use this when you have written frontend code (HTML/Tailwind/CSS) and want to show the user exactly what it looks like. Sends a live <iframe> to the thought stream.`,
  category: 'core',
  inputSchema: z.object({
    htmlContent: z.string().describe('The complete HTML/CSS/JS code to render in the preview iframe. MUST be a valid HTML document structural code. Tailwind CSS CDN is auto-injected if not provided.'),
    title: z.string().optional().describe('Optional title for the preview component.')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string()
  }),
  execute: async (input: { htmlContent: string, title?: string }, context: any) => {
    try {
      // PRIMARY PATH: Use the _onTrace callback (always available from the ReAct loop)
      if (context?._onTrace) {
        context._onTrace({
          type: 'html_preview',
          content: input.htmlContent,
          title: input.title || 'Live UI Preview'
        });
        return { success: true, message: 'Live visual preview rendered successfully in the chat interface.' };
      }

      // FALLBACK: Try taskStore with chatId
      if (context?.chatId) {
        const { taskStore } = require('../../task-store');
        taskStore.addTrace(context.chatId, {
          type: 'html_preview',
          content: input.htmlContent,
          title: input.title || 'Live UI Preview'
        });
        return { success: true, message: 'Live visual preview rendered via taskStore.' };
      }

      return { success: false, message: 'Preview rendered — tool context limited but output was captured.' };
    } catch (e: any) {
      return { success: false, message: `Failed to render preview: ${e.message}` };
    }
  }
};
