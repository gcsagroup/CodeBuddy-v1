import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopCoordinator } from '../desktop-coordinator.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';

// Exercises the real lease/loop/MCP path against a held loopback action. It
// never opens an app, captures the user's desktop, or dispatches native input.
test('steering during an in-flight desktop action preserves that action, skips stale proposals and keeps its receipt', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-steering-desktop-'));
  const coordinator = new DesktopCoordinator({ directory: join(root, 'control') });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const calls = [], models = [], notifications = [];
  let driver, turn, running;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url === '/mcp') {
      if (!('id' in body)) { notifications.push(body.method); res.writeHead(202).end(); return; }
      let result;
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'desktop-steering-fixture', version: '1' } };
      else if (body.method === 'tools/list') result = { tools: [{ name: 'click', description: 'Held local fixture only', inputSchema: { type: 'object', properties: {} } }] };
      else if (body.method === 'tools/call') {
        calls.push(body); entered.resolve(); await release.promise;
        assert.equal(body.params._meta['codebuddy/desktop-control'].token, 'steering-desktop');
        result = { content: [{ type: 'text', text: 'ORIGINAL_DESKTOP_ACTION_COMPLETED_ONCE' }] };
      } else result = {};
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      return;
    }
    if (replyToNoActionReview(body, res)) return;
    models.push(body);
    const delta = models.length === 1 ? { role: 'assistant', tool_calls: [0, 1].map(index => ({ index, id: `desktop-${index}`, type: 'function',
      function: { name: 'mcp__qwen_computer__click', arguments: '{}' } })) } : { role: 'assistant', content: 'Finished the revised local fixture.' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [chunk, finish_reason] of [[delta, null], [{}, models.length === 1 ? 'tool_calls' : 'stop']])
      res.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: chunk, finish_reason }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    release.resolve(); await running?.catch(() => {}); await turn?.end(); await driver?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  driver = await createHarnessDriver({ dataDir: join(root, 'harness'), cwd: root });
  const { sessionId } = await driver.createSession({ cwd: root,
    provider: { id: 'fixture', baseUrl: `${base}/v1`, apiKey: 'fixture-only' }, model: 'fixture',
    options: { mcpServers: [{ serverName: 'qwen_computer', transport: 'streamable-http', url: `${base}/mcp` }] },
  });
  const signal = new AbortController();
  turn = coordinator.begin({ sessionId, token: 'steering-desktop', signal: signal.signal });
  running = driver.prompt(sessionId, 'INITIAL_DESKTOP_TASK', {
    signal: signal.signal, onPermission: async () => true,
    onToolPolicy: tool => turn.admit(tool, async () => ({ kind: 'allow' })),
    onDesktopTool: (tool, next) => turn.execute(tool, next), desktopMetadata: () => turn.metadata(),
  });
  running.catch(() => {}); await entered.promise;
  await driver.steer(sessionId, 'STEER_DURING_DESKTOP', { requestId: 'desktop-steer', preempt: true });
  // Compat performs this after admission too. In-flight ownership must survive.
  await coordinator.preparePrompt(sessionId, { activeInput: true, token: 'steering-desktop' });
  await delay(50);
  assert.equal(models.length, 1, 'An admitted steer does not fabricate a completed in-flight desktop result');
  assert.equal(signal.signal.aborted, false);
  assert.ok(!notifications.includes('notifications/cancelled'));
  release.resolve(); assert.equal((await running).stopReason, 'end_turn');
  assert.equal(calls.length, 1, 'The second obsolete click was never dispatched or replayed');
  assert.equal(models.length, 2);
  const completed = models[1].messages.filter(message => message.role === 'tool' && message.tool_call_id === 'desktop-0');
  const skipped = models[1].messages.filter(message => message.role === 'tool' && message.tool_call_id === 'desktop-1');
  assert.equal(completed.length, 1);
  assert.match(JSON.stringify(completed[0].content), /ORIGINAL_DESKTOP_ACTION_COMPLETED_ONCE/);
  assert.equal(skipped.length, 1);
  assert.match(JSON.stringify(skipped[0].content), /tool call aborted before dispatch/);
  const nextInput = JSON.stringify(models[1].messages);
  assert.equal(nextInput.split('STEER_DURING_DESKTOP').length - 1, 1);
  assert.match(nextInput, /INITIAL_DESKTOP_TASK/);
  assert.match(nextInput, /ORIGINAL_DESKTOP_ACTION_COMPLETED_ONCE/);
  assert.equal(coordinator.state().paused, false);
  const history = await driver.history(sessionId);
  assert.equal(history.events.filter(event => event.type === 'turn/start').length, 1);
  assert.equal(history.events.filter(event => event.type === 'user/message' && event.data.source?.rpcId === 'desktop-steer').length, 1);
});
