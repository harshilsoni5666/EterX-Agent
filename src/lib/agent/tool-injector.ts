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
import type { AgentBuilderDirectTool, AgentBuilderCustomTool, AgentBuilderProfile } from './builder-agent';
import { isBuilderOnlyToolName } from './builder-agent';
import { normalizeRegistryToolArgs, validateRegistryToolArgs } from './tools/tool-args';
import { enforceToolCapability } from './tools/security/tool_policy';
import { createToolExecutionContext, isToolCancellationError } from './cancellation';

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
  const tool = globalToolRegistry.getTool(ref.toolName);
  if (!tool) return null;
  if (isBuilderOnlyToolName(ref.toolName)) return null;

  // Build prompt guidance from the attach metadata
  const lines: string[] = [
    `### Tool: ${ref.toolName}`,
    `**Purpose**: ${ref.purpose}`,
    `**When to use**: ${ref.whenToUse}`,
  ];
  if (ref.inputPolicy) lines.push(`**Input rules**: ${ref.inputPolicy}`);
  if (ref.outputPolicy) lines.push(`**Output rules**: ${ref.outputPolicy}`);
  if (ref.promptInjection) lines.push(`**Special instructions**: ${ref.promptInjection}`);

  return {
    name: tool.name,
    description: tool.description,
    declaration: {
      name: tool.name,
      description: tool.description.substring(0, 420),
      // We'll use the actual schema from the registry at runtime
    },
    promptGuidance: lines.join('\n'),
    execute: tool.execute,
  };
}

/**
 * Resolve a custom tool (prompt_macro / tool_chain) into a declaration.
 * agent_scoped_code tools are NOT executed — they generate prompt behavior only.
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
    if (schema.type && schema.properties && typeof schema.properties === 'object') {
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
            continue;
          }
          const stepArgs = step.argsTemplate ? { ...step.argsTemplate, ...args } : args;
          try {
            const normalizedArgs = normalizeRegistryToolArgs(stepToolName, stepArgs);
            const validation = validateRegistryToolArgs(realTool, normalizedArgs);
            if (!validation.success) {
              results.push({ tool: step.tool, error: validation.error });
              continue;
            }
            const capabilityDecision = enforceToolCapability(stepToolName, validation.args, context);
            if (!capabilityDecision.allowed) {
              results.push({ tool: step.tool, error: capabilityDecision.reason || `Tool ${stepToolName} is not allowed` });
              continue;
            }
            const toolExec = createToolExecutionContext(context);
            try {
              toolExec.throwIfCancelled();
              const result = await realTool.execute(validation.args, toolExec.context);
              toolExec.throwIfCancelled();
              results.push({ tool: step.tool, result });
            } finally {
              toolExec.dispose();
            }
          } catch (err: any) {
            if (isToolCancellationError(err)) {
              return { chainResults: results, cancelled: true, error: 'CANCELLED_BY_USER' };
            }
            results.push({ tool: step.tool, error: err.message });
          }
        }
        return { chainResults: results };
      },
    };
  }

  // agent_scoped_code — prompt-only, no execution
  return {
    name: custom.toolName,
    description: custom.description,
    declaration: {
      name: custom.toolName,
      description: custom.description.substring(0, 420),
    },
    promptGuidance: [
      `### Custom Tool: ${custom.toolName} (Agent-Scoped)`,
      `**Description**: ${custom.description}`,
      custom.behaviorPrompt ? `**Behavior**: ${custom.behaviorPrompt}` : '',
    ].filter(Boolean).join('\n'),
    execute: async () => ({
      success: false,
      type: 'agent_scoped_code',
      toolName: custom.toolName,
      error: 'This agent-scoped code tool is stored for the agent but is not executable until reviewed and promoted into a safe runtime adapter.',
    }),
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
  for (const ref of profile.directMainTools) {
    const resolved = resolveDirectTool(ref);
    if (resolved) {
      tools.push(resolved);
      promptParts.push(resolved.promptGuidance);
    }
  }

  // Resolve custom tools
  for (const custom of profile.customTools) {
    const resolved = resolveCustomTool(custom);
    if (resolved) {
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
