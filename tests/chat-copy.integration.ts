import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { nextChatCopyTitle } from '../src/lib/chat-copy';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eterx-chat-copy-'));
  process.env.ETERX_DATA_DIR = path.join(root, 'data');
  process.env.ETERX_WORKSPACE_ROOT = path.join(root, 'workspace');
  try {
    await fs.outputJson(path.join(root, 'data', 'chats', 'chats.json'), { version: 1, savedAt: 1, chats: [] });
    const store = await import('../src/lib/chat-store');
    const media = await import('../src/lib/chat-media-store');
    const sourceFile = path.join(root, 'attachment.txt');
    await fs.writeFile(sourceFile, 'Independent attachment bytes');
    const [attachment] = await media.registerChatMediaAttachments('original', [{ id: 'file-one', name: 'attachment.txt', path: sourceFile }]);
    const source = {
      id: 'original', title: 'Project notes', updatedAt: 10, workspacePath: 'C:\\Projects\\Example',
      modelSelection: 'test-model', runLocation: 'local', importFolder: 'Imported folder',
      traceLogs: [
        { id: 'request', type: 'user_action', text: 'Read this file', chatId: 'original', ownerChatId: 'original', timestamp: 1, attachments: [{ id: attachment.id, path: attachment.path, name: attachment.name }] },
        { id: 'answer', type: 'answer', text: `The file: ${media.chatMediaHref('original', attachment.id)}`, timestamp: 2 },
      ],
    };
    await store.saveChatSnapshot([source, { id: 'recent', title: 'Recent chat', updatedAt: 9, traceLogs: [] }], Date.now());
    const [first, second] = await Promise.all([store.copyStoredChat('original'), store.copyStoredChat('original')]);
    assert.equal(first.chat.title, 'Project notes (1)');
    assert.equal(second.chat.title, 'Project notes (2)');
    assert.notEqual(first.chat.id, second.chat.id);
    assert.equal(first.chat.workspacePath, source.workspacePath);
    assert.equal(first.chat.importFolder, source.importFolder);
    assert.equal(first.chat.traceLogs.length, source.traceLogs.length);
    assert.equal(first.chat.traceLogs[0].ownerChatId, first.chat.id);
    assert.equal(first.chat.traceLogs[0].chatId, first.chat.id);
    assert.equal(first.chat.traceLogs[0].text, source.traceLogs[0].text);
    assert.ok(first.chat.traceLogs[1].text.includes(encodeURIComponent(first.chat.id)));
    const third = await store.copyStoredChat(first.chat.id);
    assert.equal(third.chat.title, 'Project notes (3)');
    const recent = await store.copyStoredChat('recent');
    assert.equal(recent.chat.workspacePath, null);
    assert.equal(nextChatCopyTitle('Project notes (2)', ['Project notes (1)', 'Project notes (2)']), 'Project notes (3)');
    await media.removeChatMedia(['original']);
    const copiedMedia = await media.getChatMediaAttachment(first.chat.id, attachment.id);
    assert.ok(copiedMedia);
    assert.equal(await fs.readFile(copiedMedia.path, 'utf8'), 'Independent attachment bytes');
    first.chat.traceLogs[0].text = 'Changed copy';
    assert.equal((await store.loadChatById('original') as any).traceLogs[0].text, 'Read this file');
    const snapshot = await store.loadChatSnapshot();
    await store.patchChatSnapshot([], (snapshot.chats as any[]).map(chat => chat.id), snapshot.savedAt + 1, ['original']);
    assert.ok(await store.loadChatById(first.chat.id));
    assert.equal(await store.loadChatById('original'), null);
    await assert.rejects(store.copyStoredChat('missing'), /no longer exists/);
    console.log('Chat copy checks passed: concurrent numbering, project/Recents placement, complete history, independent media and deletion.');
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('eterx-chat-copy-'));
    await fs.remove(root);
  }
}
void main();
