import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import * as math from 'mathjs';

export const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description: 'Evaluate mathematical expressions safely. Use for math, arithmetic, algebra, and statistics.',
  category: 'core',
  inputSchema: z.object({
    expression: z.string().describe('The mathematical expression to evaluate (e.g. "12 * (3 + 4)")')
  }),
  outputSchema: z.object({
    result: z.any(),
    error: z.string().optional()
  }),
  execute: async (input: { expression: string }) => {
    console.log(`[Tool: calculator] Evaluating: ${input.expression}`);
    try {
      const result = math.evaluate(input.expression);
      return { result };
    } catch (error: any) {
      return { result: null, error: error.message };
    }
  }
};
