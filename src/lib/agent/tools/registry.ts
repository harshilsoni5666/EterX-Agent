import { ToolDefinition } from '../schemas';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { normalizeToolTraceName } from '../tool-trace';

type RegisterOptions = {
  allowOverride?: boolean;
};

export function normalizeRegistryToolName(name: string): string {
  return normalizeToolTraceName(name);
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
      description: tool.modelDescription || tool.description,
      parameters: toFunctionParameters(tool),
    }));
  }

  /** Return one portable declaration for deferred tool discovery. */
  public getFunctionDeclaration(name: string) {
    const tool = this.getTool(name);
    if (!tool) return undefined;
    return {
      name: tool.name,
      description: tool.modelDescription || tool.description,
      parameters: toFunctionParameters(tool),
    };
  }
}

export const globalToolRegistry = new ToolRegistry();

const inputSchemaCache = new WeakMap<object, Record<string, any>>();

/** Inline reused shapes before provider cleanup, especially files[].edits[]. */
export function getToolInputJsonSchema(tool: Pick<ToolDefinition, 'name' | 'inputSchema'>): Record<string, any> {
  const cached = inputSchemaCache.get(tool.inputSchema);
  if (cached) return cached;
  try {
    const schema = zodToJsonSchema(tool.inputSchema as any, {
      $refStrategy: 'none',
      target: 'jsonSchema7',
    }) as Record<string, any>;
    const portable = sanitizeJsonSchema(schema);
    inputSchemaCache.set(tool.inputSchema, portable);
    return portable;
  } catch (error: any) {
    console.warn(`Failed to convert schema for tool ${tool.name}: ${error?.message || error}`);
    throw new Error(`Cannot expose ${tool.name}: its argument schema could not be converted.`);
  }
}

function toFunctionParameters(tool: ToolDefinition): Record<string, any> {
  return getToolInputJsonSchema(tool);
}

/** Provider-unsupported constraints remain visible as compact field guidance. */
export function schemaUsageDescription(schema: any): string {
  const constraints = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
    'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format']
    .filter(key => schema?.[key] !== undefined)
    .map(key => `${key}=${JSON.stringify(schema[key])}`);
  return [String(schema?.description || '').replace(/\s+/g, ' ').trim(),
    constraints.length ? `Constraints: ${constraints.join(', ')}.` : ''].filter(Boolean).join(' ');
}

function sanitizeJsonSchema(value: any): any {
  if (Array.isArray(value)) return value.map(sanitizeJsonSchema);
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, any> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === '$ref') throw new Error(`Unresolved schema reference: ${String(raw)}`);
    if (key === '$schema' || key === 'definitions' || key === '$defs') continue;
    result[key] = sanitizeJsonSchema(raw);
  }
  return result;
}
