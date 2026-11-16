import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createHarnessDriver } from '../harness/index.mjs';
import { WorkspaceService } from '../workspaces.mjs';

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
