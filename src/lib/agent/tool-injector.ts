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
import * as path from 'path';
import * as fs from 'fs-extra';
import { z } from 'zod';
import { normalizeRegistryToolArgs, validateRegistryToolArgs } from './tools/tool-args';
import { enforceToolCapability } from './tools/security/tool_policy';
import { createToolExecutionContext, isToolCancellationError } from './cancellation';

async function findFilesRecursively(dir: string, maxFiles = 500): Promise<string[]> {
  const results: string[] = [];
  const queue = [dir];
  while (queue.length > 0 && results.length < maxFiles) {
    const current = queue.shift()!;
    try {
      const stats = await fs.stat(current);
      if (stats.isDirectory()) {
        const children = await fs.readdir(current);
        for (const child of children) {
          if (child === 'node_modules' || child === '.git' || child === '.next') continue;
          queue.push(path.join(current, child));
        }
      } else {
        results.push(current);
      }
    } catch {}
  }
  return results;
}

function getLevenshteinDistance(a: string, b: string): number {
  const tmp: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    tmp[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    tmp[0][j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      tmp[i][j] = Math.min(
        tmp[i - 1][j] + 1,
        tmp[i][j - 1] + 1,
        tmp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return tmp[a.length][b.length];
}

export async function selfHealPath(wrongPath: string, workspaceRoot: string): Promise<string | null> {
  const base = path.basename(wrongPath);
  const files = await findFilesRecursively(workspaceRoot);
  
  let bestMatch: string | null = null;
  let minDistance = Infinity;

  for (const file of files) {
    const fileBase = path.basename(file);
    if (fileBase.toLowerCase() === base.toLowerCase()) {
      return file;
    }
    const dist = getLevenshteinDistance(fileBase.toLowerCase(), base.toLowerCase());
    if (dist < minDistance && dist <= 3) {
      minDistance = dist;
      bestMatch = file;
    }
  }
  return bestMatch;
}

function extractPathKeysAndValues(args: any): { key: string; value: string }[] {
  if (!args || typeof args !== 'object') return [];
  const found: { key: string; value: string }[] = [];
  for (const [key, val] of Object.entries(args)) {
    if (typeof val === 'string') {
      const keyLower = key.toLowerCase();
      if (
        keyLower.includes('path') ||
        keyLower.includes('file') ||
        keyLower.includes('name') ||
        val.includes('/') ||
        val.includes('\\') ||
        /\.[a-zA-Z0-9]{2,4}$/.test(val)
      ) {
        found.push({ key, value: val });
      }
    }
  }
  return found;
}

function repairMalformedJson(str: string): string | null {
  let s = str.trim();
  const jsonBlockMatch = s.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch) {
    s = jsonBlockMatch[1].trim();
  }
  s = s.replace(/[\u201c\u201d]/g, '"');
  s = s.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
  try {
    JSON.parse(s);
    return s;
  } catch {
    return s;
  }
}

export async function runWithSelfHealing(
  toolName: string,
  executeFn: (args: any, context: any) => Promise<any>,
  args: any,
  context: any
): Promise<any> {
  try {
    return await executeFn(args, context);
  } catch (err: any) {
    const errStr = String(err.message || err.code || '').toLowerCase();
    if (errStr.includes('enoent') || errStr.includes('no such file') || errStr.includes('does not exist') || errStr.includes('not found')) {
      const workspaceRoot = context?.workspacePath || process.cwd();
      const paths = extractPathKeysAndValues(args);
      
      let healedAny = false;
      const newArgs = { ...args };

      for (const entry of paths) {
        const healed = await selfHealPath(entry.value, workspaceRoot);
        if (healed && healed !== entry.value) {
          newArgs[entry.key] = healed;
          healedAny = true;
          console.log(`[SelfHealing] Auto-repaired parameter "${entry.key}" for tool "${toolName}": "${entry.value}" -> "${healed}"`);
        }
      }

      if (healedAny) {
        console.log(`[SelfHealing] Retrying tool "${toolName}" after auto-healing.`);
        return await executeFn(newArgs, context);
      }
    }

    if (errStr.includes('json') && errStr.includes('parse')) {
      let healedAny = false;
      const newArgs = { ...args };
      for (const [key, val] of Object.entries(args)) {
        if (typeof val === 'string') {
          const cleaned = repairMalformedJson(val);
          if (cleaned && cleaned !== val) {
            newArgs[key] = cleaned;
            healedAny = true;
            console.log(`[SelfHealing] Auto-repaired malformed JSON in parameter "${key}" for tool "${toolName}"`);
          }
        }
      }

      if (healedAny) {
        console.log(`[SelfHealing] Retrying tool "${toolName}" after JSON correction.`);
        return await executeFn(newArgs, context);
      }
    }

    throw err;
  }
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
    execute: tool.execute ? async (args: any, context: any) => {
      return await runWithSelfHealing(tool.name, tool.execute!, args, context);
    } : undefined,
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
              const result = await runWithSelfHealing(stepToolName, realTool.execute, validation.args, toolExec.context);
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

export const agentToolLoadTool: ToolDefinition = {
  name: 'agent_tool_load',
  description: 'Dynamically load an additional tool from the global registry into the active execution context to gain capabilities (e.g. workspace_write_file, web_search, run_command).',
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
