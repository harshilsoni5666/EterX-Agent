const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

exports.convertDocumentToPdf = async (app, source) => {
  if (typeof source !== 'string' || !path.isAbsolute(source) || !/\.docx$/i.test(source)) return null;
  if (!(await fs.stat(source).catch(() => null))?.isFile()) return null;
  // Separate both the output and LibreOffice profile for concurrent previews.
  // Reusing the normal profile can hand the request to an open editor and
  // return before conversion finishes.
  const directory = await fs.mkdtemp(path.join(app.getPath('temp'), 'eterx-document-'));
  const destination = path.join(directory, 'preview.pdf');
  const generated = path.join(directory, path.basename(source, path.extname(source)) + '.pdf');
  const ready = async file => (await fs.stat(file).catch(() => null))?.size > 0;
  const options = { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 };
  if (process.platform === 'win32') {
    // Pass paths through the environment and avoid cmd.exe string expansion
    // for spaces, Unicode, apostrophes, percent signs, and ampersands.
    const script = "$ErrorActionPreference = 'Stop'; $word = $null; $doc = $null; try { $word = New-Object -ComObject Word.Application; $word.Visible = $false; $word.DisplayAlerts = 0; $word.AutomationSecurity = 3; $doc = $word.Documents.Open($env:ETERX_PREVIEW_SOURCE, $false, $true); $doc.ExportAsFixedFormat($env:ETERX_PREVIEW_PDF, 17); } finally { if ($doc) { $doc.Close($false) }; if ($word) { $word.Quit() } }";
    try {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { ...options, env: { ...process.env, ETERX_PREVIEW_SOURCE: source, ETERX_PREVIEW_PDF: destination } });
      if (await ready(destination)) return destination;
    } catch { /* LibreOffice can preview documents when Word is unavailable. */ }
  }
  const commands = process.platform === 'darwin'
    ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice', path.join(app.getPath('home'), 'Applications/LibreOffice.app/Contents/MacOS/soffice'), 'soffice', 'libreoffice']
    : process.platform === 'win32'
      ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map(root => path.join(root, 'LibreOffice/program/soffice.exe')).concat(['soffice.exe'])
      : ['libreoffice', 'soffice', '/usr/bin/libreoffice', '/usr/bin/soffice'];
  for (const command of commands) {
    try {
      await run(command, [`-env:UserInstallation=${pathToFileURL(path.join(directory, 'profile')).href}`, '--headless', '--convert-to', 'pdf', '--outdir', directory, source], options);
      if (await ready(generated)) return generated;
    } catch { /* Try the next installed converter. */ }
  }
  return null;
};
