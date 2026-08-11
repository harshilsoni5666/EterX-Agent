export const isProjectFile = (filepath: string): boolean => {
  if (!filepath) return false;
  const pathLower = filepath.toLowerCase();

  // Exclude EterX-Agent internal files
  if (pathLower.includes('page.tsx')) return false;
  if (pathLower.includes('chat-input.tsx')) return false;
  if (pathLower.includes('route.ts')) return false;
  if (pathLower.includes('system')) return false;
  if (pathLower.includes('walkthrough.md')) return false;
  if (pathLower.includes('task.md')) return false;
  if (pathLower.includes('implementation_plan.md')) return false;

  // Other standard excludes
  if (pathLower.includes('.system_generated')) return false;
  if (pathLower.includes('node_modules')) return false;
  if (pathLower.includes('.next')) return false;
  if (pathLower.includes('.git/')) return false;
  if (pathLower.includes('.git\\')) return false;
  if (pathLower.includes('.vscode')) return false;
  if (pathLower.includes('.temp')) return false;
  if (pathLower.includes('.gitleaks')) return false;
  if (pathLower.endsWith('.log')) return false;

  return true;
};

const FILE_ICON_ROOT = '/icons/files';

const COMMON_EXTENSIONLESS_FILES = new Set([
  'dockerfile', 'makefile', 'license', 'rakefile', 'gemfile', 'procfile',
  'readme', 'authors', 'copying', 'install', 'todo', 'changelog',
]);

const FILE_ICONS_BY_EXTENSION: Record<string, string> = {
  tsx: 'react', jsx: 'react',
  ts: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python',
  html: 'html', htm: 'html',
  css: 'css', scss: 'sass', sass: 'sass',
  json: 'json',
  go: 'go',
  md: 'markdown', mdx: 'markdown',
  sh: 'console', bash: 'console', zsh: 'console', ps1: 'console',
  svg: 'svg',
  yaml: 'yaml', yml: 'yaml',
  dockerfile: 'docker',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  avif: 'image', bmp: 'image', ico: 'image', heic: 'image', heif: 'image',
  pdf: 'pdf',
  csv: 'spreadsheet', tsv: 'spreadsheet',
  xls: 'spreadsheet', xlsx: 'spreadsheet', xlsm: 'spreadsheet', ods: 'spreadsheet',
  zip: 'zip', tar: 'zip', gz: 'zip', rar: 'zip', '7z': 'zip',
  lock: 'lock',
  sql: 'database', db: 'database', sqlite: 'database',
};

const getFileName = (filepath: string) => {
  const normalized = String(filepath || '').trim().replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() || '';
};

export const getFileIconPath = (
  filepath: string,
  options: { extensionless?: 'folder' | 'document' } = {},
): string => {
  const filename = getFileName(filepath);
  const dotIndex = filename.lastIndexOf('.');
  const ext = dotIndex > 0 ? filename.slice(dotIndex + 1) : '';

  if (filename.startsWith('.git') || filename === 'gitignore' || filename === 'gitattributes') {
    return `${FILE_ICON_ROOT}/git.svg`;
  }
  if (filename.includes('eslint')) {
    return `${FILE_ICON_ROOT}/eslint.svg`;
  }
  if (filename.includes('prettier')) {
    return `${FILE_ICON_ROOT}/prettier.svg`;
  }
  if (filename.includes('tsconfig')) {
    return `${FILE_ICON_ROOT}/tsconfig.svg`;
  }
  if (filename === 'package.json') {
    return `${FILE_ICON_ROOT}/npm.svg`;
  }
  if (filename === 'yarn.lock') {
    return `${FILE_ICON_ROOT}/yarn.svg`;
  }
  if (filename === 'pnpm-lock.yaml') {
    return `${FILE_ICON_ROOT}/pnpm.svg`;
  }
  if (filename.includes('next.config')) {
    return `${FILE_ICON_ROOT}/next.svg`;
  }
  if (filename.includes('vite.config')) {
    return `${FILE_ICON_ROOT}/vite.svg`;
  }
  if (filename.includes('webpack.config')) {
    return `${FILE_ICON_ROOT}/webpack.svg`;
  }
  if (filename.startsWith('.env') || filename === 'settings.json') {
    return `${FILE_ICON_ROOT}/settings.svg`;
  }

  if (filename === 'dockerfile' || filename === 'makefile') {
    return `${FILE_ICON_ROOT}/docker.svg`;
  }

  if (!ext && options.extensionless === 'folder' && !COMMON_EXTENSIONLESS_FILES.has(filename)) {
    return `${FILE_ICON_ROOT}/folder.svg`;
  }

  const icon = FILE_ICONS_BY_EXTENSION[ext] || (COMMON_EXTENSIONLESS_FILES.has(filename) ? 'document' : 'document');
  return `${FILE_ICON_ROOT}/${icon}.svg`;
};
