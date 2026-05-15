import { z } from 'zod';
import { ToolDefinition } from '../../schemas';

/**
 * Diff & Patch Tool
 * 
 * Compare texts/files and apply patches. Essential for code reviews,
 * change tracking, and automated code modifications.
 */
export const diffTool: ToolDefinition = {
  name: 'diff_patch',
  description: `Compare two texts or files and generate unified diffs. Apply patches. Use for code reviews, tracking changes, and automated modifications.`,
  category: 'workspace',
  inputSchema: z.object({
    action: z.enum(['diff', 'apply_patch', 'stats']).describe('diff: compare two texts, apply_patch: apply a diff, stats: show change statistics'),
    textA: z.string().optional().describe('Original text (or text to patch)'),
    textB: z.string().optional().describe('Modified text'),
    patch: z.string().optional().describe('Unified diff patch to apply (for apply_patch)'),
    context: z.number().optional().default(3).describe('Lines of context in diff (default: 3)')
  }),
  outputSchema: z.object({ success: z.boolean(), result: z.any() }),
  execute: async (input: any) => {
    try {
      switch (input.action) {
        case 'diff': {
          if (!input.textA || !input.textB) return { success: false, result: 'textA and textB required' };
          const linesA = input.textA.split('\n');
          const linesB = input.textB.split('\n');
          const diff = computeUnifiedDiff(linesA, linesB, input.context || 3);
          
          const added = diff.filter((l: string) => l.startsWith('+')).length;
          const removed = diff.filter((l: string) => l.startsWith('-')).length;
          
          return {
            success: true,
            result: {
              diff: diff.join('\n'),
              stats: { added, removed, unchanged: Math.max(linesA.length, linesB.length) - added - removed },
              isDifferent: added > 0 || removed > 0
            }
          };
        }
        case 'apply_patch': {
          if (!input.textA || !input.patch) return { success: false, result: 'textA and patch required' };
          const result = applySimplePatch(input.textA, input.patch);
          return { success: true, result };
        }
        case 'stats': {
          if (!input.textA || !input.textB) return { success: false, result: 'textA and textB required' };
          const a = input.textA.split('\n');
          const b = input.textB.split('\n');
          return {
            success: true,
            result: {
              originalLines: a.length,
              modifiedLines: b.length,
              originalChars: input.textA.length,
              modifiedChars: input.textB.length,
              charDiff: input.textB.length - input.textA.length,
              lineDiff: b.length - a.length
            }
          };
        }
        default: return { success: false, result: 'Unknown action' };
      }
    } catch (err: any) {
      return { success: false, result: `Diff error: ${err.message}` };
    }
  }
};

function computeUnifiedDiff(a: string[], b: string[], context: number): string[] {
  const output: string[] = [];
  output.push(`--- original`);
  output.push(`+++ modified`);

  // Simple LCS-based diff
  const n = a.length, m = b.length;
  let i = 0, j = 0;

  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      output.push(` ${a[i]}`);
      i++; j++;
    } else if (j < m && (i >= n || a[i] !== b[j])) {
      output.push(`+${b[j]}`);
      j++;
    } else if (i < n) {
      output.push(`-${a[i]}`);
      i++;
    }
  }
  return output;
}

function applySimplePatch(text: string, patch: string): string {
  const lines = text.split('\n');
  const patchLines = patch.split('\n');
  const result: string[] = [];
  let textIdx = 0;

  for (const pLine of patchLines) {
    if (pLine.startsWith('---') || pLine.startsWith('+++') || pLine.startsWith('@@')) continue;
    if (pLine.startsWith('+')) {
      result.push(pLine.substring(1));
    } else if (pLine.startsWith('-')) {
      textIdx++; // Skip this line from original
    } else if (pLine.startsWith(' ')) {
      result.push(pLine.substring(1));
      textIdx++;
    }
  }

  // Append remaining original lines
  while (textIdx < lines.length) {
    result.push(lines[textIdx]);
    textIdx++;
  }

  return result.join('\n');
}
