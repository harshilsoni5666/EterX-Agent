/** Reload the desktop view through the startup flow without stopping agents. */
export async function reloadApp(): Promise<void> {
  const desktop = (window as any).electronAPI;
  if (desktop?.reloadApp) {
    try {
      await desktop.reloadApp();
      return;
    } catch (error) {
      console.error('[Startup] Desktop reload failed:', error);
    }
  }
  window.location.reload();
}
