import { ToolDefinition } from '../schemas';

export function normalizeRegistryToolName(name: string): string {
  const value = String(name || '').trim();
  if (value === 'system_shell') return 'workspace_run_command';
  if (value === 'read_file') return 'workspace_read_file';
  if (value === 'search_text') return 'workspace_search_text';
  if (value === 'find_files') return 'workspace_find_files';
  if (value === 'apply_patch') return 'workspace_apply_patch';
  if (value === 'shell_command') return 'system_shell';
  return value;
}

class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  /**
   * Register a new tool with the agent OS.
   */
  public registerTool(tool: ToolDefinition) {
    if (this.tools.has(tool.name)) {
      console.warn(`Tool ${tool.name} is already registered. Overwriting.`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Register multiple tools without removing existing entries.
   */
  public registerTools(tools: ToolDefinition[]) {
    tools.forEach(t => this.registerTool(t));
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
   * Generates the Function Declaration schemas for Gemini API.
   * This maps our custom Zod schema to Gemini's expected JSON Schema format.
   * Note: A robust implementation would use zod-to-json-schema.
   */
  public getGeminiFunctionDeclarations() {
    return this.getAllTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      // We will integrate zod-to-json-schema mapping here
      // parameters: zodToJsonSchema(tool.inputSchema) 
    }));
  }
}

export const globalToolRegistry = new ToolRegistry();
