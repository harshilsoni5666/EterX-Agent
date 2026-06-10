import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const brand = 'Co' + 'dex';
const brandLower = brand.toLowerCase();
const pro = 'Pro' + 'fessional';
const style = `${brand}-style`;
const styleLower = `${brandLower}-style`;
const styleSpaced = `${brand} style`;
const styleSpacedLower = `${brandLower} style`;
const proWorkspace = `${pro} workspace`;
const proWorkspaceLower = `${pro.toLowerCase()} workspace`;

const skipDirs = new Set([
  '.git',
  '.next',
  '.workspaces',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
]);

const textExts = new Set([
  '.cjs', '.css', '.csv', '.env', '.html', '.js', '.json', '.jsx', '.md',
  '.mjs', '.ps1', '.scss', '.sh', '.sql', '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const replacements = [
  [new RegExp(escapeRegExp(style), 'g'), 'Workspace'],
  [new RegExp(escapeRegExp(styleLower), 'g'), 'workspace'],
  [new RegExp(escapeRegExp(styleSpaced), 'g'), 'workspace'],
  [new RegExp(escapeRegExp(styleSpacedLower), 'g'), 'workspace'],
  [new RegExp(escapeRegExp(proWorkspace), 'g'), 'Workspace'],
  [new RegExp(escapeRegExp(proWorkspaceLower), 'g'), 'workspace'],
  [new RegExp(`\\b${escapeRegExp(brand)}\\b`, 'g'), 'EterX'],
  [new RegExp(`\\b${escapeRegExp(brandLower)}\\b`, 'g'), 'eterx'],
];

const isTextFile = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (textExts.has(ext)) return true;
  const base = path.basename(filePath).toLowerCase();
  return base === 'readme' || base.startsWith('.env');
};

const containsBinaryByte = (buffer) => {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
};

const walk = (dir, files = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      walk(path.join(dir, entry.name), files);
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    if (isTextFile(filePath)) files.push(filePath);
  }
  return files;
};

const changed = [];
for (const filePath of walk(root)) {
  const originalBuffer = fs.readFileSync(filePath);
  if (containsBinaryByte(originalBuffer)) continue;

  let text = originalBuffer.toString('utf8');
  const original = text;
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }

  if (text !== original) {
    fs.writeFileSync(filePath, text, 'utf8');
    changed.push(path.relative(root, filePath));
  }
}

console.log(`Updated ${changed.length} file(s).`);
for (const file of changed) console.log(file);
