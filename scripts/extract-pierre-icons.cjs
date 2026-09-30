const fs = require('fs');
const path = require('path');

const builtInIconsPath = path.join(__dirname, '../node_modules/@pierre/trees/dist/builtInIcons.js');
const text = fs.readFileSync(builtInIconsPath, 'utf8');

const targetDir = path.join(__dirname, '../public/icons/pierre');
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

const filesTargetDir = path.join(__dirname, '../public/icons/files');

const tokenColors = {
  default: '#adadb1',
  astro: '#d568ea',
  babel: '#ffd452',
  bash: '#5ecc71',
  console: '#5ecc71',
  biome: '#69b1ff',
  bootstrap: '#9d6afb',
  browserslist: '#ffd452',
  bun: '#c4a5c9',
  c: '#69b1ff',
  cpp: '#69b1ff',
  claude: '#ffa359',
  css: '#9d6afb',
  database: '#d568ea',
  docker: '#69b1ff',
  eslint: '#9d6afb',
  git: '#d5512f',
  go: '#68cdf2',
  graphql: '#ff678d',
  html: '#ffa359',
  image: '#ff678d',
  javascript: '#ffd452',
  json: '#ffa359',
  markdown: '#5ecc71',
  mcp: '#64d1db',
  nextjs: '#ffffff',
  next: '#ffffff',
  npm: '#ff6762',
  oxc: '#68cdf2',
  postcss: '#ff6762',
  prettier: '#64d1db',
  python: '#69b1ff',
  react: '#68cdf2',
  ruby: '#ff6762',
  rust: '#ffa359',
  sass: '#ff678d',
  stylelint: '#ffffff',
  svelte: '#ffa359',
  svg: '#ffa359',
  svgo: '#68cdf2',
  swift: '#ffa359',
  table: '#5ecc71',
  spreadsheet: '#5ecc71',
  tailwind: '#68cdf2',
  terraform: '#9d6afb',
  text: '#adadb1',
  document: '#adadb1',
  typescript: '#69b1ff',
  vite: '#ffd452',
  vscode: '#69b1ff',
  vue: '#5ecc71',
  wasm: '#9d6afb',
  webpack: '#68cdf2',
  yml: '#ff678d',
  yaml: '#ff678d',
  zig: '#ffa359',
  zip: '#ffd452',
  font: '#d568ea',
  lock: '#adadb1',
  settings: '#64d1db',
  folder: '#ffa359',
  pdf: '#ff6762',
};

const symbols = [...text.matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)];

for (const match of symbols) {
  const id = match[1];
  const viewBox = match[2];
  const innerSvg = match[3].trim();
  
  let token = id.replace('file-tree-builtin-', '').replace('file-tree-icon-', '');
  const color = tokenColors[token] || '#adadb1';
  
  // Colored version: replaces currentColor with specific color
  const coloredSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="${color}" color="${color}">\n  ${innerSvg}\n</svg>\n`;
  fs.writeFileSync(path.join(targetDir, `${token}.svg`), coloredSvg);
  
  // Also write aliases into public/icons/files for existing compatibility
  if (token === 'yml') {
    fs.writeFileSync(path.join(targetDir, 'yaml.svg'), coloredSvg);
  }
  if (token === 'table') {
    fs.writeFileSync(path.join(targetDir, 'spreadsheet.svg'), coloredSvg);
  }
  if (token === 'text') {
    fs.writeFileSync(path.join(targetDir, 'document.svg'), coloredSvg);
  }
  if (token === 'bash') {
    fs.writeFileSync(path.join(targetDir, 'console.svg'), coloredSvg);
  }
}

// Write folder.svg
const folderSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#ffa359" color="#ffa359">
  <path d="M14.5 15H4.5C3.67157 15 3 14.3284 3 13.5V6.5C3 5.67157 3.67157 5 4.5 5H8.4C8.78516 5 9.15557 5.14816 9.43448 5.41379L10.0655 6.01478C10.3444 6.28041 10.7148 6.42857 11.1 6.42857H14.5C15.3284 6.42857 16 7.10014 16 7.92857V13.5C16 14.3284 15.3284 15 14.5 15Z" fill="#ffa359"/>
  <path opacity="0.4" d="M13 5.42857H11.1C10.9716 5.42857 10.8481 5.37918 10.7552 5.29064L10.1241 4.68965C9.65928 4.24694 9.04194 4 8.4 4H4.5C3.11929 4 2 5.11929 2 6.5V11H1.5C0.671573 11 0 10.3284 0 9.5V2.5C0 1.67157 0.671573 1 1.5 1H5.4C5.78516 1 6.15557 1.14816 6.43448 1.41379L7.06552 2.01478C7.34443 2.28041 7.71484 2.42857 8.1 2.42857H11.5C12.3284 2.42857 13 3.10014 13 3.92857V5.42857Z" fill="#ffa359"/>
</svg>\n`;
fs.writeFileSync(path.join(targetDir, 'folder.svg'), folderSvg);

// Now copy all Pierre icons into public/icons/files to upgrade that pack as well
for (const file of fs.readdirSync(targetDir)) {
  fs.copyFileSync(path.join(targetDir, file), path.join(filesTargetDir, file));
}

console.log('Successfully generated Pierre colored SVGs in public/icons/pierre and updated public/icons/files');
