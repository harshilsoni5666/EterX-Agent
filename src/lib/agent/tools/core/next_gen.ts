import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { dynamicSkillEngine, toolCompositionEngine, workspaceIntelligence } from '../../engines';

/**
 * Dynamic Tool Creator — Runtime Tool Factory
 * 
 * Allows the agent to CREATE new tools at runtime.
 * When you encounter a repetitive pattern, create a reusable tool for it.
 */
export const dynamicToolCreatorTool: ToolDefinition = {
  name: 'create_dynamic_tool',
  description: `Create a new tool at runtime. Use this when you notice repetitive patterns that would benefit from a dedicated tool. The tool gets registered immediately and persists across sessions.

INPUT:
- name: Unique tool name (snake_case, e.g. "format_date", "fetch_stock_price")
- description: What the tool does
- inputFields: Array of {name, type, description, required}
- executionCode: JavaScript async code. Has access to: input (object), require, path, fs

EXAMPLE:
{
  name: "word_count",
  description: "Count words in text",
  inputFields: [{ name: "text", type: "string", description: "Text to count", required: true }],
  executionCode: "return { count: input.text.split(/\\s+/).length }"
}

The tool is immediately available after creation. Use it like any other tool.`,
  category: 'core',
  inputSchema: z.object({
    name: z.string().describe('Tool name (snake_case)'),
    description: z.string().describe('What the tool does'),
    inputFields: z.array(z.object({
      name: z.string(),
      type: z.enum(['string', 'number', 'boolean', 'array']),
      description: z.string(),
      required: z.boolean()
    })).describe('Tool input parameters'),
    executionCode: z.string().describe('JavaScript async function body. Access input via `input` object. Return result.'),
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string() }),
  execute: async (input: {
    name: string, description: string,
    inputFields: Array<{ name: string, type: string, description: string, required: boolean }>,
    executionCode: string
  }) => {
    console.log(`[Tool: create_dynamic_tool] Creating: ${ input.name }`);
    return await dynamicSkillEngine.createTool({
      name: input.name,
      description: input.description,
      category: 'dynamic',
      inputFields: input.inputFields,
      executionCode: input.executionCode,
      createdAt: Date.now(),
      createdBy: 'main_agent'
    });
  }
};

/**
 * Workspace Analyzer — Deep Project Intelligence
 * 
 * Analyzes the workspace to understand the project's framework, structure,
 * dependencies, and build system. Returns a comprehensive profile.
 */
export const workspaceAnalyzerTool: ToolDefinition = {
  name: 'workspace_analyze',
  description: `Deeply analyze the current workspace to understand the project. Returns: framework, language, package manager, build system, directory structure, key dependencies, and feature flags (TypeScript, Docker, CI, tests).

Use this:
- At the START of complex coding tasks to understand the project
- When you need to know what framework/language the project uses
- To understand the directory structure before creating files

The analysis is cached for 1 hour for performance.`,
  category: 'workspace',
  inputSchema: z.object({
    forceRefresh: z.boolean().optional().describe('Force re-analysis even if cache is valid')
  }),
  outputSchema: z.object({
    profile: z.any(),
    summary: z.string()
  }),
  execute: async (input: { forceRefresh?: boolean }) => {
    if (input.forceRefresh) {
      const profile = await workspaceIntelligence.analyze();
      const context = await workspaceIntelligence.getWorkspaceContext();
      return { profile, summary: context };
    }
    const profile = await workspaceIntelligence.getProfile();
    const context = await workspaceIntelligence.getWorkspaceContext();
    return { profile, summary: context };
  }
};

/**
 * Macro Runner — Execute Tool Chains
 * 
 * Run a sequence of tools in order, piping outputs between them.
 * Define the chain and this tool executes it step by step.
 */
export const macroRunnerTool: ToolDefinition = {
  name: 'run_macro',
  description: `Execute a chain of tools in sequence. Each step's output becomes available as context for the next step. Use this to automate multi-step workflows.

Define steps as an array:
- tool: Name of the tool to call
- args: Arguments for the tool
- outputKey: Key to store the result under (accessible in later steps)

Steps execute IN ORDER. If any step fails, the macro stops.

EXAMPLE: Research then write
{
  steps: [
    { tool: "web_search", args: { query: "latest AI news" }, outputKey: "research" },
    { tool: "workspace_write_file", args: { filename: "report.md", content: "{{research}}" }, outputKey: "file" }
  ]
}`,
  category: 'core',
  inputSchema: z.object({
    steps: z.array(z.object({
      tool: z.string().describe('Tool name to execute'),
      args: z.string().describe('JSON object string of tool arguments'),
      outputKey: z.string().describe('Key to store output under')
    })).describe('Ordered list of tool execution steps')
  }),
  outputSchema: z.object({ success: z.boolean(), results: z.any() }),
  execute: async (input: { steps: Array<{ tool: string, args: any, outputKey: string }> }) => {
    const { globalToolRegistry: reg } = require('../../tools/registry');
    const context: Record<string, any> = {};

    for (let i = 0; i < input.steps.length; i++) {
      const step = input.steps[i];
      const tool = reg.getTool(step.tool);
      if (!tool) {
        return { success: false, results: context, error: `Step ${ i + 1 }: Tool "${ step.tool }" not found` };
      }

      // Replace {{key}} placeholders in args with context values
      const rawArgs = parseJsonObject(step.args);
      if (!rawArgs) {
        return { success: false, results: context, error: `Step ${ i + 1 }: args must be a JSON object string` };
      }
      const resolvedArgs: any = {};
      for (const [key, value] of Object.entries(rawArgs)) {
        if (typeof value === 'string' && value.startsWith('{{') && value.endsWith('}}')) {
          const contextKey = value.slice(2, -2);
          resolvedArgs[key] = context[contextKey];
        } else {
          resolvedArgs[key] = value;
        }
      }

      console.log(`[MacroRunner] Step ${ i + 1 }/${ input.steps.length }: ${ step.tool }`);
      try {
        const result = await tool.execute(resolvedArgs, {});
        context[step.outputKey] = result;
      } catch (error: any) {
        return { success: false, results: context, error: `Step ${ i + 1 } (${ step.tool }) failed: ${ error.message }` };
      }
    }

    return { success: true, results: context };
  }
};

function parseJsonObject(value: any): Record<string, any> | null {
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
