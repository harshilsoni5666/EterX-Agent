import path from 'path';
import Module from 'module';

// Use a dynamically retrieved createRequire to bypass webpack's static parser analysis
const getCreateRequire = (): ((path: string) => NodeRequire) | null => {
  try {
    // 1. Try __non_webpack_require__ if in a webpack bundle
    if (typeof __non_webpack_require__ !== 'undefined') {
      const mod = __non_webpack_require__('module');
      return mod.createRequire || mod.default?.createRequire;
    }
  } catch {}

  try {
    // 2. Try default import from 'module'
    const createRequireFn = Module.createRequire || (Module as any).default?.createRequire;
    if (typeof createRequireFn === 'function') {
      return createRequireFn;
    }
  } catch {}

  return null;
};

declare const __non_webpack_require__: any;

const createRequireFn = getCreateRequire();
const requireFromWorkspace = createRequireFn 
  ? createRequireFn(path.join(process.cwd(), 'package.json'))
  : null;

export function loadOptionalModule<T = any>(moduleName: string): T | null {
  if (!requireFromWorkspace) return null;
  try {
    return requireFromWorkspace(moduleName) as T;
  } catch {
    return null;
  }
}
