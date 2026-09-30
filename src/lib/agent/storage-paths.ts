import path from 'path';
const storageLayout = require('../../../electron/storage-layout') as {
  dataRoot: () => string;
  workspaceRoot: () => string;
};
const { chatWorkspacePaths } = require('../../../electron/workspace-layout') as {
  chatWorkspacePaths: (root: string, userId: string, chatId: string) => { base: string; workspace: string; scratch: string; output: string };
};

/**
 * Root for durable application data.
 *
 * Packaged Electron sets ETERX_DATA_DIR explicitly. Direct Next.js/dev runs
 * use the operating system's per-user application-data directory as well, so
 * durable user state never depends on the source checkout or current folder.
 */
export function getEterxDataDir(): string {
  return storageLayout.dataRoot();
}

export function getEterxWorkspaceDir(...segments: string[]): string {
  return path.resolve(storageLayout.workspaceRoot(), ...segments);
}

export function getChatWorkspacePaths(chatId: string, userId = 'default') {
  return chatWorkspacePaths(getEterxWorkspaceDir(), userId, chatId);
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
