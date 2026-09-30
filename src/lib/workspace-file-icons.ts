// Pierre icon theme mappings (from trees.software / @pierre/trees)
const extensions: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', jsx: 'react', tsx: 'react',
  py: 'python', pyw: 'python', html: 'html', htm: 'html', xml: 'html', css: 'css', scss: 'sass', sass: 'sass', less: 'css',
  json: 'json', jsonc: 'json', jsonl: 'json', yaml: 'yml', yml: 'yml', toml: 'settings', ini: 'settings', cfg: 'settings', env: 'settings',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'bash', psm1: 'bash', bat: 'bash', cmd: 'bash',
  rs: 'rust', go: 'go', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
  vue: 'vue', svelte: 'svelte', md: 'markdown', mdx: 'markdown', txt: 'text', log: 'text',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', ico: 'image', bmp: 'image', tiff: 'image', tif: 'image', heic: 'image', svg: 'svg',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video', mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio',
  pdf: 'pdf', doc: 'word', docx: 'word', odt: 'word', pages: 'word', xls: 'table', xlsx: 'table', xlsm: 'table', csv: 'table', tsv: 'table', ods: 'table', numbers: 'table', ppt: 'powerpoint', pptx: 'powerpoint', odp: 'powerpoint', key: 'powerpoint',
  zip: 'zip', tar: 'zip', gz: 'zip', bz2: 'zip', xz: 'zip', rar: 'zip', '7z': 'zip', sql: 'database', db: 'database', sqlite: 'database', sqlite3: 'database',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', exe: 'exe', dll: 'exe', so: 'exe', dylib: 'exe', lock: 'lock',
  graphql: 'graphql', gql: 'graphql', astro: 'astro', tf: 'terraform', wasm: 'wasm', zig: 'zig',
};
const folders: Record<string, string> = {
  src: 'src', source: 'src', public: 'public', assets: 'public', test: 'test', tests: 'test', __tests__: 'test', config: 'config', '.vscode': 'config', components: 'components', api: 'api', images: 'images', docs: 'docs', documentation: 'docs', node_modules: 'node',
};
export function workspaceFileIcon(path: string, folder = false): string {
  const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase() || '';
  if (folder) return folders[name] ? 'folder-' + folders[name] : 'folder';
  if (name === 'package.json' || name === 'package-lock.json' || name === '.npmrc') return 'npm';
  if (name === 'yarn.lock') return 'yarn';
  if (name === 'pnpm-lock.yaml' || name === 'pnpm-workspace.yaml') return 'pnpm';
  if (name === 'bun.lockb' || name === 'bun.lock') return 'bun';
  if (name === '.gitignore' || name === '.gitattributes' || name === '.gitmodules') return 'git';
  if (name === 'dockerfile' || name.startsWith('docker-compose.') || name === '.dockerignore') return 'docker';
  if (/^tsconfig(?:\..+)?\.json$/.test(name)) return 'tsconfig';
  if (name.includes('eslint')) return 'eslint';
  if (name.includes('prettier')) return 'prettier';
  if (name.includes('tailwind')) return 'tailwind';
  if (name.includes('postcss')) return 'postcss';
  if (name.includes('biome')) return 'biome';
  if (name.includes('oxc')) return 'oxc';
  if (name.includes('stylelint')) return 'stylelint';
  if (name.includes('claude')) return 'claude';
  if (name.startsWith('next.config.')) return 'nextjs';
  if (name.startsWith('vite.config.')) return 'vite';
  if (name.startsWith('webpack.config.')) return 'webpack';
  if (name === '.env' || name.startsWith('.env.')) return 'settings';
  if (name === 'makefile') return 'bash';
  const dot = name.lastIndexOf('.');
  return (dot > 0 && extensions[name.slice(dot + 1)]) || 'text';
}
