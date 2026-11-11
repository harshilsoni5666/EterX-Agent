const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A receipt is evidence of an attempted update, never permission to run an
// installer at startup. Keep it outside the replaceable application package.
function readUpdateInstallAttempt(filePath) {
  let attempt;
  try {
    attempt = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (attempt?.schemaVersion !== 1 ||
    !['pending', 'succeeded', 'incomplete'].includes(attempt.status) ||
    !['id', 'fromVersion', 'targetVersion', 'installLocation', 'attemptedAt'].every(key => typeof attempt[key] === 'string' && attempt[key].length > 0)) {
    throw new Error('The last update installation receipt is invalid.');
  }
  return attempt;
}

function writeUpdateInstallAttempt(filePath, attempt) {
  const temporary = `${filePath}.tmp-${crypto.randomUUID()}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(attempt), 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    // Replace atomically, keeping the previous receipt if writing fails.
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { readUpdateInstallAttempt, writeUpdateInstallAttempt };
