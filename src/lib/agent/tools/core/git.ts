import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

export const gitTool: ToolDefinition = {
  name: 'git_operations',
  description: 'Execute Git operations: clone, init, add, commit, push, pull, branch, checkout, diff, log, status, merge, stash. Use this for version control, code management, and DevOps workflows.',
  category: 'core',
  inputSchema: z.object({
    operation: z.enum([
      'clone', 'init', 'status', 'add', 'commit', 'push', 'pull',
      'branch', 'checkout', 'diff', 'log', 'merge', 'stash', 'remote', 'reset', 'tag'
    ]).describe('The git operation to perform'),
    args: z.string().optional().describe('Arguments for the git command (e.g., repo URL for clone, branch name for checkout, commit message for commit)'),
    repoPath: z.string().optional().describe('Relative path to the repo inside workspace. Defaults to workspace root.')
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number()
  }),
  execute: async (input: { operation: string, args?: string, repoPath?: string }) => {
    const workspaceRoot = path.resolve(process.cwd(), '.workspaces', 'temp');
    const repoDir = input.repoPath ? path.resolve(workspaceRoot, input.repoPath) : workspaceRoot;

    let command = '';

    switch (input.operation) {
      case 'clone':
        command = `git clone ${input.args || ''} "${repoDir}"`;
        break;
      case 'init':
        command = `git init`;
        break;
      case 'status':
        command = `git status --short`;
        break;
      case 'add':
        command = `git add ${input.args || '.'}`;
        break;
      case 'commit':
        command = `git commit -m "${(input.args || 'auto-commit').replace(/"/g, '\\"')}"`;
        break;
      case 'push':
        command = `git push ${input.args || ''}`;
        break;
      case 'pull':
        command = `git pull ${input.args || ''}`;
        break;
      case 'branch':
        command = `git branch ${input.args || '-a'}`;
        break;
      case 'checkout':
        command = `git checkout ${input.args || ''}`;
        break;
      case 'diff':
        command = `git diff ${input.args || ''} --stat`;
        break;
      case 'log':
        command = `git log --oneline -20 ${input.args || ''}`;
        break;
      case 'merge':
        command = `git merge ${input.args || ''}`;
        break;
      case 'stash':
        command = `git stash ${input.args || ''}`;
        break;
      case 'remote':
        command = `git remote -v ${input.args || ''}`;
        break;
      case 'reset':
        command = `git reset ${input.args || '--hard HEAD'}`;
        break;
      case 'tag':
        command = `git tag ${input.args || '-l'}`;
        break;
      default:
        return { stdout: '', stderr: `Unknown git operation: ${input.operation}`, exitCode: 1 };
    }

    console.log(`[Tool: git_operations] Running: ${command} in ${repoDir}`);

    try {
      const { stdout, stderr } = await execAsync(command, { cwd: repoDir });
      return { stdout: stdout.substring(0, 8000), stderr: stderr.substring(0, 2000), exitCode: 0 };
    } catch (error: any) {
      return {
        stdout: (error.stdout || '').substring(0, 5000),
        stderr: (error.stderr || error.message).substring(0, 5000),
        exitCode: error.code || 1
      };
    }
  }
};
