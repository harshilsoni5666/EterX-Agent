import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

/**
 * Git Intelligence — Smart Version Control Operations
 * 
 * Goes beyond basic git commands. Provides intelligent git operations:
 * - Smart commit with auto-generated messages
 * - Branch management with PR descriptions
 * - Diff analysis with change summaries
 * - Conflict detection  
 * - Changelog generation
 * - Stash management
 */
export const gitIntelTool: ToolDefinition = {
  name: 'git_intelligence',
  description: `Smart git operations with AI-powered intelligence.

MODES:
- "status": Enhanced status with file categories and change summary
- "smart_commit": Auto-generate commit message from staged changes, then commit
- "diff_summary": Analyze changes and provide a human-readable summary
- "branch_info": Show branch info with ahead/behind counts
- "changelog": Generate changelog from recent commits
- "stash_smart": Smart stash with auto-generated name
- "unstash": Pop or apply most recent stash
- "log": Pretty git log with formatting
- "conflict_check": Check if current branch has conflicts with a target branch

EXAMPLES:
- Status: { mode: "status" }
- Smart commit: { mode: "smart_commit", message: "optional override" }
- Diff summary: { mode: "diff_summary" }
- Changelog: { mode: "changelog", count: 20 }`,
  category: 'core',
  inputSchema: z.object({
    mode: z.enum([
      'status', 'smart_commit', 'diff_summary', 'branch_info',
      'changelog', 'stash_smart', 'unstash', 'log', 'conflict_check'
    ]).describe('Operation mode'),
    message: z.string().optional().describe('Commit message override (for smart_commit)'),
    count: z.number().optional().default(10).describe('Number of log entries (for log, changelog)'),
    branch: z.string().optional().describe('Target branch (for conflict_check)')
  }),
  outputSchema: z.object({ success: z.boolean(), result: z.any(), message: z.string() }),
  execute: async (input: { mode: string, message?: string, count?: number, branch?: string }) => {
    const cwd = process.cwd();

    const run = async (cmd: string): Promise<string> => {
      try {
        const { stdout } = await execAsync(cmd, { cwd, timeout: 15000 });
        return stdout.trim();
      } catch (err: any) {
        return err.stdout?.trim() || err.message;
      }
    };

    switch (input.mode) {
      case 'status': {
        const status = await run('git status --porcelain');
        if (!status) return { success: true, result: { clean: true }, message: 'Working tree is clean' };

        const lines = status.split('\n');
        const staged: string[] = [], modified: string[] = [], untracked: string[] = [], deleted: string[] = [];

        for (const line of lines) {
          const code = line.substring(0, 2);
          const file = line.substring(3).trim();
          if (code[0] === 'A' || code[0] === 'M') staged.push(file);
          if (code[1] === 'M') modified.push(file);
          if (code === '??') untracked.push(file);
          if (code.includes('D')) deleted.push(file);
        }

        const branch = await run('git branch --show-current');
        return {
          success: true,
          result: { branch, staged, modified, untracked, deleted, totalChanges: lines.length },
          message: `Branch: ${branch} | ${staged.length} staged, ${modified.length} modified, ${untracked.length} untracked, ${deleted.length} deleted`
        };
      }

      case 'smart_commit': {
        // Check if there are staged changes
        const staged = await run('git diff --cached --stat');
        if (!staged) {
          // Auto-stage all
          await run('git add -A');
        }

        let commitMsg = input.message;
        if (!commitMsg) {
          // Auto-generate from diff
          const diff = await run('git diff --cached --stat');
          const files = diff.split('\n').filter(l => l.includes('|')).map(l => l.split('|')[0].trim());

          if (files.length === 0) {
            return { success: false, result: null, message: 'No changes to commit' };
          }

          // Generate smart message
          const allFiles = files.join(', ');
          if (files.length === 1) {
            commitMsg = `update ${path.basename(files[0])}`;
          } else if (files.length <= 3) {
            commitMsg = `update ${files.map(f => path.basename(f)).join(', ')}`;
          } else {
            // Find common directory
            const dirs = [...new Set(files.map(f => path.dirname(f)))];
            if (dirs.length === 1) {
              commitMsg = `update ${dirs[0]} (${files.length} files)`;
            } else {
              commitMsg = `update ${files.length} files across ${dirs.length} directories`;
            }
          }
        }

        const result = await run(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
        return { success: true, result: { message: commitMsg, output: result }, message: `Committed: "${commitMsg}"` };
      }

      case 'diff_summary': {
        const diff = await run('git diff --stat');
        const diffFull = await run('git diff --shortstat');
        const staged = await run('git diff --cached --stat');

        return {
          success: true,
          result: { unstaged: diff, staged, summary: diffFull },
          message: `Changes: ${diffFull || 'No unstaged changes'}${staged ? ` | Staged: ${staged.split('\n').length} files` : ''}`
        };
      }

      case 'branch_info': {
        const current = await run('git branch --show-current');
        const branches = await run('git branch -a --format="%(refname:short) %(upstream:short) %(upstream:track)"');
        const remote = await run('git remote -v');

        return {
          success: true,
          result: { current, branches: branches.split('\n').filter(Boolean), remote },
          message: `Current: ${current} | ${branches.split('\n').filter(Boolean).length} branches`
        };
      }

      case 'changelog': {
        const count = input.count || 20;
        const log = await run(`git log --oneline --pretty=format:"%h %s (%cr)" -n ${count}`);

        const entries = log.split('\n').filter(Boolean).map(line => {
          const match = line.match(/^(\w+)\s+(.+)\s+\((.+)\)$/);
          return match
            ? { hash: match[1], message: match[2], time: match[3] }
            : { hash: '', message: line, time: '' };
        });

        let changelog = `# Changelog\n\nGenerated: ${new Date().toLocaleDateString()}\n\n`;
        for (const entry of entries) {
          changelog += `- **${entry.hash}** ${entry.message} *(${entry.time})*\n`;
        }

        return { success: true, result: { entries, changelog }, message: `${entries.length} commits in changelog` };
      }

      case 'stash_smart': {
        const branch = await run('git branch --show-current');
        const stashName = `auto-stash-${branch}-${new Date().toISOString().split('T')[0]}`;
        const result = await run(`git stash push -m "${stashName}"`);
        return { success: true, result: { name: stashName, output: result }, message: `Stashed: "${stashName}"` };
      }

      case 'unstash': {
        const result = await run('git stash pop');
        return { success: true, result: { output: result }, message: 'Stash popped' };
      }

      case 'log': {
        const count = input.count || 10;
        const log = await run(`git log --oneline --graph --decorate -n ${count}`);
        return { success: true, result: { log }, message: `Last ${count} commits` };
      }

      case 'conflict_check': {
        if (!input.branch) {
          return { success: false, result: null, message: 'branch is required for conflict_check' };
        }
        const current = await run('git branch --show-current');
        const mergeCheck = await run(`git merge --no-commit --    no-ff ${input.branch} 2>&1 || true`);
        await run('git merge --abort 2>&1 || true');

        const    cts = mergeCheck.toLowerCase().includes('conflict');
        return	 {
          success: true,
          result: { current, target: input.branch, hasConflicts: cts, output: mergeCheck },
          message: cts ? `⚠️ Conflicts detected with ${input.branch}` : `✅ No conflicts with ${input.branch}`
        };
      }

      default:
        return { success: false, result: null, message: `Unknown mode: ${input.mode}` };
    }
  }
};
