import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';

/**
 * Local Database (JSON-backed Key-Value + Table Store)
 * 
 * Persistent structured data storage without external dependencies.
 * Think of it as a local SQLite alternative using JSON files.
 * Perfect for storing user data, configs, cache, and app state.
 */

const DB_DIR = path.resolve(process.cwd(), '.workspaces', '.database');

export const databaseTool: ToolDefinition = {
  name: 'local_database',
  description: `Persistent local database for structured data storage. Store, query, update, and delete records. Supports multiple tables/collections, filtering, sorting, and aggregation. No external dependencies.
  
  Use cases:
  - Store user contacts, bookmarks, notes
  - Cache API responses
  - Track project metrics over time
  - Store configurations and settings
  - Build data-driven apps`,
  category: 'core',
  inputSchema: z.object({
    action: z.enum(['create_table', 'insert', 'find', 'update', 'delete', 'count', 'list_tables', 'drop_table', 'aggregate'])
      .describe('Database operation'),
    table: z.string().optional().describe('Table/collection name'),
    data: z.string().optional().describe('Optional JSON string for record data or update payload'),
    filter: z.string().optional().describe('Optional JSON object string for filter conditions'),
    sort: z.string().optional().describe('Sort field (prefix with - for descending, e.g., "-createdAt")'),
    limit: z.number().optional().default(50).describe('Max records to return'),
    aggregation: z.enum(['count', 'sum', 'avg', 'min', 'max']).optional().describe('Aggregation operation'),
    aggregationField: z.string().optional().describe('Field to aggregate on')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    data: z.any().optional(),
    count: z.number().optional()
  }),
  execute: async (input: any) => {
    await fs.ensureDir(DB_DIR);
    const tablePath = input.table ? path.join(DB_DIR, `${input.table}.json`) : '';

    try {
      const parsedData = parseJsonValue(input.data);
      const parsedFilter = parseJsonObject(input.filter);

      switch (input.action) {
        case 'create_table': {
          if (!input.table) return { success: false, message: 'table name required' };
          if (await fs.pathExists(tablePath)) return { success: true, message: `Table "${input.table}" already exists` };
          await fs.writeJSON(tablePath, [], { spaces: 2 });
          return { success: true, message: `Table "${input.table}" created` };
        }

        case 'insert': {
          if (!input.table || parsedData == null) return { success: false, message: 'table and data required' };
          if (!isPlainObject(parsedData)) return { success: false, message: 'data must be a JSON object string' };
          const records = await loadTable(tablePath);
          const newRecord = {
            _id: `${Date.now()}_${Math.random().toString(36).substring(7)}`,
            ...parsedData,
            _createdAt: new Date().toISOString(),
            _updatedAt: new Date().toISOString()
          };
          records.push(newRecord);
          await saveTable(tablePath, records);
          return { success: true, message: `Inserted 1 record into "${input.table}"`, data: newRecord, count: records.length };
        }

        case 'find': {
          if (!input.table) return { success: false, message: 'table required' };
          let records = await loadTable(tablePath);
          
          // Apply filters
          if (parsedFilter) {
            records = records.filter((r: any) => matchesFilter(r, parsedFilter));
          }

          // Apply sort
          if (input.sort) {
            const desc = input.sort.startsWith('-');
            const field = desc ? input.sort.slice(1) : input.sort;
            records.sort((a: any, b: any) => {
              const va = a[field], vb = b[field];
              if (va < vb) return desc ? 1 : -1;
              if (va > vb) return desc ? -1 : 1;
              return 0;
            });
          }

          // Apply limit
          const limited = records.slice(0, input.limit || 50);
          return { success: true, message: `Found ${limited.length} records (${records.length} total)`, data: limited, count: records.length };
        }

        case 'update': {
          if (!input.table || !parsedFilter || parsedData == null) return { success: false, message: 'table, filter, and data required' };
          if (!isPlainObject(parsedData)) return { success: false, message: 'data must be a JSON object string' };
          const records = await loadTable(tablePath);
          let updated = 0;
          for (const record of records) {
            if (matchesFilter(record, parsedFilter)) {
              Object.assign(record, parsedData, { _updatedAt: new Date().toISOString() });
              updated++;
            }
          }
          await saveTable(tablePath, records);
          return { success: true, message: `Updated ${updated} records in "${input.table}"`, count: updated };
        }

        case 'delete': {
          if (!input.table || !parsedFilter) return { success: false, message: 'table and filter required' };
          const records = await loadTable(tablePath);
          const before = records.length;
          const remaining = records.filter((r: any) => !matchesFilter(r, parsedFilter));
          await saveTable(tablePath, remaining);
          return { success: true, message: `Deleted ${before - remaining.length} records from "${input.table}"`, count: before - remaining.length };
        }

        case 'count': {
          if (!input.table) return { success: false, message: 'table required' };
          let records = await loadTable(tablePath);
          if (parsedFilter) records = records.filter((r: any) => matchesFilter(r, parsedFilter));
          return { success: true, message: `${records.length} records`, count: records.length };
        }

        case 'list_tables': {
          const files = await fs.readdir(DB_DIR);
          const tables = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
          return { success: true, message: `${tables.length} tables`, data: tables };
        }

        case 'drop_table': {
          if (!input.table) return { success: false, message: 'table required' };
          if (await fs.pathExists(tablePath)) await fs.remove(tablePath);
          return { success: true, message: `Table "${input.table}" dropped` };
        }

        case 'aggregate': {
          if (!input.table || !input.aggregation || !input.aggregationField) {
            return { success: false, message: 'table, aggregation, and aggregationField required' };
          }
          let records = await loadTable(tablePath);
          if (parsedFilter) records = records.filter((r: any) => matchesFilter(r, parsedFilter));
          
          const values = records.map((r: any) => Number(r[input.aggregationField])).filter((v: number) => !isNaN(v));
          let result: number;
          
          switch (input.aggregation) {
            case 'count': result = values.length; break;
            case 'sum': result = values.reduce((a: number, b: number) => a + b, 0); break;
            case 'avg': result = values.length > 0 ? values.reduce((a: number, b: number) => a + b, 0) / values.length : 0; break;
            case 'min': result = Math.min(...values); break;
            case 'max': result = Math.max(...values); break;
            default: result = 0;
          }
          
          return { success: true, message: `${input.aggregation}(${input.aggregationField}) = ${result}`, data: result, count: values.length };
        }

        default:
          return { success: false, message: 'Unknown action' };
      }
    } catch (error: any) {
      return { success: false, message: `Database error: ${error.message}` };
    }
  }
};

async function loadTable(filePath: string): Promise<any[]> {
  if (!await fs.pathExists(filePath)) return [];
  return await fs.readJSON(filePath);
}

async function saveTable(filePath: string, records: any[]): Promise<void> {
  await fs.writeJSON(filePath, records, { spaces: 2 });
}

function matchesFilter(record: any, filter: Record<string, any>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (typeof value === 'object' && value !== null) {
      // Support operators: $gt, $lt, $gte, $lte, $ne, $contains, $startsWith
      for (const [op, opVal] of Object.entries(value as Record<string, any>)) {
        switch (op) {
          case '$gt': if (!(record[key] > opVal)) return false; break;
          case '$lt': if (!(record[key] < opVal)) return false; break;
          case '$gte': if (!(record[key] >= opVal)) return false; break;
          case '$lte': if (!(record[key] <= opVal)) return false; break;
          case '$ne': if (record[key] === opVal) return false; break;
          case '$contains': if (!String(record[key]).includes(String(opVal))) return false; break;
          case '$startsWith': if (!String(record[key]).startsWith(String(opVal))) return false; break;
        }
      }
    } else {
      if (record[key] !== value) return false;
    }
  }
  return true;
}

function parseJsonValue(value: any): any {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function parseJsonObject(value: any): Record<string, any> | undefined {
  const parsed = parseJsonValue(value);
  if (parsed == null) return undefined;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('filter must be a JSON object string');
  }
  return parsed as Record<string, any>;
}

function isPlainObject(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
