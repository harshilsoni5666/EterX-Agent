import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getChatWorkspacePaths, getEterxAppRoot, getEterxWorkspaceDir } from '../storage-paths';
import { getUserFolders } from '../runtime/user-folders';

const PROTECTED_SUBDIRS = ['src', 'electron', 'public', 'node_modules', '.git', '.next', 'dist'];
const PROTECTED_ROOT_FILES = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.bot.json', 'next.config.mjs', 'tailwind.config.js', 'postcss.config.js', '.gitignore', 'next-env.d.ts']);
const EterX_ROOT = getEterxAppRoot();

function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Protect the application installation, not every project with a src folder. */
export function checkEterXProtection(targetPath: string): { blocked: boolean; reason: string } {
  let isApp = Boolean(process.env.ETERX_APP_ROOT);
  if (!isApp) {
    try { isApp = JSON.parse(fs.readFileSync(path.join(EterX_ROOT, 'package.json'), 'utf8')).name === 'eterx'; } catch {}
  }
  if (!isApp || !inside(EterX_ROOT, targetPath) || inside(getEterxWorkspaceDir(), targetPath)) return { blocked: false, reason: '' };
  const relative = path.relative(EterX_ROOT, path.resolve(targetPath));
  const top = relative.split(path.sep)[0].toLowerCase();
  const blocked = PROTECTED_SUBDIRS.includes(top) || PROTECTED_ROOT_FILES.has(relative.toLowerCase());
  return { blocked, reason: blocked ? `The path belongs to the EterX application installation: ${targetPath}. Explicitly select this checkout as the workspace to edit it.` : '' };
}

export function getUserDocumentsPath(): string { return getUserFolders().documents; }
export function getUserDownloadsPath(): string { return getUserFolders().downloads; }

function chatPaths(context?: any) {
  const id = String(context?.ownerChatId || context?.chatId || context?.projectId || '').trim();
  return id ? getChatWorkspacePaths(id, String(context?.userId || 'default')) : undefined;
}

/** Legacy callers without a chat use app storage, never Desktop or process CWD. */
export function getRuntimeScratchRoot(context?: any): string {
  const explicit = String(context?.scratchRoot || '').trim();
  return explicit ? path.resolve(explicit) : chatPaths(context)?.scratch || getEterxWorkspaceDir('unassigned', 'scratch');
}

export function hasRuntimeWorkspaceContext(context?: any): boolean {
  return Boolean(context?.workspacePath || context?.workspaceRoot || context?.chatId || context?.projectId || context?.scratchRoot || context?.paths?.length);
}

/** A selected folder remains authoritative when unavailable; never switch folders. */
export function getRuntimeWorkspaceRoot(context?: any): string {
  const selected = String(context?.workspacePath || context?.workspaceRoot || '').trim();
  if (selected) return resolveUserPath(selected, chatPaths(context)?.workspace || getEterxWorkspaceDir('unassigned', 'working'));
  const pinned = Array.isArray(context?.paths) ? context.paths.find((p: unknown) => typeof p === 'string' && p.trim()) : undefined;
  if (pinned) {
    const resolved = resolveUserPath(pinned, chatPaths(context)?.workspace || getEterxWorkspaceDir('unassigned', 'working'));
    try { return fs.statSync(resolved).isFile() ? path.dirname(resolved) : resolved; } catch { return resolved; }
  }
  return chatPaths(context)?.workspace || (context?.scratchRoot ? path.resolve(context.scratchRoot) : getEterxWorkspaceDir('unassigned', 'working'));
}

function resolveUserPath(value: string, root: string): string {
  if (value.includes('\0')) throw new Error('A file path cannot contain a null character.');
  if (/^file:/i.test(value)) return resolveUserPath(fileURLToPath(value), root);
  if (process.platform === 'win32' && (/^[a-z]:(?![\\/])/i.test(value) || /^[\\/](?![\\/])/.test(value))) {
    throw new Error(`The path is not an absolute Windows host path: ${value}. Use the folder selected on this device or a full drive/UNC path.`);
  }
  if (process.platform !== 'win32' && (/^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\'))) {
    throw new Error(`This Windows path is not available on ${process.platform}: ${value}. Select a folder on this device.`);
  }
  if (path.isAbsolute(value)) return path.normalize(value);
  if (value === '~') return os.homedir();
  if (/^~[\\/]/.test(value)) return path.resolve(os.homedir(), value.slice(2));
  // All other relative names are literal, including docs, Desktop, temp and
  // sandbox. Human folder requests use the OS folder paths in runtime context.
  return path.resolve(root, value);
}

function resolveContextPath(value: string, context?: any): string {
  return resolveUserPath(value, getRuntimeWorkspaceRoot(context));
}

function protectWrite(filePath: string, context?: any): string {
  // A selected project routes relative paths; explicit local paths use OS permissions.
  const selected = String(context?.workspacePath || context?.workspaceRoot || '').trim();
  if (context?.isFocusedWorkspace === true && selected && inside(selected, filePath)) {
    let available = false;
    try { available = fs.statSync(selected).isDirectory(); } catch {}
    if (!available) throw new Error(`Selected workspace is unavailable: ${selected}. Reconnect the drive or select its current folder. The requested path was not changed.`);
  }
  if (context?.allowEterXSource === true || (selected && inside(selected, filePath) && context?.isFocusedWorkspace === true)) return filePath;
  const protection = checkEterXProtection(filePath);
  if (protection.blocked) throw new Error(protection.reason);
  return filePath;
}

export function resolveWorkspacePathForContext(filename: string, context?: any): string {
  return protectWrite(resolveContextPath(filename, context), context);
}

export function resolveReadableWorkspacePathForContext(filename: string, context?: any): string {
  return resolveContextPath(filename, context);
}

export function resolveWorkspaceDirectoryForContext(directory: string | undefined, context?: any): string {
  return directory?.trim() ? resolveContextPath(directory, context) : getRuntimeWorkspaceRoot(context);
}

function ensureExtension(filename: string, extension?: string): string {
  if (!extension) return filename;
  const suffix = extension.startsWith('.') ? extension : `.${extension}`;
  return filename.toLowerCase().endsWith(suffix.toLowerCase()) ? filename : filename + suffix;
}

export function resolveFinalArtifactPathForContext(filename: string | undefined, extension?: string, title?: string, context?: any): string {
  const fallback = String(title || 'EterX Artifact').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').trim().slice(0, 120) || 'EterX Artifact';
  return resolveWorkspacePathForContext(ensureExtension(filename?.trim() || fallback, extension), context);
}

export function resolveFinalArtifactPath(filename: string, extension?: string, title?: string): string {
  return resolveFinalArtifactPathForContext(filename, extension, title);
}

export function resolveWorkspacePath(filename: string): string { return resolveWorkspacePathForContext(filename); }
export function resolveReadableWorkspacePath(filename: string): string { return resolveReadableWorkspacePathForContext(filename); }
export function getWorkspacePathCandidates(filename: string): string[] { return [resolveReadableWorkspacePath(filename)]; }

export function getPathResolverInfo() {
  return { EterXRoot: EterX_ROOT, desktopPath: getUserFolders().desktop, tempDir: getRuntimeScratchRoot(), protectedDirs: PROTECTED_SUBDIRS };
}
