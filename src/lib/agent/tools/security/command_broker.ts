import { resolveWorkspaceDirectoryForContext } from '../../workspace/path_resolver';
import { getChatCommandEnvironment, type PythonRuntime } from '../../runtime/python-runtime';

export interface CommandBrokerDecision {
  allowed: boolean;
  reason?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  pythonRuntime?: PythonRuntime;
}

/** Bind execution to this chat and project, with explicit invocation overrides. */
export async function authorizeToolCommand(input: {
  command: string;
  cwd?: string;
  context?: any;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  network?: 'allow' | 'deny';
}): Promise<CommandBrokerDecision> {
  const cwd = resolveWorkspaceDirectoryForContext(input.cwd, input.context);
  const { env, runtime } = getChatCommandEnvironment(input.context, cwd, input.env);
  return { allowed: true, cwd, env, pythonRuntime: runtime };
}
