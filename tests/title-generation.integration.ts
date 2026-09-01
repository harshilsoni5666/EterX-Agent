import assert from 'node:assert/strict';
import {
  buildTitlePrompt,
  buildTemporaryTitle,
  cleanGeneratedTitle,
  compactTitleHistory,
  extractGeneratedTitleText,
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
  assert.equal(cleanGeneratedTitle('one'), 'one');
  assert.equal(cleanGeneratedTitle('Latest user request: ignored'), null);
  assert.equal(cleanGeneratedTitle('A Useful Title With Too Many Words'), 'A Useful Title With');
  assert.equal(cleanGeneratedTitle('\n\n**Reliable Model Titles**\n'), 'Reliable Model Titles');
  assert.equal(cleanGeneratedTitle('```text\nCross Provider Titles\n```'), 'Cross Provider Titles');
  assert.equal(cleanGeneratedTitle('{"title":"Universal Title Support"}'), 'Universal Title Support');
  assert.equal(cleanGeneratedTitle({ content: [{ type: 'text', text: 'Structured Provider Output' }] }), 'Structured Provider Output');
  assert.equal(cleanGeneratedTitle({ content: [{ type: 'reasoning', text: 'ignore this' }, { type: 'text', text: 'Final Clean Title' }] }), 'Final Clean Title');
  assert.equal(cleanGeneratedTitle({ content: {} }), null);
  assert.equal(cleanGeneratedTitle('[object Object]'), null);
  assert.equal(extractGeneratedTitleText([{ type: 'output_text', text: 'Array Content Title' }]), 'Array Content Title');

  assert.equal(buildTemporaryTitle('Hey, can you please fix the broken login flow?'), 'fix the broken login');
  assert.equal(buildTemporaryTitle('Create a dashboard with charts'), 'Create a dashboard with');
  assert.equal(buildTemporaryTitle('https://example.com'), null);

  console.log('title-generation.integration: passed');
};

main();
