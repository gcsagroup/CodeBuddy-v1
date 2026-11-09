import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHarnessDriver } from '../harness/index.mjs';

test('concurrent cold history reads and permission admission share the native write handle', { timeout: 30000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'codebuddy-cold-reads-'));
  const options = { cwd, dataDir: join(cwd, 'state') };
  const id = randomUUID();
  let driver = await createHarnessDriver(options);
  t.after(() => driver.close());
  await driver.permissions(id, { cwd });
  await driver.setPlanMode(id, true);
  await driver.close();
  driver = await createHarnessDriver(options);
  const reads = await Promise.allSettled([
    driver.getPlanMode(id), driver.getGoal(id), driver.permissions(id, { cwd }),
    driver.getPlanMode(id), driver.getGoal(id),
  ]);
  assert.deepEqual(reads.map(result => result.status), Array(5).fill('fulfilled'),
    reads.filter(result => result.status === 'rejected').map(result => String(result.reason)).join('\n'));
  assert.equal(reads[0].value.active, true);
  assert.equal(reads[1].value, undefined);
  await driver.setPlanMode(id, false);
  assert.equal((await driver.getPlanMode(id)).active, false);
});
