import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopCoordinator } from '../desktop-coordinator.mjs';
import { createHarnessDriver } from '../harness/index.mjs';

for (const phase of ['execution', 'approval', 'conflict', 'unavailable']) test(`real Harness ${phase} interruption preserves independent work`, { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-harness-'));
  const coordinator = new DesktopCoordinator({ directory: join(root, 'control') });
  const signal = new AbortController(), calls = [], models = [];
  let turn, sessionId;
  const events = [];
  const sequence = phase === 'conflict' ? ['click', 'get_app_state', 'click', 'list_apps', 'click', 'click', 'work'] : ['click', 'click', 'work'];
  let conflicts = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (req.url.startsWith('/mcp/')) {
      if (!('id' in body)) { res.writeHead(202).end(); return; }
      const desktop = req.url.endsWith('desktop');
      let result;
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      else if (body.method === 'tools/list') result = { tools: (desktop ? ['click', 'get_app_state', 'list_apps'] : ['work']).map(name => ({ name, description: 'Local acceptance fixture', inputSchema: { type: 'object', properties: {} } })) };
      else if (body.method === 'tools/call') {
        calls.push(body);
        if (desktop) {
          assert.equal(body.params._meta['codebuddy/desktop-control'].token, 'turn');
          if (phase === 'unavailable') {
            result = { isError: true, content: [{ type: 'text', text: 'Native lease directory is missing.' }],
              structuredContent: { desktop_control: { schema_version: 1, outcome: 'control_unavailable' } } };
          } else if (phase === 'conflict') {
            const conflict = body.params.name === 'click';
            if (conflict) conflicts++;
            result = { content: [{ type: 'text', text: conflict ? 'Fresh state only; no click dispatched.' : 'Observation only.' }],
              ...(conflict ? { isError: conflicts === 2, structuredContent: { desktop_control: { schema_version: 1, outcome: 'input_conflict' } } } : {}) };
          } else {
            coordinator.pause(sessionId, 'turn', 'escape');
            result = { content: [{ type: 'text', text: 'PRIVATE_AFTER_TAKEOVER' }] };
          }
        } else result = { content: [{ type: 'text', text: 'INDEPENDENT_WORK_DONE' }] };
      } else result = {};
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); return;
    }
    models.push(body);
    const count = body.messages.filter(m => m.role === 'tool').length;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = count >= sequence.length ? { role: 'assistant', content: 'Independent work finished; desktop control was interrupted.' } : {
      role: 'assistant', tool_calls: [{ index: 0, id: `call-${count}`, type: 'function', function: { name: sequence[count] === 'work' ? 'mcp__other__work' : `mcp__qwen_computer__${sequence[count]}`, arguments: '{}' } }],
    };
    for (const [data, finish_reason] of [[delta, null], [{}, count >= sequence.length ? 'stop' : 'tool_calls']])
      res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: data, finish_reason }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const driver = await createHarnessDriver({ dataDir: join(root, 'harness'), cwd: root });
  t.after(async () => { signal.abort(); await turn?.end(); await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  ({ sessionId } = await driver.createSession({ cwd: root, provider: { id: 'fixture', baseUrl: base + '/v1', apiKey: 'fixture' }, model: 'fixture', options: {
    mcpServers: [{ serverName: 'qwen_computer', transport: 'streamable-http', url: base + '/mcp/desktop' }, { serverName: 'other', transport: 'streamable-http', url: base + '/mcp/other' }],
  } }));
  turn = coordinator.begin({ sessionId, token: 'turn', signal: signal.signal });
  if (phase === 'approval') await turn.execute({ name: 'mcp__qwen_computer__get_app_state' }, async () => ({}));
  let approvals = 0;
  const result = await driver.prompt(sessionId, 'Perform desktop fixture then independent work.', {
    signal: signal.signal,
    onToolPolicy: tool => turn.admit(tool, async () => ({ kind: phase === 'approval' && tool.name === 'mcp__qwen_computer__click' ? 'ask' : 'allow' })),
    onPermission: tool => turn.admit(tool, async scoped => {
      approvals++;
      return new Promise((resolve, reject) => {
        scoped.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
        queueMicrotask(() => coordinator.pause(sessionId, 'turn', 'escape'));
      });
    }),
    onDesktopTool: (tool, next) => turn.execute(tool, next), desktopMetadata: () => turn.metadata(),
    onEvent: event => events.push(event),
  });
  assert.notEqual(result.stopReason, 'cancelled');
  assert.equal(signal.signal.aborted, false);
  assert.equal(approvals, phase === 'approval' ? 1 : 0, 'interrupted retries do not ask again');
  assert.equal(calls.length, phase === 'conflict' ? 6 : phase === 'approval' ? 1 : 2, 'the repeated desktop proposal never reaches native input, independent tool still runs');
  assert.match(JSON.stringify(models), /INDEPENDENT_WORK_DONE/);
  assert.doesNotMatch(JSON.stringify(models), /PRIVATE_AFTER_TAKEOVER/);
  assert.match(JSON.stringify(models), phase === 'unavailable' ? /DESKTOP_UNAVAILABLE/ : /DESKTOP_STOPPED/);
  assert.doesNotMatch(JSON.stringify(models), /简要说明进度后结束本轮/);
  assert.equal(coordinator.state().paused, phase !== 'unavailable');
  assert.ok(events.some(e => e.type === 'tool_result' && e.name === 'mcp__qwen_computer__click' && e.desktopOutcome === 'stopped'));
  if (phase === 'conflict') {
    assert.equal(conflicts, 3);
    assert.equal(coordinator.state().pauseReason, 'input_conflicts');
    assert.equal(events.filter(e => e.type === 'tool_result' && e.desktopOutcome === 'stopped').length, 2);
  }
});
