export type GitPreferences = {
  gitIntegration: boolean;
  gitWorkspaceEnabled: boolean;
  gitAutoDetect: boolean;
  gitBranchPrefix: string;
  gitConfirmPush: boolean;
  gitMergeMethod: 'merge' | 'squash';
};

export const DEFAULT_GIT_PREFERENCES: GitPreferences = {
  gitIntegration: true,
  gitWorkspaceEnabled: true,
  gitAutoDetect: true,
  gitBranchPrefix: 'eterx/',
  gitConfirmPush: true,
  gitMergeMethod: 'merge',
};

export function normalizeGitPreferences(value: unknown): GitPreferences {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    gitIntegration: source.gitIntegration !== false,
    gitWorkspaceEnabled: source.gitWorkspaceEnabled !== false,
    gitAutoDetect: source.gitAutoDetect !== false,
    gitBranchPrefix: typeof source.gitBranchPrefix === 'string' ? source.gitBranchPrefix.slice(0, 120) : 'eterx/',
    gitConfirmPush: source.gitConfirmPush !== false,
    gitMergeMethod: source.gitMergeMethod === 'squash' ? 'squash' : 'merge',
  };
}
