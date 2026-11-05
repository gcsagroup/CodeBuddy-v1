import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { RuntimeSettings } from '../settings.mjs';
import { LibraryService } from '../library.mjs';
import { openStore } from '../store.mjs';
import { chatInstallTools } from '../chat-install.mjs';

test('a GitHub repository resolves publisher MCP metadata without executing commands or saving configuration', async () => {
  const context = { sessionId: 'root', signal: new AbortController().signal };
  const requests = [];
  const [install] = chatInstallTools({ session: { id: 'root' }, foreground: () => ({ ask() {} }),
    fetchManifest: async (url, options) => {
      requests.push(url);
      assert.equal(options.redirect, 'error');
      return Response.json({ websiteUrl: 'https://example.org/setup', packages: [{
        identifier: 'fixture', transport: { type: 'stdio' }, packageArguments: [{ type: 'positional', valueHint: 'mcp' }],
      }] });
    }, confirm: () => assert.fail('inspection does not install') });
  const result = await install.execute({ repository_url: 'https://github.com/example/fixture.git' }, context);
  assert.equal(result.installed, false);
  assert.equal(result.packages[0].transport, 'stdio');
  assert.equal(result.packages[0].packageArguments[0].valueHint, 'mcp');
  for (const url of ['https://github.com.invalid/example/fixture', 'https://attacker@github.com/example/fixture'])
    await assert.rejects(install.execute({ repository_url: url }, context));
  assert.deepEqual(requests, ['https://api.github.com/repos/example/fixture/contents/server.json']);
});

test('only an unambiguous installed CLI with publisher-fixed arguments reaches desktop confirmation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cb-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = path.join(root, process.platform === 'win32' ? 'fixture.exe' : 'fixture');
  await writeFile(command, '', { mode: 0o755 });
  const source = 'https://github.com/example/fixture';
  const session = { id: 'root', cwd: root }, context = { sessionId: 'root', signal: new AbortController().signal };
  const pkg = { registryType: 'pypi', identifier: 'fixture', transport: { type: 'stdio' },
    packageArguments: [{ type: 'positional', valueHint: 'serve' }] };
  const manifest = { repository: { url: source }, packages: [pkg] };
  const calls = [];
  const [tool] = chatInstallTools({ session, foreground: () => ({ ask() {} }), searchPath: root,
    fetchManifest: async () => Response.json(manifest),
    confirm: async (_name, input) => { assert.deepEqual(input, { repository_url: source, name: 'fixture', command, args: ['serve'] }); calls.push('confirm'); },
    settings: { extensionSnapshot: async () => ({ configured: [] }), request: async () => { calls.push('test'); return { success: true, tools: ['read'] }; },
      saveExtension: async () => calls.push('save') } });
  const run = () => tool.execute({ repository_url: source }, context);
  assert.equal((await run()).installed, false);
  pkg.packageArguments[0].isFixed = true;
  manifest.repository.url = 'https://github.com/other/fixture';
  assert.equal((await run()).installed, false);
  assert.deepEqual(calls, []);
  manifest.repository.url = source;
  assert.equal((await run()).connectionVerified, true);
  assert.deepEqual(calls, ['confirm', 'test', 'save']);
});

test('chat installation uses one-shot consent, verified settings, and conflict-checked skill publication', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cb-chat-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openStore(path.join(root, 'profile'));
  const session = { id: 'chat', cwd: path.join(root, 'project'), extensions: ['developer'] };
  await mkdir(session.cwd);
  await store.update(state => state.sessions.push(session));
  let approve = false, reachable = false, probes = 0;
  const settings = new RuntimeSettings(store, { changed: async () => {}, testExtension: async () => {
    probes++;
    if (!reachable) throw Error('unreachable');
    return { tools: ['mcp__sample__read'] };
  } });
  const library = new LibraryService(store, { downloader: { download: async () => ({
    displaySource: 'fixture', provenance: {}, files: [{ relativePath: 'SKILL.md', buffer: Buffer.from('---\nname: sample\ndescription: Fixture skill\n---\nFixture body.') }],
  }) } });
  const [mcp, skill] = chatInstallTools({ session, settings, library, foreground: () => ({ ask() {} }),
    confirm: async () => { if (!approve) throw Error('declined'); } });
  const context = { sessionId: session.id, callId: 'call', signal: new AbortController().signal };
  const server = { name: 'sample', url: 'http://localhost:1234/mcp' };
  const download = { name: 'sample', url: 'https://example.org/SKILL.md', scope: 'project' };
  await assert.rejects(mcp.execute(server, { ...context, sessionId: 'child' }), /requesting chat/);
  await assert.rejects(mcp.execute(server, context), /declined/);
  await assert.rejects(skill.execute(download, context), /declined/);
  assert.equal(probes, 0);
  assert.equal(library.previews.size, 0);
  approve = true;
  await assert.rejects(mcp.execute(server, context), /unreachable/);
  assert.equal(store.read(['extensions']).extensions.length, 0);
  reachable = true;
  const results = await Promise.allSettled([mcp.execute(server, context), mcp.execute(server, context)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'fulfilled').value.connectionVerified, true);
  assert.deepEqual(store.readSession(session.id).extensions, ['developer', 'sample']);
  assert.equal((await settings.extensions())[0].enabled, true);
  const resumedSession = store.readSession(session.id);
  const [resumed] = chatInstallTools({ session: resumedSession, settings, library, foreground: () => ({ ask() {} }),
    confirm: () => assert.fail('Recovery must not run an installation') });
  const before = probes;
  const recovered = await resumed.execute(server, context);
  assert.equal(recovered.alreadyInstalled, true);
  assert.equal(recovered.selectedInChat, true);
  assert.equal(recovered.connectionStatus, 'not_retested');
  assert.equal(probes, before);
  await assert.rejects(resumed.execute({ ...server, url: 'http://localhost:5678/mcp' }, context), /different configuration/);
  await settings.request('config/extensions/set-enabled', { configKey: 'sample', enabled: false });
  await assert.rejects(resumed.execute(server, context), /disabled extension/);
  const installed = await skill.execute(download, context);
  assert.equal(installed.enabled, true);
  assert.equal(installed.availableForModel, true);
  assert.match(await readFile(path.join(installed.path, 'SKILL.md'), 'utf8'), /Fixture body/);
  assert.equal((await skill.execute(download, context)).alreadyInstalled, true);
  await assert.rejects(skill.execute({ ...download, url: 'https://different.example/SKILL.md' }, context), /already exists/);
});

test('MCP cancellation before save leaves nothing installed; a lost receipt after save can be recovered after restart', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cb-install-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openStore(root);
  const session = { id: 'chat', cwd: root, extensions: [] };
  await store.update(state => state.sessions.push(session));
  const server = { name: 'receipt', command: 'receipt-server', args: ['serve'] };
  let stop = new AbortController(), approvals = 0, probes = 0, phase = 'testing';
  const settings = new RuntimeSettings(store, {
    testExtension: async () => { probes++; if (phase === 'testing') stop.abort(); return { tools: ['ticket'] }; },
    changed: async () => stop.abort(),
  });
  const toolsFor = (settings, chat) => chatInstallTools({ session: chat, settings,
    foreground: () => ({ ask() {} }), confirm: async () => { approvals++; } })[0];
  const install = toolsFor(settings, session);
  const run = tool => tool.execute(server, { sessionId: session.id, signal: stop.signal });
  await assert.rejects(run(install), { name: 'AbortError' });
  assert.equal(store.read(['extensions']).extensions.length, 0);
  phase = 'saving';
  stop = new AbortController();
  await assert.rejects(run(install), { name: 'AbortError' });
  await store.flush();
  const restored = await openStore(root);
  stop = new AbortController();
  const receipt = await run(toolsFor(new RuntimeSettings(restored), restored.readSession(session.id)));
  assert.equal(receipt.alreadyInstalled, true);
  assert.equal(receipt.selectedInChat, true);
  assert.equal(receipt.connectionStatus, 'not_retested');
  assert.equal(restored.read(['extensions']).extensions.length, 1);
  assert.equal(approvals, 2);
  assert.equal(probes, 2);
});
