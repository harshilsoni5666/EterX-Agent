import { z } from 'zod';
import fs from 'fs-extra';
import path from 'path';
import { ToolDefinition } from '../../schemas';
import { globalToolRegistry } from '../registry';
import { normalizeRegistryToolName } from '../registry';
import {
  AgentBuilderCustomTool,
  AgentBuilderDirectTool,
  AgentBuilderImplementationType,
  getAgentBuilderProfilePath,
  getAgentBuilderToolPath,
  isAgentBuilderRuntimeContext,
  isBuilderOnlyToolName,
  readAgentBuilderProfile,
  sanitizeAgentBuilderId,
  sanitizeAgentToolName,
  upsertAgentBuilderProfile,
  validateAgentScopedCode,
  writeAgentBuilderProfile,
  CUSTOM_AGENT_RUNTIME,
  loadCustomAgentProfile,
  AgentFlowProfile,
  AgentFlowStep,
  readAgentFlowProfile,
  writeAgentFlowProfile,
  listAgentFlowProfiles,
  deleteAgentFlowProfile,
  sanitizeFlowId,
  applyAgentBuilderDefaults,
  evaluateAgentBuilderProfile,
} from '../../builder-agent';
import * as vm from 'vm';
import { agentToolLoadTool, agentToolUnloadTool } from '../../tool-injector';

const requireBuilderContext = (context: any, argsAgentId?: string) => {
  if (!isAgentBuilderRuntimeContext(context)) {
    return {
      ok: false as const,
      error: 'This tool is only available inside Agent Builder runtime.',
      agentId: sanitizeAgentBuilderId(argsAgentId || 'unknown-agent'),
    };
  }
  return {
    ok: true as const,
    agentId: sanitizeAgentBuilderId(argsAgentId || context?.agentId || context?.projectId || 'unknown-agent'),
  };
};

const uniqueStrings = (values: unknown[] = []) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
};

const parseObject = (value: unknown): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

export const agentBuilderSaveProfileTool: ToolDefinition = {
  name: 'agent_builder_save_profile',
  description: 'Save or update the target custom agent profile. Builder-only. Stores the professional system prompt, mission, behavior rules, safety rules, skills, and completion criteria under the target agent only.',
  category: 'automation',
  inputSchema: z.object({
    agentId: z.string().optional().describe('Target custom agent ID. Defaults to the current Agent Builder target.'),
    name: z.string().optional().describe('Human-readable agent name.'),
    mission: z.string().describe('Clear mission for the target agent.'),
    professionalPrompt: z.string().describe('Complete professional system prompt for the target agent.'),
    responseStyle: z.string().optional().describe('Target agent response style.'),
    behaviorRules: z.array(z.string()).optional().describe('Specific operating rules for the target agent.'),
    safetyRules: z.array(z.string()).optional().describe('Specific safety and scope rules for the target agent.'),
    skills: z.array(z.string()).optional().describe('Skill IDs or capability labels to attach conceptually.'),
    toolUsePolicy: z.string().optional().describe('When and how the target agent should use tools.'),
    completionCriteria: z.string().optional().describe('How the target agent knows it is done.'),
    notes: z.array(z.string()).optional().describe('Builder notes for future revisions.'),
  }),
  outputSchema: z.object({ success: z.boolean(), profilePath: z.string().optional(), message: z.string(), profile: z.any().optional() }),
  execute: async (args: any, context: any) => {
    const runtime = requireBuilderContext(context, args.agentId);
    if (!runtime.ok) return { success: false, message: runtime.error };

    const saved = await upsertAgentBuilderProfile(runtime.agentId, profile => applyAgentBuilderDefaults({
      ...profile,
      name: args.name || profile.name || String(context?.agentName || '').trim() || undefined,
      mission: args.mission || profile.mission,
      professionalPrompt: args.professionalPrompt || profile.professionalPrompt,
      responseStyle: args.responseStyle || profile.responseStyle,
      behaviorRules: uniqueStrings([...(profile.behaviorRules || []), ...(args.behaviorRules || [])]),
      safetyRules: uniqueStrings([...(profile.safetyRules || []), ...(args.safetyRules || [])]),
      skills: uniqueStrings([...(profile.skills || []), ...(args.skills || [])]),
      toolUsePolicy: args.toolUsePolicy || profile.toolUsePolicy,
      completionCriteria: args.completionCriteria || profile.completionCriteria,
      notes: uniqueStrings([...(profile.notes || []), ...(args.notes || [])]),
      status: 'draft',
    }));

    return {
      success: true,
      message: `Saved builder profile for ${runtime.agentId}.`,
      profilePath: saved.path,
      profile: saved.profile,
    };
  },
};

export const agentBuilderAttachMainTool: ToolDefinition = {
  name: 'agent_builder_attach_main_tool',
  description: 'Attach an existing main-agent tool to the target custom agent by reference. Builder-only. This grants direct tool access in the agent profile without creating duplicate code.',
  category: 'automation',
  inputSchema: z.object({
    agentId: z.string().optional().describe('Target custom agent ID. Defaults to the current Agent Builder target.'),
    toolName: z.string().describe('Existing main tool name to attach, for example web_search or workspace_read_file.'),
    purpose: z.string().describe('Why this target agent needs the tool.'),
    whenToUse: z.string().describe('Precise trigger conditions for using this tool.'),
    inputPolicy: z.string().optional().describe('How the target agent should prepare inputs for the tool.'),
    outputPolicy: z.string().optional().describe('How the target agent should validate and use outputs from the tool.'),
    promptInjection: z.string().optional().describe('Tool-specific prompt guidance injected into the target agent profile.'),
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string(), profilePath: z.string().optional(), attachedTool: z.any().optional() }),
  execute: async (args: any, context: any) => {
    const runtime = requireBuilderContext(context, args.agentId);
    if (!runtime.ok) return { success: false, message: runtime.error };

    const toolName = normalizeRegistryToolName(String(args.toolName || '').trim());
    if (!toolName) return { success: false, message: 'toolName is required.' };
    if (isBuilderOnlyToolName(toolName)) {
      return { success: false, message: `Cannot attach "${toolName}" as a target-agent main tool.` };
    }
    if (!globalToolRegistry.getTool(toolName)) {
      return { success: false, message: `Main tool "${toolName}" was not found in the registry.` };
    }

    const attachedTool: AgentBuilderDirectTool = {
      toolName,
      purpose: String(args.purpose || '').trim(),
      whenToUse: String(args.whenToUse || '').trim(),
      inputPolicy: args.inputPolicy ? String(args.inputPolicy) : undefined,
      outputPolicy: args.outputPolicy ? String(args.outputPolicy) : undefined,
      promptInjection: args.promptInjection ? String(args.promptInjection) : undefined,
      attachedAt: new Date().toISOString(),
    };

    const saved = await upsertAgentBuilderProfile(runtime.agentId, profile => ({
      ...profile,
      directMainTools: [
        ...profile.directMainTools.filter(tool => tool.toolName !== toolName),
        attachedTool,
      ],
      status: 'draft',
    }));

    return {
      success: true,
      message: `Attached main tool "${toolName}" to ${runtime.agentId} by reference.`,
      profilePath: saved.path,
      attachedTool,
    };
  },
};

export const agentBuilderAttachAllMainToolsTool: ToolDefinition = {
  name: 'agent_builder_attach_all_main_tools',
  description: 'Attach the complete current main-agent tool catalog to the target custom agent in one operation. Builder-only. Builder orchestration tools remain excluded.',
  category: 'automation',
  inputSchema: z.object({
    agentId: z.string().optional().describe('Target custom agent ID. Defaults to the current Agent Builder target.'),
    excludeToolNames: z.array(z.string()).optional().describe('Optional main tool names to leave out of the complete catalog.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    attachedCount: z.number().optional(),
    skippedToolNames: z.array(z.string()).optional(),
  }),
  execute: async (args: any, context: any) => {
    const runtime = requireBuilderContext(context, args.agentId);
    if (!runtime.ok) return { success: false, message: runtime.error };

    const excluded = new Set((Array.isArray(args.excludeToolNames) ? args.excludeToolNames : []).map((name: unknown) => String(name || '').trim()));
    const availableTools = globalToolRegistry.getAllTools()
      .filter(tool => !isBuilderOnlyToolName(tool.name))
      .filter(tool => !excluded.has(tool.name));
    const availableNames = new Set(availableTools.map(tool => tool.name));
    const skippedToolNames = Array.from(excluded).map(String).filter(name => name.length > 0 && !availableNames.has(name));

    const saved = await upsertAgentBuilderProfile(runtime.agentId, profile => {
      const existing = new Map(profile.directMainTools.map(tool => [tool.toolName, tool]));
      for (const tool of availableTools) {
        if (existing.has(tool.name)) continue;
        existing.set(tool.name, {
          toolName: tool.name,
          purpose: `Use ${tool.name} when it is relevant to the agent's mission.`,
          whenToUse: `Use when the user's request requires the capability provided by ${tool.name}.`,
          inputPolicy: 'Validate arguments against the tool schema before calling.',
          outputPolicy: 'Inspect the result, handle errors, and only then continue.',
          attachedAt: new Date().toISOString(),
        });
      }
      return { ...profile, directMainTools: Array.from(existing.values()), status: 'draft' };
    });

    return {
      success: true,
      message: `Attached ${saved.profile.directMainTools.length} main tools to ${runtime.agentId}.`,
      attachedCount: saved.profile.directMainTools.length,
      skippedToolNames,
    };
  },
};

export const agentBuilderAttachConnectorToolsTool: ToolDefinition = {
  name: 'agent_builder_attach_connector_tools',
  description: 'Attach the universal live connector bridges to the target custom agent. This grants Gateway channel access through gateway_bridge and saved REST/MCP access through connector_mcp, without copying connector implementation code or secrets into the agent profile.',
  category: 'automation',
  inputSchema: z.object({
    agentId: z.string().optional().describe('Target custom agent ID. Defaults to the current Agent Builder target.'),
    mode: z.enum(['all', 'gateway', 'mcp']).optional().describe('Attach both connector paths, only native Gateway channels, or only saved REST/MCP connectors. Defaults to all.'),
    connectorId: z.string().optional().describe('Optional connector ID to mention in the target guidance. The credential itself is never stored in the profile.'),
    platform: z.string().optional().describe('Optional native platform to mention in the target guidance, such as telegram or slack.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    attachedToolNames: z.array(z.string()).optional(),
    profilePath: z.string().optional(),
  }),
  execute: async (args: any, context: any) => {
    const runtime = requireBuilderContext(context, args.agentId);
    if (!runtime.ok) return { success: false, message: runtime.error };

    const mode = String(args.mode || 'all');
    const toolNames = mode === 'gateway'
      ? ['gateway_bridge']
      : mode === 'mcp'
        ? ['connector_mcp']
        : ['gateway_bridge', 'connector_mcp'];
    const missing = toolNames.filter(toolName => !globalToolRegistry.getTool(toolName));
    if (missing.length > 0) {
      return { success: false, message: `Connector tools are not registered: ${missing.join(', ')}.` };
    }

    const scope = [args.platform ? `platform=${String(args.platform).trim()}` : '', args.connectorId ? `connector_id=${String(args.connectorId).trim()}` : '']
      .filter(Boolean)
      .join(', ');
    const saved = await upsertAgentBuilderProfile(runtime.agentId, profile => {
      const existing = new Map(profile.directMainTools.map(tool => [tool.toolName, tool]));
      for (const toolName of toolNames) {
        const isGateway = toolName === 'gateway_bridge';
        existing.set(toolName, {
          toolName,
          purpose: isGateway
            ? `Operate live native Gateway channels${scope ? ` (${scope})` : ''}.`
            : `Operate saved REST and MCP connectors${scope ? ` (${scope})` : ''}.`,
          whenToUse: isGateway
            ? 'First discover live Gateway channels, then use the explicit platform, conversation, and message identifiers for the requested action.'
            : 'First list or verify the named connector or MCP server, discover its live tools, then call the exact connector or server action required by the request.',
          inputPolicy: isGateway
            ? 'Keep platform, conversation_id, target, and action explicit. Never invent a connected channel.'
            : 'Keep connector_id, server_id, tool_name, method, and path explicit. Never put secrets in visible notes or responses.',
          outputPolicy: 'Treat the connector result as authoritative evidence. If the runtime returns an error, report the actual failure and recover with a bounded alternative; never claim success without the result.',
          promptInjection: 'This is a real external integration. Execute directly when the user requested the action. Do not ask for routine permission or connector discovery; only stop for a genuinely missing secret, required outbound approval, or an irreducible user decision.',
          attachedAt: new Date().toISOString(),
        });
      }
      return { ...profile, directMainTools: Array.from(existing.values()), status: 'draft' };
    });

    return {
      success: true,
      message: `Attached live connector bridge${toolNames.length === 1 ? '' : 's'} to ${runtime.agentId}: ${toolNames.join(', ')}.`,
      attachedToolNames: toolNames,
      profilePath: saved.path,
    };
  },
};

export const agentBuilderDefineTool: ToolDefinition = {
  name: 'agent_builder_define_tool',
  description: 'Define or update an agent-scoped custom tool for the target custom agent. Builder-only. The spec is stored under that agent only and is not registered globally.',
  category: 'automation',
  inputSchema: z.object({
    agentId: z.string().optional().describe('Target custom agent ID. Defaults to the current Agent Builder target.'),
    toolName: z.string().describe('Agent-scoped tool name in snake_case.'),
    description: z.string().describe('What the custom tool does for this target agent.'),
    implementationType: z.enum(['prompt_macro', 'tool_chain', 'agent_scoped_code']).describe('Use prompt_macro first, tool_chain for existing tools, agent_scoped_code only when custom code is necessary.'),
    inputSchemaJson: z.string().optional().describe('JSON object describing expected input fields.'),
    behaviorPrompt: z.string().optional().describe('Prompt behavior for prompt_macro tools.'),
    toolChainJson: z.string().optional().describe('JSON array of {tool,purpose,argsTemplate} for tool_chain tools.'),
    code: z.string().optional().describe('Code draft for agent_scoped_code tools. Stored only under this agent after safety review.'),
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string(), toolPath: z.string().optional(), tool: z.any().optional(), safetyNotes: z.array(z.string()).optional() }),
  execute: async (args: any, context: any) => {
    const runtime = requireBuilderContext(context, args.agentId);
    if (!runtime.ok) return { success: false, message: runtime.error };

    const toolName = sanitizeAgentToolName(args.toolName);
    const implementationType = args.implementationType as AgentBuilderImplementationType;
    const inputSchema = parseObject(args.inputSchemaJson);

    let toolChain: AgentBuilderCustomTool['toolChain'];
    if (args.toolChainJson) {
      try {
        const parsed = JSON.parse(String(args.toolChainJson));
        if (!Array.isArray(parsed)) return { success: false, message: 'toolChainJson must be a JSON array.' };
        toolChain = parsed.map((step: any) => ({
          tool: String(step.tool || '').trim(),
          purpose: String(step.purpose || '').trim(),
          argsTemplate: parseObject(step.argsTemplate),
        }));
        for (const step of toolChain) {
          if (!globalToolRegistry.getTool(step.tool)) {
            return { success: false, message: `Tool-chain step "${step.tool}" does not exist.` };
          }
          if (isBuilderOnlyToolName(step.tool)) {
            return { success: false, message: `Tool-chain step "${step.tool}" is not allowed for target agents.` };
          }
        }
      } catch {
        return { success: false, message: 'toolChainJson is invalid JSON.' };
      }
    }

    const safety = implementationType === 'agent_scoped_code'
      ? validateAgentScopedCode(args.code || '')
      : { allowed: true, notes: [] as string[] };

    const now = new Date().toISOString();
    const customTool: AgentBuilderCustomTool = {
      toolName,
      description: String(args.description || '').trim(),
      implementationType,
      inputSchema,
      behaviorPrompt: args.behaviorPrompt ? String(args.behaviorPrompt) : undefined,
      toolChain,
      code: implementationType === 'agent_scoped_code' ? String(args.code || '') : undefined,
      safetyStatus: safety.allowed ? 'safe' : 'blocked',
      safetyNotes: safety.notes,
      createdAt: now,
      updatedAt: now,
    };

    if (!customTool.description) return { success: false, message: 'description is required.' };
    if (implementationType === 'prompt_macro' && !customTool.behaviorPrompt) {
      return { success: false, message: 'behaviorPrompt is required for prompt_macro tools.' };
    }
    if (implementationType === 'tool_chain' && (!toolChain || toolChain.length === 0)) {
      return { success: false, message: 'toolChainJson with at least one step is required for tool_chain tools.' };
    }
    if (implementationType === 'agent_scoped_code' && !safety.allowed) {
      return {
        success: false,
        message: 'Agent-scoped code was blocked by safety review.',
        safetyNotes: safety.notes,
      };
    }

    const toolPath = getAgentBuilderToolPath(runtime.agentId, toolName);
    await fs.ensureDir(path.dirname(toolPath));
    await fs.writeJson(toolPath, customTool, { spaces: 2 });

    await upsertAgentBuilderProfile(runtime.agentId, profile => ({
      ...profile,
      customTools: [
        ...profile.customTools.filter(tool => tool.toolName !== toolName),
        customTool,
      ],
      status: 'draft',
    }));

    return {
      success: true,
      message: `Saved agent-scoped tool "${toolName}" for ${runtime.agentId}.`,
      toolPath,
      tool: customTool,
      safetyNotes: safety.notes,
    };
  },
};

export const agentBuilderFinalizeTool: ToolDefinition = {
  name: 'agent_builder_finalize',
  description: 'Validate and finalize the target custom agent profile. Builder-only. Marks the agent ready only when prompt, behavior, safety, and tool design are complete.',
  category: 'automation',
  inputSchema: z.object({
    agentId: z.string().optional().describe('Target custom agent ID. Defaults to the current Agent Builder target.'),
    readinessNotes: z.string().optional().describe('Short notes on what was finalized.'),
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string(), missing: z.array(z.string()).optional(), profilePath: z.string().optional(), promptPath: z.string().optional(), profile: z.any().optional() }),
  execute: async (args: any, context: any) => {
    const runtime = requireBuilderContext(context, args.agentId);
    if (!runtime.ok) return { success: false, message: runtime.error };

    const profile = applyAgentBuilderDefaults(await readAgentBuilderProfile(runtime.agentId));
    const missing: string[] = [];
    if (!profile.mission?.trim()) missing.push('mission');
    if (!profile.professionalPrompt?.trim() || profile.professionalPrompt.length < 600) missing.push('deep professional prompt');
    if (profile.behaviorRules.length < 3) missing.push('at least 3 behavior rules');
    if (profile.safetyRules.length < 2) missing.push('at least 2 safety rules');
    if (!profile.toolUsePolicy?.trim()) missing.push('tool use policy');
    if (!profile.completionCriteria?.trim()) missing.push('completion criteria');

    const quality = evaluateAgentBuilderProfile(profile);
    for (const failedCheck of quality.missing) {
      if (!missing.includes(failedCheck)) missing.push(failedCheck);
    }

    const blockedTools = profile.customTools.filter(tool => tool.safetyStatus === 'blocked').map(tool => tool.toolName);
    if (blockedTools.length > 0) missing.push(`unblocked custom tools: ${blockedTools.join(', ')}`);

    if (missing.length > 0) {
      return {
        success: false,
        message: `Agent ${runtime.agentId} is not ready yet.`,
        missing,
        profilePath: getAgentBuilderProfilePath(runtime.agentId),
        profile,
      };
    }

    const finalProfile = {
      ...profile,
      status: 'ready' as const,
      notes: uniqueStrings([
        ...profile.notes,
        args.readinessNotes ? String(args.readinessNotes) : `Finalized at ${new Date().toISOString()}`,
      ]),
    };
    const profilePath = await writeAgentBuilderProfile(finalProfile);
    const promptPath = path.join(path.dirname(profilePath), 'SYSTEM_PROMPT.md');
    await fs.writeFile(promptPath, finalProfile.professionalPrompt || '', 'utf8');

    return {
      success: true,
      message: `Agent ${runtime.agentId} is ready.`,
      profilePath,
      promptPath,
      profile: finalProfile,
    };
  },
};

export const agentBuilderRunQualityCheckTool: ToolDefinition = {
  name: 'agent_builder_run_quality_check',
  description: 'Run a deterministic enterprise readiness check on the target custom agent before finalization. Reports prompt depth, safety, baseline tool coverage, adaptive training, and real-data discipline without changing the profile.',
  category: 'automation',
  inputSchema: z.object({
    agentId: z.string().optional().describe('Target custom agent ID. Defaults to the current Agent Builder target.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    score: z.number(),
    ready: z.boolean(),
    trainingStandard: z.boolean(),
    checks: z.array(z.any()),
    missing: z.array(z.string()),
    warnings: z.array(z.string()),
    profile: z.any().optional(),
  }),
  execute: async (args: any, context: any) => {
    const runtime = requireBuilderContext(context, args.agentId);
    if (!runtime.ok) {
      return {
        success: false,
        score: 0,
        ready: false,
        trainingStandard: false,
        checks: [],
        missing: [runtime.error],
        warnings: [],
      };
    }
    const profile = applyAgentBuilderDefaults(await readAgentBuilderProfile(runtime.agentId));
    const quality = evaluateAgentBuilderProfile(profile);
    return { success: true, ...quality, profile };
  },
};


const flowBlackboards: Map<string, Record<string, any>> = new Map();

export function getFlowBlackboard(flowRunId: string): Record<string, any> {
  if (!flowBlackboards.has(flowRunId)) {
    flowBlackboards.set(flowRunId, {});
  }
  return flowBlackboards.get(flowRunId)!;
}

export function clearFlowBlackboard(flowRunId: string): void {
  flowBlackboards.delete(flowRunId);
}

export const agentFlowBlackboardSetTool: ToolDefinition = {
  name: 'agent_flow_blackboard_set',
  description: 'Set a key-value pair in the shared flow blackboard memory. Available only during flow execution.',
  category: 'automation',
  inputSchema: z.object({
    key: z.string().describe('The name of the state variable to set.'),
    value: z.any().describe('The value to set (can be a string, number, boolean, array, or object).')
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string() }),
  execute: async (args: any, context: any) => {
    const flowRunId = context?.flowRunId;
    if (!flowRunId) {
      return { success: false, message: 'Blackboard is only available during flow execution.' };
    }
    const bb = getFlowBlackboard(flowRunId);
    bb[args.key] = args.value;
    return { success: true, message: `Set blackboard key "${args.key}" successfully.` };
  }
};

export const agentFlowBlackboardGetTool: ToolDefinition = {
  name: 'agent_flow_blackboard_get',
  description: 'Retrieve a value from the shared flow blackboard memory. Available only during flow execution.',
  category: 'automation',
  inputSchema: z.object({
    key: z.string().describe('The state key to retrieve.')
  }),
  outputSchema: z.object({ success: z.boolean(), value: z.any(), found: z.boolean() }),
  execute: async (args: any, context: any) => {
    const flowRunId = context?.flowRunId;
    if (!flowRunId) {
      return { success: false, value: null, found: false };
    }
    const bb = getFlowBlackboard(flowRunId);
    const value = bb[args.key];
    return { success: true, value, found: value !== undefined };
  }
};

export const agentFlowBlackboardListTool: ToolDefinition = {
  name: 'agent_flow_blackboard_list',
  description: 'List all variables and values in the shared flow blackboard memory. Available only during flow execution.',
  category: 'automation',
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), blackboard: z.any() }),
  execute: async (args: any, context: any) => {
    const flowRunId = context?.flowRunId;
    if (!flowRunId) {
      return { success: false, blackboard: {} };
    }
    const bb = getFlowBlackboard(flowRunId);
    return { success: true, blackboard: { ...bb } };
  }
};

export const agentBuilderSaveFlowTool: ToolDefinition = {
  name: 'agent_builder_save_flow',
  description: 'Save or update a multi-agent flow profile. Allows orchestrating multiple steps, passing inputs, and establishing cyclic execution loops between agents.',
  category: 'automation',
  inputSchema: z.object({
    flowId: z.string().describe('Unique identifier for the multi-agent flow.'),
    name: z.string().optional().describe('Human-readable name of the flow.'),
    description: z.string().optional().describe('Clear purpose of this flow.'),
    steps: z.array(z.object({
      stepId: z.string().describe('Unique ID for this step, e.g. step1, review_step.'),
      agentId: z.string().describe('Custom agent ID or "default-1" for general agent to execute this step (ignored if parallelAgentIds is set).'),
      promptTemplate: z.string().describe('Prompt template. Use {{input}} or {{stepId.output}} for dynamic variables (ignored if promptTemplates is set).'),
      parallelAgentIds: z.array(z.string()).optional().describe('Array of agent IDs to run in parallel.'),
      promptTemplates: z.array(z.string()).optional().describe('Array of prompt templates corresponding to the parallel agents.'),
      reflection: z.object({
        evaluatorAgentId: z.string().describe('Agent to review/evaluate the step output.'),
        criteria: z.string().describe('Criteria prompt to check the output against.'),
        maxRetries: z.number().int().describe('Maximum number of self-correction loops to attempt.')
      }).optional().describe('Optional self-correction review configuration.'),
      nextStepId: z.string().optional().describe('Sequential next step ID if no condition is met.'),
      conditionalBranches: z.array(z.object({
        conditionExpression: z.string().describe('JS boolean condition, e.g. "output.includes(\'ERROR\')" or "iterationCount < 3".'),
        targetStepId: z.string().describe('The step ID to route to if this condition evaluates to true.')
      })).optional().describe('Array of conditional branches to check.')
    })).describe('Structured list of execution steps.'),
    maxIterations: z.number().int().optional().describe('Safety limit for total steps run in this flow to avoid infinite cycles (default 20).'),
    notes: z.array(z.string()).optional().describe('Builder notes.')
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string(), flowPath: z.string().optional(), flow: z.any().optional() }),
  execute: async (args: any, context: any) => {
    const runtime = requireBuilderContext(context, args.flowId);
    if (!runtime.ok) return { success: false, message: runtime.error };

    const flowId = sanitizeFlowId(args.flowId);
    const steps = Array.isArray(args.steps) ? args.steps : [];
    if (steps.length === 0) {
      return { success: false, message: 'A flow must contain at least one step.' };
    }
    if (steps.length > 100) {
      return { success: false, message: 'A flow cannot contain more than 100 steps.' };
    }

    const stepIds = new Set<string>();
    const validAgentId = (value: unknown) => {
      const id = String(value || '').trim();
      return id === 'default-1' || /^[a-zA-Z0-9_-]{1,96}$/.test(id);
    };
    for (const step of steps) {
      const stepId = String(step?.stepId || '').trim();
      if (!stepId || !/^[a-zA-Z0-9_-]{1,96}$/.test(stepId)) {
        return { success: false, message: 'Every flow step needs a safe stepId (letters, numbers, hyphens, or underscores).' };
      }
      if (stepIds.has(stepId)) {
        return { success: false, message: `Duplicate flow stepId: ${stepId}.` };
      }
      stepIds.add(stepId);

      const parallelAgentIds = Array.isArray(step.parallelAgentIds) ? step.parallelAgentIds : [];
      const promptTemplates = Array.isArray(step.promptTemplates) ? step.promptTemplates : [];
      if (parallelAgentIds.length > 0) {
        if (parallelAgentIds.length !== promptTemplates.length) {
          return { success: false, message: `Step ${stepId} must provide one promptTemplate for each parallel agent.` };
        }
        if (!parallelAgentIds.every(validAgentId)) {
          return { success: false, message: `Step ${stepId} contains an invalid parallel agent ID.` };
        }
      } else if (!validAgentId(step.agentId)) {
        return { success: false, message: `Step ${stepId} contains an invalid agent ID.` };
      } else if (!String(step.promptTemplate || '').trim()) {
        return { success: false, message: `Step ${stepId} needs a promptTemplate.` };
      }

      if (step.reflection) {
        const retries = Number(step.reflection.maxRetries);
        if (!validAgentId(step.reflection.evaluatorAgentId) || !Number.isInteger(retries) || retries < 0 || retries > 10) {
          return { success: false, message: `Step ${stepId} has an invalid reflection evaluator or retry limit.` };
        }
      }
    }

    for (const step of steps) {
      const references = [
        step.nextStepId,
        ...(Array.isArray(step.conditionalBranches) ? step.conditionalBranches.map((branch: any) => branch?.targetStepId) : []),
      ].filter(Boolean).map(String);
      const missing = references.find(reference => !stepIds.has(reference));
      if (missing) {
        return { success: false, message: `Step ${String(step.stepId)} references missing step ${missing}.` };
      }
    }

    const maxIterations = Number(args.maxIterations ?? 20);
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 1000) {
      return { success: false, message: 'maxIterations must be an integer between 1 and 1000.' };
    }

    const savedPath = await writeAgentFlowProfile({
      flowId,
      name: args.name,
      description: args.description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'ready',
      steps: args.steps,
      maxIterations,
      notes: args.notes || []
    });

    const flow = await readAgentFlowProfile(args.flowId);

    return {
      success: true,
      message: `Flow "${args.flowId}" saved successfully.`,
      flowPath: savedPath,
      flow
    };
  }
};

export const agentBuilderListFlowsTool: ToolDefinition = {
  name: 'agent_builder_list_flows',
  description: 'List all defined multi-agent flow profiles.',
  category: 'automation',
  inputSchema: z.object({}),
  outputSchema: z.object({ success: z.boolean(), flows: z.array(z.any()) }),
  execute: async () => {
    const flows = await listAgentFlowProfiles();
    return { success: true, flows };
  }
};

export const agentBuilderDeleteFlowTool: ToolDefinition = {
  name: 'agent_builder_delete_flow',
  description: 'Delete a multi-agent flow profile by ID.',
  category: 'automation',
  inputSchema: z.object({
    flowId: z.string().describe('ID of the flow to delete.')
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string() }),
  execute: async (args: any) => {
    const deleted = await deleteAgentFlowProfile(args.flowId);
    return {
      success: deleted,
      message: deleted ? `Flow "${args.flowId}" deleted successfully.` : `Flow "${args.flowId}" not found.`
    };
  }
};

function resolveTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z0-9_\.]+)\}\}/g, (_, key) => {
    return vars[key] || '';
  });
}

function evaluateCondition(expression: string, vars: Record<string, any>, flowRunId?: string): boolean {
  try {
    const blackboard = flowRunId ? getFlowBlackboard(flowRunId) : {};
    const sandbox = {
      ...vars,
      blackboard,
      output: vars.output || '',
      iterationCount: vars.iterationCount || 0
    };
    vm.createContext(sandbox);
    const script = new vm.Script(expression);
    return !!script.runInContext(sandbox, { timeout: 100 });
  } catch (err) {
    console.error(`[AgentFlow] Error evaluating condition "${expression}":`, err);
    return false;
  }
}

export const agentBuilderRunFlowTool: ToolDefinition = {
  name: 'agent_builder_run_flow',
  description: 'Execute a multi-agent loop/flow profile by stepping through the state machine.',
  category: 'automation',
  inputSchema: z.object({
    flowId: z.string().describe('ID of the flow profile to execute.'),
    input: z.string().describe('Initial input prompt to feed into the flow.')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    finalOutput: z.string(),
    message: z.string(),
    history: z.array(z.any()).optional(),
    error: z.string().optional()
  }),
  execute: async (args: { flowId: string, input: string }, context: any) => {
    const flowRunId = `flowrun-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const emitFlowTrace = (trace: Record<string, any>) => {
      try {
        context?._onTrace?.({ ...trace, flowId: args.flowId });
      } catch {
        // Timeline reporting must never interrupt execution of a workflow.
      }
    };
    try {
      const flow = await readAgentFlowProfile(args.flowId);
      if (flow.status !== 'ready' || !flow.steps || flow.steps.length === 0) {
        return { success: false, finalOutput: '', message: `Flow "${args.flowId}" is not ready to run.` };
      }

      const flowMode = typeof context?.selectedModelMode === 'string' ? context.selectedModelMode : 'think';
      const flowApiKey = String(context?.executionApiKey || '');
      const { createIsolatedClient } = await import('../../Agent');
      const createFlowClient = () => createIsolatedClient(flowApiKey, flowMode as any, context?.runtimeSettings);
      const resolveFlowAgent = async (agentId: string) => {
        if (agentId === 'default-1') return { profile: null, name: 'General agent' };
        const profile = await loadCustomAgentProfile(agentId);
        if (!profile) throw new Error(`Flow agent "${agentId}" is not ready or no longer exists.`);
        return { profile, name: profile.name || agentId };
      };

      // Initialize flow-scoped blackboard
      getFlowBlackboard(flowRunId);

      const variables: Record<string, string> = {
        input: args.input,
        output: '',
      };
      const stepIterationCounts: Record<string, number> = {};
      const history: any[] = [];

      let currentStepId: string | undefined = flow.steps[0].stepId;
      let totalStepsExecuted = 0;
      const maxIterations = flow.maxIterations || 20;

      while (currentStepId) {
        if (context?.abortSignal?.aborted || context?.signal?.aborted) {
          throw new Error('Flow cancelled by user.');
        }
        const stepId: string = currentStepId;
        const step: AgentFlowStep | undefined = flow.steps.find(s => s.stepId === stepId);
        if (!step) {
          throw new Error(`Flow step "${stepId}" was not found in profile.`);
        }

        // Cycle protection
        stepIterationCounts[stepId] = (stepIterationCounts[stepId] || 0) + 1;
        totalStepsExecuted++;
        if (totalStepsExecuted > maxIterations) {
          throw new Error(`Flow exceeded safety limit of ${maxIterations} total step executions (potential infinite loop).`);
        }

        // --- Option A: Parallel Execution ---
        if (step.parallelAgentIds && step.parallelAgentIds.length > 0) {
          const parallelAgentIds = step.parallelAgentIds;
          const parallelPrompts = step.promptTemplates || [];
          console.log(`[AgentFlow: ${args.flowId}] Running step "${stepId}" in parallel with agents: ${parallelAgentIds.join(' · ')} (iteration ${stepIterationCounts[stepId]})...`);

          const promises = parallelAgentIds.map(async (agentId, idx) => {
            const promptTemplate = parallelPrompts[idx] || step.promptTemplate;
            const resolvedPrompt = resolveTemplate(promptTemplate, variables);

            const { profile: customProfile, name: stepAgentName } = await resolveFlowAgent(agentId);
            emitFlowTrace({
              type: 'status',
              text: `Step ${stepId}: ${stepAgentName} is working in parallel`,
              agentName: stepAgentName,
            });
            const stepContext = {
              ...context,
              agentRuntime: agentId === 'default-1' ? undefined : CUSTOM_AGENT_RUNTIME,
              customAgentId: agentId === 'default-1' ? undefined : agentId,
              customAgentName: agentId === 'default-1' ? undefined : (customProfile?.name || agentId),
              _customAgentProfile: customProfile || undefined,
              flowId: args.flowId,
              flowRunId
            };

            const client = createFlowClient();
            const response = await client.executeMessageLoop(
              stepContext,
              resolvedPrompt,
              [],
              (trace: any) => emitFlowTrace({ ...trace, agentName: stepAgentName })
            );

            return { agentId, prompt: resolvedPrompt, output: response.text || '' };
          });

          const parallelResults = await Promise.all(promises);

          let combinedOutput = '';
          parallelResults.forEach((res, idx) => {
            variables[`${stepId}.${idx}.output`] = res.output;
            variables[`${stepId}.${res.agentId}.output`] = res.output;
            combinedOutput += `--- Agent: ${res.agentId} ---\n${res.output}\n\n`;
          });
          combinedOutput = combinedOutput.trim();
          variables[`${stepId}.output`] = combinedOutput;
          variables['output'] = combinedOutput;

          history.push({
            stepId,
            parallel: true,
            results: parallelResults.map(r => ({ agentId: r.agentId, prompt: r.prompt, output: r.output })),
            timestamp: Date.now()
          });

        // --- Option B: Reflection/Correction Loop ---
        } else if (step.reflection) {
          let attempts = 0;
          let currentOutput = '';
          const maxRetries = step.reflection.maxRetries || 3;
          let approved = false;
          let lastCritique = '';

          const basePrompt = resolveTemplate(step.promptTemplate, variables);
          let currentPrompt = basePrompt;

          while (attempts < maxRetries && !approved) {
            attempts++;

            if (attempts > 1) {
              currentPrompt = `${basePrompt}\n\n[SELF-CORRECTION CRITIQUE (Attempt ${attempts - 1}/${maxRetries})]\nThe evaluator rejected your previous output because: "${step.reflection.criteria}"\nEvaluator critique details:\n${lastCritique}\n\nPlease revise your output to address this feedback, and provide a corrected version.`;
            }

            const { profile: customProfile, name: stepAgentName } = await resolveFlowAgent(step.agentId);
            const stepContext = {
              ...context,
              agentRuntime: step.agentId === 'default-1' ? undefined : CUSTOM_AGENT_RUNTIME,
              customAgentId: step.agentId === 'default-1' ? undefined : step.agentId,
              customAgentName: step.agentId === 'default-1' ? undefined : (customProfile?.name || step.agentId),
              _customAgentProfile: customProfile || undefined,
              flowId: args.flowId,
              flowRunId
            };

            const client = createFlowClient();
            console.log(`[AgentFlow: ${args.flowId}] Running step "${stepId}" (attempt ${attempts}/${maxRetries}, iteration ${stepIterationCounts[stepId]})...`);
            emitFlowTrace({
              type: 'status',
              text: `Step ${stepId}: ${stepAgentName} is preparing attempt ${attempts}`,
              agentName: stepAgentName,
            });
            
            const response = await client.executeMessageLoop(
              stepContext,
              currentPrompt,
              [],
              (trace: any) => emitFlowTrace({ ...trace, agentName: stepAgentName })
            );
            currentOutput = response.text || '';

            // Run Evaluator Reflection
            console.log(`[AgentFlow: ${args.flowId}] Running evaluator "${step.reflection.evaluatorAgentId}" for critique against criteria: "${step.reflection.criteria}"...`);
            
            const { profile: evaluatorProfile, name: evaluatorName } = await resolveFlowAgent(step.reflection.evaluatorAgentId);
            emitFlowTrace({
              type: 'status',
              text: `Review gate: ${evaluatorName} is checking step ${stepId}`,
              agentName: evaluatorName,
            });
            const evalContext = {
              ...context,
              agentRuntime: step.reflection.evaluatorAgentId === 'default-1' ? undefined : CUSTOM_AGENT_RUNTIME,
              customAgentId: step.reflection.evaluatorAgentId === 'default-1' ? undefined : step.reflection.evaluatorAgentId,
              customAgentName: step.reflection.evaluatorAgentId === 'default-1' ? undefined : (evaluatorProfile?.name || step.reflection.evaluatorAgentId),
              _customAgentProfile: evaluatorProfile || undefined,
              flowId: args.flowId,
              flowRunId
            };

            const evalClient = createFlowClient();
            const evaluationPrompt = `
You are the EVALUATOR for flow step "${stepId}".
Evaluate the candidate output against these criteria: "${step.reflection.criteria}"

[CANDIDATE OUTPUT]
${currentOutput}

[INSTRUCTIONS]
Decide if the candidate output passes the criteria.
Return your decision starting with either [APPROVED] or [REJECTED].
Follow with a detailed explanation of why, and suggest specific corrections if rejected.
`.trim();

            const evalResponse = await evalClient.executeMessageLoop(
              evalContext,
              evaluationPrompt,
              [],
              (trace: any) => emitFlowTrace({ ...trace, agentName: evaluatorName })
            );

            const evalResult = evalResponse.text || '';
            lastCritique = evalResult;

            if (evalResult.toUpperCase().includes('[APPROVED]')) {
              approved = true;
              console.log(`[AgentFlow: ${args.flowId}] Reflection Approved!`);
            } else {
              console.log(`[AgentFlow: ${args.flowId}] Reflection Rejected: ${evalResult.substring(0, 100)}...`);
            }

            history.push({
              stepId,
              agentId: step.agentId,
              attempt: attempts,
              prompt: currentPrompt,
              output: currentOutput,
              evaluatorId: step.reflection.evaluatorAgentId,
              evaluation: evalResult,
              approved,
              timestamp: Date.now()
            });
          }

          variables[`${stepId}.output`] = currentOutput;
          variables['output'] = currentOutput;

        // --- Option C: Standard Single-Agent Step ---
        } else {
          const resolvedPrompt = resolveTemplate(step.promptTemplate, variables);
          const { profile: customProfile, name: stepAgentName } = await resolveFlowAgent(step.agentId);
          const stepContext = {
            ...context,
            agentRuntime: step.agentId === 'default-1' ? undefined : CUSTOM_AGENT_RUNTIME,
            customAgentId: step.agentId === 'default-1' ? undefined : step.agentId,
            customAgentName: step.agentId === 'default-1' ? undefined : (customProfile?.name || step.agentId),
            _customAgentProfile: customProfile || undefined,
            flowId: args.flowId,
            flowRunId
          };

          const client = createFlowClient();
          console.log(`[AgentFlow: ${args.flowId}] Running step "${stepId}" with Agent "${step.agentId}" (iteration ${stepIterationCounts[stepId]})...`);
          emitFlowTrace({
            type: 'status',
            text: `Step ${stepId}: ${stepAgentName} is working`,
            agentName: stepAgentName,
          });
          
          const response = await client.executeMessageLoop(
            stepContext,
            resolvedPrompt,
            [],
            (trace: any) => emitFlowTrace({ ...trace, agentName: stepAgentName })
          );

          const outputText = response.text || '';
          variables[`${stepId}.output`] = outputText;
          variables['output'] = outputText;

          history.push({
            stepId,
            agentId: step.agentId,
            prompt: resolvedPrompt,
            output: outputText,
            timestamp: Date.now()
          });
        }

        // Determine next step
        let routed = false;
        if (step.conditionalBranches && step.conditionalBranches.length > 0) {
          for (const branch of step.conditionalBranches) {
            const varsForCondition = {
              ...variables,
              iterationCount: stepIterationCounts[stepId],
              totalSteps: totalStepsExecuted
            };
            if (evaluateCondition(branch.conditionExpression, varsForCondition, flowRunId)) {
              currentStepId = branch.targetStepId;
              routed = true;
              console.log(`[AgentFlow: ${args.flowId}] Condition "${branch.conditionExpression}" passed. Routing to step "${branch.targetStepId}".`);
              break;
            }
          }
        }

        if (!routed) {
          currentStepId = step.nextStepId;
        }
      }

      return {
        success: true,
        finalOutput: variables['output'] || '',
        message: `Multi-agent flow "${args.flowId}" completed successfully.`,
        history
      };

    } catch (err: any) {
      console.error(`[AgentFlow: ${args.flowId}] Execution error:`, err);
      return {
        success: false,
        finalOutput: '',
        message: `Flow execution failed: ${err.message}`,
        error: err.message
      };
    } finally {
      clearFlowBlackboard(flowRunId);
    }
  }
};

export const agentBuilderTools = [
  agentBuilderSaveProfileTool,
  agentBuilderAttachMainTool,
  agentBuilderAttachAllMainToolsTool,
  agentBuilderAttachConnectorToolsTool,
  agentBuilderDefineTool,
  agentBuilderRunQualityCheckTool,
  agentBuilderFinalizeTool,
  agentBuilderSaveFlowTool,
  agentBuilderListFlowsTool,
  agentBuilderDeleteFlowTool,
  agentBuilderRunFlowTool,
  agentFlowBlackboardSetTool,
  agentFlowBlackboardGetTool,
  agentFlowBlackboardListTool,
  agentToolLoadTool,
  agentToolUnloadTool,
];
