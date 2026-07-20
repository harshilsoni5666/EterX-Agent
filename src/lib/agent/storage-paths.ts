import path from 'path';

/**
 * Root for durable application data.
 *
 * Packaged Electron sets ETERX_DATA_DIR to %LOCALAPPDATA%/EterX/data. The
 * process.cwd fallback keeps web/dev mode backwards-compatible.
 */
export function getEterxDataDir(): string {
  const configured = String(process.env.ETERX_DATA_DIR || '').trim();
  return configured ? path.resolve(configured) : path.resolve(process.cwd());
}

export function getEterxWorkspaceDir(...segments: string[]): string {
  return path.resolve(getEterxDataDir(), '.workspaces', ...segments);
}

