const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createPlan, executePlan, waitForExit } = require('../macos-uninstall.cjs');

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-uninstall-test-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const root = path.join(home, '.CodeBuddy');
  const app = path.join(base, 'CodeBuddy.app');
  async function write(file, value = 'fixture') {
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value);
  }
  await write(path.join(app, 'Contents/Info.plist'), '<plist><key>CFBundleIdentifier</key><string>local.codebuddy.desktop</string></plist>');
  await write(path.join(root, 'backend/state.json'), JSON.stringify({ version: 1, sessions: [] }));
  await write(path.join(root, 'workspaces/project/作品.txt'));
  await write(path.join(root, 'backend/workspaces/old-project/file.txt'));
  await write(path.join(root, 'state/electron-app/pets/custom/pet.json'));
  await write(path.join(root, 'notes.txt'), 'unknown user file');
  await write(path.join(home, 'external-project/file.txt'));
  await write(path.join(home, 'Library/Preferences/local.codebuddy.desktop.plist'));
  await write(path.join(home, 'Library/Application Support/CodeBuddy/data-root.txt'), root);
  const options = { app, home, dataRoot: root, workspace: path.join(root, 'workspaces') };
  const commands = [];
  const command = (bin, args) => { commands.push([bin, args]); return { exitCode: 0 }; };
  return { home, root, app, options, commands, command, write };
}
const exists = file => fs.access(file).then(() => true, () => false);

test('ordinary uninstall removes only this application and retains all user data and grants', async t => {
  const f = await fixture(t);
  const plan = await createPlan(f.options);
  const result = await executePlan(plan, { command: f.command });
  assert.equal(result.status, 'complete');
  assert.equal(await exists(f.app), false);
  assert.equal(await exists(path.join(f.root, 'backend/state.json')), true);
  assert.equal(await exists(path.join(f.root, 'workspaces/project/作品.txt')), true);
  assert.equal(f.commands.length, 0);
});
test('clean removes app data, keeps default and nested historical workspaces and unknown files', async t => {
  const f = await fixture(t);
  const plan = await createPlan({ ...f.options, cleanData: true });
  const result = await executePlan(plan, { command: f.command });
  assert.equal(result.status, 'complete');
  for (const file of ['backend/state.json', 'state/electron-app/pets/custom/pet.json'])
    assert.equal(await exists(path.join(f.root, file)), false);
  for (const file of ['workspaces/project/作品.txt', 'backend/workspaces/old-project/file.txt', 'notes.txt'])
    assert.equal(await exists(path.join(f.root, file)), true);
  assert.equal(await exists(path.join(f.home, 'external-project/file.txt')), true);
  assert.deepEqual(f.commands.map(c => c[0]), ['/usr/bin/security', '/usr/bin/tccutil']);
  assert.equal(f.commands[0][1][2], 'local.codebuddy.credentials.v1');
});
test('explicit project deletion removes only managed workspaces', async t => {
  const f = await fixture(t);
  const result = await executePlan(await createPlan({ ...f.options, cleanData: true, deleteProjects: true }), { command: f.command });
  assert.equal(result.status, 'complete');
  assert.equal(await exists(path.join(f.root, 'workspaces')), false);
  assert.equal(await exists(path.join(f.root, 'backend/workspaces')), false);
  assert.equal(await exists(path.join(f.home, 'external-project/file.txt')), true);
});
test('project metadata and saved session paths protect projects nested under app-owned directories', async t => {
  const f = await fixture(t);
  const project = path.join(f.root, 'backend/custom-project');
  await f.write(path.join(project, '作品.md'));
  await f.write(path.join(f.root, 'backend/projects/one.md'), `---\n${JSON.stringify({ workingDirs: [project] })}\n---\n`);
  const result = await executePlan(await createPlan({ ...f.options, cleanData: true }), { command: f.command });
  assert.equal(result.status, 'complete');
  assert.equal(await exists(path.join(project, '作品.md')), true);
});
test('a fresh session added after review is preserved too', async t => {
  const f = await fixture(t);
  const plan = await createPlan({ ...f.options, cleanData: true });
  const project = path.join(f.root, 'profiles/new-project');
  await f.write(path.join(project, 'file.txt'));
  await f.write(path.join(f.root, 'backend/state.json'), JSON.stringify({ sessions: [{ cwd: project }] }));
  await assert.rejects(executePlan(plan, { command: f.command }), /Location changed/);
  assert.equal(await exists(path.join(project, 'file.txt')), true);
  assert.equal(await exists(f.app), true);
});
test('path replacement and scope tampering stop deletion', async t => {
  const f = await fixture(t);
  const plan = await createPlan({ ...f.options, cleanData: true });
  plan.targets[0].path = path.join(f.home, 'external-project');
  await assert.rejects(executePlan(plan, { command: f.command }), /scope changed/);
  const next = await createPlan({ ...f.options, cleanData: true });
  await fs.rename(f.root, f.root + '-saved');
  await fs.mkdir(f.root);
  await assert.rejects(executePlan(next, { command: f.command }), /Location changed/);
  assert.equal(await exists(f.app), true);
});
test('symlink targets do not expand the cleanup scope', async t => {
  const f = await fixture(t);
  await fs.symlink(path.join(f.home, 'external-project'), path.join(f.root, 'state/link'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await executePlan(await createPlan({ ...f.options, cleanData: true }), { command: f.command });
  assert.equal(result.status, 'complete');
  assert.equal(await exists(path.join(f.home, 'external-project/file.txt')), true);
});
test('system cleanup errors are visible and never reported as complete', async t => {
  const f = await fixture(t);
  const result = await executePlan(await createPlan({ ...f.options, cleanData: true }),
    { command: () => ({ exitCode: 1, error: 'permission denied' }) });
  assert.equal(result.status, 'partial');
  assert.equal(result.results.filter(r => r.status === 'failed').length, 2);
});
test('review is read-only and active process prevents execution', async t => {
  const f = await fixture(t);
  await createPlan({ ...f.options, cleanData: true });
  assert.equal(await exists(f.app), true);
  assert.equal(await exists(path.join(f.root, 'backend/state.json')), true);
  await assert.rejects(waitForExit([process.pid], 1), /still running/);
  assert.equal(f.commands.length, 0);
});
test('foreign bundle and home root are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(createPlan({ ...f.options, dataRoot: f.home }), /protected/);
  await f.write(path.join(f.app, 'Contents/Info.plist'), '<plist>Other</plist>');
  await assert.rejects(createPlan(f.options), /identity/);
});
