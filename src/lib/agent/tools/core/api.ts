import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { redactUrlForLog, safeAxiosRequest } from '../shared/url_safety';
import { requireOutboundApproval } from '../communication/outbound_approval';

const API_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const apiCallerTool: ToolDefinition = {
  name: 'api_caller',
  description: 'Call an external HTTP API. Use GET for read-only lookups; POST, PUT, PATCH, and DELETE require explicit outbound approval. Prefer connector_mcp for a saved connector and gateway_bridge for messaging channels.',
  category: 'core',
  inputSchema: z.object({
    url: z.string().url().describe('The full URL of the API endpoint'),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).default('GET').describe('HTTP method'),
    headers: z.string().optional().describe('Optional JSON object string of HTTP headers, e.g. {"Authorization":"Bearer ..."}'),
    body: z.string().optional().describe('Optional request body. Prefer a JSON string for structured payloads.')
  }),
  outputSchema: z.object({
    status: z.number(),
    data: z.any(),
    error: z.string().optional()
  }),
  execute: async (input: { url: string, method: string, headers?: Record<string, string> | string, body?: any }, context?: any) => {
    console.log(`[Tool: api_caller] Requesting ${input.method} ${redactUrlForLog(input.url)}`);
    try {
      const method = String(input.method || 'GET').toUpperCase();
      if (API_WRITE_METHODS.has(method)) {
        const approval = await requireOutboundApproval(
          'External API',
          method,
          input,
          context,
          input.url,
          `${method} ${redactUrlForLog(input.url)}`,
        );
        if (approval) return { status: 0, data: null, error: approval.status };
      }
      const headers = parseStringRecord(input.headers);
      const body = parseJsonValue(input.body);
      const response = await safeAxiosRequest({
        method: method as any,
        url: input.url,
        headers,
        data: body,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024,
      }, context);
      return { status: response.status, data: response.data };
    } catch (error: any) {
      return { 
        status: error.response?.status || 500, 
        data: error.response?.data || null,
        error: error.message 
      };
    }
  }
};

function parseStringRecord(value: Record<string, string> | string | undefined): Record<string, string> {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const normalized: Record<string, string> = {};
    for (const [key, recordValue] of Object.entries(parsed)) {
      normalized[key] = String(recordValue);
    }
    return normalized;
  } catch {
    return {};
  }
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
