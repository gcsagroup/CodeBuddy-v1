import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHarnessDriver } from '../harness/index.mjs';
import { normalizeGemmaResponse, gemmaToolResponseStop } from '../harness/gemma-response.mjs';

const leakedCall = 'call:fixture_effect{prompt:<|"|>将围巾改为蓝色<|"|>}<tool_call|>';

test('Gemma tool-response stop preserves caller stops and leaves other models, protocols and plain answers alone', () => {
  const payload = { tools: [{ type: 'function' }], stop: ['existing'] };
  const model = { api: 'openai-completions', id: 'vendor/gemma-4-26B-A4B-it' };
  assert.deepEqual(gemmaToolResponseStop(payload, model).stop, ['existing', '<|tool_response>']);
  assert.deepEqual(payload.stop, ['existing']);
  assert.deepEqual(gemmaToolResponseStop({ ...payload, stop: '<|tool_response>' }, model).stop, ['<|tool_response>']);
  for (const other of [{ ...model, id: 'different-model' }, { ...model, api: 'anthropic-messages' }])
    assert.equal(gemmaToolResponseStop(payload, other), payload);
  const noTools = { messages: [], tools: [] };
  assert.equal(gemmaToolResponseStop(noTools, model), noTools);
});

test('native Gemma requests hand off before model-authored tool responses and retain multiple independent calls', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cb-gemma-handoff-'));
  const requests = [], executions = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const request = JSON.parse(raw); requests.push(request);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', model: request.model,
      choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    if (requests.length === 1) {
      for (let i = 0; i < 2; i++) emit({ tool_calls: [{ index: i, id: 'call-' + i, type: 'function', function: { name: 'fixture_effect', arguments: JSON.stringify({ index: i }) } }] });
      // Emulate the inference boundary: without it the server continues with
      // an invented tool response instead of returning execution to Harness.
      if (!request.stop?.includes('<|tool_response>')) emit({ content: 'Invented result: completed with fake-job-id.' });
      emit({}, 'tool_calls');
    } else {
      emit({ reasoning_content: '<|c' });
      for (const content of 'ught\n<channel|>已生成。') emit({ content });
      emit({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); });
  const s = await driver.createSession({ cwd: root, model: 'gemma-4-fixture', provider: { id: 'fixture',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture' }, options: { mcpServers: [], tools: [{ name: 'fixture_effect',
      execute: args => { executions.push(args.index); return { status: 'completed', job_id: 'actual-' + args.index }; } }] } });
  const visible = [];
  assert.equal((await driver.prompt(s.sessionId, 'Generate two independent outputs.', { onPermission: () => true,
    onEvent: e => { if (e.type === 'text_delta') visible.push(e.text); } })).stopReason, 'end_turn');
  assert.deepEqual(executions.sort(), [0, 1]);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.stop?.includes('<|tool_response>') && !r.stop.includes('<tool_call|>')));
  assert.match(JSON.stringify(requests[1].messages), /actual-0/);
  assert.match(JSON.stringify(requests[1].messages), /actual-1/);
  assert.doesNotMatch(JSON.stringify(requests[1].messages), /fake-job-id/);
  assert.equal(visible.join(''), '已生成。');
  const finalMessage = (await driver.history(s.sessionId)).events.findLast(e => e.type === 'assistant/message').data.message;
  assert.deepEqual(finalMessage.content.filter(c => c.type === 'text').map(c => c.text), ['已生成。']);
});

test('leaked Gemma wire calls are rejected across every stream split; examples remain prose', async () => {
  for (const raw of [leakedCall, '<|tool_call>' + leakedCall, '<|channel>thought\n<channel|>' + leakedCall,
    leakedCall + '}\n<|channel>thought\nClaimed submission without a receipt.\n<|tool_call>call:fixture_effect{}']) {
    for (let i = 0; i <= raw.length; i++) {
      const output = await Array.fromAsync(normalizeGemmaResponse([
        ...[raw.slice(0, i), raw.slice(i)].map(text => ({ type: 'text-delta', index: 0, text })),
        { type: 'block-end', index: 0, block: { type: 'text', text: raw } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]));
      assert.equal(output.at(-1).reason.failure.code, 'SERVER');
      assert.equal(output.filter(c => c.type === 'text-delta').length, 0);
      assert.equal(output.some(c => c.block?.type === 'tool-call'), false);
    }
  }
  for (const text of ['`' + leakedCall + '`', 'Example: ' + leakedCall, 'call: is a protocol prefix.']) {
    const output = await Array.fromAsync(normalizeGemmaResponse([
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
    ]));
    assert.equal(output.filter(c => c.type === 'text-delta').map(c => c.text).join(''), text);
    assert.equal(output.at(-1).block.text, text);
  }
});

test('native provider retry recovers leaked calls without executing text, and owns exhaustion and cancellation', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cb-gemma-envelope-'));
  let requests = 0, executions = 0, scenario = 'recover';
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const request = JSON.parse(raw); requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
      id: 'fixture', model: request.model, choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n');
    if (scenario !== 'recover' || requests === 1) {
      for (const content of leakedCall) emit({ content });
      emit({}, 'stop');
    } else if (requests === 2) {
      emit({ tool_calls: [{ index: 0, id: 'valid-call', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } }] });
      emit({}, 'tool_calls');
    } else { emit({ content: 'Done.' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  t.after(async () => {
    await driver.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
    await rm(root, { recursive: true, force: true });
  });
  const session = (delay = 1) => driver.createSession({ cwd: root, model: 'gemma-4-fixture', provider: {
    id: 'fixture', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'fixture',
    retryPolicy: { mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: delay, maxDelayMs: delay, jitterRatio: 0 } },
  }, options: { mcpServers: [], tools: [{ name: 'fixture_effect', execute: () => { executions++; return {}; } }] } });
  const s = await session(); const visible = [];
  assert.equal((await driver.prompt(s.sessionId, 'Use the fixture tool.', { onPermission: async () => true,
    onEvent: e => { if (e.type === 'text_delta') visible.push(e.text); } })).stopReason, 'end_turn');
  assert.equal(requests, 3); assert.equal(executions, 1);
  assert.equal(visible.join(''), 'Done.');
  assert.equal((await driver.history(s.sessionId)).events.filter(e => e.type === 'llm/retry').length, 1);
  scenario = 'exhaust'; requests = 0;
  const exhausted = await session();
  await assert.rejects(driver.prompt(exhausted.sessionId, 'Use the fixture tool.'), { code: 'SERVER' });
  assert.equal(requests, 3); assert.equal(executions, 1);
  scenario = 'cancel'; requests = 0;
  const cancelled = await session(5000); const controller = new AbortController();
  assert.equal((await driver.prompt(cancelled.sessionId, 'Use the fixture tool.', { signal: controller.signal,
    onEvent(e) { if (e.type === 'harness_event' && e.event.type === 'llm/retry') controller.abort(); },
  })).stopReason, 'cancelled');
  assert.equal(requests, 1); assert.equal(executions, 1);
});

test('Gemma text cleanup agrees across streaming and completed blocks for all envelope split positions', async () => {
  for (const [raw, visible] of [
    ['<|channel>thought\n<channel|>', ''],
    ['<|channel>thought\n<channel|>答复', '答复'],
    ['答复<channel|>', '答复'],
    ['引用 `<channel|>` 和 <chan', '引用 `<channel|>` 和 <chan'],
  ]) for (let i = 0; i <= raw.length; i++) {
    const output = await Array.fromAsync(normalizeGemmaResponse([
      ...[raw.slice(0, i), raw.slice(i)].map(text => ({ type: 'text-delta', index: 0, text })),
      { type: 'block-end', index: 0, block: { type: 'text', text: raw } },
    ]));
    assert.equal(output.slice(0, -1).map(c => c.text).join(''), visible);
    assert.equal(output.at(-1).block.text, visible);
  }
});

test('split native Gemma thought boundaries do not leak into short media delivery, while literal examples survive', async () => {
  for (const [reasoning, raw, visible] of [
    ['<|c', 'ught\n<channel|>已生成。', '已生成。'],
    ['<|c', 'ught\n<channel|>', ''],
    ['<|channel>thought\nThe file is saved. Say 已', '生成。".<channel|>已生成。', '已生成。'],
    ['<|channel>thought\nInspect the example.', '`<channel|>` is a protocol token.', '`<channel|>` is a protocol token.'],
    ['Ordinary reasoning.', 'Example <channel|> inside text.', 'Example <channel|> inside text.'],
    ['<|channel>thought\nFinished.<channel|>', 'Literal <channel|> inside text.', 'Literal <channel|> inside text.'],
    ['<|c', '已生成。', '已生成。'],
  ]) for (let i = 0; i <= raw.length; i++) {
    const output = await Array.fromAsync(normalizeGemmaResponse([
      ...[...reasoning].map(text => ({ type: 'reasoning-delta', index: 0, text })),
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } },
      ...[raw.slice(0, i), raw.slice(i)].map(text => ({ type: 'text-delta', index: 1, text })),
      { type: 'block-end', index: 1, block: { type: 'text', text: raw } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]));
    assert.equal(output.filter(c => c.type === 'text-delta').map(c => c.text).join(''), visible);
    assert.equal(output.find(c => c.type === 'block-end' && c.block.type === 'text').block.text, visible);
    assert.equal(output.at(-1).reason.kind, 'stop');
  }
});

test('runaway reasoning is bounded without changing intentionally repeated final prose', async () => {
  const text = 'This is the same sufficiently long paragraph.\n\n'.repeat(30);
  const answer = { type: 'text-delta', index: 0, text };
  assert.deepEqual(await Array.fromAsync(normalizeGemmaResponse([answer])), [answer]);
  const output = await Array.fromAsync(normalizeGemmaResponse([{ ...answer, type: 'reasoning-delta' }]));
  assert.equal(output.at(-1).reason.failure.code, 'REPETITIVE_MODEL_OUTPUT');
});

test('a managed task inside a checkout uses its own instructions and skill roots; a degenerate tool response cannot execute', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cb-install-repro-'));
  const container = join(root, 'storage', 'workspaces'), cwd = join(container, 'task');
  await mkdir(cwd, { recursive: true });
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'AGENTS.md'), 'HOST_CHECKOUT_ONLY');
  await writeFile(join(cwd, 'AGENTS.md'), 'TASK_LOCAL_ONLY');
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
      id: 'fixture', model: 'gemma-4-fixture', choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n');
    if (requests.length === 1) {
      emit({ tool_calls: [{ index: 0, id: 'must-not-run', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } }] });
      for (let i = 0; i < 134; i++) emit({ content: "Let's go.\nActually, the `ScraplingServer` will also implement `Default`.\n\n" });
      emit({}, 'tool_calls');
    } else { emit({ content: 'Ready to continue.' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd, managedWorkspaceRoot: container });
  t.after(async () => {
    await driver.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
    await rm(root, { recursive: true, force: true });
  });
  let executions = 0;
  const session = await driver.createSession({ cwd, model: 'gemma-4-fixture', provider: { id: 'fixture',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'fixture' }, options: {
    mcpServers: [], tools: [{ name: 'fixture_effect', execute: () => { executions++; return {}; } }],
  } });
  const visible = [];
  await assert.rejects(driver.prompt(session.sessionId, 'Connect the tool.', { onPermission: async () => true,
    onEvent: event => { if (event.type === 'text_delta') visible.push(event.text); } }), { code: 'REPETITIVE_MODEL_OUTPUT' });
  assert.equal(executions, 0);
  assert.ok(visible.join('').split('Actually').length <= 16);
  assert.match(JSON.stringify(requests[0].messages), /TASK_LOCAL_ONLY/);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /HOST_CHECKOUT_ONLY/);
  const catalog = await driver.skillCatalog(cwd);
  assert.equal(catalog.roots.find(r => r.source === 'project-agents').path, join(cwd, '.agents', 'skills'));
  assert.equal((await driver.prompt(session.sessionId, 'Continue.')).stopReason, 'end_turn');
});
