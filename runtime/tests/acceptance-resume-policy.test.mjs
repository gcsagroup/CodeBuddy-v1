import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { permissionDecision, assertPrefixPreserved, assertQuiescent } from '../../scripts/accept-real-codepro-resume.mjs';

const cwd = path.resolve('isolated-acceptance-project'), command = "& 'node.exe' --test tests/project.test.mjs";
test('real-model acceptance restricts writes to phase files and never permits outside paths, arbitrary commands or network tools', () => {
  const decide = (title, input, phase = 'initial', checkpointRequested = false) => permissionDecision(cwd, command, title, input, { phase, checkpointRequested });
  assert.equal(decide('write', { file_path: 'packages/money/index.mjs' }), 'allow');
  assert.equal(decide('write', { file_path: 'packages/invoice/index.mjs' }), 'deny');
  assert.equal(decide('write', { file_path: 'packages/money/index.mjs' }, 'resumed'), 'deny');
  assert.equal(decide('write', { file_path: 'tests/project.test.mjs' }, 'resumed'), 'allow');
  assert.equal(decide('write', { file_path: '../outside.mjs' }), 'deny');
  assert.equal(decide('read', { file_path: path.join(cwd + '-sibling', 'file.txt') }), 'deny');
  assert.equal(decide('read', {}), 'deny');
  assert.equal(decide('write', { file_path: 'packages/money/index.mjs' }, 'initial', true), 'deny');
  assert.equal(decide('pwsh', { command }), 'deny');
  assert.equal(decide('pwsh', { command }, 'resumed'), 'review');
  assert.equal(decide('pwsh', { command: command + '; git status' }, 'resumed'), 'deny');
  assert.equal(decide('pwsh', { command, background: true }, 'resumed'), 'deny');
  assert.equal(decide('pwsh', { command, run_in_background: true }, 'resumed'), 'deny');
  assert.equal(decide('pwsh', { command, workdir: '..' }, 'resumed'), 'deny');
  assert.equal(decide('pwsh', { command, sandbox_permissions: 'danger-full-access' }, 'resumed'), 'deny');
  assert.equal(decide('pwsh', { command, workdir: cwd }, 'resumed'), 'review');
  assert.equal(decide('web_fetch', { url: 'https://example.com' }, 'resumed'), 'deny');
});
test('acceptance rejects live or uncertain checkpoints and any altered or duplicate saved event', () => {
  const paused = { state: 'paused', activeAttempt: null, recovery: { pendingEffects: 0, uncertainEffects: 0 }, effects: [{ state: 'completed', requiresResolution: false }] };
  assert.doesNotThrow(() => assertQuiescent(paused));
  assert.throws(() => assertQuiescent({ ...paused, activeAttempt: 'running' }));
  assert.throws(() => assertQuiescent({ ...paused, recovery: { pendingEffects: 0, uncertainEffects: 1 } }));
  const before = { runId: 'same', events: [{ eventId: 'one', eventType: 'tool_result', payload: { outcome: 'succeeded' } }] };
  assert.doesNotThrow(() => assertPrefixPreserved(before, { ...before, events: [...before.events, { eventId: 'two', eventType: 'run_resumed' }] }));
  assert.throws(() => assertPrefixPreserved(before, { ...before, runId: 'different' }));
  assert.throws(() => assertPrefixPreserved(before, { ...before, events: [...before.events, ...before.events] }));
  assert.throws(() => assertPrefixPreserved(before, { ...before, events: [{ ...before.events[0], payload: { outcome: 'failed' } }] }));
});
