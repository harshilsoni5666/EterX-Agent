import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import * as vm from 'vm';
import { enforceToolCapability } from '../security/tool_policy';

const BLOCKED_JS_PATTERNS = [
  /\brequire\s*\(/,
  /\bprocess\b/,
  /\bimport\s*\(/,
  /\bmodule\b/,
  /\bexports\b/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bBuffer\b/,
  /\bcrypto\b/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /constructor\s*\.\s*constructor/,
  /\bsetTimeout\s*\(/,
  /\bsetInterval\s*\(/,
];

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`JavaScript execution exceeded ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function serializeResult(value: any): any {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return value.slice(0, 10000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.parse(JSON.stringify(value)).slice?.(0, 10000) ?? JSON.parse(JSON.stringify(value));
  } catch {
    return String(value).slice(0, 10000);
  }
}

export const jsRunnerTool: ToolDefinition = {
  name: 'code_execution_js',
  description: 'Execute modern JavaScript code in a sandboxed V8 execution context. Use this for data transformations, custom logic, or iterating on code snippets.',
  category: 'core',
  inputSchema: z.object({
    code: z.string().describe('The JavaScript code block to execute. Must return a value or set a variable named `result`')
  }),
  outputSchema: z.object({
    result: z.any(),
    logs: z.array(z.string()),
    error: z.string().optional()
  }),
  execute: async (input: { code: string }, context?: any) => {
    console.log(`[Tool: code_execution_js] Running code snippet...`);
    const policy = enforceToolCapability('code_execution_js', input, context);
    if (!policy.allowed) {
      return { result: null, logs: [], error: policy.reason || 'Dynamic JavaScript execution is not allowed in this context' };
    }

    for (const pattern of BLOCKED_JS_PATTERNS) {
      if (pattern.test(input.code)) {
        return { result: null, logs: [], error: 'Code uses blocked runtime APIs. This runner only supports pure JavaScript data transformation.' };
      }
    }

    const logs: string[] = [];

    // Restricted data-transform sandbox. vm is not a full security boundary, so host APIs are not exposed.
    const sandbox = {
      console: {
        log: (...args: any[]) => logs.push(args.map(String).join(' ').slice(0, 1000)),
        error: (...args: any[]) => logs.push(('ERROR: ' + args.map(String).join(' ')).slice(0, 1000)),
        warn: (...args: any[]) => logs.push(('WARN: ' + args.map(String).join(' ')).slice(0, 1000)),
      },
      Math,
      JSON,
      Date,
      RegExp,
      URL,
      URLSearchParams,
      Intl,
      result: undefined
    };

    try {
      vm.createContext(sandbox);
      const script = new vm.Script(`
        (async () => {
          ${ input.code }
        })();
      `);

      const executionResult = script.runInContext(sandbox, { timeout: 1000 });

      let finalResult = await withTimeout(Promise.resolve(executionResult), 3000);

      // Prefer the explicitly set `result` variable if available
      if (sandbox.result !== undefined) {
        finalResult = sandbox.result;
      }

      return { result: serializeResult(finalResult), logs: logs.slice(-50) };
    } catch (error: any) {
      return { result: null, logs, error: error.message };
    }
  }
};
