const fs = require('fs');
const path = require('path');
const https = require('https');

const iconsToDownload = {
  'markdown.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/markdown.svg',
  'html.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/html.svg',
  'css.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/css.svg',
  'react.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/react.svg',
  'typescript.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/typescript.svg',
  'javascript.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/javascript.svg',
  'python.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/python.svg',
  'json.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/json.svg',
  'go.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/go.svg',
  'console.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/console.svg',
  'git.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/git.svg',
  'document.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/document.svg',
  // Extra icons
  'npm.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/npm.svg',
  'node.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/node.svg',
  'yarn.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/yarn.svg',
  'pnpm.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/pnpm.svg',
  'svg.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/svg.svg',
  'yaml.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/yaml.svg',
  'docker.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/docker.svg',
  'eslint.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/eslint.svg',
  'prettier.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/prettier.svg',
  'tsconfig.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/tsconfig.svg',
  'image.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/image.svg',
  'pdf.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/pdf.svg',
  'zip.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/zip.svg',
  'text.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/text.svg',
  'lock.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/lock.svg',
  'webpack.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/webpack.svg',
  'vite.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/vite.svg',
  'next.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/next.svg',
  'database.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/database.svg',
  'settings.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/settings.svg',
  'sass.svg': 'https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/master/icons/sass.svg'
};

const outputDir = path.join(__dirname, '..', 'public', 'icons', 'files');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function main() {
  console.log(`Starting download of all icon types to ${outputDir}...`);
  for (const [filename, url] of Object.entries(iconsToDownload)) {
    const dest = path.join(outputDir, filename);
    try {
      await downloadFile(url, dest);
      console.log(`Downloaded: ${filename}`);
    } catch (err) {
      console.error(`Error downloading ${filename}: ${err.message}`);
    }
  }
  console.log('Finished downloading all icon types.');
}

main();
