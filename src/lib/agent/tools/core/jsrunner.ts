import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import * as vm from 'vm';

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
  execute: async (input: { code: string }) => {
    console.log(`[Tool: code_execution_js] Running code snippet...`);
    const logs: string[] = [];

    // Create a sandbox environment matching full Node.js capabilities
    const sandbox = {
      console: {
        log: (...args: any[]) => logs.push(args.join(' ')),
        error: (...args: any[]) => logs.push('ERROR: ' + args.join(' ')),
        warn: (...args: any[]) => logs.push('WARN: ' + args.join(' ')),
      },
      fetch: global.fetch,
      crypto: require('crypto'),
      Buffer: Buffer,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      URL: URL,
      result: undefined
    };

    try {
      vm.createContext(sandbox);
      const script = new vm.Script(`
        (async () => {
          ${ input.code }
        })();
      `);

      const executionResult = script.runInContext(sandbox, { timeout: 5000 });

      // Wait for any promises to resolve if the snippet returned one
      let finalResult = await executionResult;

      // Prefer the explicitly set `result` variable if available
      if (sandbox.result !== undefined) {
        finalResult = sandbox.result;
      }

      return { result: finalResult, logs };
    } catch (error: any) {
      return { result: null, logs, error: error.message };
    }
  }
};
