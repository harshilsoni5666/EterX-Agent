import { ToolDefinition } from '../schemas';

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
   * Register multiple tools at once.
   */
  public registerTools(tools: ToolDefinition[]) {
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
