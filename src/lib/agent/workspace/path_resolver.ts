import os from 'os';
import path from 'path';
import fs from 'fs';

// ═══════════════════════════════════════════════════════════════
// EterX Source Protection Cloak v1.0
// 
// The ABSOLUTE #1 RULE: The agent can NEVER modify its own source code.
// This prevents catastrophic self-destruction (like the page.tsx incident).
// ═══════════════════════════════════════════════════════════════

/** 
 * The EterX project root — detected at startup. 
 * Every file operation is checked against this to prevent self-modification.
 */
const EterX_ROOT = detectEterXRoot();

/**
 * Protected directories within EterX that the agent must NEVER touch.
 * .workspaces is excluded because the agent legitimately uses it for temp work.
 */
const PROTECTED_SUBDIRS = ['src', 'electron', 'public', 'node_modules', '.git', '.next', 'dist'];

/**
 * Files in EterX root that are protected.
 */
const PROTECTED_ROOT_FILES = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.bot.json',
  'next.config.mjs', 'tailwind.config.ts', 'postcss.config.js',
  '.gitignore', 'next-env.d.ts'
];

const USER_FOLDER_ALIASES = new Map<string, () => string>([
  ['desktop', getRealDesktopPath],
  ['downloads', () => path.join(os.homedir(), 'Downloads')],
  ['documents', () => path.join(os.homedir(), 'Documents')],
  ['docs', () => path.join(os.homedir(), 'Documents')],
]);

function isPathInsideOrEqual(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function relativeStartsWithPath(relativePath: string, prefix: string): boolean {
  const normalizedRelative = relativePath.replace(/\\/g, '/').toLowerCase();
  const normalizedPrefix = prefix.replace(/\\/g, '/').toLowerCase();
  return normalizedRelative === normalizedPrefix || normalizedRelative.startsWith(`${normalizedPrefix}/`);
}

function detectEterXRoot(): string {
  // process.cwd() is the EterX root when running in dev
  const cwd = process.cwd();

  // Verify by checking for our signature files
  const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));
  const hasSrc = fs.existsSync(path.join(cwd, 'src'));

  if (hasPackageJson && hasSrc) {
    return path.resolve(cwd);
  }

  // Fallback: hardcoded known path
  return path.resolve('c:\\Harshil projects\\EterX');
}

/**
 * Checks if a path falls inside the protected EterX source tree.
 * Returns { blocked: true, reason: string } if the path is protected.
 * 
 * ALLOWED paths within EterX:
 *   - .workspaces/  (agent's working area)
 *   - .temp/        (temporary files)
 *   - .agent_task_tracker.* (task tracking)
 *   - data/         (user data directory)
 * 
 * BLOCKED paths:
 *   - src/          (all source code)
 *   - electron/     (desktop app code)  
 *   - public/       (static assets)
 *   - node_modules/ (dependencies)
 *   - .git/         (version control)
 *   - .next/        (build output)
 *   - dist/         (production build)
 *   - package.json, tsconfig.json, etc. (config files)
 */
export function checkEterXProtection(targetPath: string): { blocked: boolean; reason: string } {
  // If the path is not inside EterX at all, it's fine
  if (!isPathInsideOrEqual(EterX_ROOT, targetPath)) {
    return { blocked: false, reason: '' };
  }

  // Get the relative path within EterX
  const relativePath = path.relative(EterX_ROOT, path.resolve(targetPath));
  const relLower = relativePath.toLowerCase();

  // ALLOWED exceptions within EterX
  const allowedPrefixes = ['.workspaces', '.temp', 'data', 'p_block_ppt_assets'];
  const allowedFiles = ['.agent_task_tracker.json', '.agent_task_tracker.md', 'chunk_log.txt', 'chunk_log2.txt', 'err.log'];

  for (const prefix of allowedPrefixes) {
    if (relativeStartsWithPath(relLower, prefix)) {
      return { blocked: false, reason: '' };
    }
  }

  for (const file of allowedFiles) {
    if (relLower === file.toLowerCase()) {
      return { blocked: false, reason: '' };
    }
  }

  // CHECK: Is it a protected subdirectory?
  for (const dir of PROTECTED_SUBDIRS) {
    if (relativeStartsWithPath(relLower, dir)) {
      return {
        blocked: true,
        reason: `🛡️ BLOCKED: Cannot modify EterX source file "${ relativePath }". The "${ dir }/" directory is protected. Save your files to the Desktop or a different location instead.`
      };
    }
  }

  // CHECK: Is it a protected root config file?
  for (const file of PROTECTED_ROOT_FILES) {
    if (relLower === file.toLowerCase()) {
      return {
        blocked: true,
        reason: `🛡️ BLOCKED: Cannot modify EterX config file "${ file }". This is a protected project configuration file.`
      };
    }
  }

  // Any other file directly in EterX root — allow cautiously
  // (e.g., report_content.txt, process_data.js are user-created)
  return { blocked: false, reason: '' };
}

/**
 * Resolves the REAL user Desktop path, handling:
 * - OneDrive Desktop redirection (common on modern Windows)
 * - Standard Windows Desktop
 * - Electron app context where CWD might differ
 */
function getRealDesktopPath(): string {
  const homeDir = os.homedir();

  // Check OneDrive Desktop first (many Windows users have this)
  const oneDriveDesktop = path.join(homeDir, 'OneDrive', 'Desktop');
  if (fs.existsSync(oneDriveDesktop)) {
    return oneDriveDesktop;
  }

  // Check OneDrive with locale-specific folder names
  const oneDrivePath = process.env.OneDrive || process.env.OneDriveConsumer || '';
  if (oneDrivePath) {
    const oneDriveDesktopAlt = path.join(oneDrivePath, 'Desktop');
    if (fs.existsSync(oneDriveDesktopAlt)) {
      return oneDriveDesktopAlt;
    }
  }

  // Standard Windows Desktop
  const standardDesktop = path.join(homeDir, 'Desktop');
  if (fs.existsSync(standardDesktop)) {
    return standardDesktop;
  }

  // Fallback: create standard Desktop if nothing exists
  return standardDesktop;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    const key = resolved.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(resolved);
    }
  }
  return unique;
}

function isInternalWorkspacePath(targetPath: string): boolean {
  if (!isPathInsideOrEqual(EterX_ROOT, targetPath)) return false;

  const relLower = path.relative(EterX_ROOT, path.resolve(targetPath)).toLowerCase();
  return (
    relativeStartsWithPath(relLower, '.workspaces') ||
    relativeStartsWithPath(relLower, '.temp') ||
    relativeStartsWithPath(relLower, 'temp') ||
    relativeStartsWithPath(relLower, 'sandbox') ||
    relLower === '.agent_task_tracker' ||
    relLower.startsWith('.agent_task_tracker.')
  );
}

function sanitizeArtifactName(name: string): string {
  return name
    .replace(/\.[a-z0-9]{2,6}$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function isGenericArtifactName(name: string): boolean {
  const stem = sanitizeArtifactName(name).toLowerCase();
  return !stem || /^(main|draft|final|output|document|report|file|untitled|artifact|result)$/i.test(stem);
}

function ensureExtension(filePath: string, extension?: string): string {
  if (!extension) return filePath;
  const normalized = extension.startsWith('.') ? extension : `.${extension}`;
  return filePath.toLowerCase().endsWith(normalized.toLowerCase()) ? filePath : `${filePath}${normalized}`;
}

function expandHomePath(filename: string): string | null {
  if (filename === '~') return os.homedir();
  if (filename.startsWith(`~${path.sep}`) || filename.startsWith('~/') || filename.startsWith('~\\')) {
    return path.resolve(os.homedir(), filename.slice(2));
  }
  return null;
}

function resolveUserFolderAlias(filename: string): string | null {
  const normalized = filename.replace(/\\/g, '/');
  const match = /^([^/]+)(?:\/(.*))?$/.exec(normalized);
  if (!match) return null;

  const resolver = USER_FOLDER_ALIASES.get(match[1].toLowerCase());
  if (!resolver) return null;

  return path.resolve(resolver(), match[2] || '');
}

function resolveSpecialUserPath(filename: string): string | null {
  return expandHomePath(filename) || resolveUserFolderAlias(filename);
}

function isInternalRelativePath(filename: string): boolean {
  const lowerFilename = filename.replace(/\\/g, '/').toLowerCase();
  return (
    lowerFilename === '.workspaces' ||
    lowerFilename.startsWith('.workspaces/') ||
    lowerFilename === '.temp' ||
    lowerFilename.startsWith('.temp/') ||
    lowerFilename === 'sandbox' ||
    lowerFilename.startsWith('sandbox/') ||
    lowerFilename === 'temp' ||
    lowerFilename.startsWith('temp/') ||
    lowerFilename.startsWith('.agent_task_tracker')
  );
}

function isExplicitUserPath(filename: string): boolean {
  return path.isAbsolute(filename) || !!resolveSpecialUserPath(filename) || isInternalRelativePath(filename);
}

export function hasRuntimeWorkspaceContext(context?: any): boolean {
  return [
    context?.workspacePath,
    context?.workspaceRoot,
    ...(Array.isArray(context?.allowedPaths) ? context.allowedPaths : []),
    ...(Array.isArray(context?.paths) ? context.paths : []),
  ].some(candidate => typeof candidate === 'string' && candidate.trim().length > 0);
}

export function getRuntimeWorkspaceRoot(context?: any): string {
  const rawCandidates = [
    context?.workspacePath,
    context?.workspaceRoot,
    ...(Array.isArray(context?.allowedPaths) ? context.allowedPaths : []),
    ...(Array.isArray(context?.paths) ? context.paths : []),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);

  for (const candidate of rawCandidates) {
    const resolved = path.resolve(candidate);
    try {
      if (fs.existsSync(resolved)) {
        const stat = fs.statSync(resolved);
        return stat.isDirectory() ? resolved : path.dirname(resolved);
      }
    } catch {
      continue;
    }
  }

  // IMPORTANT: Fall back to process.cwd() (EterX project root), NOT the Desktop.
  // Relative paths like ".workspaces/sandbox/file.py" must resolve to the same
  // location where workspace_write_file writes them (EterX root/.workspaces/sandbox/).
  // Using the Desktop as fallback causes "python: can't open file '...Desktop\.workspaces\...'" errors.
  return path.resolve(process.cwd());
}

export function resolveWorkspacePathForContext(filename: string, context?: any): string {
  if (isExplicitUserPath(filename)) return resolveWorkspacePath(filename);

  const root = getRuntimeWorkspaceRoot(context);
  const filePath = path.resolve(root, filename);
  const protection = checkEterXProtection(filePath);
  if (protection.blocked) {
    throw new Error(protection.reason);
  }
  return filePath;
}

export function resolveReadableWorkspacePathForContext(filename: string, context?: any): string {
  if (isExplicitUserPath(filename)) return resolveReadableWorkspacePath(filename);

  const root = getRuntimeWorkspaceRoot(context);
  const scopedPath = path.resolve(root, filename);
  if (fs.existsSync(scopedPath)) return scopedPath;
  return scopedPath;
}

export function resolveWorkspaceDirectoryForContext(directory: string | undefined, context?: any): string {
  if (!directory || !directory.trim()) return getRuntimeWorkspaceRoot(context);
  if (isExplicitUserPath(directory)) return resolveWorkspacePath(directory);

  const dirPath = path.resolve(getRuntimeWorkspaceRoot(context), directory);
  const protection = checkEterXProtection(dirPath);
  if (protection.blocked) {
    throw new Error(protection.reason);
  }
  return dirPath;
}

/**
 * Resolve final consumer artifacts only.
 *
 * Sandbox/.workspaces/.temp paths are valid for drafts, scripts, and source files,
 * but they must never become the user-facing DOCX/PDF/PPTX/XLSX path. If an
 * agent accidentally passes an internal path, promote the final artifact to the
 * real Desktop and keep only the basename/title.
 */
export function resolveFinalArtifactPath(filename: string, extension?: string, title?: string): string {
  const desktopPath = getRealDesktopPath();
  const requestedName = path.basename(filename || '');
  const titleName = title ? sanitizeArtifactName(title) : '';
  const outputName = isGenericArtifactName(requestedName) && titleName ? titleName : sanitizeArtifactName(requestedName);
  const fallbackName = titleName || 'EterX Artifact';
  const finalName = ensureExtension(outputName || fallbackName, extension);

  if (!filename || !filename.trim()) {
    return path.resolve(desktopPath, finalName);
  }

  const pointsToInternal =
    isInternalRelativePath(filename) ||
    (path.isAbsolute(filename) && isInternalWorkspacePath(filename));

  if (pointsToInternal) {
    return path.resolve(desktopPath, finalName);
  }

  const resolved = ensureExtension(resolveWorkspacePath(filename), extension);
  if (isInternalWorkspacePath(resolved)) {
    return path.resolve(desktopPath, finalName);
  }

  return resolved;
}

/**
 * Context-aware final artifact resolution.
 *
 * When a code/workspace UI has selected or pinned a project folder, plain
 * relative final paths belong inside that folder. Explicit user paths
 * (absolute paths, Desktop/Downloads/Documents aliases, ~, or internal draft
 * paths) keep the global resolver behavior.
 */
export function resolveFinalArtifactPathForContext(
  filename: string | undefined,
  extension?: string,
  title?: string,
  context?: any
): string {
  const requested = filename || '';
  if (!hasRuntimeWorkspaceContext(context)) {
    return resolveFinalArtifactPath(requested, extension, title);
  }

  const requestedName = path.basename(requested || '');
  const titleName = title ? sanitizeArtifactName(title) : '';
  const outputName = isGenericArtifactName(requestedName) && titleName ? titleName : sanitizeArtifactName(requestedName);
  const fallbackName = titleName || 'EterX Artifact';
  const finalName = ensureExtension(outputName || fallbackName, extension);
  const workspaceRoot = getRuntimeWorkspaceRoot(context);

  if (!requested.trim()) {
    return path.resolve(workspaceRoot, finalName);
  }

  const pointsToInternal =
    isInternalRelativePath(requested) ||
    (path.isAbsolute(requested) && isInternalWorkspacePath(requested));

  if (pointsToInternal) {
    const finalPath = path.resolve(workspaceRoot, finalName);
    const protection = checkEterXProtection(finalPath);
    if (protection.blocked) throw new Error(protection.reason);
    return finalPath;
  }

  if (isExplicitUserPath(requested)) {
    return resolveFinalArtifactPath(requested, extension, title);
  }

  const resolved = ensureExtension(resolveWorkspacePathForContext(requested, context), extension);
  if (isInternalWorkspacePath(resolved)) {
    return path.resolve(workspaceRoot, finalName);
  }

  return resolved;
}

/**
 * Returns likely read locations for a user/artifact path.
 *
 * Write resolution intentionally defaults relative final files to Desktop.
 * Reads need to be more flexible because an agent may draft in sandbox,
 * generate final files on Desktop, or receive a relative path from a project.
 */
export function getWorkspacePathCandidates(filename: string): string[] {
  if (path.isAbsolute(filename)) return [path.resolve(filename)];

  const specialUserPath = resolveSpecialUserPath(filename);
  const candidates = [
    ...(specialUserPath ? [specialUserPath] : []),
    path.resolve(process.cwd(), filename),
    path.resolve(process.cwd(), '.workspaces', 'sandbox', filename),
    path.resolve(process.cwd(), '.workspaces', 'temp', filename),
    path.resolve(process.cwd(), '.temp', filename),
    path.resolve(getRealDesktopPath(), filename),
  ];

  try {
    candidates.push(resolveWorkspacePath(filename));
  } catch {
    // resolveWorkspacePath enforces write protection. Read fallbacks should
    // continue trying other locations instead of failing early.
  }

  return uniquePaths(candidates);
}

/**
 * Resolve a path for reading. Existing CWD/sandbox/temp/Desktop files win;
 * if nothing exists, return the normal write-resolved path for a useful error.
 */
export function resolveReadableWorkspacePath(filename: string): string {
  const candidates = getWorkspacePathCandidates(filename);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  if (path.isAbsolute(filename)) return path.resolve(filename);
  return candidates[candidates.length - 1] || path.resolve(process.cwd(), filename);
}

/**
 * Resolves file paths according to system rules:
 * 1. Absolute paths are preserved (but checked against EterX protection).
 * 2. Temporary/trash/sandbox files are saved to EterX/.temp/
 * 3. All other relative files are saved to the user's REAL Desktop.
 * 4. Files targeting EterX source are BLOCKED with a clear error.
 */
export function resolveWorkspacePath(filename: string): string {
  if (path.isAbsolute(filename)) {
    // Check protection before allowing absolute path writes
    const protection = checkEterXProtection(filename);
    if (protection.blocked) {
      throw new Error(protection.reason);
    }
    return filename;
  }

  const specialUserPath = resolveSpecialUserPath(filename);
  if (specialUserPath) {
    const protection = checkEterXProtection(specialUserPath);
    if (protection.blocked) {
      throw new Error(protection.reason);
    }
    return specialUserPath;
  }

  // Define paths
  const desktopPath = getRealDesktopPath();
  const tempDir = path.resolve(process.cwd(), '.temp');

  // Distinguish working/temp files from final output
  const lowerFilename = filename.replace(/\\/g, '/').toLowerCase();

  if (
    lowerFilename === '.temp' ||
    lowerFilename.startsWith('.temp/') ||
    lowerFilename === 'sandbox' ||
    lowerFilename.startsWith('sandbox/') ||
    lowerFilename === 'temp' ||
    lowerFilename.startsWith('temp/')
  ) {
    // Strip the prefix and save it into the real .temp folder
    const stripped = filename.replace(/^(\.?temp|sandbox)[\/\\]/i, '');
    if (stripped === filename && ['.temp', 'temp', 'sandbox'].includes(lowerFilename)) {
      return tempDir;
    }
    return path.join(tempDir, stripped);
  }

  // .workspaces/ paths — resolve inside EterX root (where sub-agents and sandbox live)
  if (
    lowerFilename === '.workspaces' ||
    lowerFilename.startsWith('.workspaces/')
  ) {
    return path.resolve(process.cwd(), filename);
  }

  // Legacy tracker names resolve inside task storage, never the repo root.
  if (lowerFilename.startsWith('.agent_task_tracker')) {
    return path.resolve(process.cwd(), '.workspaces', '.tasks', '_manual', path.basename(filename));
  }

  // Default for user requests: REAL Desktop
  const finalPath = path.resolve(desktopPath, filename);

  // Double-check: make sure resolved path isn't somehow inside EterX
  const protection = checkEterXProtection(finalPath);
  if (protection.blocked) {
    // Redirect to Desktop instead
    return path.resolve(desktopPath, path.basename(filename));
  }

  return finalPath;
}

/**
 * Get info about the path resolution system for debugging.
 */
export function getPathResolverInfo(): {
  EterXRoot: string;
  desktopPath: string;
  tempDir: string;
  protectedDirs: string[];
} {
  return {
    EterXRoot: EterX_ROOT,
    desktopPath: getRealDesktopPath(),
    tempDir: path.resolve(process.cwd(), '.temp'),
    protectedDirs: PROTECTED_SUBDIRS,
  };
}
