import assert from 'node:assert/strict';
import {
  filterLiveUserVisibleTraces,
  filterUserVisibleTraces,
  isLiveUserVisibleTrace,
  isPrivateReasoningTrace,
} from '../src/lib/agent/trace-visibility';
import { formatVisibleWorkNote } from '../src/lib/agent/work-note';

assert.equal(isPrivateReasoningTrace({ type: 'thought_stream', text: 'Image 1 analysis: ...' }), true);
assert.equal(isPrivateReasoningTrace({ type: 'analysis', text: 'private scratch work' }), true);
assert.equal(isPrivateReasoningTrace({ type: 'answer', visibility: 'internal', text: 'private' }), true);
assert.equal(isPrivateReasoningTrace({ type: 'work_note', text: 'I’m checking the screenshot now.' }), false);
assert.equal(isLiveUserVisibleTrace({ type: 'thought_stream', uiOnly: true, isStreaming: true }), true);
assert.equal(isLiveUserVisibleTrace({ type: 'thought_stream', text: 'private scratch work' }), false);
assert.equal(isLiveUserVisibleTrace({ type: 'analysis', uiOnly: true, text: 'private scratch work' }), false);
assert.equal(isLiveUserVisibleTrace({ type: 'tool_call', toolName: 'attachment_view', text: 'Viewed an image' }), false);
assert.equal(isLiveUserVisibleTrace({ type: 'tool_call', name: 'attachment_view', text: 'Viewed a video' }), false);

assert.deepEqual(
  filterUserVisibleTraces([
    { type: 'thought_stream', text: 'private' },
    { type: 'work_note', text: 'Checking the layout now.' },
    { type: 'answer', text: 'Done.' },
  ]),
  [
    { type: 'work_note', text: 'Checking the layout now.' },
    { type: 'answer', text: 'Done.' },
  ],
);

assert.deepEqual(
  filterLiveUserVisibleTraces([
    { type: 'thought_stream', uiOnly: true, text: '' },
    { type: 'thought_stream', text: 'unmarked private reasoning' },
    { type: 'analysis', uiOnly: true, text: 'private scratch work' },
    { type: 'work_note', text: 'Checking the layout now.' },
  ]),
  [
    { type: 'thought_stream', uiOnly: true, text: '' },
    { type: 'work_note', text: 'Checking the layout now.' },
  ],
);

assert.equal(formatVisibleWorkNote('Image 1 analysis: the header is blue'), 'Image 1 analysis: the header is blue');
assert.equal(formatVisibleWorkNote('Analysis: I should answer with three bullets'), 'Analysis: I should answer with three bullets');
assert.equal(formatVisibleWorkNote('The user wants a concise answer'), 'The user wants a concise answer');
assert.equal(formatVisibleWorkNote('<analysis>private visual inspection</analysis>I’m checking the layout now.'), 'I’m checking the layout now.');
assert.equal(formatVisibleWorkNote('I’m checking the attached image’s layout and text now.'), 'I’m checking the attached image’s layout and text now.');

console.log('trace visibility integration tests passed');
