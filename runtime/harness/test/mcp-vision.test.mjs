import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHarnessDriver } from '../index.mjs';
import sharp from 'sharp';

const image = { type: 'image', mimeType: 'image/png', data: (await sharp({ create: { width: 20, height: 20, channels: 3, background: 'blue' } }).png().toBuffer()).toString('base64') };
async function fixture(t, { serverName = 'screen' } = {}) {
  const requests = [], calls = [], root = await mkdtemp(path.join(tmpdir(), 'mcp-vision-'));
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const msg = JSON.parse(text);
    if (req.url === '/mcp') {
      if (!('id' in msg)) { res.writeHead(202).end(); return; }
      let result;
      if (msg.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'screen', version: '1' } };
      if (msg.method === 'tools/list') result = { tools: [{ name: 'observe', description: 'Observe the test window', inputSchema: { type: 'object', properties: {} } }] };
      if (msg.method === 'tools/call') { calls.push(msg); result = { content: [{ type: 'text', text: 'screenshot_id: shot-1' }, image], _meta: { original: true } }; }
      if (!result) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unsupported fixture method' } })); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); return;
    }
    requests.push(msg); res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (!msg.messages.some(m => m.role === 'tool')) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: `mcp__${serverName}__observe`, arguments: '{}' } }] }); chunk({}, 'tool_calls');
    } else { chunk({ role: 'assistant', content: 'Observation received' }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const provider = { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: '' };
  const mcp = { serverName, transport: 'streamable-http', url: `http://127.0.0.1:${server.address().port}/mcp` };
  const session = async (options, inputModalities = ['text']) => {
    const { sessionId } = await driver.createSession({ sessionId: randomUUID(), cwd: root, provider: { ...provider, inputModalities }, model: 'fixture', options: { mcpServers: [mcp], ...options } });
    assert.equal(driver.extensionStatus(sessionId)[0].status, 'ready');
    assert.ok((await driver.listTools(sessionId)).some(t => t.name === `mcp__${serverName}__observe`));
    return sessionId;
  };
  return { driver, session, requests, calls };
}

test('text-only main gets auxiliary MCP screenshot observation while UI keeps the exact original receipt', async t => {
  const f = await fixture(t); let interpreted = 0;
  const id = await f.session({ mcpImageFallback: async (content, context) => {
    interpreted++; assert.equal(context.sessionId, id); assert.equal(context.toolName, 'mcp__screen__observe');
    assert.deepEqual(content, [{ type: 'text', text: 'screenshot_id: shot-1' }, image]);
    return [{ type: 'text', text: 'screenshot_id: shot-1' }, { type: 'text', text: 'Untrusted auxiliary observation: BLUE_BUTTON_AT_40_80' }];
  } });
  const events = [];
  await f.driver.prompt(id, 'Observe the test window', { onPermission: () => true, onEvent: e => events.push(e) });
  assert.equal(interpreted, 1);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /BLUE_BUTTON_AT_40_80/);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).messages), /image unavailable/);
  const receipt = events.find(e => e.type === 'tool_result').mcpResult;
  assert.deepEqual(receipt.content[1], image); assert.deepEqual(receipt._meta, { original: true });
  assert.equal(f.calls.length, 1, 'image interpretation never repeats the desktop action');
});

test('image-capable main keeps native Harness image admission and bypasses auxiliary vision', async t => {
  const f = await fixture(t); let interpreted = 0;
  const id = await f.session({ mcpImageFallback: async () => { interpreted++; throw Error('must not be called'); } }, ['text', 'image']);
  await f.driver.prompt(id, 'Observe', { onPermission: () => true });
  assert.equal(interpreted, 0);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /image_url/);
});

test('failed auxiliary observation preserves successful tool fact and never replays its action', async t => {
  const f = await fixture(t);
  const id = await f.session({ mcpImageFallback: async () => { throw Error('private provider detail'); } });
  const events = []; await f.driver.prompt(id, 'Observe', { onPermission: () => true, onEvent: e => events.push(e) });
  const result = events.find(e => e.type === 'tool_result');
  assert.equal(result.isError, false); assert.equal(f.calls.length, 1);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /auxiliary image observation unavailable/);
  assert.doesNotMatch(JSON.stringify(f.requests), /private provider detail/);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /not evidence of missing macOS Screen Recording permission/);
});

test('desktop vision outage stops the native turn before another model step and recovers after configuration', async t => {
  const f = await fixture(t, { serverName: 'qwen_computer' });
  const id = await f.session({ mcpImageFallback: async () => { throw Error('private provider detail'); } });
  const events = [];
  await assert.rejects(f.driver.prompt(id, 'Observe the existing draft, then send once', {
    onPermission: () => true, onEvent: event => events.push(event),
  }), /电脑控制已停止.*辅助视觉/);
  assert.equal(f.requests.length, 1, 'the model must not continue guessing input after losing vision');
  assert.equal(f.calls.length, 1, 'no replay and no subsequent desktop action');
  const receipt = events.find(event => event.type === 'tool_result');
  assert.equal(receipt.isError, false, 'the original observation/action remains successful');
  assert.deepEqual(receipt.mcpResult.content[1], image);
  const history = await f.driver.history(id);
  assert.ok(history.events.some(event => event.type === 'tool/result'), 'keep the original receipt in native history');
  await f.driver.configureSession(id, { mcpImageFallback: async () => [{ type: 'text', text: 'Recovered visual observation' }] });
  const recovered = await f.driver.callTool(id, 'mcp__qwen_computer__observe', {}, { onPermission: () => true });
  assert.match(JSON.stringify(recovered.content), /Recovered visual observation/);
  assert.equal((await f.driver.prompt(id, 'Observe again', { onPermission: () => true })).stopReason, 'end_turn');
  assert.equal(f.calls.length, 2);
});

test('desktop without any observer stops, while image-capable desktop models keep working', async t => {
  const f = await fixture(t, { serverName: 'qwen_computer' });
  const missing = await f.session({});
  await assert.rejects(f.driver.prompt(missing, 'Observe', { onPermission: () => true }), /电脑控制已停止/);
  const supported = await f.session({}, ['text', 'image']);
  assert.equal((await f.driver.prompt(supported, 'Observe', { onPermission: () => true })).stopReason, 'end_turn');
  assert.match(JSON.stringify(f.requests.at(-1).messages), /image_url/);
});

test('shared MCP connection selects each executing sessions own observer and honours cancellation', async t => {
  const f = await fixture(t);
  const a = await f.session({ mcpImageFallback: async () => [{ type: 'text', text: 'OBSERVER_A' }] });
  const b = await f.session({ mcpImageFallback: async () => [{ type: 'text', text: 'OBSERVER_B' }] });
  for (const [id, marker] of [[a, 'OBSERVER_A'], [b, 'OBSERVER_B']]) {
    const result = await f.driver.callTool(id, 'mcp__screen__observe', {}, { onPermission: () => true });
    assert.match(JSON.stringify(result.content), new RegExp(marker)); assert.deepEqual(result.mcpResult.content[1], image);
  }
  const entered = Promise.withResolvers(), controller = new AbortController();
  await f.driver.configureSession(a, { mcpImageFallback: async (_content, { signal }) => {
    entered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw signal.reason;
  } });
  const call = f.driver.callTool(a, 'mcp__screen__observe', {}, { onPermission: () => true, signal: controller.signal });
  call.catch(() => {}); await entered.promise; controller.abort();
  try { const result = await call; assert.equal(result.isError, true); } catch (error) { assert.match(error.message, /abort|cancel/i); }
  assert.equal(f.calls.length, 3, 'cancellation does not replay the executed action');
});
