import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../harness/index.mjs';

test('direct goal tools preserve the official model-turn boundary and never launch unobserved rounds', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-direct-goal-'));
  const requests = [], approvals = [], events = [];
  let effects = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (requests.length === 1) {
      emit({ tool_calls: [{ index: 0, id: 'background-effect', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } }] });
      emit({}, 'tool_calls');
    } else { emit({ content: 'UNATTACHED_GOAL_ROUND' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  const sessionId = randomUUID();
  let history;
  const results = [];
  try {
    await driver.createSession({ sessionId, cwd: root, model: 'fixture',
      provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture' },
      options: { tools: [{ name: 'fixture_effect', inputSchema: { type: 'object', properties: {} }, async execute() { effects++; return { applied: true }; } }] },
    });
    const tools = (await driver.listTools(sessionId)).map(tool => tool.name);
    assert.ok(tools.includes('create_goal') && tools.includes('get_goal') && tools.includes('update_goal'));
    for (const [name, args] of [
      ['create_goal', { objective: 'An isolated direct-tool goal', max_goal_rounds: 1 }],
      ['update_goal', { goal_id: 'fixture-goal', revision: 1, action: 'resume' }],
      ['get_goal', {}],
    ]) {
      results.push(await driver.callTool(sessionId, name, args, {
        onToolStart: tool => { approvals.push(tool.name); },
        onEvent: event => events.push(event),
      }));
    }
    // Allow the official idle/checkpoint driver to expose accidental scheduling.
    await delay(250);
    history = await driver.history(sessionId);
  } finally {
    driver.cancel(sessionId);
    await driver.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  const evidence = {
    modelRequests: requests.length,
    turnStarts: history.events.filter(event => event.type === 'turn/start').length,
    approvals, forwardedEvents: events.map(event => event.type), effects,
  };
  assert.equal(requests.length, 0, `A direct toolbox call started an unbound model loop: ${JSON.stringify(evidence)}`);
  for (const result of results) {
    assert.equal(result.isError, true, 'official tools reject calls outside an open model turn');
    assert.match(JSON.stringify(result), /goal tools require (?:an open model turn|the exact live calling agent inside its active driver)/);
  }
  assert.equal(evidence.turnStarts, 0);
  assert.deepEqual(approvals, ['create_goal', 'update_goal', 'get_goal']);
  assert.equal(effects, 0);
});
