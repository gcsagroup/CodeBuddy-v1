const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const storage = require('../storage-management.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-locator-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('codebuddy-locator-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, locator: path.join(root, 'data-root.txt'), source: path.join(root, '旧 数据'), target: path.join(root, '新 数据') };
}
test('removed storage UI retains default and existing Unicode data locations without writing to them', async t => {
  const f = await fixture(t);
  assert.equal(storage.readDataRoot(f.locator, f.source), f.source);
  await fs.writeFile(f.locator, '\uFEFF' + f.target + '\r\n');
  const before = await fs.readFile(f.locator);
  assert.equal(storage.readDataRoot(f.locator, f.source), f.target);
  assert.deepEqual(await fs.readFile(f.locator), before);
  await fs.writeFile(f.locator, 'relative-folder');
  assert.throws(() => storage.readDataRoot(f.locator, f.source), /完整/);
  assert.throws(() => storage.managedRoot(path.parse(f.root).root), /根目录/);
});
test('legacy migration journal recovery preserves the committed data location', async t => {
  const f = await fixture(t);
  const job = { version: 1, source: f.source, target: f.target, parentPid: 2147483647, workerPid: null, status: 'copying' };
  await fs.writeFile(storage.jobFileFor(f.locator), JSON.stringify(job));
  assert.equal(storage.readMigration(f.locator).status, 'failed');
  await fs.writeFile(f.locator, f.target + '\n');
  assert.equal(storage.readMigration(f.locator).status, 'completed');
  storage.assertNoMigration(f.locator);
});
test('a still-running legacy migration blocks a second writer; no new migration API remains', async t => {
  const f = await fixture(t);
  await fs.writeFile(storage.jobFileFor(f.locator), JSON.stringify({ version: 1, source: f.source, target: f.target, status: 'copying', parentPid: process.pid, workerPid: null }));
  assert.throws(() => storage.assertNoMigration(f.locator), /正在迁移/);
  assert.equal(storage.prepareMigration, undefined);
  assert.equal(storage.runMigration, undefined);
  assert.equal(storage.inspectStorage, undefined);
});
