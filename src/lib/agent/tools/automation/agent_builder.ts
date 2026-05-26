import { z } from 'zod';
import fs from 'fs-extra';
import path from 'path';
import { ToolDefinition } from '../../schemas';
import { globalToolRegistry } from '../registry';
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
} from '../../builder-agent';

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

    const saved = await upsertAgentBuilderProfile(runtime.agentId, profile => ({
      ...profile,
      name: args.name || profile.name,
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

    const toolName = String(args.toolName || '').trim();
    if (!toolName) return { success: false, message: 'toolName is required.' };
    if (isBuilderOnlyToolName(toolName) || toolName === 'create_dynamic_tool') {
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
          if (isBuilderOnlyToolName(step.tool) || step.tool === 'create_dynamic_tool') {
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

    const profile = await readAgentBuilderProfile(runtime.agentId);
    const missing: string[] = [];
    if (!profile.mission?.trim()) missing.push('mission');
    if (!profile.professionalPrompt?.trim() || profile.professionalPrompt.length < 600) missing.push('deep professional prompt');
    if (profile.behaviorRules.length < 3) missing.push('at least 3 behavior rules');
    if (profile.safetyRules.length < 2) missing.push('at least 2 safety rules');
    if (!profile.toolUsePolicy?.trim()) missing.push('tool use policy');
    if (!profile.completionCriteria?.trim()) missing.push('completion criteria');

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

export const agentBuilderTools = [
  agentBuilderSaveProfileTool,
  agentBuilderAttachMainTool,
  agentBuilderDefineTool,
  agentBuilderFinalizeTool,
];
