import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

type UserFolder = 'desktop' | 'documents' | 'downloads';
let cached: { key: string; paths: Record<UserFolder, string> } | undefined;

/** Native known folders from Electron, or registry/XDG for standalone servers. */
export function getUserFolders(): Record<UserFolder, string> {
  const home = os.homedir();
  const key = [home, process.env.ETERX_DESKTOP_DIR, process.env.ETERX_DOCUMENTS_DIR, process.env.ETERX_DOWNLOADS_DIR, process.env.XDG_CONFIG_HOME, process.env.XDG_DESKTOP_DIR, process.env.XDG_DOCUMENTS_DIR, process.env.XDG_DOWNLOAD_DIR].join('\0');
  if (cached?.key === key) return cached.paths;
  const paths = { desktop: path.join(home, 'Desktop'), documents: path.join(home, 'Documents'), downloads: path.join(home, 'Downloads') };
  const expand = (value: string) => value.replace(/^~(?=[/\\]|$)|\$HOME(?=[/\\]|$)/g, home)
    .replace(/%([^%]+)%/g, (match, name) => process.env[Object.keys(process.env).find(k => k.toLowerCase() === name.toLowerCase()) || name] || match);
  if (process.platform === 'win32' && (!process.env.ETERX_DESKTOP_DIR || !process.env.ETERX_DOCUMENTS_DIR || !process.env.ETERX_DOWNLOADS_DIR)) {
    try {
      const registry = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
      const output = execFileSync(registry, ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'], { encoding: 'utf8', timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const names: Record<string, UserFolder> = { desktop: 'desktop', personal: 'documents', '{374de290-123f-4565-9164-39c4925e467b}': 'downloads' };
      for (const line of output.split(/\r?\n/)) {
        const match = /^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
        const folder = match && names[match[1].toLowerCase()];
        if (folder && match) { const value = expand(match[2]); if (path.isAbsolute(value)) paths[folder] = value; }
      }
    } catch { /* Headless hosts may not configure known folders. */ }
  }
  if (process.platform === 'linux') {
    let config = '';
    try { config = fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'user-dirs.dirs'), 'utf8'); } catch {}
    for (const [folder, name] of Object.entries({ desktop: 'DESKTOP', documents: 'DOCUMENTS', downloads: 'DOWNLOAD' })) {
      const match = new RegExp(`^XDG_${name}_DIR="([^"]*)"`, 'm').exec(config);
      const value = expand(process.env[`XDG_${name}_DIR`] || match?.[1] || '');
      if (value && path.isAbsolute(value)) paths[folder as UserFolder] = value;
    }
  }
  for (const folder of Object.keys(paths) as UserFolder[]) {
    const supplied = process.env[`ETERX_${folder.toUpperCase()}_DIR`];
    if (supplied && path.isAbsolute(supplied)) paths[folder] = path.normalize(supplied);
  }
  cached = { key, paths };
  return paths;
}
