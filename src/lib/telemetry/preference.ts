export function resolveTelemetryEnabled(choice: unknown, desktop: boolean): boolean {
  return choice === true || (choice === undefined && desktop);
}

export function isDesktopTelemetryRenderer(): boolean {
  return typeof window !== 'undefined'
    && (window as Window & { electronAPI?: { isElectron?: boolean } }).electronAPI?.isElectron === true;
}
