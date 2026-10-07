import path from 'path';
import { getChatWorkspacePaths } from '../storage-paths';
import { getRuntimeWorkspaceRoot } from '../workspace/path_resolver';

export type PythonRuntime = {
  program: string | null;
  source: 'configured' | 'workspace' | 'eterx' | 'system' | 'unavailable';
  isolated: boolean;
  environmentRoot?: string;
  kind?: 'venv' | 'conda';
  managedRoot?: string;
  issue?: string;
};

const { createHostEnvironment, pythonEnvironmentRoot } = require('../../../../electron/host-environment') as {
  createHostEnvironment: (base?: NodeJS.ProcessEnv, overrides?: Partial<NodeJS.ProcessEnv>) => NodeJS.ProcessEnv;
  pythonEnvironmentRoot: (location: string) => string | null;
};
const { resolvePythonRuntime, applyWorkspaceEnvironment } = require('../../../../electron/python-runtime') as {
  resolvePythonRuntime: (options: { cwd: string; workspaceRoot: string; managedRoot?: string; env?: NodeJS.ProcessEnv }) => PythonRuntime;
  applyWorkspaceEnvironment: (env: NodeJS.ProcessEnv, options: { cwd: string; workspaceRoot: string; runtime: PythonRuntime; overrides?: Partial<NodeJS.ProcessEnv> }) => NodeJS.ProcessEnv;
};

export function getChatPythonRuntime(context?: any, cwd = getRuntimeWorkspaceRoot(context), env?: NodeJS.ProcessEnv): PythonRuntime {
  const chatId = String(context?.ownerChatId || context?.chatId || context?.projectId || '').trim();
  const managedRoot = chatId ? path.join(getChatWorkspacePaths(chatId, String(context?.userId || 'default')).base, 'runtime', 'python') : undefined;
  return resolvePythonRuntime({ cwd, workspaceRoot: getRuntimeWorkspaceRoot(context), managedRoot, env });
}

export function getChatCommandEnvironment(context: any, cwd: string, overrides?: Partial<NodeJS.ProcessEnv>) {
  const host = createHostEnvironment(process.env, overrides);
  const runtime = getChatPythonRuntime(context, cwd, host);
  return {
    runtime,
    env: applyWorkspaceEnvironment(host, { cwd, workspaceRoot: getRuntimeWorkspaceRoot(context), runtime, overrides }),
  };
}

/** An explicitly supplied executable keeps its own environment, even outside the chat. */
export function environmentForExplicitProgram(program: string, context: any, cwd: string, overrides?: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const root = pythonEnvironmentRoot(program);
  const host = createHostEnvironment(process.env, overrides);
  const runtime = resolvePythonRuntime({ cwd, workspaceRoot: getRuntimeWorkspaceRoot(context), env: { ...host, ETERX_PYTHON_PATH: program } });
  return applyWorkspaceEnvironment(host, {
    cwd, workspaceRoot: getRuntimeWorkspaceRoot(context),
    runtime: { ...runtime, environmentRoot: root || undefined }, overrides,
  });
}
