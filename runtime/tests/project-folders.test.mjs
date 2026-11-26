import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createHarnessDriver } from '../harness/index.mjs';
import { WorkspaceService } from '../workspaces.mjs';
import { openStore } from '../store.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';

test('legacy chats freeze missing snapshots on first use, including explicit empty snapshots', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'legacy-project-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'main'), linked = path.join(root, 'reference');
  await Promise.all([cwd, linked].map(dir => mkdir(dir)));
  const store = await openStore(path.join(root, 'state'));
  const service = new WorkspaceService(store);
  const config = await service.saveProjectFolders({ cwd, version: '', folders: [{ path: linked, access: 'reference' }] });
  await store.update(state => state.sessions.push({ id: 'legacy', cwd }, { id: 'empty', cwd, projectFoldersSnapshot: null }));
  assert.deepEqual(await service.executionFolders(cwd, 'legacy'), { writable: [], reference: [linked] });
  assert.deepEqual(await service.executionFolders(cwd, 'empty'), { writable: [], reference: [] });
  await service.saveProjectFolders({ cwd, version: config.version, folders: [{ path: linked, access: 'write' }] });
  const reopened = new WorkspaceService(await openStore(path.join(root, 'state')));
  assert.deepEqual(await reopened.executionFolders(cwd, 'legacy'), { writable: [], reference: [linked] });
  await assert.rejects(reopened.executionFolders(cwd, 'unknown'), /session/i);
});

test('edited native identity resolves the product snapshot instead of the current template', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'edited-project-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'main'), linked = path.join(root, 'reference');
  await Promise.all([cwd, linked].map(dir => mkdir(dir)));
  const store = await openStore(path.join(root, 'state'));
  const service = new WorkspaceService(store);
  const config = await service.saveProjectFolders({ cwd, version: '', folders: [{ path: linked, access: 'reference' }] });
  const frozen = await service.readFolderConfig(cwd);
  await store.update(state => state.sessions.push({ id: 'product', nativeSessionId: 'native-after-edit', cwd, projectFoldersSnapshot: frozen }));
  await service.saveProjectFolders({ cwd, version: config.version, folders: [{ path: linked, access: 'write' }] });
  const driver = createConversationDriver({ callTool: native => service.executionFolders(cwd, driver.productSessionId?.(native) ?? native) }, store);
  assert.deepEqual(await driver.callTool('product', 'fixture', {}), { writable: [], reference: [linked] });
});

test('editing reusable folders preserves old chats and validates notes and stale directory identities', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'project-snapshots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'main'), linked = path.join(root, 'linked');
  await Promise.all([cwd, linked].map(dir => mkdir(dir)));
  const store = await openStore(path.join(root, 'state'));
  const service = new WorkspaceService(store);
  const initial = await service.saveProjectFolders({ cwd, version: '', folders: [{ path: linked, access: 'reference', note: ' Upstream source ' }] });
  assert.equal(initial.folders[0].note, 'Upstream source');
  await store.update(state => { state.sessions.push({ id: 'legacy', cwd }); });
  await service.saveProjectFolders({ cwd, version: initial.version, folders: [{ path: linked, access: 'write' }] });
  assert.deepEqual(await service.executionFolders(cwd, 'legacy'), { writable: [], reference: [linked] });
  assert.deepEqual(await service.executionFolders(cwd), { writable: [linked], reference: [] });
  const reopened = new WorkspaceService(await openStore(path.join(root, 'state')));
  assert.deepEqual(await reopened.executionFolders(cwd, 'legacy'), { writable: [], reference: [linked] });
  const current = await service.projectFolders(cwd);
  await assert.rejects(service.saveProjectFolders({ cwd, version: current.version, folders: [{ path: linked, access: 'write', note: 'x'.repeat(501) }] }), /500/);
  await rename(linked, linked + '-old'); await mkdir(linked);
  await assert.rejects(service.executionFolders(cwd, 'legacy'), /changed/);
});

test('project folder changes persist and constrain native Harness file tools', async t => {
  // The native sandbox permits the OS temp directory. Put test targets outside it.
  const fixture = await mkdtemp(path.join(process.cwd(), '.linked-folders-test-'));
  const data = await mkdtemp(path.join(tmpdir(), 'linked-folder-host-'));
  t.after(async () => { await rm(fixture, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); });
  const [cwd, upstream, api] = ['app', 'upstream', 'api'].map(name => path.join(fixture, name));
  await Promise.all([cwd, upstream, api].map(dir => mkdir(dir)));
  await writeFile(path.join(upstream, 'example.txt'), 'reference example');
  const service = new WorkspaceService({ directory: data });
  const folders = [{ path: upstream, access: 'reference' }, { path: api, access: 'write' }];
  const save = params => service.request('_codebuddy/project-folders/save', { cwd, ...params });
  const { version } = await save({ version: '', folders });
  assert.deepEqual((await new WorkspaceService({ directory: data }).projectFolders(cwd)).folders, folders);
  await assert.rejects(save({ version: '', folders: [] }), /changed/);
  await assert.rejects(save({ version, folders: [folders[0], folders[0]] }), /overlap/);
  const driver = await createHarnessDriver({ cwd, dataDir: path.join(data, 'harness'),
    projectFolders: { writeAccess: (root, target) => service.linkedWriteAccess(root, target) } });
  t.after(() => driver.close());
  const { sessionId } = await driver.createSession({ cwd, model: 'fixture', provider: {
    id: 'fixture', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', protocol: 'openai-completions' } });
  const call = (name, args) => driver.callTool(sessionId, name, args, { onPermission: async () => true });
  const write = dir => call('write', { file_path: path.join(dir, 'result.txt'), content: 'actual write' });
  assert.match(JSON.stringify((await call('read', { file_path: path.join(upstream, 'example.txt') })).content), /reference example/);
  assert.equal((await write(cwd)).isError, false);
  const linked = await write(api);
  assert.equal(linked.isError, false, JSON.stringify(linked.content));
  assert.equal((await write(upstream)).isError, true);
  assert.equal(await readFile(path.join(api, 'result.txt'), 'utf8'), 'actual write');
  await driver.permissions(sessionId, { preset: 'read-only' });
  assert.equal((await write(api)).isError, true);
  await driver.permissions(sessionId, { preset: 'danger-full-access' });
  assert.equal((await write(upstream)).isError, true);
  await driver.permissions(sessionId, { preset: 'workspace-write' });
  await rename(api, api + '-previous');
  await mkdir(api);
  assert.equal((await write(api)).isError, true);
  await save({ version, folders: [] });
  assert.equal((await write(api)).isError, true);
  assert.equal(await readFile(path.join(upstream, 'example.txt'), 'utf8'), 'reference example');
});
