export type ActivitySurface = 'browser' | 'computer';

const browserTools = new Set([
  'browser', 'browser_control', 'browser_use', 'browser_launch',
  'browser_navigate', 'browser_click', 'browser_snapshot', 'browser_screenshot',
]);
const computerTools = new Set([
  'computer', 'computer_control', 'computer_use', 'screen_agent',
  'screenshot', 'screenshot_capture', 'computer_screenshot',
]);

export function getControlToolSurface(name: unknown): ActivitySurface | undefined {
  const qualifiedName = String(name ?? '').trim().toLowerCase();
  const tool = qualifiedName
    .replace(/^mcp__.+?__/, '')
    .replace(/^.*\./, '')
    .replace(/[\s-]+/g, '_');

  if (browserTools.has(tool) || qualifiedName.startsWith('mcp__playwright__browser_')) return 'browser';
  if (computerTools.has(tool)) return 'computer';
  return undefined;
}
