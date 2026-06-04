import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { resolveWorkspaceDirectoryForContext } from '../../workspace/path_resolver';

const execAsync = promisify(exec);

export const gitTool: ToolDefinition = {
  name: 'git_operations',
  description: 'Execute Git operations only when the user explicitly asks for source-control work. Prefer read-only operations such as status, diff, log, branch, and remote unless the user clearly requested a write operation.',
  category: 'core',
  inputSchema: z.object({
    operation: z.enum([
      'clone', 'init', 'status', 'add', 'commit', 'push', 'pull',
      'branch', 'checkout', 'diff', 'log', 'merge', 'stash', 'remote', 'reset', 'tag'
    ]).describe('The git operation to perform'),
    args: z.string().optional().describe('Arguments for the git command (e.g., repo URL for clone, branch name for checkout, commit message for commit)'),
    repoPath: z.string().optional().describe('Relative path to the repo inside workspace. Defaults to workspace root.'),
    confirmDestructive: z.boolean().optional().describe('Required for destructive reset operations such as --hard.')
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number()
  }),
  execute: async (input: { operation: string, args?: string, repoPath?: string, confirmDestructive?: boolean }, context?: any) => {
    const repoDir = resolveWorkspaceDirectoryForContext(input.repoPath, context);

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
        if (!input.args?.trim()) {
          return {
            stdout: '',
            stderr: 'Refusing git reset without explicit arguments. Provide the exact reset mode and target.',
            exitCode: 1
          };
        }
        if (/\b--hard\b/i.test(input.args) && !input.confirmDestructive) {
          return {
            stdout: '',
            stderr: 'Refusing destructive git reset --hard without confirmDestructive=true and an explicit user request.',
            exitCode: 1
          };
        }
        command = `git reset ${input.args}`;
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
