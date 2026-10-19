import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessDriver } from '../index.mjs';

test('native read exposes a small minified file completely while retaining bounded large-line output', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-long-line-'));
  const html = '<!doctype html><script>' + 'const x = 1;'.repeat(600) + 'window.reviewTarget = "READ_END_MARKER";</script>';
  await writeFile(join(root, 'dashboard.html'), html);
  await writeFile(join(root, 'large-unicode.txt'), '界'.repeat(22000) + 'BEYOND_OUTPUT_BUDGET');
  const driver = await createHarnessDriver({ dataDir: join(root, 'native'), cwd: root, instructionsHome: root });
  t.after(() => driver.close());
  const { sessionId } = await driver.createSession({
    provider: { id: 'offline-read-fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only', contextWindow: 32768 },
    model: 'fixture',
  });
  const read = file_path => driver.callTool(sessionId, 'read', { file_path }, { onPermission: () => true });
  const complete = await read('dashboard.html');
  assert.equal(complete.isError, false);
  const completeText = complete.content.map(block => block.text ?? '').join('');
  assert.ok(completeText.includes(html), 'Read-only reviewers must receive the actual end of a small minified file');
  const large = await read('large-unicode.txt');
  assert.equal(large.isError, false);
  const largeText = large.content.map(block => block.text ?? '').join('');
  assert.ok(largeText.includes('界'.repeat(100)), 'A bounded Unicode read must retain content rather than an empty byte-capped result');
  assert.ok(!largeText.includes('BEYOND_OUTPUT_BUDGET'));
  assert.ok(Buffer.byteLength(largeText) < 60 * 1024, 'The native bounded-output safeguard must remain in force');
});
