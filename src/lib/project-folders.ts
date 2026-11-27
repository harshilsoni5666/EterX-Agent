import { appStorage } from './client-storage';
import { normalizePathForComparison } from './path-utils';

export const DEFAULT_WORKSPACE_PATH_KEY = 'eterx_chat_workspace_path_default';
export const DEFAULT_RUN_LOCATION_KEY = 'eterx_chat_run_location_default';
export const RECENT_PROJECTS_KEY = 'eterx_recent_projects';

export type RecentProject = { path: string; name: string; openedAt?: number };

export function projectFolderName(path?: string | null) {
  return path?.split(/[/\\]/).filter(Boolean).pop() || path || 'Chat workspace';
}

export function readRecentProjects(snapshot = appStorage.getItem(RECENT_PROJECTS_KEY)): RecentProject[] {
  try {
    const stored: unknown = JSON.parse(snapshot || '[]');
    return Array.isArray(stored) ? stored.filter(project =>
      typeof project?.path === 'string' && project.path.trim() && typeof project.name === 'string',
    ) : [];
  } catch {
    return [];
  }
}

export function writeRecentProjects(projects: RecentProject[]) {
  appStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(projects));
}

export function rememberProject(path: string) {
  const key = normalizePathForComparison(path);
  writeRecentProjects([
    { path, name: projectFolderName(path), openedAt: Date.now() },
    ...readRecentProjects().filter(project => normalizePathForComparison(project.path) !== key),
  ].slice(0, 8));
}
