import assert from 'node:assert/strict';
import {
  buildFilePreviewUrl,
  isAbsolutePathLike,
  normalizePathForComparison,
} from '../src/lib/path-utils';

assert.equal(isAbsolutePathLike('/Users/alice/My File.png'), true);
assert.equal(isAbsolutePathLike('C:\\Users\\alice\\My File.png'), true);
assert.equal(isAbsolutePathLike('\\\\server\\share\\My File.png'), true);
assert.equal(isAbsolutePathLike('relative/file.png'), false);

const windowsPath = 'C:\\Users\\alice\\folder with spaces\\100% #1.png';
assert.equal(
  buildFilePreviewUrl(windowsPath),
  `/api/preview?path=${encodeURIComponent(windowsPath)}`,
);

assert.equal(
  normalizePathForComparison('C:\\Users\\alice\\folder\\'),
  'c:/users/alice/folder',
);

// POSIX filesystems are case-sensitive; comparison normalization must not
// collapse distinct Linux/macOS paths.
assert.equal(
  normalizePathForComparison('/Users/Alice/Report.csv'),
  '/Users/Alice/Report.csv',
);
assert.equal(normalizePathForComparison('/'), '/');

console.log('path-utils integration tests passed');
