import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSourceStatus } from '../source-status.mjs';

test('preview identity detects edits, additions and removals without confusing test artifacts with runtime source', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'server.mjs'), 'old');
  const read = await createSourceStatus(root, { intervalMs: 0 });
  const initial = await read();
  await mkdir(path.join(root, 'tests'));
  await writeFile(path.join(root, 'tests', 'fixture.mjs'), 'fixture');
  assert.equal((await read()).restartRequired, false);
  await writeFile(path.join(root, 'server.mjs'), 'new');
  const changed = await read();
  assert.equal(changed.restartRequired, true);
  assert.equal(changed.sourceHash, initial.sourceHash);
  await writeFile(path.join(root, 'server.mjs'), 'old');
  assert.equal((await read()).restartRequired, false);
  await writeFile(path.join(root, 'new.mjs'), 'new');
  assert.equal((await read()).restartRequired, true);
  await rm(path.join(root, 'new.mjs'));
  assert.equal((await read()).restartRequired, false);
});
