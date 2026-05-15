import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';

/**
 * Task Checkpoint Tool v1.0
 * 
 * Enables the agent to save progress checkpoints during long-running tasks.
 * When the user says "continue" after an interruption, the agent can read
 * the checkpoint and resume exactly where it left off.
 * 
 * MUCH smarter than the old "restart from scratch" approach.
 */

const CHECKPOINT_DIR = path.resolve(process.cwd(), '.workspaces', '.checkpoints');

export const checkpointTool: ToolDefinition = {
  name: 'task_checkpoint',
  description: `Save or load a task progress checkpoint. Use this on long tasks to persist your progress so you can resume later if interrupted.

SAVE: Call after completing major milestones (e.g., "Created 3/5 files", "Downloaded dataset")
LOAD: Call at the start of a continuation ("continue", "keep going") to see where you left off

This is your insurance against interruption — save checkpoints every 3-5 tool calls on complex tasks.`,
  category: 'core',
  inputSchema: z.object({
    action: z.enum(['save', 'load', 'clear']).describe('save: store checkpoint, load: retrieve last checkpoint, clear: delete checkpoint'),
    taskSummary: z.string().optional().describe('Brief description of what has been done so far (for save action)'),
    nextSteps: z.array(z.string()).optional().describe('Array of remaining steps to complete (for save action)'),
    filesCreated: z.array(z.string()).optional().describe('Files created/modified so far (for save action)'),
    metadata: z.record(z.string(), z.any()).optional().describe('Any extra context to persist (URLs, API keys, data)')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    checkpoint: z.any().optional(),
    message: z.string()
  }),
  execute: async (input: any) => {
    await fs.ensureDir(CHECKPOINT_DIR);
    const checkpointFile = path.join(CHECKPOINT_DIR, 'current_task.json');

    try {
      switch (input.action) {
        case 'save': {
          const checkpoint = {
            taskSummary: input.taskSummary || 'No summary provided',
            nextSteps: input.nextSteps || [],
            filesCreated: input.filesCreated || [],
            metadata: input.metadata || {},
            savedAt: Date.now(),
            savedAtISO: new Date().toISOString(),
            toolCallsCompleted: true
          };

          await fs.writeJson(checkpointFile, checkpoint, { spaces: 2 });
          console.log(`[Tool: task_checkpoint] 💾 Checkpoint saved: ${input.taskSummary?.substring(0, 60)}`);
          
          return {
            success: true,
            message: `Checkpoint saved. ${input.nextSteps?.length || 0} steps remaining. Resume with "continue".`
          };
        }

        case 'load': {
          if (!await fs.pathExists(checkpointFile)) {
            return {
              success: false,
              message: 'No checkpoint found. This appears to be a fresh task — start from scratch.'
            };
          }

          const checkpoint = await fs.readJson(checkpointFile);
          const ageMinutes = ((Date.now() - checkpoint.savedAt) / 60000).toFixed(1);

          // If checkpoint is older than 24 hours, it's probably stale
          if (Date.now() - checkpoint.savedAt > 24 * 60 * 60 * 1000) {
            return {
              success: false,
              message: `Found checkpoint from ${ageMinutes} minutes ago, but it's too old (>24h). Starting fresh.`
            };
          }

          console.log(`[Tool: task_checkpoint] 📋 Loaded checkpoint (${ageMinutes} min old): ${checkpoint.taskSummary?.substring(0, 60)}`);
          
          return {
            success: true,
            checkpoint,
            message: `Checkpoint loaded (${ageMinutes} min old). Task: "${checkpoint.taskSummary}". ${checkpoint.nextSteps?.length || 0} steps remaining. Files: ${checkpoint.filesCreated?.join(', ') || 'none'}.`
          };
        }

        case 'clear': {
          if (await fs.pathExists(checkpointFile)) {
            await fs.remove(checkpointFile);
          }
          return { success: true, message: 'Checkpoint cleared.' };
        }

        default:
          return { success: false, message: 'Unknown action. Use save, load, or clear.' };
      }
    } catch (err: any) {
      return { success: false, message: `Checkpoint error: ${err.message}` };
    }
  }
};
