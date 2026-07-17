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

export const getFileIconPath = (filepath: string): string => {
  const ext = filepath.split('.').pop()?.toLowerCase();
  const filename = filepath.split('/').pop()?.toLowerCase() || '';

  if (filename.startsWith('.git') || filename.includes('git')) {
    return '/icons/files/git.svg';
  }
  if (filename.includes('eslint')) {
    return '/icons/files/eslint.svg';
  }
  if (filename.includes('prettier')) {
    return '/icons/files/prettier.svg';
  }
  if (filename.includes('tsconfig')) {
    return '/icons/files/tsconfig.svg';
  }
  if (filename === 'package.json') {
    return '/icons/files/npm.svg';
  }
  if (filename === 'yarn.lock') {
    return '/icons/files/yarn.svg';
  }
  if (filename === 'pnpm-lock.yaml') {
    return '/icons/files/pnpm.svg';
  }
  if (filename.includes('next.config')) {
    return '/icons/files/next.svg';
  }
  if (filename.includes('vite.config')) {
    return '/icons/files/vite.svg';
  }
  if (filename.includes('webpack.config')) {
    return '/icons/files/webpack.svg';
  }
  if (filename.startsWith('.env') || filename === 'settings.json') {
    return '/icons/files/settings.svg';
  }

  switch (ext) {
    case 'tsx':
    case 'jsx':
      return '/icons/files/react.svg';
    case 'ts':
      return '/icons/files/typescript.svg';
    case 'js':
      return '/icons/files/javascript.svg';
    case 'py':
      return '/icons/files/python.svg';
    case 'html':
      return '/icons/files/html.svg';
    case 'css':
      return '/icons/files/css.svg';
    case 'json':
      return '/icons/files/json.svg';
    case 'go':
      return '/icons/files/go.svg';
    case 'md':
      return '/icons/files/markdown.svg';
    case 'sh':
    case 'bash':
    case 'zsh':
      return '/icons/files/console.svg';
    case 'svg':
      return '/icons/files/svg.svg';
    case 'yaml':
    case 'yml':
      return '/icons/files/yaml.svg';
    case 'dockerfile':
      return '/icons/files/docker.svg';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'ico':
      return '/icons/files/image.svg';
    case 'pdf':
      return '/icons/files/pdf.svg';
    case 'zip':
    case 'tar':
    case 'gz':
    case 'rar':
      return '/icons/files/zip.svg';
    case 'lock':
      return '/icons/files/lock.svg';
    case 'sql':
    case 'db':
      return '/icons/files/database.svg';
    case 'sass':
    case 'scss':
      return '/icons/files/sass.svg';
    default:
      return '/icons/files/document.svg';
  }
};
