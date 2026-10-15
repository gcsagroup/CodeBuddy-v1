import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessPrompt } from '../prompt-content.mjs';

test('ACP text, embedded context and images preserve their actual Harness shapes', () => {
  const data = Buffer.from('isolated-image-bytes').toString('base64');
  assert.deepEqual(harnessPrompt([{ type: 'text', text: 'read this' }, { type: 'image', data, mimeType: 'image/png' }, { type: 'resource', resource: { uri: 'file:///fixture.txt', text: 'attached data' } }]), [
    { type: 'text', text: 'read this' }, { type: 'image', data, mediaType: 'image/png' }, { type: 'text', text: 'Attached resource: file:///fixture.txt\nattached data' },
  ]);
});

test('empty, invalid base64 and unsupported attachments fail before model admission', () => {
  for (const value of [[], null, [{ type: 'text', text: '  ' }], [{ type: 'image', data: 'a===', mimeType: 'image/png' }], [{ type: 'image', data: 'YQ', mimeType: 'image/png' }], [{ type: 'image', data: 'YQ==', mimeType: 'image/svg+xml' }], [{ type: 'resource', resource: { blob: 'YQ==' } }]]) assert.throws(() => harnessPrompt(value));
});
