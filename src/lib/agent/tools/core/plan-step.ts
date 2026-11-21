import { z } from 'zod';

export const planStepSchema = z.object({
  id: z.string().optional().describe('Stable step id from the current plan when revising.'),
  step: z.number().int().positive().describe('Step number, starting at 1.'),
  name: z.string().trim().min(1).describe('Short, specific outcome.'),
  description: z.string().optional(),
  done_when: z.string().trim().min(1).describe('Observable completion condition within the user’s constraints.'),
  depends_on: z.array(z.number().int().positive()).optional().describe('Earlier step numbers required for this outcome.'),
  tools: z.array(z.string()).optional(),
  step_type: z.enum(['inspect', 'research', 'configure', 'edit', 'create', 'run', 'verify', 'communicate', 'deliver']).optional(),
  expected_output: z.string().optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  artifacts: z.array(z.string()).optional(),
});
