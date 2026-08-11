import assert from 'node:assert/strict';
import { getFileIconPath } from '../src/lib/utils/file-icon-utils';

assert.equal(
  getFileIconPath('C:\\Users\\Alice\\Report.XLSX'),
  '/icons/files/spreadsheet.svg',
);
assert.equal(
  getFileIconPath('/Users/alice/project\u002Fsrc\u002FApp.TSX'),
  '/icons/files/react.svg',
);
assert.equal(
  getFileIconPath('\\\\server\\share\\archive.7z'),
  '/icons/files/zip.svg',
);
assert.equal(
  getFileIconPath('/tmp/Dockerfile'),
  '/icons/files/docker.svg',
);
assert.equal(
  getFileIconPath('/tmp/unknown-extensionless', { extensionless: 'folder' }),
  '/icons/files/folder.svg',
);
assert.equal(
  getFileIconPath('/tmp/README', { extensionless: 'folder' }),
  '/icons/files/document.svg',
);

console.log('file-icon-utils.integration: ok');
