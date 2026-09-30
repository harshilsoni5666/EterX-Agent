/**
 * Small path helpers shared by browser-rendered components.
 *
 * Do not import Node's `path` module here: this file is also bundled into the
 * browser renderer. The values passed to these helpers are opaque paths from
 * the machine running EterX, so preserve their native separators and only
 * normalize when we need a display/key representation.
 */

export function isAbsolutePathLike(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const candidate = value.trim();
  return Boolean(candidate) && (
    candidate.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(candidate) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/.test(candidate) ||
    /^\/\/[^/]+\//.test(candidate)
  );
}

/** Return the native absolute path exposed by Electron, if one is available. */
export function getNativeFilePath(file?: File | null): string | undefined {
  if (!file) return undefined;
  const candidate = (file as File & { path?: unknown }).path;
  return isAbsolutePathLike(candidate) ? candidate.trim() : undefined;
}

/**
 * Encode the complete path in a query parameter instead of splitting it into
 * route segments. This preserves POSIX roots, Windows drive letters, UNC
 * prefixes, and filenames containing URL-significant characters.
 */
export function buildFilePreviewUrl(filePath: string | undefined | null): string {
  const value = String(filePath || '').trim();
  return value ? `/api/preview?path=${encodeURIComponent(value)}` : '';
}

export function normalizePathForComparison(value: string | undefined | null): string {
  const normalized = String(value || '').replace(/\\/g, '/').trim();
  if (!normalized) return '';

  // Windows drive and UNC paths are case-insensitive. POSIX paths are not;
  // lower-casing those here makes two real Linux/macOS files compare equal.
  const isWindowsPath = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//');
  const withoutTrailingSeparators = normalized === '/'
    ? normalized
    : /^[A-Za-z]:\/$/i.test(normalized)
      ? normalized
      : normalized.replace(/\/+$/, '');
  return isWindowsPath ? withoutTrailingSeparators.toLowerCase() : withoutTrailingSeparators;
}
