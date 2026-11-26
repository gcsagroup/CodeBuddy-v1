import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessDriver } from '../index.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
const { apply } = await import('@deepseek-ai/dsh-tool-skill');
const { installToolDiscovery } = await import('../tool-discovery.mjs');

function fixture(count, config = { catalogIndexMaxCharacters: 640 }, compact = true) {
  const hooks = new Map(), tools = new Map();
  const agent = { id: 'fixture', session: { seq: 0, log: [], surface: { nodes: [] }, requestHeader() {} } };
  const snapshot = { complete: true, skills: Array.from({ length: count }, (_, i) => ({ name: `fixture-${String(i).padStart(4, '0')}`,
    description: `Read acceptance record ${i}. ` + 'Catalog summary. '.repeat(40), invocation: { modelInvocable: true, userInvocable: true } })) };
  const scopes = [];
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool), get: name => tools.get(name), schemas: () => [...tools.values()] },
    skills: { snapshot: async options => { scopes.push(options); return snapshot; } },
    workingDirectory: { ensure: async () => '/fixture' },
    systemPrompt: { section() {} },
    on(name, hook) { hooks.set(name, [...(hooks.get(name) ?? []), hook]); },
  };
  apply(ctx, config);
  if (!compact) tools.set('write', { name: 'write', description: 'Write a file' });
  installToolDiscovery(ctx, agent, undefined, () => true, compact);
  const step = (messages = []) => hooks.get('agent/pre-step').at(-1)({ agent, signal: new AbortController().signal }, async () => ({ kind: 'accept', messages }));
  return { ctx, agent, snapshot, scopes, tools, step };
}

for (const count of [10, 100, 1000]) test(`native skill catalog remains bounded with ${count} discoverable skills`, async () => {
  const f = fixture(count);
  const message = (await f.step()).messages[0];
  assert.equal(message.source.entries.length, count, 'native durable catalog stays complete');
  assert.equal(message.source.presentation, 'discovery-v1:640');
  assert.ok(message.content[0].text.length < 1600, 'resident text has a fixed budget');
  const search = f.tools.get('search_mcp_tools');
  const result = await search.execute({ kind: 'skills', query: `fixture-${String(count - 1).padStart(4, '0')}` });
  assert.equal(result.skills[0].name, f.snapshot.skills.at(-1).name, 'skills outside the resident index remain discoverable');
  assert.deepEqual(result.tools, [], 'search never executes or loads a skill');
  const names = [];
  let offset = 0;
  do {
    const page = await search.execute({ kind: 'skills', offset });
    assert.ok(JSON.stringify(search.output.render({}, page)).length < 2200);
    names.push(...page.skills.map(skill => skill.name));
    offset = page.nextOffset;
  } while (offset !== undefined);
  assert.equal(new Set(names).size, count);
  assert.ok(f.scopes.every(scope => scope.scope === f.agent && scope.cwd === '/fixture'));
});

test('native catalog republishes on presentation migration, rollback and hot updates without repetitive publication', async () => {
  const f = fixture(20);
  const native = fixture(20, {});
  const old = (await native.step()).messages[0];
  const resumed = message => {
    f.agent.session.seq = 1;
    f.agent.session.surface.nodes = [0];
    f.agent.session.eventAt = () => ({ seq: 0, type: 'user/message', data: message });
  };
  resumed(old);
  let updated = (await f.step()).messages[0];
  assert.equal(updated.source.update, true);
  assert.equal(updated.source.presentation, 'discovery-v1:640');
  resumed(updated);
  assert.deepEqual((await f.step()).messages, [], 'cold history retains presentation identity');
  f.snapshot.skills[19].revision = 'new-body-same-description';
  updated = (await f.step()).messages[0];
  assert.equal(updated.source.entries[19].revision, 'new-body-same-description');
  assert.match(updated.content[0].text, /Reload previously loaded skills/);
  resumed(updated);
  assert.deepEqual((await f.step()).messages, [], 'a stable content revision is not repeatedly published');
  f.snapshot.skills[19].description = 'Changed description outside the resident index';
  updated = (await f.step()).messages[0];
  assert.equal(updated.source.entries[19].description, f.snapshot.skills[19].description);
  resumed(updated);
  f.snapshot.complete = false;
  assert.deepEqual((await f.step()).messages, [], 'incomplete refresh never publishes a false removal');
  assert.equal((await f.tools.get('search_mcp_tools').execute({ kind: 'skills' })).incomplete, true);
  f.snapshot.complete = true;
  f.snapshot.skills = [];
  assert.equal((await f.step()).messages[0].source.entries.length, 0);
  native.agent.session = f.agent.session;
  assert.equal((await native.step()).messages[0].source.presentation, undefined, 'removing one config key restores native rendering');
});

test('skill discovery respects invocation policy and absence of scoped loader', async () => {
  const f = fixture(10);
  f.snapshot.skills[9].invocation.modelInvocable = false;
  const search = f.tools.get('search_mcp_tools');
  assert.equal((await search.execute({ kind: 'skills', query: 'fixture-0009' })).totalMatches, 0);
  assert.equal((await f.step()).messages[0].source.entries.length, 9);
  f.tools.delete('skill');
  assert.deepEqual((await search.execute({ kind: 'skills' })).skills, []);
  assert.deepEqual((await f.step()).messages, []);
});

test('native full catalog remains available when no compatible discovery is installed', async () => {
  const f = fixture(20);
  f.tools.delete('search_mcp_tools');
  const message = (await f.step()).messages[0];
  assert.equal(message.source.presentation, undefined);
  assert.ok(message.content[0].text.includes('fixture-0019'));
});

test('configured project skills receive index space before bundled defaults without changing discoverability', async () => {
  const f = fixture(20);
  for (const skill of f.snapshot.skills) skill.source = 'bundled';
  f.snapshot.skills[19].source = 'project';
  const message = (await f.step()).messages[0];
  assert.match(message.content[0].text, /fixture-0019/);
  assert.equal(message.source.entries.length, 20);
  assert.equal((await f.tools.get('search_mcp_tools').execute({ kind: 'skills', query: 'fixture-0018' })).skills[0].name, 'fixture-0018');
});

test('noncompact agents retain the full native catalog and can still search skills', async () => {
  const f = fixture(20, { catalogIndexMaxCharacters: 640 }, false);
  const message = (await f.step()).messages[0];
  assert.equal(message.source.presentation, undefined);
  assert.ok(message.content[0].text.includes('fixture-0019'));
  assert.equal((await f.tools.get('search_mcp_tools').execute({ kind: 'skills', query: 'fixture-0019' })).skills[0].name, 'fixture-0019');
});

for (const count of [10, 100, 1000]) test(`final provider request stays bounded with ${count} filesystem skills`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'skill-payload-'));
  let driver;
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  t.after(async () => {
    await driver?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(dirname(root), tmpdir());
    assert.ok(root.startsWith(join(tmpdir(), 'skill-payload-')));
    await rm(root, { recursive: true, force: true });
  });
  const directory = join(root, '.dsh', 'skills');
  await mkdir(directory, { recursive: true });
  await Promise.all(Array.from({ length: count }, (_, i) => writeFile(join(directory, `fixture-${i}.md`),
    `---\nname: fixture-${i}\ndescription: Read local acceptance records. ${'Summary details. '.repeat(15)}\n---\nPRIVATE_BODY_${i}\n`)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  driver = await createHarnessDriver({ dataDir: join(root, 'data'), cwd: root, sharedSkillDir: join(root, 'shared') });
  const { sessionId } = await driver.createSession({ cwd: root, model: 'fixture', provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 65536 }, options: { mainAgentRole: { baseline: () => null, input: () => null } } });
  assert.equal((await driver.prompt(sessionId, 'hello')).stopReason, 'end_turn');
  assert.equal(requests.length, 1, 'greeting must not add discovery/model calls');
  assert.ok(JSON.stringify(requests[0]).length < 15000, 'complete durable source metadata must not leak into the provider request');
  assert.doesNotMatch(JSON.stringify(requests[0]), /PRIVATE_BODY_/);
  assert.equal((await driver.listSkills(sessionId)).filter(skill => skill.name.startsWith('fixture-')).length, count);
});
