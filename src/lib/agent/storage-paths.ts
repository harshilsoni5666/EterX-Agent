import path from 'path';
import os from 'os';

/**
 * Root for durable application data.
 *
 * Packaged Electron sets ETERX_DATA_DIR explicitly. Direct Next.js/dev runs
 * use the operating system's per-user application-data directory as well, so
 * durable user state never depends on the source checkout or current folder.
 */
export function getEterxDataDir(): string {
  const configured = String(process.env.ETERX_DATA_DIR || '').trim();
  if (configured) return path.resolve(configured);

  if (process.platform === 'win32') {
    const appDataRoot = String(process.env.LOCALAPPDATA || process.env.APPDATA || '').trim();
    if (appDataRoot) return path.resolve(appDataRoot, 'EterX', 'data');
  }

  if (process.platform === 'darwin') {
    return path.resolve(os.homedir(), 'Library', 'Application Support', 'EterX', 'data');
  }

  const xdgDataHome = String(process.env.XDG_DATA_HOME || '').trim();
  return path.resolve(xdgDataHome || path.join(os.homedir(), '.local', 'share'), 'EterX', 'data');
}

export function getEterxWorkspaceDir(...segments: string[]): string {
  return path.resolve(getEterxDataDir(), '.workspaces', ...segments);
}

export function getEterxAppRoot(): string {
  const configured = String(process.env.ETERX_APP_ROOT || '').trim();
  return configured ? path.resolve(configured) : path.resolve(process.cwd());
}

export function getEterxAssetPath(...segments: string[]): string {
  return path.resolve(getEterxAppRoot(), 'assets', ...segments);
}

export function getEterxExecutableAssetPath(...segments: string[]): string {
  const assetPath = getEterxAssetPath(...segments);
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  return assetPath.includes(asarSegment)
    ? assetPath.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
    : assetPath;
}
