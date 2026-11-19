import test from 'node:test';
import assert from 'node:assert/strict';
import { projectImageContext } from '../harness/image-context.mjs';

test('old image history cannot poison continuation after eight generated image receipts', () => {
  const image = id => ({ type: 'image', attachment: { id } });
  const messages = [
    { role: 'user', content: [image('reference')] },
    { role: 'tool', toolCallId: 'old', content: [{ type: 'text', text: 'saved/old.png' }, image('old')] },
    ...Array.from({ length: 8 }, (_, i) => ({ role: 'tool', toolCallId: `job-${i}`, content: [
      { type: 'text', text: `completed: saved/${i}.png` }, image(`result-${i}`),
    ] })),
  ];
  const original = structuredClone(messages);
  const projected = projectImageContext(messages);
  assert.equal(projected.flatMap(m => m.content).filter(b => b.type === 'image').length, 8);
  assert.deepEqual(messages, original, 'persistent history stays intact');
  assert.match(projected[1].content[0].text, /saved\/old.png/);
  assert.match(projected[1].content[1].text, /Do not regenerate/);
  assert.equal(projectImageContext(projected), projected, 'projection reentry is idempotent');
  const continued = projectImageContext([...messages, { role: 'user', content: [{ type: 'text', text: 'continue' }] }]);
  assert.equal(continued.flatMap(m => m.content).filter(b => b.type === 'image').length, 8);
});
