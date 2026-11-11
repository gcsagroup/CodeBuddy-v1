import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Compat } from '../compat.mjs';
import { openStore } from '../store.mjs';
import { driverProvider } from '../providers.mjs';
import { applyModelThinking } from '../model-settings.mjs';
import { createHarnessDriver } from '../harness/index.mjs';

const route = (provider, model) => {
  const { outputTokenCapacity: _capacity, ...connection } = provider;
  return 'codebuddy-' + createHash('sha256').update(JSON.stringify({ ...connection, model })).digest('hex').slice(0, 20);
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codebuddy-cold-provider-'));
  const store = await openStore(join(directory, 'store'));
  const model = 'cold-provider-' + randomUUID();
  const input = { id: randomUUID(), engine: 'ollama_compatible', apiUrl: 'https://ollama.com', models: [model], requiresAuth: false,
    headers: { 'X-Cold-Fixture': randomUUID() }, thinkingEfforts: { [model]: 'high' } };
  await store.update(state => { state.providers = [input]; state.extensions = []; });
  const compat = new Compat(store, { close: async () => {} });
  await compat.initialize();
  t.after(() => compat.close());
  const restore = (await compat.sessionOptions({ id: randomUUID(), cwd: directory }, {
    tools: [], extensions: { selected: [], configured: [], mcpServers: [], assertCurrent() {} },
  })).restoreSubagentProvider;
  let recovered = false, clock = Date.now(), driver;
  const requests = [];
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/api/tags' || path === '/api/show') {
      if (!recovered) return Response.json({ error: 'Synthetic advisory metadata outage' }, { status: 503 });
      return Response.json(path === '/api/tags'
        ? { models: [{ name: model, contextWindow: 1048576, capabilities: ['completion', 'thinking', 'tools'] }] }
        : { model_info: { 'cold.context_length': 1048576 }, capabilities: ['completion', 'thinking', 'tools'], thinking: { values: [false, 'low', 'high'], default: 'low' } });
    }
    assert.ok(path.endsWith('/chat/completions'), 'Only the synthetic model endpoint may be used');
    const body = JSON.parse(options.body);
    if (body.tools?.some(tool => tool.function?.name === 'check_execution_claims')) {
      const delta = { tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: {
        name: 'check_execution_claims', arguments: JSON.stringify({ changes: [], successes: [], executionMissing: false }),
      } }] };
      return new Response('data: ' + JSON.stringify({ id: randomUUID(), model, choices: [{ index: 0, delta, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    const marker = body.messages.findLastIndex(message => message.role === 'user' && /COLD_PARENT_START|COLD_PARENT_CONTINUE|COLD_CHILD_INITIAL|COLD_CHILD_CONTINUE/.test(JSON.stringify(message.content)));
    const latest = JSON.stringify(body.messages[marker]?.content);
    const child = /COLD_CHILD_INITIAL|COLD_CHILD_CONTINUE/.test(latest);
    const continued = latest.includes('COLD_CHILD_CONTINUE');
    const followup = latest.includes('COLD_PARENT_CONTINUE');
    requests.push({ child, continued, followup, body });
    const serviced = body.messages.slice(marker + 1).some(message => message.role === 'tool');
    const call = child || serviced ? undefined : followup
      ? { name: 'send_message', arguments: { agent_id: latest.match(/COLD_PARENT_CONTINUE ([0-9a-f-]+)/)?.[1], message: 'COLD_CHILD_CONTINUE' } }
      : { name: 'subagent', arguments: { description: 'Original cold fixture', prompt: 'COLD_CHILD_INITIAL' } };
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: 'assistant', content: child ? continued ? 'CHILD_CONTINUED' : 'CHILD_INITIAL_DONE' : 'PARENT_DONE' };
    const chunk = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    return new Response(chunk(delta) + chunk({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  async function open() { driver = await createHarnessDriver({ dataDir: join(directory, 'native'), cwd: directory }); }
  await open();
  t.after(async () => { await driver?.close(); });
  async function configure(id, effort) {
    const prepared = applyModelThinking(await driverProvider(store.read(['providers']).providers[0], model), effort);
    await driver.createSession({ sessionId: id, cwd: directory, provider: prepared.provider, model,
      options: { tools: [], thinkingEffort: prepared.thinkingEffort, restoreSubagentProvider: restore } });
    return prepared.provider;
  }
  async function waitEnd(id, turn) {
    const deadline = performance.now() + 4000;
    while (performance.now() < deadline) {
      const history = await driver.history(id);
      const end = history.events.findLast(row => row.type === 'turn/end');
      if (end?.data.turn >= turn) return history;
      await delay(10);
    }
    assert.fail('Native child did not finish its expected turn');
  }
  return { directory, store, model, requests, restore, configure, waitEnd,
    get driver() { return driver; },
    async create() {
      const id = randomUUID();
      const provider = await configure(id, 'high');
      assert.equal(provider.contextWindow, 262144);
      await driver.prompt(id, 'COLD_PARENT_START', { onPermission: () => true });
      const children = await driver.listSubagentChildren(id);
      assert.equal(children.length, 1);
      const child = children[0].id;
      const history = await waitEnd(child, 1);
      assert.equal(history.events.findLast(row => row.type === 'turn/end').data.reason.kind, 'completed');
      return { id, child, provider, route: route(provider, model), history };
    },
    async restart(change) {
      await driver.close(); driver = undefined;
      recovered = true; clock += 31000;
      if (change) await store.update(change);
      const before = requests.length;
      await open();
      assert.equal(requests.length, before, 'Native restart cannot start a model request');
    },
  };
}

for (const parallel of [false, true]) test(`original fallback children resume after metadata recovery${parallel ? ' concurrently with chat isolation' : ''}`, { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const roots = [await f.create()];
  if (parallel) roots.push(await f.create());
  await f.restart(state => { state.providers[0].thinkingEfforts[f.model] = 'none'; });
  const before = f.requests.length;
  for (const root of roots) {
    const current = await f.configure(root.id, 'low');
    assert.equal(current.contextWindow, 1048576);
    assert.notEqual(route(current, f.model), root.route);
    assert.equal(await f.restore(f.model, value => route(value, f.model) === root.route), undefined, 'No inferred fallback without native record');
    assert.equal(await f.restore(f.model, value => route(value, f.model) === root.route, { contextWindow: 12345, reasoningEffort: 'high' }), undefined, 'No invented context profiles');
  }
  await Promise.all(roots.map(root => f.driver.prompt(root.id, 'COLD_PARENT_CONTINUE ' + root.child, { onPermission: () => true })));
  for (const root of roots) {
    const history = await f.waitEnd(root.child, 2);
    assert.equal(history.events.findLast(row => row.type === 'turn/end').data.reason.kind, 'completed');
    assert.equal(history.events.filter(row => row.type === 'subagent/descriptor').length, root.history.events.filter(row => row.type === 'subagent/descriptor').length);
    assert.deepEqual((await f.driver.listSubagentChildren(root.id)).map(child => child.id), [root.child], 'No replacement child');
    const context = history.events.findLast(row => row.type === 'request/context').data;
    assert.equal(context.provider, root.route, 'Original exact provider identity retained');
    assert.equal(context.contextWindow, 262144, 'Original bounded fallback window retained');
    const own = (await f.driver.history(root.id)).events.filter(row => row.type === 'tool/result');
    assert.ok(!own.some(row => row.data.message.isError));
  }
  const resumed = f.requests.slice(before).filter(request => request.continued);
  assert.equal(resumed.length, roots.length);
  assert.ok(resumed.every(request => request.body.reasoning_effort === 'high'), 'Original native child effort wins over changed parent preference');
  if (parallel) {
    const ownBefore = f.requests.filter(request => request.continued).length;
    await f.driver.prompt(roots[0].id, 'COLD_PARENT_CONTINUE ' + roots[1].child, { onPermission: () => true });
    assert.equal(f.requests.filter(request => request.continued).length, ownBefore, 'A different chat cannot resume this child');
    const history = await f.driver.history(roots[0].id);
    assert.ok(history.events.findLast(row => row.type === 'tool/result').data.message.isError);
  }
});

for (const change of ['endpoint', 'smaller-window', 'credential', 'headers']) test(`cold restoration rejects ${change} instead of substituting the saved connection`, { timeout: 30000 }, async t => {
  const f = await fixture(t), root = await f.create();
  await f.restart(state => {
    if (change === 'endpoint') state.providers[0].apiUrl = 'https://different-fixture.invalid';
    else if (change === 'smaller-window') state.providers[0].contextWindows = { [f.model]: 131072 };
    else if (change === 'credential') state.providers[0].apiKey = 'synthetic-changed-key';
    else state.providers[0].headers['X-Cold-Fixture'] = 'synthetic-changed-header';
  });
  await f.configure(root.id, 'low');
  const before = f.requests.filter(request => request.child).length;
  await f.driver.prompt(root.id, 'COLD_PARENT_CONTINUE ' + root.child, { onPermission: () => true });
  assert.equal(f.requests.filter(request => request.child).length, before, 'Rejected restore must not enter a child model call');
  const history = await f.driver.history(root.id);
  const result = history.events.findLast(row => row.type === 'tool/result');
  assert.equal(result.data.message.isError, true);
  assert.ok(JSON.stringify(result.data).includes('unavailable'));
});
