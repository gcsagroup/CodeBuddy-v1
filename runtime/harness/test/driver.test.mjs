import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHarnessDriver, HARNESS_VERSION } from '../index.mjs';
import { workStatusUpdates } from '../../work-status.mjs';

let driver, server, root, provider;
const requests = [];
const bareToolTexts = {
  subagent: 'call:subagent{description:<|"|>代码审查专家<|"|>,prompt:<|"|>检查示例代码<|"|>,role:<|"|>代码审查专家<|"|>}<tool_call|>',
  image: 'call:generate_image{job_id:<|"|>fixture-existing-job<|"|>,operation:<|"|>status<|"|>,wait_seconds:30}<tool_call|>',
};
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'codebuddy-harness-test-'));
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const request = JSON.parse(raw);
    requests.push({ path: req.url, ...request, wireHeaders: { ...req.headers } });
    const lastUserIndex = request.messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message.content).includes('fixture_'));
    const prompt = JSON.stringify(request.messages[lastUserIndex]?.content ?? '');
    if (prompt.includes('fixture_error')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture rejected request', type: 'invalid_request_error' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
    if (request.tools?.some(tool => tool.function.name === 'check_execution_claims')) {
      const audit = JSON.parse(request.messages.at(-1).content);
      const success = audit.draft.includes('fabricated') ? 'failed-run' : 'successful-run';
      emit({ tool_calls: [{ index: 0, id: 'review', type: 'function', function: {
        name: 'check_execution_claims', arguments: JSON.stringify({ changes: [], successes: [success] }),
      } }] });
      emit({}, 'tool_calls');
    } else if (prompt.includes('fixture_grounding')) {
      const results = request.messages.slice(lastUserIndex + 1).filter(message => message.role === 'tool');
      const correctiveRetry = JSON.stringify(request.messages).includes('previous draft claimed results without supporting receipts');
      if (!results.length || (results.length === 1 && correctiveRetry)) {
        const failed = !results.length;
        emit({ tool_calls: [{ index: 0, id: failed ? 'failed-run' : 'successful-run', type: 'function', function: {
          name: process.platform === 'win32' ? 'pwsh' : 'bash',
          arguments: JSON.stringify({ command: failed ? 'exit 1' : 'exit 0', description: 'Run the isolated check' }),
        } }] });
        emit({}, 'tool_calls');
      } else {
        emit({ content: results.length > 1 ? 'Verified rerun passed.' : 'All tests passed (fabricated).' });
        emit({}, 'stop');
      }
    } else if (prompt.includes('fixture_literal_tool_protocol')) {
      const text = bareToolTexts[prompt.includes('image') ? 'image' : 'subagent'];
      emit({ role: 'assistant', content: text.slice(0, 9) });
      emit({ content: text.slice(9, -6) });
      emit({ content: text.slice(-6) });
      emit({}, 'stop');
      res.end('data: [DONE]\n\n');
      return;
    }
    else if (prompt.includes('fixture_slow')) {
      emit({ role: 'assistant', content: 'started' });
      const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 30000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    else if (prompt.includes('fixture_write_stream') && !request.messages.slice(lastUserIndex + 1).some(message => message.role === 'tool')) {
      const latePath = prompt.includes('late_path');
      const file = join(root, latePath ? 'late-path.txt' : prompt.includes('cancel') ? 'cancel-preview.txt' : 'preview.txt');
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'draft-write', type: 'function', function: { name: 'write', arguments: '{"content":"' + 'x'.repeat(1500) } }] });
      if (!latePath) await new Promise(resolve => setTimeout(resolve, 300));
      emit({ tool_calls: [{ index: 0, function: { arguments: '\\nmore","file_path":' + JSON.stringify(file) } }] });
      if (!latePath) await new Promise(resolve => setTimeout(resolve, 300));
      emit({ tool_calls: [{ index: 0, function: { arguments: '}' } }] });
      emit({}, 'tool_calls');
    } else if (prompt.includes('fixture_write') && !request.messages.slice(lastUserIndex + 1).some(message => message.role === 'tool')) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: join(root, prompt.includes('denied') ? 'denied.txt' : 'allowed.txt'), content: 'harness wrote this\n' }) } }] });
      emit({}, 'tool_calls');
    } else if (prompt.includes('fixture_shell') && !request.messages.slice(lastUserIndex + 1).some(message => message.role === 'tool')) {
      const name = process.platform === 'win32' ? 'pwsh' : 'bash';
      const command = process.platform === 'win32' ? "Write-Output 'CODEBUDDY_HARNESS_SHELL_OK'" : "printf '%s\\n' CODEBUDDY_HARNESS_SHELL_OK";
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-shell', type: 'function', function: { name, arguments: JSON.stringify({ description: 'Print a controlled shell verification marker', command }) } }] });
      emit({}, 'tool_calls');
    } else {
      emit({ role: 'assistant', reasoning_content: 'fixture reasoning' });
      emit({ content: 'Hello ' });
      emit({ content: 'from Harness.' });
      emit({}, 'stop', { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  provider = { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: 'openai-completions', apiKey: 'fixture-key', compat: { thinkingFormat: 'deepseek' } };
  driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
});
after(async () => { await driver?.close(); server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve)); });

async function session() { return driver.createSession({ sessionId: randomUUID(), cwd: root, provider, model: 'fixture-model' }); }

test('real Harness streams, uses HTTP adapter, and persists session history', async () => {
  assert.equal(driver.version, HARNESS_VERSION);
  const created = await session();
  const events = [];
  const result = await driver.prompt(created.sessionId, 'fixture_chat', { onEvent: event => events.push(event) });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.text).join(''), 'Hello from Harness.');
  assert.equal(events.filter(event => event.type === 'thinking_delta').map(event => event.text).join(''), 'fixture reasoning');
  assert.equal(requests.at(-1).path, '/v1/chat/completions');
  const system = JSON.stringify(requests.at(-1).messages.filter(message => message.role === 'system'));
  assert.match(system, /You are CodeBuddy/);
  assert.doesNotMatch(system, /powered by DeepSeek Harness/);
  assert.ok(requests.at(-1).tools.some(tool => tool.function.name === 'search_mcp_tools'));
  assert.ok(requests.at(-1).tools.some(tool => tool.function.name === 'write'));
  assert.ok((await driver.listTools(created.sessionId)).some(tool => tool.name === 'write'));
  const history = await driver.history(created.sessionId);
  assert.ok(history.events.some(event => event.type === 'assistant/message'));
  assert.ok(history.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed'));
  assert.ok((await driver.listSessions()).some(item => item.id === created.sessionId || item.sessionId === created.sessionId));
});

for (const [kind, bareToolText] of Object.entries(bareToolTexts)) test(`${kind} protocol in provider text cannot dispatch, request approval or create a child`, async () => {
  const created = await session();
  const events = [], approvals = [];
  await driver.prompt(created.sessionId, `fixture_literal_tool_protocol_${kind}`, {
    onEvent: event => events.push(event),
    onPermission: call => { approvals.push(call); return true; },
  });
  assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.text).join(''), bareToolText);
  assert.equal(events.filter(event => ['tool_call', 'tool_result', 'subagent_start'].includes(event.type)).length, 0);
  assert.equal(approvals.length, 0);
  const history = await driver.history(created.sessionId);
  assert.equal(history.events.filter(event => event.type === 'tool/call').length, 0);
});

test('official tool pipeline owns requested approval and its dispatch result', async () => {
  const denied = await session();
  const deniedEvents = [];
  await driver.prompt(denied.sessionId, 'fixture_write denied', { onToolPolicy: () => ({ kind: 'ask' }), onEvent: event => deniedEvents.push(event) });
  await assert.rejects(access(join(root, 'denied.txt')));
  assert.ok(deniedEvents.some(event => event.type === 'tool_result' && event.isError));
  const allowed = await session();
  const approvals = [];
  const events = [];
  await driver.prompt(allowed.sessionId, 'fixture_write allowed', {
    onToolPolicy: () => ({ kind: 'ask' }),
    onEvent: event => events.push(event),
    onPermission: async call => { approvals.push(call); return true; },
  });
  assert.equal(await readFile(join(root, 'allowed.txt'), 'utf8'), 'harness wrote this\n');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].name, 'write');
  assert.ok(events.some(event => event.type === 'tool_call' && event.name === 'write'));
  assert.ok(events.some(event => event.type === 'tool_result' && !event.isError));
  assert.equal(events.filter(event => event.type === 'assistant_start').length, 2);
  assert.equal(events.filter(event => event.type === 'assistant_committed').length, 2);
  const project = workStatusUpdates({ sessionId: allowed.sessionId });
  let started = false;
  for (const event of events) {
    // Simulate a dropped result notification while exercising the real loop's
    // batch boundary, rather than declaring completion from assistant text.
    if (event.type === 'tool_result') continue;
    const snapshot = project(event)[0]?.status.data.active_tool_call_ids;
    if (event.type === 'tool_call') { started = true; assert.deepEqual(snapshot, [event.id]); }
    if (event.type === 'assistant_start' && started) assert.deepEqual(snapshot, []);
  }
});

test('streamed file input is visible before native dispatch without leaking draft contents or inventing its path', async () => {
  const created = await session(), events = [];
  const result = await driver.prompt(created.sessionId, 'fixture_write_stream', {
    onPermission: () => true,
    async onEvent(event) {
      events.push(event);
      if (event.type === 'tool_input') await assert.rejects(access(join(root, 'preview.txt')));
    },
  });
  assert.equal(result.stopReason, 'end_turn');
  const previews = events.filter(e => e.type === 'tool_input');
  assert.ok(previews.length >= 2);
  assert.deepEqual(previews[0].preview, { id: 'draft-write', name: 'write', kilobytes: 2 });
  assert.equal(previews.at(-1).preview.path, join(root, 'preview.txt'));
  assert.doesNotMatch(JSON.stringify(previews), /xxxxxxxx|argumentsDelta|content/);
  assert.equal(events.filter(e => e.type === 'tool_call' && e.id === 'draft-write').length, 1);
  assert.ok(events.findIndex(e => e.type === 'tool_input') < events.findIndex(e => e.type === 'tool_call'));
  assert.equal(await readFile(join(root, 'preview.txt'), 'utf8'), 'x'.repeat(1500) + '\nmore');
});

test('stopping during file parameter generation never dispatches or writes the draft', async () => {
  const created = await session(), controller = new AbortController(), events = [];
  const result = await driver.prompt(created.sessionId, 'fixture_write_stream_cancel', {
    signal: controller.signal,
    onEvent(event) { events.push(event); if (event.type === 'tool_input') controller.abort(); },
  });
  assert.equal(result.stopReason, 'cancelled');
  assert.ok(events.some(e => e.type === 'tool_input'));
  assert.equal(events.filter(e => e.type === 'tool_call').length, 0);
  await assert.rejects(access(join(root, 'cancel-preview.txt')));
  const history = await driver.history(created.sessionId);
  assert.equal(history.events.filter(e => e.type === 'tool/call').length, 0);
  assert.equal(history.events.at(-1).data.reason.kind, 'aborted');
});

test('a file path received in the last draft fragment remains visible before native dispatch', async t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const created = await session(), events = [];
  await driver.prompt(created.sessionId, 'fixture_write_stream_late_path', {
    onPermission: () => true,
    onEvent: event => events.push(event),
  });
  const namedPreview = events.findIndex(event => event.type === 'tool_input' && event.preview.path === join(root, 'late-path.txt'));
  const dispatch = events.findIndex(event => event.type === 'tool_call' && event.id === 'draft-write');
  assert.ok(namedPreview >= 0, 'A received file path must not disappear behind the draft throttle');
  assert.ok(namedPreview < dispatch, 'Draft metadata is published before execution');
  assert.equal(events.filter(event => event.type === 'tool_call' && event.id === 'draft-write').length, 1);
  assert.equal(await readFile(join(root, 'late-path.txt'), 'utf8'), 'x'.repeat(1500) + '\nmore');
});

test('adopting a live session and changing its model preserves prior history', async () => {
  const created = await session();
  await driver.prompt(created.sessionId, 'fixture_chat original_model');
  const before = await driver.history(created.sessionId);
  await driver.createSession({ sessionId: created.sessionId, cwd: root, provider, model: 'fixture-model-two' });
  const adopted = await driver.history(created.sessionId);
  assert.deepEqual(adopted.events.slice(0, before.events.length), before.events);
  await driver.prompt(created.sessionId, 'fixture_chat changed_model');
  assert.equal(requests.at(-1).model, 'fixture-model-two');
  assert.equal((await driver.history(created.sessionId)).events.filter(event => event.type === 'turn/end').length, 2);
});

test('changing to a model without reasoning clears the previous request effort', async () => {
  const reasoningProvider = { ...provider, compat: { thinkingFormat: 'openai', supportsReasoningEffort: true }, reasoningEfforts: { low: 'low', high: 'high' } };
  const created = await driver.createSession({ cwd: root, provider: reasoningProvider, model: 'fixture-reasoning', options: { thinkingEffort: 'low' } });
  await driver.prompt(created.sessionId, 'fixture_chat with_effort');
  assert.equal(requests.at(-1).reasoning_effort, 'low');
  await driver.createSession({ sessionId: created.sessionId, cwd: root,
    provider: { ...provider, compat: undefined, reasoningEfforts: false }, model: 'fixture-no-reasoning', options: {} });
  await driver.prompt(created.sessionId, 'fixture_chat without_effort');
  assert.equal(requests.at(-1).model, 'fixture-no-reasoning');
  assert.equal(requests.at(-1).reasoning_effort, undefined);
});

test('cancellation closes a real in-flight model turn', async () => {
  const created = await session();
  const abort = new AbortController();
  const result = await driver.prompt(created.sessionId, 'fixture_slow', {
    signal: abort.signal,
    onEvent: event => { if (event.type === 'text_delta') abort.abort(); },
  });
  assert.equal(result.stopReason, 'cancelled');
  assert.ok((await driver.history(created.sessionId)).events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'));
});

test('provider failure is surfaced and never converted to successful completion', async () => {
  const created = await session();
  await assert.rejects(driver.prompt(created.sessionId, 'fixture_error'), /fixture rejected request|400/);
});

test('cancellation while approval is pending never starts the file tool', async () => {
  const created = await session();
  const abort = new AbortController();
  const result = await driver.prompt(created.sessionId, 'fixture_write denied', {
    onToolPolicy: () => ({ kind: 'ask' }),
    signal: abort.signal,
    onPermission: async () => { abort.abort(); return new Promise(() => {}); },
  });
  assert.equal(result.stopReason, 'cancelled');
  await assert.rejects(access(join(root, 'denied.txt')));
});

test('official platform shell executes only after approval', async () => {
  const created = await session();
  const events = [];
  await driver.prompt(created.sessionId, 'fixture_shell', { onPermission: async () => true, onEvent: event => events.push(event) });
  const outcome = events.find(event => event.type === 'tool_result');
  assert.ok(outcome && !outcome.isError, JSON.stringify(outcome));
  assert.match(JSON.stringify(outcome.result), /CODEBUDDY_HARNESS_SHELL_OK/);
  assert.equal(outcome.structuredContent.kind, 'foreground');
  assert.equal(outcome.structuredContent.exitCode, 0);
  assert.equal(outcome.structuredContent.aborted, false);
  assert.equal(outcome.structuredContent.timedOut, false);
  assert.equal(outcome.name, process.platform === 'win32' ? 'pwsh' : 'bash');
  assert.equal(typeof outcome.arguments.command, 'string');
});

test('a passing-test claim with only a nonzero command receipt is withheld and native recovery can execute the missing rerun', async () => {
  const created = await session();
  const events = [];
  const result = await driver.prompt(created.sessionId, 'fixture_grounding', { onPermission: async () => true, onEvent: event => events.push(event) });
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(events.filter(e => e.type === 'tool_result').map(e => e.structuredContent.exitCode), [1, 0]);
  assert.equal(events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), 'Verified rerun passed.');
  const { events: journal } = await driver.history(created.sessionId);
  assert.ok(journal.some(e => e.type === 'llm/retry'));
  assert.ok(!journal.some(e => e.type === 'assistant/message' && JSON.stringify(e.data.message.content).includes('fabricated')));
});

test('cold history and follow-up survive a clean runtime restart', async () => {
  const created = await session();
  await driver.prompt(created.sessionId, 'fixture_chat before_restart');
  await driver.rename(created.sessionId, 'Persistent Harness chat');
  await driver.close();
  driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  const cold = await driver.history(created.sessionId);
  assert.ok(cold.events.some(event => event.type === 'assistant/message'));
  await driver.createSession({ sessionId: created.sessionId, cwd: root, provider, model: 'fixture-model' });
  await driver.prompt(created.sessionId, 'fixture_chat after_restart');
  const history = await driver.history(created.sessionId);
  assert.equal(history.events.filter(event => event.type === 'turn/end').length, 2);
});

test('API key and custom authorization headers reach HTTP but never enter Harness state', async () => {
  const markers = {
    apiKey: 'CODEBUDDY_FIXTURE_API_KEY_DO_NOT_PERSIST_7fd2',
    authorization: 'Bearer CODEBUDDY_FIXTURE_AUTHORIZATION_DO_NOT_PERSIST_3bf1',
    custom: 'CODEBUDDY_FIXTURE_CUSTOM_HEADER_DO_NOT_PERSIST_4e0a',
  };
  const privateProvider = {
    ...provider,
    apiKey: markers.apiKey,
    headers: { Authorization: markers.authorization, 'X-CodeBuddy-Fixture-Secret': markers.custom },
  };
  const created = await driver.createSession({ sessionId: randomUUID(), cwd: root, provider: privateProvider, model: 'fixture-private-model' });
  await driver.prompt(created.sessionId, 'fixture_chat secret_isolation');
  assert.equal(requests.at(-1).wireHeaders.authorization, markers.authorization);
  assert.equal(requests.at(-1).wireHeaders['x-codebuddy-fixture-secret'], markers.custom);

  // Exercise the separate explicit API-key path too, without a custom override.
  const keyed = await driver.createSession({ sessionId: randomUUID(), cwd: root, provider: { ...provider, apiKey: markers.apiKey }, model: 'fixture-private-model' });
  await driver.prompt(keyed.sessionId, 'fixture_chat explicit_key_isolation');
  assert.equal(requests.at(-1).wireHeaders.authorization, `Bearer ${markers.apiKey}`);

  const stateDir = join(root, 'state');
  async function assertSecretsAbsent(directory = stateDir) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) await assertSecretsAbsent(filename);
      else if (entry.isFile()) {
        const bytes = await readFile(filename);
        for (const marker of Object.values(markers)) {
          assert.equal(bytes.includes(Buffer.from(marker)), false, `Fixture secret persisted in ${filename}`);
        }
      }
    }
  }
  const config = JSON.parse(await readFile(join(stateDir, 'codebuddy-host.json'), 'utf8'));
  assert.deepEqual(config.find(entry => entry.id === 'llm-pi-ai').config.providers, {});
  await assertSecretsAbsent();
  await driver.close();
  driver = undefined;
  await assertSecretsAbsent();
});
