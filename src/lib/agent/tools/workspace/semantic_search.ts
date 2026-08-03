import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { resolveWorkspaceDirectoryForContext } from '../../workspace/path_resolver';
import { ensureCodeIndex, searchCodeIndex } from '../../workspace/code-index';

export const workspaceSemanticSearchTool: ToolDefinition = {
  name: 'workspace_semantic_search',
  description: 'Meaning-based codebase search. Ask natural-language questions like "how does auth work" or "where is the chat route handled". Returns ranked files, line ranges, and snippets. Prefer this before blind grep when exploring architecture or behavior.',
  category: 'workspace',
  inputSchema: z.object({
    query: z.string().describe('Natural-language question about code behavior, architecture, or ownership'),
    directory: z.string().optional().describe('Optional subdirectory scope. Defaults to the active user workspace, or the runtime scratch root when no user workspace is selected.'),
    maxResults: z.number().optional().describe('Maximum hits (default: 12)'),
  }),
  outputSchema: z.object({
    results: z.array(z.any()),
    indexedFiles: z.number(),
    searchEngine: z.string(),
  }),
  execute: async (input: { query: string; directory?: string; maxResults?: number }, context?: any) => {
    const workspacePath = resolveWorkspaceDirectoryForContext(input.directory, context);
    const index = await ensureCodeIndex(workspacePath);
    const results = searchCodeIndex(index, input.query, {
      maxResults: input.maxResults,
      targetDirectories: input.directory ? [input.directory] : undefined,
    });

    return {
      results,
      totalMatches: results.length,
      indexedFiles: index.fileCount,
      searchEngine: 'eterx-code-index+bm25',
      directory: workspacePath,
      hint: results.length > 0
        ? 'Read the best match with workspace_read_file using startLine/endLine, or batch with workspace_read_many_files.'
        : 'No semantic hits. Fall back to workspace_search_text for exact symbols/strings.',
    };
  },
};
