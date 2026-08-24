import assert from 'node:assert/strict';
import {
  buildTitlePrompt,
  buildTemporaryTitle,
  cleanGeneratedTitle,
  compactTitleHistory,
  TITLE_MAX_CONTEXT_CHARS,
  TITLE_MAX_CONTEXT_MESSAGES,
  TITLE_MAX_MESSAGE_CHARS,
} from '../src/lib/chat/title-generation';

const main = () => {
  const history = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'model',
    parts: [{ text: `${index} ${'large payload '.repeat(200)}` }],
    ignoredToolPayload: 'x'.repeat(100_000),
  }));
  history.push({ role: 'user', parts: [{ text: 'Fix the slow title generation path' }], ignoredToolPayload: '' });

  const compact = compactTitleHistory(history);
  assert.ok(compact.length <= TITLE_MAX_CONTEXT_MESSAGES);
  assert.ok(compact.reduce((total, message) => total + message.text.length, 0) <= TITLE_MAX_CONTEXT_CHARS);
  assert.ok(compact.every(message => message.text.length <= TITLE_MAX_MESSAGE_CHARS));
  assert.equal(compact.at(-1)?.text, 'Fix the slow title generation path');
  assert.ok(!JSON.stringify(compact).includes('ignoredToolPayload'));

  const prompt = buildTitlePrompt(history);
  assert.match(prompt, /Latest user request: Fix the slow title generation path/);
  assert.ok(prompt.length < 3_500, `title prompt unexpectedly large: ${prompt.length}`);

  assert.equal(cleanGeneratedTitle('Title: "Fast Title Generation."'), 'Fast Title Generation');
  assert.equal(cleanGeneratedTitle('one'), null);
  assert.equal(cleanGeneratedTitle('Latest user request: ignored'), null);
  assert.equal(cleanGeneratedTitle('A Useful Title With Too Many Words'), 'A Useful Title With');

  assert.equal(buildTemporaryTitle('Fix the slow title generation path'), 'Fix the slow');
  assert.equal(buildTemporaryTitle('  **Create**   a dashboard\nwith charts  '), 'Create a dashboard');
  assert.equal(buildTemporaryTitle('https://example.com'), null);

  console.log('title-generation.integration: passed');
};

main();
