import { ToolDefinition } from '../schemas';
import { zodToJsonSchema } from 'zod-to-json-schema';

type RegisterOptions = {
  allowOverride?: boolean;
};

export function normalizeRegistryToolName(name: string): string {
  const value = String(name || '').trim();
  if (value === 'system_shell') return 'workspace_run_command';
  if (value === 'read_file') return 'workspace_read_file';
  if (value === 'search_text') return 'workspace_search_text';
  if (value === 'find_files') return 'workspace_find_files';
  if (value === 'apply_patch') return 'workspace_apply_patch';
  if (value === 'shell_command') return 'workspace_run_command';
  return value;
}

class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  /**
   * Register a new tool with the agent OS.
   */
  public registerTool(tool: ToolDefinition, options: RegisterOptions = {}) {
    const existing = this.tools.get(tool.name);
    if (existing && !options.allowOverride) {
      throw new Error(`Tool ${tool.name} is already registered. Refusing to overwrite without allowOverride.`);
    }
    if (existing && options.allowOverride) {
      console.warn(`Tool ${tool.name} is already registered. Overwriting.`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Register multiple tools without removing existing entries.
   */
  public registerTools(tools: ToolDefinition[], options: RegisterOptions = {}) {
    tools.forEach(t => this.registerTool(t, options));
  }

  /**
   * Replace the registry contents with an explicit tool set.
   * Use this only during bootstrap; runtime-created tools should append.
   */
  public replaceAllTools(tools: ToolDefinition[]) {
    this.tools.clear();
    tools.forEach(t => this.registerTool(t));
  }

  /**
   * Retrieve a tool definition by name.
   */
  public getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools, useful for passing context to the Planner.
   */
  public getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Generates Function Declaration schemas for Gemini/API tool calling.
   */
  public getGeminiFunctionDeclarations() {
    return this.getAllTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: toFunctionParameters(tool),
    }));
  }
}

export const globalToolRegistry = new ToolRegistry();

function toFunctionParameters(tool: ToolDefinition): Record<string, any> {
  try {
    const schema = zodToJsonSchema(tool.inputSchema as any, {
      $refStrategy: 'none',
      target: 'jsonSchema7',
    }) as Record<string, any>;
    return sanitizeJsonSchema(schema);
  } catch (error: any) {
    console.warn(`Failed to convert schema for tool ${tool.name}: ${error?.message || error}`);
    return { type: 'object', properties: {} };
  }
}

function sanitizeJsonSchema(value: any): any {
  if (Array.isArray(value)) return value.map(sanitizeJsonSchema);
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, any> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === '$schema' || key === 'definitions' || key === '$ref') continue;
    result[key] = sanitizeJsonSchema(raw);
  }
  return result;
}
