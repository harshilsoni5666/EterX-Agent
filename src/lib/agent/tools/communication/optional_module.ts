import path from 'path';
import { createRequire } from 'module';

const requireFromWorkspace = createRequire(path.join(process.cwd(), 'package.json'));

export function loadOptionalModule<T = any>(moduleName: string): T | null {
  try {
    return requireFromWorkspace(moduleName) as T;
  } catch {
    return null;
  }
}
