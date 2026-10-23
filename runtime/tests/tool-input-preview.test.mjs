import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolInputPreview } from '../harness/tool-input-preview.mjs';

test('content-first repetitive input exposes bounded size, never a guessed filename or the draft body', () => {
  const view = createToolInputPreview();
  const delta = argumentsDelta => view.push({ type: 'tool-call-delta', index: 0, id: 'call', name: 'write', argumentsDelta });
  delta('{"content":"');
  for (let i = 0; i < 303; i++) delta('integration-check-2/summarize.test.js\\n');
  const preview = view.read(0);
  assert.equal(preview.name, 'write');
  assert.ok(preview.kilobytes > 10);
  assert.equal(preview.path, undefined);
  assert.ok(JSON.stringify(preview).length < 100);
  delta('","file_path":"目录/引号\\\"与\\uD83D\\uDE42.js');
  assert.equal(view.read(0).path, undefined, 'an unfinished path is not a file identity');
  delta('"}');
  assert.equal(view.read(0).path, '目录/引号"与🙂.js');
  view.clear();
  assert.equal(view.read(0), undefined);
});

test('interleaved calls retain independent input size and never expose generic tool secrets', () => {
  const view = createToolInputPreview();
  view.push({ type: 'tool-call-delta', index: 0, id: 'a', name: 'write', argumentsDelta: '{"file_path":"a.js","content":"abc' });
  view.push({ type: 'tool-call-delta', index: 1, id: 'b', name: 'generate_image', argumentsDelta: '{"apiKey":"PRIVATE","content":"PRIVATE","path":"PRIVATE"}' });
  assert.deepEqual(view.read(1), { id: 'b', name: 'generate_image' });
  assert.deepEqual(view.read(0), { id: 'a', name: 'write', path: 'a.js', kilobytes: 1 });
  view.push({ type: 'tool-call-delta', index: 0, id: 'wrong', name: 'write', argumentsDelta: 'WRONG' });
  assert.deepEqual(view.read(0), { id: 'a', name: 'write', path: 'a.js', kilobytes: 1 });
});
