import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { editTracker } from '@/lib/code/edit-tracker';

export const workspaceEditSessionTool: ToolDefinition = {
  name: 'workspace_edit_session',
  description: 'Manage the current edit session: review all changes, undo edits, create checkpoints, rollback, or get a diff report. Essential for long coding tasks to stay oriented and recover from mistakes.',
  category: 'workspace',
  inputSchema: z.object({
    action: z.enum(['summary', 'undo', 'diff', 'checkpoint', 'rollback', 'list_checkpoints']).describe(
      'summary: list all files changed + counts. undo: revert last edit to a file. diff: session diff report. checkpoint: save named snapshot. rollback: restore to checkpoint. list_checkpoints: show saved checkpoints.'
    ),
    filename: z.string().optional().describe('File path for undo action'),
    name: z.string().optional().describe('Checkpoint name for checkpoint/rollback actions'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    result: z.any(),
  }),
  execute: async (input: { action: string; filename?: string; name?: string }) => {
    try {
      switch (input.action) {
        case 'summary': {
          const summary = editTracker.getEditSummary();
          return {
            success: true,
            result: summary,
          };
        }

        case 'undo': {
          if (!input.filename) {
            return { success: false, result: 'filename is required for undo action' };
          }
          const undoResult = await editTracker.undoLastEdit(input.filename);
          return {
            success: undoResult.success,
            result: undoResult,
          };
        }

        case 'diff': {
          const report = editTracker.getSessionDiffReport();
          return {
            success: true,
            result: report,
          };
        }

        case 'checkpoint': {
          const cpName = input.name || `cp_${Date.now()}`;
          const cpResult = await editTracker.createCheckpoint(cpName);
          return {
            success: cpResult.success,
            result: cpResult,
          };
        }

        case 'rollback': {
          if (!input.name) {
            return { success: false, result: 'name is required for rollback action' };
          }
          const rbResult = await editTracker.rollbackToCheckpoint(input.name);
          return {
            success: rbResult.success,
            result: rbResult,
          };
        }

        case 'list_checkpoints': {
          const checkpoints = editTracker.listCheckpoints();
          return {
            success: true,
            result: {
              checkpoints,
              count: checkpoints.length,
            },
          };
        }

        default:
          return { success: false, result: `Unknown action: ${input.action}. Use summary, undo, diff, checkpoint, rollback, or list_checkpoints.` };
      }
    } catch (err: any) {
      return { success: false, result: `Edit session error: ${err.message}` };
    }
  },
};
