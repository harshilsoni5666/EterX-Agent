import { z } from 'zod';
import { ToolDefinition } from '../../schemas';

export const jsonTransformTool: ToolDefinition = {
  name: 'json_yaml_transform',
  description: 'Parse, query, transform, merge, diff, flatten, and convert between JSON and YAML. Use this for structured data manipulation, config file processing, API response parsing, and data extraction with JSONPath-like queries.',
  category: 'core',
  inputSchema: z.object({
    operation: z.enum([
      'parse', 'stringify', 'query', 'merge', 'diff', 'flatten',
      'unflatten', 'json_to_yaml', 'yaml_to_json', 'validate', 'keys', 'values', 'pick', 'omit'
    ]).describe('The transformation operation to perform'),
    data: z.string().describe('The JSON or YAML string to process'),
    secondaryData: z.string().optional().describe('Second dataset for merge/diff operations'),
    queryPath: z.string().optional().describe('Dot-notation path to query (e.g., "users.0.name", "config.database.host")')
  }),
  outputSchema: z.object({
    result: z.any(),
    error: z.string().optional()
  }),
  execute: async (input: { operation: string, data: string, secondaryData?: string, queryPath?: string }) => {
    console.log(`[Tool: json_yaml_transform] Operation: ${input.operation}`);

    try {
      let parsed: any;

      // Try parsing as JSON first, then YAML-like (simple key:value)
      try {
        parsed = JSON.parse(input.data);
      } catch {
        // Basic YAML-like parsing for simple configs
        const lines = input.data.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
        const obj: any = {};
        for (const line of lines) {
          const colonIdx = line.indexOf(':');
          if (colonIdx > 0) {
            const key = line.substring(0, colonIdx).trim();
            let value: any = line.substring(colonIdx + 1).trim();
            // Auto-type casting
            if (value === 'true') value = true;
            else if (value === 'false') value = false;
            else if (value === 'null') value = null;
            else if (!isNaN(Number(value)) && value !== '') value = Number(value);
            else if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
            obj[key] = value;
          }
        }
        parsed = obj;
      }

      switch (input.operation) {
        case 'parse':
          return { result: parsed };

        case 'stringify':
          return { result: JSON.stringify(parsed, null, 2) };

        case 'query': {
          if (!input.queryPath) return { result: null, error: 'queryPath is required for query operation' };
          const parts = input.queryPath.split('.');
          let current = parsed;
          for (const part of parts) {
            if (current == null) break;
            current = current[part] ?? current[parseInt(part)];
          }
          return { result: current ?? null };
        }

        case 'merge': {
          if (!input.secondaryData) return { result: null, error: 'secondaryData required for merge' };
          const second = JSON.parse(input.secondaryData);
          const merged = deepMerge(parsed, second);
          return { result: merged };
        }

        case 'diff': {
          if (!input.secondaryData) return { result: null, error: 'secondaryData required for diff' };
          const second = JSON.parse(input.secondaryData);
          const diffs = deepDiff(parsed, second);
          return { result: diffs };
        }

        case 'flatten': {
          const flat = flattenObject(parsed);
          return { result: flat };
        }

        case 'unflatten': {
          const unflat = unflattenObject(parsed);
          return { result: unflat };
        }

        case 'json_to_yaml': {
          const yaml = jsonToYaml(parsed);
          return { result: yaml };
        }

        case 'yaml_to_json': {
          return { result: JSON.stringify(parsed, null, 2) };
        }

        case 'validate': {
          return { result: { valid: true, type: typeof parsed, isArray: Array.isArray(parsed), keys: typeof parsed === 'object' ? Object.keys(parsed || {}).length : 0 } };
        }

        case 'keys':
          return { result: typeof parsed === 'object' ? Object.keys(parsed || {}) : [] };

        case 'values':
          return { result: typeof parsed === 'object' ? Object.values(parsed || {}) : [] };

        case 'pick': {
          if (!input.queryPath) return { result: null, error: 'queryPath required (comma-separated keys)' };
          const pickKeys = input.queryPath.split(',').map(k => k.trim());
          const picked: any = {};
          for (const k of pickKeys) {
            if (parsed[k] !== undefined) picked[k] = parsed[k];
          }
          return { result: picked };
        }

        case 'omit': {
          if (!input.queryPath) return { result: null, error: 'queryPath required (comma-separated keys to omit)' };
          const omitKeys = input.queryPath.split(',').map(k => k.trim());
          const omitted = { ...parsed };
          for (const k of omitKeys) delete omitted[k];
          return { result: omitted };
        }

        default:
          return { result: null, error: `Unknown operation: ${input.operation}` };
      }
    } catch (error: any) {
      return { result: null, error: `Transform failed: ${error.message}` };
    }
  }
};

// --- Helper functions ---

function flattenObject(obj: any, prefix = ''): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key in obj) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      Object.assign(result, flattenObject(obj[key], fullKey));
    } else {
      result[fullKey] = obj[key];
    }
  }
  return result;
}

function unflattenObject(obj: any): any {
  const result: any = {};
  for (const key in obj) {
    const parts = key.split('.');
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {};
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = obj[key];
  }
  return result;
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key in source) {
    if (typeof source[key] === 'object' && source[key] !== null && typeof result[key] === 'object') {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function deepDiff(obj1: any, obj2: any, path = ''): any[] {
  const diffs: any[] = [];
  const allKeys = new Set([...Object.keys(obj1 || {}), ...Object.keys(obj2 || {})]);
  
  for (const key of allKeys) {
    const fullPath = path ? `${path}.${key}` : key;
    if (!(key in (obj1 || {}))) {
      diffs.push({ path: fullPath, type: 'added', newValue: obj2[key] });
    } else if (!(key in (obj2 || {}))) {
      diffs.push({ path: fullPath, type: 'removed', oldValue: obj1[key] });
    } else if (typeof obj1[key] === 'object' && typeof obj2[key] === 'object') {
      diffs.push(...deepDiff(obj1[key], obj2[key], fullPath));
    } else if (obj1[key] !== obj2[key]) {
      diffs.push({ path: fullPath, type: 'changed', oldValue: obj1[key], newValue: obj2[key] });
    }
  }
  return diffs;
}

function jsonToYaml(obj: any, indent = 0): string {
  const pad = '  '.repeat(indent);
  let yaml = '';
  
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (typeof item === 'object' && item !== null) {
        yaml += `${pad}- \n${jsonToYaml(item, indent + 1)}`;
      } else {
        yaml += `${pad}- ${item}\n`;
      }
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const key in obj) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        yaml += `${pad}${key}:\n${jsonToYaml(obj[key], indent + 1)}`;
      } else {
        yaml += `${pad}${key}: ${obj[key]}\n`;
      }
    }
  }
  return yaml;
}
