const path = require('path');
const { createHash } = require('crypto');

function isAbsoluteHostPath(value) {
  if (typeof value !== 'string' || value.includes('\0')) return false;
  return process.platform === 'win32' ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value) : path.isAbsolute(value);
}

// Keep existing ordinary chat IDs stable; unusual IDs must not collide after
// punctuation replacement, truncation, or Windows case folding.
function storageSegment(value, fallback) {
  const raw = String(value || fallback);
  if (/^[a-z0-9_-]{1,80}$/.test(raw) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(raw)) return raw;
  const label = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || fallback;
  return `${label}-${createHash('sha256').update(raw).digest('hex').slice(0, 20)}`;
}

function chatWorkspacePaths(workspaceRoot, userId, chatId) {
  if (!String(chatId || '').trim()) throw new Error('A chat ID is required for a chat workspace.');
  // New chat reserves its future ID before a terminal can be opened. Promoting
  // the draft therefore keeps the same files and cwd without moving live files.
  const draft = /^terminal-draft-([a-f0-9-]{36})$/i.exec(String(chatId));
  if (draft) chatId = draft[1];
  const base = path.resolve(workspaceRoot, storageSegment(userId, 'user'), 'projects', storageSegment(chatId, 'chat'));
  return { base, workspace: path.join(base, 'working'), scratch: path.join(base, 'sandbox'), output: path.join(base, 'output') };
}

module.exports = { chatWorkspacePaths, storageSegment, isAbsoluteHostPath };
