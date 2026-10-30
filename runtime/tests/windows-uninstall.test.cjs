const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPlan, executePlan, cleanData } = require('../windows-uninstall.cjs');

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-windows-uninstall-')));
  // Every deletion in these tests is restricted to this freshly allocated fixture.
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), root = path.join(home, '个人 数据'), app = path.join(base, 'program');
  const locator = path.join(home, 'bootstrap/data-root.txt');
  const write = async (file, value = 'keep') => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); };
  await fs.mkdir(app);
  await write(locator, '\ufeff' + root + '\r\n');
  await write(path.join(root, 'backend/state.json'), JSON.stringify({ version: 1, sessions: [{ cwd: path.join(root, 'backend/custom-project') }] }));
  await write(path.join(root, 'backend/custom-project/work.txt'));
  await write(path.join(root, 'workspaces/project/work.txt'));
  await write(path.join(root, 'backend/workspaces/project/work.txt'));
  await write(path.join(root, 'state/electron-app/pets/custom/pet.json'));
  await write(path.join(root, 'state/electron-app/recent-dirs.json'), JSON.stringify({ dirs: [path.join(root, 'logs/recent-project')] }));
  await write(path.join(root, 'logs/recent-project/work.txt'));
  await write(path.join(root, 'logs/runtime.log'));
  await write(path.join(root, 'notes.txt'));
  return { base, root, home, app, locator, write, options: { root, home, app, locator } };
}
const exists = file => fs.access(file).then(() => true, () => false);

test('cleanup removes personal records but preserves workspaces, registered projects and unknown root files', async t => {
  const f = await fixture(t);
  const result = await cleanData(f.options);
  assert.equal(result.status, 'complete');
  for (const file of ['backend/state.json', 'state/electron-app/pets/custom/pet.json', 'logs/runtime.log'])
    assert.equal(await exists(path.join(f.root, file)), false, file);
  for (const file of ['backend/custom-project/work.txt', 'backend/workspaces/project/work.txt', 'workspaces/project/work.txt', 'logs/recent-project/work.txt', 'notes.txt'])
    assert.equal(await exists(path.join(f.root, file)), true, file);
  assert.equal(await exists(f.locator), false);
  assert.equal(await exists(f.app), true);
});

test('planning or cancelling does not remove data', async t => {
  const f = await fixture(t);
  await createPlan(f.options);
  assert.equal(await exists(path.join(f.root, 'backend/state.json')), true);
  assert.equal(await exists(f.locator), true);
});

test('invalid project metadata blocks before deleting any personal files', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.root, 'backend/projects/broken.md'), 'invalid');
  await assert.rejects(createPlan(f.options), /metadata/);
  assert.equal(await exists(path.join(f.root, 'logs/runtime.log')), true);
});

test('project metadata adds protected paths; workingDirs remains optional', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.root, 'backend/projects/a.md'), '---\n' + JSON.stringify({ workingDirs: [path.join(f.root, 'config/project')] }) + '\n---\n');
  await f.write(path.join(f.root, 'backend/projects/b.md'), '---\n{"name":"empty"}\n---\n');
  await f.write(path.join(f.root, 'config/project/work.txt'));
  await executePlan(await createPlan(f.options));
  assert.equal(await exists(path.join(f.root, 'config/project/work.txt')), true);
});

test('changed locator or new data after planning blocks cleanup', async t => {
  const f = await fixture(t);
  const plan = await createPlan(f.options);
  await f.write(f.locator, path.join(f.home, 'other'));
  await assert.rejects(executePlan(plan), /location changed/);
  await f.write(f.locator, f.root);
  await f.write(path.join(f.root, 'logs/new.log'));
  await assert.rejects(executePlan(plan), /changed/);
  assert.equal(await exists(path.join(f.root, 'backend/state.json')), true);
});

test('junctions into another directory are refused without touching their targets', async t => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside');
  await f.write(path.join(outside, 'important.txt'));
  await fs.symlink(outside, path.join(f.root, 'plugins'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createPlan(f.options), /Link\/junction/);
  assert.equal(await exists(path.join(outside, 'important.txt')), true);
  assert.equal(await exists(path.join(f.root, 'backend/state.json')), true);
});

test('home and application overlap cannot become a cleanup root', async t => {
  const f = await fixture(t);
  await assert.rejects(createPlan({ ...f.options, root: f.home }), /protected/);
  await assert.rejects(createPlan({ ...f.options, root: f.app }), /protected/);
});

test('an active native profile blocks cleanup even without a desktop process', async t => {
  const f = await fixture(t);
  const { acquireProfileLock } = await import('../profile-lock.mjs');
  const lease = await acquireProfileLock(path.join(f.root, 'backend'));
  try {
    await assert.rejects(cleanData(f.options), /running|owns it/);
    assert.equal(await exists(path.join(f.root, 'backend/state.json')), true);
    assert.equal(await exists(f.locator), true);
  } finally { lease.close(); }
});
