import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopCoordinator } from '../desktop-coordinator.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import { waitForSteeringInput } from '../harness/steering-patch.mjs';
import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';

async function until(predicate, milliseconds, message) {
  const deadline = Date.now() + milliseconds;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
}

async function bounded(work, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// Both chats use the real Harness/desktop lease/MCP adapter. All input is a
// loopback fixture: no app is opened and no native desktop input is dispatched.
for (const discovery of [false, true]) test(discovery
  ? 'withdrawn lease-queued discovery does not bind title A before fresh discovery chooses title B'
  : 'steering cancels only a queued desktop proposal before dispatch while another chat retains its lease',
  { timeout: 25000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'codebuddy-steering-desktop-queue-'));
    const coordinator = new DesktopCoordinator({ directory: join(root, 'control') });
    const ownerSignal = new AbortController(), queuedSignal = new AbortController();
    const models = [], calls = [], events = [], notifications = [], fixtureErrors = [];
    let driver, ownerTurn, queuedTurn, running, ownerEnd;
    let ownerSessionId, sessionId;
    const endOwner = () => ownerEnd ??= ownerTurn?.end();
    const initial = 'INITIAL_QUEUED_DESKTOP_TASK';
    const steer = 'STEER_REPLACES_QUEUED_DESKTOP_PROPOSAL';
    const oldId = 'desktop-queue-old', freshId = 'desktop-queue-fresh';
    const emit = (res, delta, reason) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [chunk, finish_reason] of [[delta, null], [{}, reason]])
        res.write(`data: ${JSON.stringify({ id: 'queue-fixture', choices: [{ index: 0, delta: chunk, finish_reason }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    const server = createServer(async (req, res) => {
      try {
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        if (req.url === '/mcp') {
          if (!('id' in body)) { notifications.push(body.method); res.writeHead(202).end(); return; }
          let result;
          if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} },
            serverInfo: { name: 'desktop-queue-fixture', version: '1' } };
          else if (body.method === 'tools/list') result = { tools: ['click', 'list_apps', 'get_app_state'].map(name => ({
            name, description: 'Loopback fixture only', inputSchema: { type: 'object',
              properties: { tag: { type: 'string' }, window_title: { type: 'string' } }, required: ['tag'] },
          })) };
          else if (body.method === 'tools/call') {
            calls.push(body);
            const tag = body.params.arguments.tag;
            assert.equal(body.params._meta['codebuddy/desktop-control'].token,
              tag === 'owner' ? 'queue-owner' : 'queue-subject');
            if (discovery && tag === 'fresh') {
              assert.equal(body.params.name, 'get_app_state');
              assert.equal(body.params._meta['codebuddy/desktop-control'].windowTitle, 'Fixture Window B');
            }
            result = { content: [{ type: 'text', text: tag === 'owner' ? 'OWNER_ACTION_RECEIPT' : 'FRESH_ACTION_RECEIPT' }] };
          } else result = {};
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
          return;
        }
        if (replyToNoActionReview(body, res)) return;
        // Session-title requests are not main Agent sampling.
        if (!Array.isArray(body.tools) || body.tools.length === 0) {
          emit(res, { role: 'assistant', content: 'Queue fixture' }, 'stop'); return;
        }
        models.push(body);
        const index = models.length;
        if (index <= 2) emit(res, { role: 'assistant', tool_calls: [{ index: 0,
          id: index === 1 ? oldId : freshId, type: 'function', function: {
            name: `mcp__qwen_computer__${discovery ? index === 1 ? 'list_apps' : 'get_app_state' : 'click'}`,
            arguments: JSON.stringify({ tag: index === 1 ? 'old' : 'fresh',
              ...(discovery ? { window_title: index === 1 ? 'Fixture Window A' : 'Fixture Window B' } : {}) }),
          } }] }, 'tool_calls');
        else emit(res, { role: 'assistant', content: 'Finished the revised fixture.' }, 'stop');
      } catch (error) {
        fixtureErrors.push(error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
      queuedSignal.abort();
      try {
        await bounded(Promise.resolve(endOwner()), 3000, 'owner desktop cleanup did not settle');
        await bounded(Promise.resolve(running).catch(() => {}), 5000, 'queued Harness cleanup did not settle');
        await bounded(Promise.resolve(queuedTurn?.end()), 3000, 'queued desktop tail did not settle');
      } finally {
        ownerSignal.abort();
        try { await bounded(Promise.resolve(driver?.close()), 5000, 'Harness close did not settle'); }
        finally {
          server.closeAllConnections();
          await new Promise(resolve => server.close(resolve));
          await rm(root, { recursive: true, force: true });
        }
      }
    });
    driver = await createHarnessDriver({ dataDir: join(root, 'harness'), cwd: root });
    const options = { mcpServers: [{ serverName: 'qwen_computer', transport: 'streamable-http', url: `${base}/mcp` }] };
    const session = () => driver.createSession({ cwd: root,
      provider: { id: 'fixture', baseUrl: `${base}/v1`, apiKey: 'fixture-only' }, model: 'fixture', options });
    ({ sessionId: ownerSessionId } = await session());
    ({ sessionId } = await session());
    ownerTurn = coordinator.begin({ sessionId: ownerSessionId, token: 'queue-owner', signal: ownerSignal.signal });
    queuedTurn = coordinator.begin({ sessionId, token: 'queue-subject', signal: queuedSignal.signal });
    const hooks = (turn, signal) => ({ signal,
      onPermission: async () => true,
      onToolPolicy: tool => turn.admit(tool, async () => ({ kind: 'allow' })),
      onDesktopTool: (tool, next) => turn.execute(tool, next), desktopMetadata: () => turn.metadata(),
    });
    const owned = await driver.callTool(ownerSessionId, 'mcp__qwen_computer__click', { tag: 'owner' }, hooks(ownerTurn, ownerSignal.signal));
    assert.equal(owned.isError, false);
    assert.equal(calls.length, 1);
    const lease = coordinator.readLease();
    assert.equal(lease.sessionId, ownerSessionId);
    running = driver.prompt(sessionId, initial, { ...hooks(queuedTurn, queuedSignal.signal), onEvent: event => events.push(event) });
    running.catch(() => {});
    await until(() => coordinator.state().queue.some(turn => turn.token === 'queue-subject'), 4000,
      'The original proposal never reached the actual desktop lease queue');
    assert.equal(models.length, 1);
    assert.deepEqual(calls.map(call => call.params.arguments.tag), ['owner']);
    const at = Date.now();
    await driver.steer(sessionId, steer, { requestId: 'desktop-queue-steer', preempt: true });
    await coordinator.preparePrompt(sessionId, { activeInput: true, token: 'queue-subject' });
    // A stays owner throughout this assertion. Releasing A would hide the bug.
    try {
      await until(() => models.length >= 2, 2000,
        'The admitted steer must reach the next real main request before the other chat releases its lease');
    } finally {
      t.diagnostic(JSON.stringify({ nextRequestMs: Date.now() - at, models: models.length,
        dispatchedTags: calls.map(call => call.params.arguments.tag), ownerToken: coordinator.state().owner?.token,
        ownerLeaseUnchanged: JSON.stringify(coordinator.readLease()) === JSON.stringify(lease),
        queuedSignalAborted: queuedSignal.signal.aborted }));
    }
    assert.deepEqual(coordinator.readLease(), lease, 'Steering B must not revoke or refresh A\'s lease');
    assert.equal(queuedSignal.signal.aborted, false);
    assert.equal(ownerSignal.signal.aborted, false);
    assert.ok(!notifications.includes('notifications/cancelled'));
    assert.deepEqual(calls.map(call => call.params.arguments.tag), ['owner'], 'Neither old nor fresh B input may overlap A');
    const request = models[1].messages;
    const user = request.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n');
    assert.equal(user.split(initial).length - 1, 1);
    assert.equal(user.split(steer).length - 1, 1);
    const receipt = request.filter(message => message.role === 'tool' && message.tool_call_id === oldId);
    assert.equal(receipt.length, 1, 'The native writer must pair the obsolete original call exactly once');
    assert.match(JSON.stringify(receipt[0].content), /before dispatch|not dispatched|未派发/iu,
      'The queued action must be reported truthfully as not dispatched');
    assert.doesNotMatch(JSON.stringify(receipt[0].content), /FRESH_ACTION_RECEIPT|OWNER_ACTION_RECEIPT/);
    const skipped = events.filter(event => event.type === 'tool_result' && event.id === oldId);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].isError, true, 'Cancellation is not a successful desktop action');
    await until(() => coordinator.state().queue.some(turn => turn.token === 'queue-subject') ||
      events.some(event => event.type === 'tool_result' && event.id === freshId), 2000,
      'The revised fresh proposal must remain eligible for the same turn\'s lease queue');
    const prematureResult = events.find(event => event.type === 'tool_result' && event.id === freshId);
    assert.equal(prematureResult, undefined,
      `The fresh proposal must queue behind A, not fail from an undispatched old title: ${JSON.stringify(prematureResult?.error)}`);
    await endOwner();
    assert.equal((await bounded(running, 5000, 'The revised call did not finish after the owner released its lease')).stopReason, 'end_turn');
    assert.deepEqual(calls.map(call => call.params.arguments.tag), ['owner', 'fresh']);
    assert.equal(models.length, 3);
    assert.equal(models[2].messages.filter(message => message.role === 'tool' && message.tool_call_id === freshId).length, 1);
    assert.match(JSON.stringify(models[2].messages), /FRESH_ACTION_RECEIPT/);
    const history = await driver.history(sessionId);
    const oldResults = history.events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === oldId);
    assert.equal(oldResults.length, 1);
    assert.equal(oldResults[0].data.message.source.kind, 'tool');
    assert.equal(oldResults[0].data.message.isError, true);
    assert.equal(history.events.filter(event => event.type === 'turn/start').length, 1);
    assert.equal(history.events.filter(event => event.type === 'user/message' && event.data.source?.rpcId === 'desktop-queue-steer').length, 1);
    assert.deepEqual(fixtureErrors, []);
  });

test('a withdrawn tail proposal never dispatches later and a fresh proposal cannot pass its real predecessor',
  { timeout: 6000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'codebuddy-steering-desktop-tail-'));
    const coordinator = new DesktopCoordinator({ directory: root });
    const signal = new AbortController(), bus = new EventEmitter();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const order = [];
    let pending = false, oldSettled = false, freshSettled = false;
    const agent = { codebuddyHasPendingSteering: () => pending };
    const ctx = { on(name, listener) { bus.on(name, listener); return () => bus.off(name, listener); } };
    const turn = coordinator.begin({ sessionId: 'tail-owner', token: 'tail-owner', signal: signal.signal });
    const waitingTool = () => ({ name: 'mcp__qwen_computer__click', signal: signal.signal,
      waitForSteering: wait => waitForSteeringInput(ctx, { agent, signal: signal.signal }, wait) });
    let first, old, fresh;
    t.after(async () => {
      release.resolve();
      await bounded(Promise.allSettled([first, old, fresh]), 2000, 'Tail fixture calls did not settle');
      await bounded(turn.end(), 1000, 'Tail fixture cleanup did not settle');
      await rm(root, { recursive: true, force: true });
    });
    // This is the coordinator contract seam, not a claim that the native MCP
    // scheduler marks desktop input safe for parallel execution.
    first = turn.execute({ name: 'mcp__qwen_computer__click' }, async () => {
      order.push('predecessor-start'); entered.resolve(); await release.promise;
      order.push('predecessor-end'); return 'PREDECESSOR_RECEIPT';
    });
    await entered.promise;
    old = assert.rejects(turn.execute(waitingTool(), async () => {
      order.push('old'); assert.fail('The withdrawn old tail closure dispatched late');
    }), error => error.desktopOutcome === 'steered').then(() => { oldSettled = true; });
    await until(() => bus.listenerCount('codebuddy/steer-requested') === 1, 500, 'The old tail waiter did not attach');
    bus.emit('codebuddy/steer-requested', { agent: {} });
    await delay(30);
    assert.equal(oldSettled, false, 'Another agent\'s steer cannot withdraw this caller');
    pending = true;
    bus.emit('codebuddy/steer-requested', { agent });
    await bounded(old, 500, 'The obsolete tail wait did not release before the predecessor');
    assert.deepEqual(order, ['predecessor-start']);
    assert.equal(signal.signal.aborted, false);
    pending = false; // The next native sampling boundary has consumed the input.
    fresh = turn.execute(waitingTool(), async () => { order.push('fresh'); return 'FRESH_RECEIPT'; })
      .then(result => { freshSettled = true; return result; });
    await delay(50);
    assert.equal(freshSettled, false, 'Withdrawing a waiter must not reset the predecessor tail');
    assert.deepEqual(order, ['predecessor-start']);
    release.resolve();
    assert.equal(await first, 'PREDECESSOR_RECEIPT');
    assert.equal(await fresh, 'FRESH_RECEIPT');
    assert.deepEqual(order, ['predecessor-start', 'predecessor-end', 'fresh']);
    assert.equal(bus.listenerCount('codebuddy/steer-requested'), 0);
  });

async function presentationFixture(t, { discovery = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-steering-desktop-presentation-'));
  const coordinator = new DesktopCoordinator({ directory: join(root, 'control') });
  const signal = new AbortController(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const models = [], calls = [], events = [], fixtureErrors = [];
  const oldId = 'desktop-presentation-old', freshId = 'desktop-presentation-fresh', initial = 'INITIAL_PRESENTATION_DESKTOP_TASK';
  let driver, turn, running;
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (req.url === '/mcp') {
        if (!('id' in body)) { res.writeHead(202).end(); return; }
        let result;
        if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} },
          serverInfo: { name: 'presentation-fixture', version: '1' } };
        else if (body.method === 'tools/list') result = { tools: ['click', 'list_apps', 'get_app_state'].map(name => ({
          name, description: 'Loopback fixture only', inputSchema: { type: 'object', properties: { window_title: { type: 'string' } } },
        })) };
        else if (body.method === 'tools/call') {
          calls.push(body);
          if (discovery) {
            assert.equal(body.params.name, 'get_app_state');
            assert.equal(body.params.arguments.window_title, 'Fixture Window B');
            assert.equal(body.params._meta['codebuddy/desktop-control'].windowTitle, 'Fixture Window B');
          }
          result = { content: [{ type: 'text', text: discovery ? 'FRESH_DISCOVERY_RECEIPT' : 'UNEXPECTED_CLICK_RECEIPT' }] };
        } else result = {};
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        return;
      }
      if (replyToNoActionReview(body, res)) return;
      const main = Array.isArray(body.tools) && body.tools.length > 0;
      if (main) models.push(body);
      const first = main && models.length === 1;
      const proposing = first || main && discovery && models.length === 2;
      const delta = proposing ? { role: 'assistant', tool_calls: [{ index: 0, id: first ? oldId : freshId, type: 'function',
        function: { name: `mcp__qwen_computer__${discovery ? first ? 'list_apps' : 'get_app_state' : 'click'}`,
          arguments: JSON.stringify(discovery ? { window_title: first ? 'Fixture Window A' : 'Fixture Window B' } : {}) } }] }
        : { role: 'assistant', content: main ? 'Finished the revised fixture.' : 'Presentation fixture' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [chunk, finish_reason] of [[delta, null], [{}, proposing ? 'tool_calls' : 'stop']])
        res.write(`data: ${JSON.stringify({ id: 'presentation-fixture', choices: [{ index: 0, delta: chunk, finish_reason }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) {
      fixtureErrors.push(error); if (!res.headersSent) res.writeHead(500); res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    signal.abort(); release.resolve();
    try {
      await bounded(Promise.resolve(running).catch(() => {}), 5000, 'Presentation Harness cleanup did not settle');
      await bounded(Promise.resolve(turn?.end()), 2000, 'Presentation tail cleanup did not settle');
    } finally {
      try { await bounded(Promise.resolve(driver?.close()), 5000, 'Presentation driver close did not settle'); }
      finally {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  driver = await createHarnessDriver({ dataDir: join(root, 'harness'), cwd: root });
  const { sessionId } = await driver.createSession({ cwd: root,
    provider: { id: 'fixture', baseUrl: `${base}/v1`, apiKey: 'fixture-only' }, model: 'fixture',
    options: { mcpServers: [{ serverName: 'qwen_computer', transport: 'streamable-http', url: `${base}/mcp` }] },
  });
  turn = coordinator.begin({ sessionId, token: 'presentation-subject', signal: signal.signal });
  return { driver, sessionId, coordinator, signal, entered, release, models, calls, events, fixtureErrors, oldId, freshId, initial,
    start() {
      running = driver.prompt(sessionId, initial, { signal: signal.signal, onPermission: async () => true,
        onToolPolicy: tool => turn.admit(tool, async () => ({ kind: 'allow' })),
        onDesktopTool: (tool, next) => turn.execute(tool, next), desktopMetadata: () => turn.metadata(),
        onEvent: event => events.push(event),
        onToolStart: async call => { if (call.id === oldId) { entered.resolve(); await release.promise; } },
      });
      running.catch(() => {}); return running;
    },
  };
}

test('steering during asynchronous onToolStart still skips a desktop body that has not dispatched',
  { timeout: 15000 }, async t => {
    const f = await presentationFixture(t), running = f.start();
    await bounded(f.entered.promise, 4000, 'The asynchronous presentation window did not start');
    assert.equal(f.calls.length, 0);
    const lease = f.coordinator.readLease();
    await f.driver.steer(f.sessionId, 'STEER_INSIDE_TOOL_PRESENTATION', { requestId: 'presentation-steer', preempt: true });
    assert.equal(f.signal.signal.aborted, false);
    assert.equal(f.models.length, 1, 'The held presentation callback must finish before native tool settlement');
    f.release.resolve();
    assert.equal((await bounded(running, 5000, 'The revised presentation turn did not finish')).stopReason, 'end_turn');
    assert.equal(f.calls.length, 0, 'A steer received before next() must not dispatch the obsolete click');
    assert.deepEqual(f.coordinator.readLease(), lease);
    assert.equal(f.models.length, 2);
    const receipt = f.models[1].messages.filter(message => message.role === 'tool' && message.tool_call_id === f.oldId);
    assert.equal(receipt.length, 1);
    assert.match(JSON.stringify(receipt[0].content), /before dispatch|not dispatched|未派发/iu);
    const results = f.events.filter(event => event.type === 'tool_result' && event.id === f.oldId);
    assert.equal(results.length, 1); assert.equal(results[0].isError, true);
    const users = JSON.stringify(f.models[1].messages.filter(message => message.role === 'user'));
    assert.equal(users.split(f.initial).length - 1, 1);
    assert.equal(users.split('STEER_INSIDE_TOOL_PRESENTATION').length - 1, 1);
    const history = await f.driver.history(f.sessionId);
    assert.equal(history.events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === f.oldId).length, 1);
    assert.equal(history.events.filter(event => event.type === 'user/message' && event.data.source?.rpcId === 'presentation-steer').length, 1);
    assert.deepEqual(f.fixtureErrors, []);
  });

test('real Stop wins over a steer received while the desktop presentation callback is still pending',
  { timeout: 15000 }, async t => {
    const f = await presentationFixture(t), running = f.start();
    await bounded(f.entered.promise, 4000, 'The Stop test never reached the pending presentation callback');
    await f.driver.steer(f.sessionId, 'STEER_BEFORE_REAL_STOP', { requestId: 'presentation-stop-steer', preempt: true });
    const stopping = Promise.resolve(f.driver.cancel(f.sessionId));
    stopping.catch(() => {});
    await delay(30);
    assert.equal(f.models.length, 1);
    assert.equal(f.calls.length, 0);
    f.release.resolve();
    await bounded(stopping, 4000, 'The real cancellation did not settle');
    assert.equal((await bounded(running, 4000, 'The stopped presentation turn did not settle')).stopReason, 'cancelled');
    assert.equal(f.models.length, 1, 'A pending steer must not reopen sampling after real Stop');
    assert.equal(f.calls.length, 0, 'The old click must not cross next() after Stop');
    const history = await f.driver.history(f.sessionId);
    const ends = history.events.filter(event => event.type === 'turn/end');
    assert.equal(ends.length, 1); assert.equal(ends[0].data.reason.kind, 'aborted');
    assert.equal(ends[0].data.reason.reason.kind, 'user');
    assert.deepEqual(f.fixtureErrors, []);
  });

test('withdrawn discovery during onToolStart leaves the first dispatched discovery free to bind title B',
  { timeout: 15000 }, async t => {
    const f = await presentationFixture(t, { discovery: true }), running = f.start();
    await bounded(f.entered.promise, 4000, 'The old discovery never reached asynchronous onToolStart');
    assert.equal(f.calls.length, 0, 'The title-A discovery has not crossed the actual MCP dispatch boundary');
    await f.driver.steer(f.sessionId, 'DISCOVER_WINDOW_B_INSTEAD', { requestId: 'presentation-title-steer', preempt: true });
    f.release.resolve();
    assert.equal((await bounded(running, 5000, 'The replacement discovery turn did not finish')).stopReason, 'end_turn');
    const old = f.events.filter(event => event.type === 'tool_result' && event.id === f.oldId);
    assert.equal(old.length, 1); assert.equal(old[0].isError, true);
    const fresh = f.events.filter(event => event.type === 'tool_result' && event.id === f.freshId);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].isError, false,
      `Undispatched title A must not bind the turn: ${JSON.stringify(fresh[0].error)}`);
    assert.equal(f.calls.length, 1, 'Only the fresh title-B discovery may be dispatched');
    assert.equal(f.calls[0].params.name, 'get_app_state');
    assert.equal(f.calls[0].params._meta['codebuddy/desktop-control'].windowTitle, 'Fixture Window B');
    assert.equal(f.models.length, 3);
    const oldReceipt = f.models[1].messages.filter(message => message.role === 'tool' && message.tool_call_id === f.oldId);
    assert.equal(oldReceipt.length, 1);
    assert.match(JSON.stringify(oldReceipt[0].content), /before dispatch|not dispatched|未派发/iu);
    assert.match(JSON.stringify(f.models[2].messages), /FRESH_DISCOVERY_RECEIPT/);
    const users = JSON.stringify(f.models[1].messages.filter(message => message.role === 'user'));
    assert.equal(users.split(f.initial).length - 1, 1);
    assert.equal(users.split('DISCOVER_WINDOW_B_INSTEAD').length - 1, 1);
    assert.deepEqual(f.fixtureErrors, []);
  });
