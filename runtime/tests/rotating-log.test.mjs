import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { createRotatingLog } from '../rotating-log.cjs';

test('long-running output rotates repeatedly, preserves recent bytes, and resumes after restart', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.log');
  const other = path.join(root, 'history.json');
  await writeFile(other, 'protected');
  const stream = createRotatingLog(file, 16);
  stream.write('a'.repeat(16));
  stream.end('b'.repeat(16) + 'c'.repeat(7));
  await finished(stream);
  assert.equal(await readFile(`${file}.previous`, 'utf8'), 'b'.repeat(16));
  assert.equal(await readFile(file, 'utf8'), 'c'.repeat(7));
  const restarted = createRotatingLog(file, 16);
  restarted.end('d'.repeat(20));
  await finished(restarted);
  assert.equal((await stat(file)).size, 11);
  assert.equal((await stat(`${file}.previous`)).size, 16);
  assert.equal(await readFile(other, 'utf8'), 'protected');
});
