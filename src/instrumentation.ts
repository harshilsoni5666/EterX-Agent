export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initializeCodexBridge } = await import('./lib/agent/codex-subscription-runtime');
    initializeCodexBridge();
    const { initializeTelemetry } = await import('./lib/telemetry/runtime');
    initializeTelemetry();
  }
}
