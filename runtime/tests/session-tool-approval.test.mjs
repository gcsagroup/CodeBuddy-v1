import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { Compat } from '../compat.mjs';
import { openStore } from '../store.mjs';
import { SafetyPolicy } from '../safety-policy.mjs';
import { createHarnessDriver } from '../harness/index.mjs';

test('one session approval covers four native MCP queries, later turns and only that live module', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-session-approval-'));
  const project = join(root, 'project');
  await mkdir(project);
  const executions = [];
  let reusableChild;
  const remote = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url.startsWith('/mcp')) {
      if (!('id' in body)) { res.writeHead(202).end(); return; }
      let result;
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'local-search-fixture', version: '1' } };
      else if (body.method === 'tools/list') result = { tools: ['search', 'other_search', 'destructive'].map(name => ({
        name, description: 'Local isolated approval fixture', annotations: { readOnlyHint: true, destructiveHint: name === 'destructive' },
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      })) };
      else if (body.method === 'tools/call') {
        executions.push({ endpoint: req.url, ...body.params });
        result = { content: [{ type: 'text', text: `fixture result ${body.params.arguments.query}` }] };
      } else { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Unknown fixture method' } })); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      return;
    }
    const delegation = body.messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message.content).includes('SESSION_APPROVAL_DELEGATE'));
    const user = delegation >= 0 ? delegation : body.messages.findLastIndex(message => message.role === 'user');
    const replies = body.messages.slice(user + 1).filter(message => message.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (JSON.stringify(body.messages[user]?.content).includes('SESSION_APPROVAL_DELEGATE')) {
      if (!replies.length) {
        const name = reusableChild ? 'send_message' : 'subagent';
        const args = reusableChild ? { agent_id: reusableChild, message: 'Run the four child queries again.' }
          : { description: 'Reusable query worker', prompt: 'Run the four child queries.' };
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
      } else {
        emit({ role: 'assistant', content: 'Delegated fixture dispatched.' }, 'stop');
      }
    } else if (replies.length === 0) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: 'search_mcp_tools', arguments: JSON.stringify({ names: ['mcp__web__search'] }) } }] }, null);
      emit({}, 'tool_calls');
    } else if (replies.length === 1) {
      emit({ role: 'assistant', tool_calls: Array.from({ length: 4 }, (_, i) => ({ index: i, id: randomUUID(), type: 'function', function: { name: 'mcp__web__search', arguments: JSON.stringify({ query: `query-${i}` }) } })) }, null);
      emit({}, 'tool_calls');
    } else {
      emit({ role: 'assistant', content: 'Four isolated fixture queries finished.' }, null);
      emit({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${remote.address().port}`;
  const driver = await createHarnessDriver({ dataDir: join(root, 'native'), cwd: project });
  t.after(async () => { await driver.close(); remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); });
  const store = await openStore(join(root, 'host'));
  const host = Object.assign(Object.create(Compat.prototype), {
    store, settings: { extensions: async () => [] }, active: new Map(), safety: new SafetyPolicy(store),
  });
  const provider = { id: 'local-approval-fixture', baseUrl: `${base}/v1`, apiKey: 'fixture-only', protocol: 'openai-completions' };
  const nativeOptions = endpoint => ({ mcpServers: [{ serverName: 'web', transport: 'streamable-http', sessionApprovalScope: 'module', url: base + endpoint, reconnect: { enabled: false } }] });
  async function session(id = randomUUID()) {
    const s = { id, cwd: project, mode: 'approve', type: 'code_pro', workspaceBinding: 'writable_project', updates: [], mcpServers: [{ name: 'web', type: 'http', url: base + '/mcp', headers: [] }] };
    await store.update(state => state.sessions.push(s));
    await driver.createSession({ sessionId: id, cwd: project, provider, model: 'fixture-model', options: nativeOptions('/mcp') });
    return s;
  }
  const firstQuestion = Promise.withResolvers(), firstReply = Promise.withResolvers();
  const questions = [], permissions = [];
  let choice = 'reject_once', held = false;
  const connection = { async ask(method, params) {
    assert.equal(method, 'session/request_permission');
    questions.push(params);
    if (!held) { held = true; firstQuestion.resolve(); await firstReply.promise; return { outcome: { outcome: 'selected', optionId: 'allow_always' } }; }
    return { outcome: { outcome: 'selected', optionId: choice } };
  } };
  const callbacks = s => ({ onToolPolicy: call => {
    permissions.push(call);
    return host.toolPolicy(s, call, call.signal);
  }, onPermission: call => {
    return host.approveTool(s, call, connection, call.signal);
  } });
  const a = await session();
  const work = driver.prompt(a.id, 'Run the four local fixture queries.', callbacks(a));
  await firstQuestion.promise;
  await immediate(); await immediate();
  assert.equal(questions.length, 1, 'Concurrent same-tool calls share one pending approval');
  assert.equal(executions.length, 0, 'No query executes before the user decision');
  assert.equal(questions[0]._meta.codepro.authorizationScope, 'session');
  assert.equal(questions[0]._meta.codepro.extensionSource, 'external_http');
  assert.ok(questions[0].options.some(option => option.kind === 'allow_always'));
  firstReply.resolve();
  await work;
  assert.equal(executions.length, 4);
  assert.equal(questions.length, 1);
  assert.equal(store.read(['toolPermissions']).toolPermissions, undefined, 'Session approval must not write a global rule');
  await driver.prompt(a.id, 'Run the same four local queries in the next turn.', callbacks(a));
  assert.equal(executions.length, 8);
  assert.equal(questions.length, 1, 'The same live tool reuses the explicit grant across turns');

  await driver.prompt(a.id, 'SESSION_APPROVAL_DELEGATE first turn', callbacks(a));
  reusableChild = (await driver.listSubagentChildren(a.id))[0].id;
  assert.equal(executions.length, 12, 'An actual child consumes the root session grant without an approval RPC');
  assert.equal(questions.length, 1);
  await driver.prompt(a.id, 'SESSION_APPROVAL_DELEGATE later turn', callbacks(a));
  assert.deepEqual((await driver.listSubagentChildren(a.id)).map(child => child.id), [reusableChild]);
  assert.equal(executions.length, 16, 'The same child reuses the same grant in a later parent turn');
  assert.equal(questions.length, 1);

  // Other conversations and destructive tools stay separate; a sibling tool shares the module.
  const b = await session();
  assert.equal((await driver.callTool(b.id, 'mcp__web__search', { query: 'other-chat' }, callbacks(b))).isError, true);
  assert.equal((await driver.callTool(a.id, 'mcp__web__other_search', { query: 'other-tool' }, callbacks(a))).isError, false);
  assert.equal((await driver.callTool(a.id, 'mcp__web__destructive', { query: 'must-not-run' }, callbacks(a))).isError, true);
  assert.equal(questions.at(-1).options.some(option => option.kind === 'allow_always'), false);
  assert.equal(executions.length, 17);
  await store.update(state => { state.toolPermissions = { mcp__web__search: 'never_allow' }; });
  const beforeDeny = questions.length;
  assert.equal((await driver.callTool(a.id, 'mcp__web__search', { query: 'explicit-deny' }, callbacks(a))).isError, true);
  assert.equal(questions.length, beforeDeny);
  await store.update(state => { state.toolPermissions = {}; });

  const oldContext = permissions.find(call => call.name === 'mcp__web__search').sessionApproval;
  await driver.configureSession(a.id, nativeOptions('/mcp-replaced'));
  assert.equal(oldContext.isCurrent(), false);
  const beforeReplacement = questions.length;
  assert.equal((await driver.callTool(a.id, 'mcp__web__search', { query: 'same-name-new-connection' }, callbacks(a))).isError, true);
  assert.equal(questions.length, beforeReplacement + 1);
  assert.equal(executions.length, 17, 'A replaced binding must ask again before execution');
});

test('cancelled or superseded approval never grants later queries, and native commands stay once-only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-approval-boundary-'));
  const store = await openStore(root);
  const s = { id: randomUUID(), cwd: root, mode: 'approve', updates: [] };
  await store.update(state => state.sessions.push(s));
  const host = Object.assign(Object.create(Compat.prototype), {
    store, settings: { extensions: async () => [] }, active: new Map(), safety: new SafetyPolicy(store),
  });
  let current = true;
  const context = { owner: {}, tool: {}, extensionSource: 'external_stdio', isCurrent: () => current };
  const ready = Promise.withResolvers(), answer = Promise.withResolvers();
  const controller = new AbortController();
  const connection = { async ask() { ready.resolve(); await answer.promise; return { outcome: { outcome: 'selected', optionId: 'allow_always' } }; } };
  const call = { name: 'fixture_query', arguments: {}, sessionApproval: context };
  const work = host.approveTool(s, call, connection, controller.signal);
  await ready.promise;
  current = false;
  answer.resolve();
  assert.equal(await work, false, 'A changed live binding invalidates even a late approval');
  current = true;
  const denied = { async ask(_method, params) {
    assert.ok(params.options.some(option => option.kind === 'allow_always'));
    return { outcome: { outcome: 'selected', optionId: 'reject_once' } };
  } };
  assert.equal(await host.approveTool(s, call, denied), false, 'The stale answer was not remembered');
  await host.approveTool(s, { name: 'pwsh', arguments: { command: 'node --version', sessionApproval: context } }, { async ask(_method, params) {
    assert.equal(params.options.some(option => option.kind === 'allow_always'), false, 'Model arguments cannot create a reusable shell grant');
    return { outcome: { outcome: 'selected', optionId: 'allow_always' } };
  } });
  const pending = Promise.withResolvers(), release = Promise.withResolvers();
  const abort = new AbortController();
  const waitingConnection = { async ask() { pending.resolve(); await release.promise; return { outcome: { outcome: 'selected', optionId: 'allow_always' } }; } };
  const first = host.approveTool(s, call, waitingConnection, abort.signal);
  await pending.promise;
  const childAbort = new AbortController();
  const second = host.approveTool(s, call, waitingConnection, childAbort.signal);
  const secondRejected = assert.rejects(second, /cancelled second call/);
  childAbort.abort(new Error('cancelled second call'));
  await secondRejected;
  abort.abort(new Error('cancelled first call'));
  const firstRejected = assert.rejects(first, /cancelled first call/);
  release.resolve();
  await firstRejected;
  assert.equal(await host.approveTool(s, call, denied), false, 'A cancelled selection never grants permission');
});


test('uncertain safety checks escalate to the parent user and never silently authorize or block the whole turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-safety-fallback-'));
  const store = await openStore(root);
  const session = { id: randomUUID(), cwd: root, mode: 'smart_approve', updates: [] };
  await store.update(state => {
    state.sessions.push(session);
    state.config = { SECURITY_PROMPT_ENABLED: { value: true }, SECURITY_COMMAND_CLASSIFIER_ENABLED: { value: false } };
  });
  const host = Object.assign(Object.create(Compat.prototype), {
    store, settings: { extensions: async () => [] }, active: new Map(), safety: new SafetyPolicy(store),
  });
  const call = { name: 'pwsh', arguments: { command: 'Write-Output isolated-fixture' } };
  let asked = 0, choice = 'reject_once';
  const connection = { async ask(_method, params) {
    asked++;
    assert.equal(params.options.some(option => option.kind === 'allow_always'), false, 'An unavailable safety check cannot be remembered as a reusable grant');
    assert.ok(params.toolCall.content?.length, 'The approval includes the uncertainty reason');
    return { outcome: { outcome: 'selected', optionId: choice } };
  } };
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
    call.sandboxMode = mode;
    assert.equal((await host.toolPolicy(session, call)).kind, 'ask');
    const before = asked;
    assert.equal(await host.approveTool(session, call, connection), false);
    assert.equal(asked, before + 1, 'An answerer presents an approval only when the native pipeline calls it');
  }
  choice = 'allow_once';
  assert.equal(await host.approveTool(session, call, connection), true, 'The original owner accepts an explicit one-time answer');
  const beforeChild = asked;
  assert.equal((await host.toolPolicy(session, { ...call, delegated: true })).kind, 'ask');
  assert.equal(asked, beforeChild, 'A policy proposal does not open a user question; native child approval:never owns the rejection');
  await store.update(state => { state.toolPermissions = { pwsh: 'never_allow' }; });
  assert.equal(await host.approveTool(session, call, connection), false);
  assert.equal(asked, beforeChild, 'A hard deny is final and cannot be overridden by a human answer');
});

test('allow once does not authorize waiting calls, and a replacement root cannot inherit a session grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-once-scope-'));
  const store = await openStore(root);
  const session = { id: randomUUID(), cwd: root, mode: 'approve', updates: [] };
  await store.update(state => state.sessions.push(session));
  const host = Object.assign(Object.create(Compat.prototype), {
    store, settings: { extensions: async () => [] }, active: new Map(), safety: new SafetyPolicy(store),
  });
  const context = { owner: {}, tool: {}, extensionSource: 'external_http', isCurrent: () => true };
  const call = { name: 'isolated_query', arguments: {}, sessionApproval: context };
  let asked = 0;
  const ready = Promise.withResolvers(), answer = Promise.withResolvers();
  const connection = { async ask() {
    if (++asked === 1) { ready.resolve(); await answer.promise; }
    return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
  } };
  const first = host.approveTool(session, call, connection);
  await ready.promise;
  const second = host.approveTool(session, call, connection);
  answer.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(asked, 2, 'Two calls each require approval when only allow once was selected');
  const grant = { async ask() { return { outcome: { outcome: 'selected', optionId: 'allow_always' } }; } };
  assert.equal(await host.approveTool(session, call, grant), true);
  let replacementAsked = false;
  assert.equal(await host.approveTool(session, { ...call, sessionApproval: { ...context, owner: {} } }, { async ask() {
    replacementAsked = true;
    return { outcome: { outcome: 'selected', optionId: 'reject_once' } };
  } }), false);
  assert.equal(replacementAsked, true, 'A new native root identity cannot consume an older grant');
});


test('automatic approval rechecks capability and binding after asynchronous safety classification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-approval-race-'));
  const store = await openStore(root);
  const session = { id: randomUUID(), cwd: root, mode: 'auto', updates: [] };
  await store.update(state => state.sessions.push(session));
  let enabled = true, bound = true, gate, inspecting;
  const host = Object.assign(Object.create(Compat.prototype), {
    store, active: new Map(),
    settings: { extensions: async () => [{ configKey: 'developer', enabled, extension: { name: 'developer', type: 'builtin' } }] },
    safety: { async inspect() { inspecting.resolve(); await gate.promise; return { requiresApproval: false }; } },
  });
  for (const [mode, delegated, invalidate] of [
    ['auto', false, 'tool'], ['auto', true, 'tool'],
    ['smart_approve', false, 'tool'], ['approve', false, 'tool'],
    ['auto', false, 'binding'], ['auto', true, 'binding'],
  ]) {
    enabled = true; bound = true; gate = Promise.withResolvers(); inspecting = Promise.withResolvers();
    await store.update(state => { state.sessions[0].mode = mode; });
    const call = { name: 'read', arguments: {}, readOnly: true, delegated,
      ...(invalidate === 'binding' ? { sessionApproval: { owner: {}, tool: {}, isCurrent: () => bound } } : {}),
    };
    const pending = host.toolPolicy(session, call);
    await inspecting.promise;
    if (invalidate === 'tool') enabled = false; else bound = false;
    gate.resolve();
    assert.equal((await pending).kind, 'deny', mode + ': ' + invalidate + ' changed during safety classification');
  }
  enabled = true; bound = true; gate = Promise.withResolvers(); inspecting = Promise.withResolvers();
  const pending = host.toolPolicy(session, { name: 'read', arguments: {}, readOnly: true });
  await inspecting.promise; gate.resolve();
  assert.equal((await pending).kind, 'allow', 'An unchanged enabled read retains its ordinary native policy');
});
