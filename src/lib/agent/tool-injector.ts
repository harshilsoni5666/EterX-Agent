/**
 * Tool Injector — Resolves tool references for custom-built agents
 * 
 * When a builder attaches a main tool via agent_builder_attach_main_tool,
 * this module resolves those references at runtime:
 * 1. Looks up the actual tool from globalToolRegistry
 * 2. Generates prompt guidance for the custom agent
 * 3. Returns the Gemini function declaration + prompt injection
 * 
 * Security: Only tools that pass shouldExposeToolToRuntime() are allowed.
 */
import { globalToolRegistry, normalizeRegistryToolName } from './tools/registry';
import { ToolDefinition } from './schemas';
import type { AgentBuilderDirectTool, AgentBuilderCustomTool, AgentBuilderProfile } from './builder-agent';
import { isBuilderOnlyToolName, validateAgentScopedCode } from './builder-agent';
import * as vm from 'vm';


import { z } from 'zod';
import { normalizeRegistryToolArgs, validateRegistryToolArgs } from './tools/tool-args';
import { enforceToolCapability } from './tools/security/tool_policy';
import { createToolExecutionContext, isToolCancellationError } from './cancellation';

/** Compatibility entry point: tools execute once with exactly the supplied paths
 * and content. Recovery decisions belong to the agent after reading the error. */
export async function runWithSelfHealing(
  _toolName: string,
  executeFn: (args: any, context: any) => Promise<any>,
  args: any,
  context: any,
): Promise<any> {
  return executeFn(args, context);
}
export interface ResolvedTool {
  name: string;
  description: string;
  /** Gemini-compatible function declaration */
  declaration: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  };
  /** Prompt text to inject into the agent's system prompt */
  promptGuidance: string;
  /** The actual execute function, if available */
  execute?: (args: any, context: any) => Promise<any>;
}

/**
 * Resolve a single direct main tool reference into a usable declaration + prompt.
 */
export function resolveDirectTool(ref: AgentBuilderDirectTool): ResolvedTool | null {
  const canonicalToolName = normalizeRegistryToolName(ref.toolName);
  const tool = globalToolRegistry.getTool(canonicalToolName);
  if (!tool) return null;
  if (isBuilderOnlyToolName(canonicalToolName)) return null;

  // Build prompt guidance from the attach metadata
  const lines: string[] = [
    `### Tool: ${canonicalToolName}`,
    `**Purpose**: ${ref.purpose}`,
    `**When to use**: ${ref.whenToUse}`,
  ];
  if (ref.inputPolicy) lines.push(`**Input rules**: ${ref.inputPolicy}`);
  if (ref.outputPolicy) lines.push(`**Output rules**: ${ref.outputPolicy}`);
  if (ref.promptInjection) lines.push(`**Special instructions**: ${ref.promptInjection}`);

  return {
    name: canonicalToolName,
    description: tool.description,
    declaration: {
      name: canonicalToolName,
      description: tool.description.substring(0, 420),
      // We'll use the actual schema from the registry at runtime
    },
    promptGuidance: lines.join('\n'),
    execute: tool.execute ? async (args: any, context: any) => {
      return await runWithSelfHealing(canonicalToolName, tool.execute!, args, context);
    } : undefined,
  };
}

/**
 * Resolve a custom tool into a provider declaration and an agent-scoped
 * executor. Code tools run only inside the restricted V8 context below.
 */
export function resolveCustomTool(custom: AgentBuilderCustomTool): ResolvedTool | null {
  if (custom.safetyStatus === 'blocked') return null;

  /**
   * Normalize inputSchema: the builder may store it as either:
   *   A) A full JSON Schema: {type:'object', properties:{...}}
   *   B) A raw properties map: {fieldName: {type:'string', ...}, ...}
   * We must return a full JSON Schema (A) for declarations.
   */
  const normalizeInputSchema = (schema: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!schema) return undefined;
    // Already a full schema with type+properties → use directly
    if (schema.type === 'object') {
      return schema;
    }
    // Raw properties map → wrap into a proper schema
    return { type: 'object', properties: schema };
  };

  if (custom.implementationType === 'prompt_macro') {
    return {
      name: custom.toolName,
      description: custom.description,
      declaration: {
        name: custom.toolName,
        description: custom.description.substring(0, 420),
        parameters: normalizeInputSchema(custom.inputSchema),
      },
      promptGuidance: [
        `### Custom Tool: ${custom.toolName}`,
        `**Behavior**: ${custom.behaviorPrompt || custom.description}`,
      ].join('\n'),
      execute: async (args: any) => ({
        success: true,
        type: 'prompt_macro',
        toolName: custom.toolName,
        guidance: custom.behaviorPrompt || custom.description,
        receivedInput: args || {},
      }),
    };
  }

  if (custom.implementationType === 'tool_chain') {
    const chainSteps = (custom.toolChain || []).map((step, i) =>
      `  ${i + 1}. Call \`${step.tool}\` — ${step.purpose}`
    ).join('\n');

    return {
      name: custom.toolName,
      description: custom.description,
      declaration: {
        name: custom.toolName,
        description: `${custom.description} (chain: ${(custom.toolChain || []).map(s => s.tool).join(' → ')})`.substring(0, 420),
        parameters: normalizeInputSchema(custom.inputSchema),
      },
      promptGuidance: [
        `### Custom Tool: ${custom.toolName} (Tool Chain)`,
        `**Steps**:`,
        chainSteps,
        `Execute these steps in sequence.`,
      ].join('\n'),
      // For tool_chain, we compose the execute function from existing tools
      execute: async (args: any, context: any) => {
        const results: any[] = [];
        for (const step of (custom.toolChain || [])) {
          const stepToolName = normalizeRegistryToolName(step.tool);
          const realTool = globalToolRegistry.getTool(stepToolName);
          if (!realTool?.execute) {
            results.push({ tool: step.tool, error: 'Tool not found' });
            return { success: false, chainResults: results, failedTool: step.tool };
          }
          const stepArgs = step.argsTemplate ? { ...step.argsTemplate, ...args } : args;
          try {
            const normalizedArgs = normalizeRegistryToolArgs(stepToolName, stepArgs);
            const validation = validateRegistryToolArgs(realTool, normalizedArgs);
            if (!validation.success) {
              results.push({ tool: step.tool, error: validation.error });
              return { success: false, chainResults: results, failedTool: step.tool };
            }
            const capabilityDecision = enforceToolCapability(stepToolName, validation.args, context);
            if (!capabilityDecision.allowed) {
              results.push({ tool: step.tool, error: capabilityDecision.reason || `Tool ${stepToolName} is not allowed` });
              return { success: false, chainResults: results, failedTool: step.tool };
            }
            const toolExec = createToolExecutionContext(context);
            try {
              toolExec.throwIfCancelled();
              const result = await runWithSelfHealing(stepToolName, realTool.execute, validation.args, toolExec.context);
              toolExec.throwIfCancelled();
              results.push({ tool: step.tool, result });
              if (result?.success === false || result?.cancelled || result?.error) {
                return { success: false, chainResults: results, failedTool: step.tool, cancelled: Boolean(result?.cancelled) };
              }
            } finally {
              toolExec.dispose();
            }
          } catch (err: any) {
            if (isToolCancellationError(err)) {
              return { success: false, chainResults: results, cancelled: true, error: 'CANCELLED_BY_USER' };
            }
            results.push({ tool: step.tool, error: err.message });
            return { success: false, chainResults: results, failedTool: step.tool };
          }
        }
        return { success: true, chainResults: results };
      },
    };
  }

  // agent_scoped_code — executable sandboxed JS tool
  return {
    name: custom.toolName,
    description: custom.description,
    declaration: {
      name: custom.toolName,
      description: custom.description.substring(0, 420),
      parameters: normalizeInputSchema(custom.inputSchema),
    },
    promptGuidance: [
      `### Custom Tool: ${custom.toolName} (Agent-Scoped Code)`,
      `**Description**: ${custom.description}`,
      custom.behaviorPrompt ? `**Behavior**: ${custom.behaviorPrompt}` : '',
    ].filter(Boolean).join('\n'),
    execute: async (args: any, context: any) => {
      if (context?.allowDynamicCode === false) {
        return { success: false, error: 'Dynamic code execution is disabled by security policy.' };
      }

      const safety = validateAgentScopedCode(custom.code || '');
      if (!safety.allowed) {
        return { success: false, error: `Blocked by safety review: ${safety.notes.join(', ')}` };
      }

      const logs: string[] = [];

      const callTool = async (name: string, toolArgs: any) => {
        name = normalizeRegistryToolName(name);
        const realTool = globalToolRegistry.getTool(name);
        if (!realTool?.execute) {
          throw new Error(`Tool "${name}" not found in registry.`);
        }

        const normalizedArgs = normalizeRegistryToolArgs(name, toolArgs || {});
        const validation = validateRegistryToolArgs(realTool, normalizedArgs);
        if (!validation.success) {
          throw new Error(`Invalid arguments for tool "${name}": ${validation.error}`);
        }

        const capabilityDecision = enforceToolCapability(name, validation.args, context);
        if (!capabilityDecision.allowed) {
          throw new Error(`Capability blocked for tool "${name}": ${capabilityDecision.reason || 'Permission denied'}`);
        }

        const toolExec = createToolExecutionContext(context);
        try {
          toolExec.throwIfCancelled();
          const result = await runWithSelfHealing(name, realTool.execute, validation.args, toolExec.context);
          toolExec.throwIfCancelled();
          return result;
        } finally {
          toolExec.dispose();
        }
      };

      const sandbox = {
        console: {
          log: (...m: any[]) => logs.push(m.map(String).join(' ')),
          error: (...m: any[]) => logs.push('ERROR: ' + m.map(String).join(' ')),
          warn: (...m: any[]) => logs.push('WARN: ' + m.map(String).join(' ')),
        },
        args: args || {},
        callTool,
        Math,
        JSON,
        Date,
        RegExp,
        URL,
        URLSearchParams,
        Intl,
        result: undefined as any,
      };

      try {
        vm.createContext(sandbox);
        const wrappedCode = `
          (async () => {
            ${custom.code || ''}
          })()
        `;
        const script = new vm.Script(wrappedCode);
        const promiseResult = script.runInContext(sandbox, { timeout: 5000 });
        let finalResult = await Promise.resolve(promiseResult);
        if (sandbox.result !== undefined) {
          finalResult = sandbox.result;
        }
        return { success: true, result: finalResult, logs };
      } catch (err: any) {
        return { success: false, error: err.message, logs };
      }
    },
  };
}

/**
 * Resolve ALL tools for an agent profile.
 * Returns resolved tools + combined prompt guidance.
 */
export function resolveAgentTools(profile: AgentBuilderProfile): {
  tools: ResolvedTool[];
  toolPrompt: string;
} {
  const tools: ResolvedTool[] = [];
  const promptParts: string[] = ['## Your Tools\n'];

  // Resolve direct main tools
  const seenToolNames = new Set<string>();
  for (const ref of profile.directMainTools) {
    const resolved = resolveDirectTool(ref);
    if (resolved && !seenToolNames.has(resolved.name)) {
      seenToolNames.add(resolved.name);
      tools.push(resolved);
      promptParts.push(resolved.promptGuidance);
    }
  }

  // Resolve custom tools
  for (const custom of profile.customTools) {
    const resolved = resolveCustomTool(custom);
    if (resolved && !seenToolNames.has(resolved.name)) {
      seenToolNames.add(resolved.name);
      tools.push(resolved);
      promptParts.push(resolved.promptGuidance);
    }
  }

  // Add tool use policy
  if (profile.toolUsePolicy) {
    promptParts.push(`\n## Tool Use Policy\n${profile.toolUsePolicy}`);
  }

  return { tools, toolPrompt: promptParts.join('\n\n') };
}

export const agentToolLoadTool: ToolDefinition = {
  name: 'agent_tool_load',
  description: 'Dynamically load an additional tool from the global registry into the active execution context to gain capabilities (e.g. workspace_run_command, workspace_edit_file, or web_search).',
  category: 'automation',
  inputSchema: z.object({
    toolName: z.string().describe('The name of the global tool to load.')
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string() }),
  execute: async (args: any, context: any) => {
    const runner = context?.agentRunner;
    if (!runner) {
      return { success: false, message: 'Dynamic tool loading is only supported during active custom agent executions.' };
    }
    const name = normalizeRegistryToolName(args.toolName);
    if (isBuilderOnlyToolName(name)) {
      return { success: false, message: `Tool "${name}" is reserved for Agent Builder and cannot be loaded by a finalized custom agent.` };
    }
    const tool = globalToolRegistry.getTool(name);
    if (!tool) {
      return { success: false, message: `Tool "${args.toolName}" was not found in the global registry.` };
    }
    if (runner.resolvedTools.some((t: any) => t.name === name)) {
      return { success: true, message: `Tool "${name}" is already loaded.` };
    }
    const resolved = resolveDirectTool({
      toolName: name,
      purpose: 'Dynamically loaded capability',
      whenToUse: 'On demand as requested by reasoning logic',
      attachedAt: new Date().toISOString()
    });
    if (!resolved) {
      return { success: false, message: `Failed to resolve tool "${name}".` };
    }
    runner.resolvedTools.push(resolved);
    return { success: true, message: `Tool "${name}" has been loaded successfully.` };
  }
};

export const agentToolUnloadTool: ToolDefinition = {
  name: 'agent_tool_unload',
  description: 'Dynamically unload a tool from the active execution context to optimize token context focus.',
  category: 'automation',
  inputSchema: z.object({
    toolName: z.string().describe('The name of the tool to unload.')
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string() }),
  execute: async (args: any, context: any) => {
    const runner = context?.agentRunner;
    if (!runner) {
      return { success: false, message: 'Dynamic tool unloading is only supported during active custom agent executions.' };
    }
    const name = normalizeRegistryToolName(args.toolName);
    const index = runner.resolvedTools.findIndex((t: any) => t.name === name);
    if (index === -1) {
      return { success: false, message: `Tool "${name}" is not currently loaded.` };
    }
    runner.resolvedTools.splice(index, 1);
    return { success: true, message: `Tool "${name}" has been unloaded successfully.` };
  }
};
