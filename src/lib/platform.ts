export type EterxDesktopPlatform = 'macos' | 'windows' | 'linux' | 'web';

/**
 * Resolve the host platform without relying on Node APIs in the renderer.
 * Electron exposes the authoritative value through the preload bridge; the
 * browser fallback keeps the same UI usable when the app is opened on the web.
 */
export function getClientPlatform(): EterxDesktopPlatform {
  if (typeof window === 'undefined') return 'web';

  const exposed = (window as Window & { electronAPI?: { platform?: string } }).electronAPI?.platform;
  if (exposed === 'macos' || exposed === 'windows' || exposed === 'linux') return exposed;

  const fingerprint = `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
  if (fingerprint.includes('mac') || fingerprint.includes('darwin')) return 'macos';
  if (fingerprint.includes('win')) return 'windows';
  if (fingerprint.includes('linux') || fingerprint.includes('x11')) return 'linux';
  return 'web';
}

export function getPrimaryModifierLabel(platform: EterxDesktopPlatform = getClientPlatform()): string {
  return platform === 'macos' ? '⌘' : 'Ctrl';
}
