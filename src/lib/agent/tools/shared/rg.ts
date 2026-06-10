import { execSync, spawnSync } from 'child_process';

let _rgAvailable: boolean | null = null;

export function isRgAvailable(): boolean {
  if (_rgAvailable !== null) return _rgAvailable;
  try {
    execSync('rg --version', { timeout: 3000, stdio: 'pipe' });
    _rgAvailable = true;
    console.log('[rg] ripgrep available');
  } catch {
    _rgAvailable = false;
    console.warn('[rg] ripgrep not found — using slower fallbacks');
  }
  return _rgAvailable;
}

export function runRgFiles(cwd: string, options: {
  glob?: string;
  maxResults: number;
}): string[] {
  const args = ['--files', '--no-ignore-vcs'];
  if (options.glob) args.push('--glob', options.glob);
  args.push('.');

  const result = spawnSync('rg', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr || `rg --files exited with code ${result.status}`);
  }

  return result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, options.maxResults);
}
