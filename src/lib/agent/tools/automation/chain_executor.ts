import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';
import { globalMemoryManager } from '../../memory/store';

/**
 * Autonomous Chain Executor
 *
 * Execute a sequence of tool calls autonomously without user intervention.
 * The agent can build and run multi-step pipelines.
 */

interface ChainStep {
  tool: string;
  args: Record<string, any> | string;
  outputVar?: string; // Store result in variable for later steps
  condition?: string; // Only run if this JS expression evaluates to true
}

interface ChainResult {
  step: number;
  tool: string;
  success: boolean;
  duration: number;
  output: any;
}

// Variable store for chain execution
const chainVars: Map<string, any> = new Map();

export const chainExecutorTool: ToolDefinition = {
  name: 'chain_executor',
  description: `Execute a sequence of tool calls as an autonomous pipeline. Each step's output can be stored in a variable and used by later steps. Supports conditional execution.
  
  This is the "deep work" engine — the agent can build and execute complex multi-step workflows autonomously:
  
  Example chain:
  1. web_search → store result as "searchResults"
  2. web_scraper (using URL from searchResults) → store as "pageContent"  
  3. workspace_write_file (save pageContent to file)
  4. desktop_notification ("Research complete!")
  
  Variables from previous steps are accessible via {{varName}} in args.`,
  category: 'automation',
  inputSchema: z.object({
    action: z.enum(['execute', 'get_vars', 'clear_vars']),
    chain: z.array(z.object({
      tool: z.string().describe('Tool name to call'),
      args: z.string().describe('JSON object string of arguments for the tool'),
      outputVar: z.string().optional().describe('Variable name to store output'),
      condition: z.string().optional().describe('JS condition: only run if evaluates to true (e.g., "steps[0].success === true")')
    })).optional().describe('Array of steps to execute (for execute action)'),
    stopOnError: z.boolean().optional().default(true).describe('Stop the chain if any step fails')
  }),
  outputSchema: z.object({
    success: z.boolean(), message: z.string(),
    results: z.array(z.any()).optional(),
    totalDuration: z.number().optional()
  }),
  execute: async (input: any, context: any) => {
    if (input.action === 'get_vars') {
      const vars: Record<string, any> = {};
      for (const [k, v] of Array.from(chainVars.entries())) {
        vars[k] = typeof v === 'string' ? v.substring(0, 200) : v;
      }
      return { success: true, message: `${chainVars.size} chain variables`, data: vars };
    }
    
    if (input.action === 'clear_vars') {
      chainVars.clear();
      return { success: true, message: 'Chain variables cleared' };
    }

    if (!input.chain || input.chain.length === 0) {
      return { success: false, message: 'chain array is required with at least one step' };
    }

    console.log(`[ChainExecutor] Starting autonomous chain: ${input.chain.length} steps`);
    const startTime = Date.now();
    const results: ChainResult[] = [];
    let allSuccess = true;

    // Dynamic import of tool registry
    const { globalToolRegistry } = await import('../registry');

    for (let i = 0; i < input.chain.length; i++) {
      const step = input.chain[i];

      // Check condition
      if (step.condition) {
        try {
          const conditionResult = new Function('steps', 'vars', `return ${step.condition}`)(results, Object.fromEntries(chainVars));
          if (!conditionResult) {
            console.log(`[ChainExecutor] Step ${i + 1} skipped (condition false)`);
            results.push({ step: i + 1, tool: step.tool, success: true, duration: 0, output: 'SKIPPED (condition)' });
            continue;
          }
        } catch { /* If condition eval fails, run the step anyway */ }
      }

      // Resolve variable references in args
      const stepArgs = parseJsonObject(step.args);
      if (!stepArgs) {
        throw new Error(`Step ${i + 1} args must be a JSON object string`);
      }
      const resolvedArgs = resolveVars(stepArgs, chainVars);

      console.log(`[ChainExecutor] Step ${i + 1}/${input.chain.length}: ${step.tool}`);
      const stepStart = Date.now();

      try {
        const tool = globalToolRegistry.getTool(step.tool);
        if (!tool) {
          throw new Error(`Tool "${step.tool}" not found in registry`);
        }

        const output = await tool.execute(resolvedArgs, {});
        const duration = Date.now() - stepStart;

        // Store output in variable if requested
        if (step.outputVar) {
          chainVars.set(step.outputVar, output);
        }

        results.push({ step: i + 1, tool: step.tool, success: true, duration, output: summarizeOutput(output) });
        console.log(`[ChainExecutor] Step ${i + 1} completed in ${duration}ms`);
      } catch (err: any) {
        const duration = Date.now() - stepStart;
        results.push({ step: i + 1, tool: step.tool, success: false, duration, output: err.message });
        allSuccess = false;

        // Log error for self-improvement
        globalMemoryManager.logError('chain_executor', `Step ${i + 1} (${step.tool}) failed: ${err.message}`, 'autonomous_chain');

        if (input.stopOnError) {
          console.log(`[ChainExecutor] Chain stopped at step ${i + 1} (stopOnError=true)`);
          break;
        }
      }
    }

    const totalDuration = Date.now() - startTime;
    const successCount = results.filter(r => r.success).length;

    return {
      success: allSuccess,
      message: `Chain completed: ${successCount}/${results.length} steps succeeded in ${totalDuration}ms`,
      results,
      totalDuration
    };
  }
};

function resolveVars(args: Record<string, any>, vars: Map<string, any>): Record<string, any> {
  const resolved: Record<string, any> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      resolved[key] = value.replace(/\{\{(\w+)\}\}/g, (_, varName) => {
        const v = vars.get(varName);
        if (v === undefined) return `{{${varName}}}`;
        return typeof v === 'string' ? v : JSON.stringify(v);
      });
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

function summarizeOutput(output: any): any {
  if (typeof output === 'string') return output.substring(0, 500);
  if (typeof output === 'object') {
    const str = JSON.stringify(output);
    if (str.length > 1000) return str.substring(0, 1000) + '... (truncated)';
    return output;
  }
  return output;
}

function parseJsonObject(value: Record<string, any> | string | undefined): Record<string, any> | null {
  if (!value) return {};
  if (typeof value !== 'string') {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
