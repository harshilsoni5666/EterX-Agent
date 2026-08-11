export type SupportedInputPlatform = 'win32' | 'darwin' | 'linux';

export type CommonShortcutAction =
  | 'select_all'
  | 'copy'
  | 'paste'
  | 'save'
  | 'undo'
  | 'close_window';

/**
 * Return the native shortcut for an action while keeping the action name
 * platform-neutral for callers. `close_window` is intentionally native too:
 * macOS apps close with Cmd+W, while Windows/Linux use Alt+F4.
 */
export function getPlatformShortcut(
  action: CommonShortcutAction,
  platform: SupportedInputPlatform = process.platform as SupportedInputPlatform,
): string {
  const primary = platform === 'darwin' ? 'cmd' : 'ctrl';
  const shortcuts: Record<CommonShortcutAction, string> = {
    select_all: `${primary}+a`,
    copy: `${primary}+c`,
    paste: `${primary}+v`,
    save: `${primary}+s`,
    undo: `${primary}+z`,
    close_window: platform === 'darwin' ? 'cmd+w' : 'alt+f4',
  };
  return shortcuts[action];
}

/**
 * Normalize the conventional `ctrl+...` spelling used by tool callers to the
 * platform's primary modifier. Explicit `control+...` remains Control on
 * macOS for callers that genuinely need the non-primary modifier.
 */
export function normalizeShortcutForPlatform(
  shortcut: string,
  platform: SupportedInputPlatform = process.platform as SupportedInputPlatform,
): string {
  const value = String(shortcut || '').trim();
  if (!value) return value;
  if (platform === 'darwin') return value.replace(/(^|\+)ctrl(?=\+|$)/gi, '$1cmd');
  return value.replace(/(^|\+)(cmd|command|meta)(?=\+|$)/gi, '$1ctrl');
}
