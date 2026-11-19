import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';
import { savedFixtureResponse } from './comfyui-catalog-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { comfyuiTool } from '../comfyui-tool.mjs';
import { comfyuiVideoTool } from '../comfyui-video-tool.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';
import { Compat } from '../compat.mjs';
import { openStore } from '../store.mjs';
import { SafetyPolicy } from '../safety-policy.mjs';
import { createCompatServer } from '../server.mjs';
import { workspaceIdentity } from '../workspaces.mjs';

// Respond to the native workflow interpreter using the catalog sent on this request.
function modelResponse(body, res, delta, finish) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = { id: randomUUID(), object: 'chat.completion.chunk', model: body.model,
    choices: [{ index: 0, delta, finish_reason: finish }] };
  res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
}

function answerSelection(body, res) {
  if (!body.tools?.some(tool => tool.function.name === 'select_workflow')) return false;
  const content = body.messages.findLast(message => message.role === 'user').content;
  const input = JSON.parse(typeof content === 'string' ? content : content[0].text);
  const selected = input.workflows.find(workflow => workflow.compatible && workflow.dependencies_available);
  assert.ok(selected);
  const args = { workflow_id: selected.id, mode: selected.mode, reason: 'Compatible test workflow', ...(input.proposed_media.kind === 'image' ? {image_count: null, images_only: false} : {}) };
  modelResponse(body, res, { role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(),
    type: 'function', function: { name: 'select_workflow', arguments: JSON.stringify(args) } }] }, 'tool_calls');
  return true;
}

async function fixture(t, kind = 'image', modern = false) {
  const toolName = kind === 'video' ? 'generate_video' : 'generate_image';
  const factory = kind === 'video' ? comfyuiVideoTool : comfyuiTool;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codebuddy-image-approval-')));
  const requests = [], questions = [], calls = [];
  const fetchImpl = async (url, options) => {
    const catalogResponse = savedFixtureResponse(url); if (catalogResponse) return catalogResponse;
    requests.push(url);
    if (url.endsWith('/object_info')) return Response.json({ FixtureNode: { input: {}, output: [] } });
    if (url.endsWith('/prompt')) return Response.json({ prompt_id: JSON.parse(options.body).prompt_id });
    if (url.includes('/history/')) return Response.json({});
    if (url.endsWith('/queue')) return Response.json({ queue_running: [], queue_pending: [] });
    throw Error(`Unexpected fixture URL ${url}`);
  };
  const dataDir = join(root, 'native');
  const store = await openStore(join(root, 'host'));
  let driver = createConversationDriver(await createHarnessDriver({ dataDir, cwd: root }), store);
  t.after(() => driver.close());
  const host = Object.assign(Object.create(Compat.prototype), {
    store, settings: { extensions: async () => [] }, active: new Map(), safety: new SafetyPolicy(store),
    businessApprovalClients: new WeakMap(),
  });
  const model = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/openapi.json')) { res.writeHead(404).end(); return; }
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'offline' }] }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (replyToNoActionReview(body, res)) return;
    if (!answerSelection(body, res)) modelResponse(body, res, { role: 'assistant', content: 'Ready.' }, 'stop');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(async () => { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); });
  const provider = { id: 'offline', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'unused' };
  const sessionChoice = modern ? 'allow_business_session' : 'allow_always';
  const f = { root, store, host, questions, requests, calls, sessionChoice, choice: sessionChoice,
    tool: (s, baseUrl = 'http://image.fixture') => factory({ cwd: root, dataDir: root, sessionId: s.id, baseUrl, fetchImpl }),
    get driver() { return driver; },
    async session(nativeSessionId) {
      const s = { id: randomUUID(), ...(nativeSessionId ? { nativeSessionId } : {}), cwd: root, type: 'code_pro', workspaceBinding: 'writable_project' };
      await store.update(state => state.sessions.push(s));
      await driver.createSession({ sessionId: s.id, cwd: root, provider, model: 'offline', options: { tools: [f.tool(s)] } });
      await driver.prompt(s.id, `Generate a fixture ${kind}.`);
      return s;
    },
    async restart(s) {
      await driver.close();
      driver = createConversationDriver(await createHarnessDriver({ dataDir, cwd: root }), store);
      await driver.createSession({ sessionId: s.id, cwd: root, provider, model: 'offline', options: { tools: [f.tool(s)] } });
    },
    invoke(s, args, { signal, answer } = {}) {
      return driver.callTool(s.id, toolName, { ...(kind === 'video' && args.operation === 'generate' ? { mode: 'text_to_video' } : {}), ...args }, {
        signal,
        onToolPolicy: call => { calls.push(call); return host.toolPolicy(s, call, call.signal); },
        onPermission: call => {
          const connection = { async ask(_method, params) {
          questions.push(params);
          return answer ? answer(params) : { outcome: { outcome: 'selected', optionId: f.choice } };
          } };
          if (modern) host.businessApprovalClients.set(connection, 1);
          return host.approveTool(s, call, connection, call.signal);
        },
      });
    },
    generate(s, options) { return f.invoke(s, { operation: 'generate', prompt: 'Isolated fixture', request_id: randomUUID() }, options); },
  };
  return f;
}

test('image and video grants stay independent when both tools share one service', { timeout: 30000 }, async t => {
  const f = await fixture(t, 'image', true), s = await f.session();
  const image = f.tool(s);
  const video = comfyuiVideoTool({ cwd: f.root, dataDir: f.root, sessionId: s.id, baseUrl: 'http://image.fixture', fetchImpl: async () => {
    throw Error('Rejected video must not contact the service');
  } });
  await f.driver.configureSession(s.id, { tools: [image, video] });
  await f.generate(s);
  const questions = [];
  const connection = { async ask(_method, params) {
    questions.push(params);
    return { outcome: { outcome: 'selected', optionId: 'reject_once' } };
  } };
  f.host.businessApprovalClients.set(connection, 1);
  const result = await f.driver.callTool(s.id, 'generate_video', { operation: 'generate', mode: 'text_to_video', prompt: 'Fixture' }, {
    onToolPolicy: call => f.host.toolPolicy(s, call, call.signal),
    onPermission: call => f.host.approveTool(s, call, connection, call.signal),
  });
  assert.equal(result.isError, true);
  assert.equal(questions.length, 1, 'Image approval never grants video access');
  assert.equal(questions[0]._meta.codepro.businessApproval.id, 'video-generation');
  assert.ok(questions[0].options.some(option => option.optionId === f.sessionChoice));
  await f.generate(s);
  assert.equal(f.questions.length, 1, 'Rejecting video preserves the independent image grant');
});

for (const kind of ['image', 'video']) {
const toolName = kind === 'video' ? 'generate_video' : 'generate_image';

for (const modern of [false, true]) {
const label = kind + (modern ? ' business' : ' legacy');
test(label + ' workflow inspection shares the service-bound tool grant', async t => {
  const f = await fixture(t, kind, modern), s = await f.session();
  const inspect = () => f.invoke(s, { operation: 'inspect', ...(kind === 'video' ? { mode: 'text_to_video' } : {}) });
  const first = await inspect();
  assert.equal(first.isError, false, JSON.stringify(first));
  assert.ok(f.questions[0].options.some(option => option.optionId === f.sessionChoice));
  await f.driver.configureSession(s.id, { tools: [f.tool(s)] });
  assert.equal((await inspect()).isError, false);
  assert.equal((await f.generate(s)).isError, false);
  assert.equal(f.questions.length, 1, 'Inspect and generate share the explicit grant for this tool and service');
});
test(label + ' session grant covers later calls and equivalent reconfiguration, but not another service or restart', { timeout: 30000 }, async t => {
  const f = await fixture(t, kind, modern), s = await f.session(randomUUID());
  const first = await f.generate(s);
  assert.equal(first.isError, false, JSON.stringify(first));
  assert.equal(f.questions[0]._meta.codepro.authorizationScope, 'session');
  assert.equal(f.questions[0]._meta.codepro.extensionSource, 'builtin');
  assert.ok(f.questions[0].options.some(option => option.optionId === f.sessionChoice));
  const oldCall = f.calls.at(-1);
  await f.driver.configureSession(s.id, { tools: [f.tool(s)] });
  assert.equal(oldCall.sessionApproval.isCurrent(), false, 'A replaced definition is never itself current');
  await f.invoke(s, { operation: 'status', job_id: first.value.job_id, wait_seconds: 0 });
  await f.invoke(s, { operation: 'generate', prompt: 'A different subject', width: 512, height: 768, seed: 42, request_id: randomUUID() });
  assert.equal(f.questions.length, 1, 'Equivalent next-turn configuration preserves the same explicit scope');
  assert.equal(f.store.read(['toolPermissions']).toolPermissions, undefined, 'No global permission is saved');

  const other = await f.session();
  f.choice = 'reject_once';
  assert.equal((await f.generate(other)).isError, true);
  assert.equal(f.questions.length, 2, 'Another conversation asks independently');

  await f.driver.configureSession(s.id, { tools: [f.tool(s, 'http://other-image.fixture')] });
  const before = f.requests.length;
  assert.equal((await f.generate(s)).isError, true);
  assert.equal(f.requests.length, before, 'A replacement service is not contacted without approval');
  f.choice = f.sessionChoice;
  await f.generate(s);
  f.choice = 'reject_once';
  assert.equal((await f.invoke(s, { operation: 'status', job_id: first.value.job_id })).isError, true);
  assert.equal(f.questions.at(-1).options.some(option => option.kind === 'allow_always'), false,
    'A new-service grant does not cover old jobs on a different service');

  await f.driver.configureSession(s.id, { tools: [f.tool(s)] });
  assert.equal((await f.generate(s)).isError, true, 'Switching back does not resurrect a revoked grant');
  f.choice = f.sessionChoice;
  await f.generate(s);
  await f.restart(s);
  f.choice = 'reject_once';
  assert.equal((await f.generate(s)).isError, true, 'Restart must ask again even with the same session ID');
});

test(label + ' once, cancellation, explicit policy and tool replacement keep their original approval boundaries', { timeout: 30000 }, async t => {
  const f = await fixture(t, kind, modern), s = await f.session();
  f.choice = 'allow_once';
  await f.generate(s);
  await f.generate(s);
  assert.equal(f.questions.length, 2, 'Allow once never becomes a session grant');

  const waiting = Promise.withResolvers(), release = Promise.withResolvers();
  const controller = new AbortController(), beforeCancel = f.requests.length;
  const pending = f.generate(s, { signal: controller.signal, answer: async () => {
    waiting.resolve(); await release.promise;
    return { outcome: { outcome: 'selected', optionId: f.sessionChoice } };
  } });
  await waiting.promise;
  controller.abort(new Error('Stop while approval is pending'));
  release.resolve();
  const cancelled = await pending;
  assert.equal(cancelled.isError, true);
  assert.equal(f.requests.length, beforeCancel, 'Stopped approval never dispatches generation');
  f.choice = 'reject_once';
  assert.equal((await f.generate(s)).isError, true, 'A late reply to a cancelled approval does not grant the next call');

  f.choice = f.sessionChoice;
  await f.generate(s);
  await f.store.update(state => { state.toolPermissions = { [toolName]: 'never_allow' }; });
  const beforeDeny = f.questions.length;
  assert.equal((await f.generate(s)).isError, true);
  assert.equal(f.questions.length, beforeDeny, 'A hard deny overrides the remembered grant');
  await f.store.update(state => { state.toolPermissions = { [toolName]: 'ask_before' }; });
  f.choice = 'reject_once';
  assert.equal((await f.generate(s)).isError, true);
  assert.equal(f.questions.at(-1).options.some(option => option.kind === 'allow_always'), false);
  await f.store.update(state => { state.toolPermissions = {}; });

  await f.driver.configureSession(s.id, { tools: [] });
  await f.driver.configureSession(s.id, { tools: [f.tool(s)] });
  assert.equal((await f.generate(s)).isError, true, 'Removing and re-enabling the tool clears its grant');
  const sameName = { ...f.tool(s), execute() { throw Error('Replacement must not execute'); } };
  await f.driver.configureSession(s.id, { tools: [sameName] });
  assert.equal((await f.generate(s)).isError, true);
  assert.equal(f.questions.at(-1).options.some(option => option.kind === 'allow_always'), false,
    'A same-name replacement cannot claim the image capability');
});
}

for (const modern of [false, true]) test(kind + ' real ACP ' + (modern ? 'business' : 'legacy') + ' approval reuses session scope across later turns', { timeout: 30000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codebuddy-image-approval-acp-')));
  const dataDir = join(root, 'host'), cwd = join(root, 'project');
  const questions = [], submissions = [], results = [], failures = [];
  let latestJob;
  const remote = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/openapi.json')) { res.writeHead(404).end(); return; }
    const json = value => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    try {
      const catalog = savedFixtureResponse(req.url); if (catalog) return json(await catalog.json());
      if (req.url.endsWith('/models')) return json({ data: [{ id: 'fixture' }] });
      if (req.url.startsWith('/history/')) return json({ [req.url.split('/').at(-1)]: {
        status: { status_str: 'error', messages: [['execution_error', 'Isolated fixture: no real image generation']] },
      } });
      if (req.url.startsWith('/ws')) { res.writeHead(404).end(); return; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
    if (replyToNoActionReview(body, res)) return;
      if (req.url === '/prompt') { submissions.push(body); return json({ prompt_id: body.prompt_id }); }
      if (!body.stream) return json({ choices: [{ message: { content: 'OK' } }] });
      if (answerSelection(body, res)) return;
      const user = body.messages.findLastIndex(message => message.role === 'user' &&
        ['Run image permission fixture.', 'Run another subject and size.'].includes(message.content));
      if (user < 0) { modelResponse(body, res, { role: 'assistant', content: 'Fixture title.' }, 'stop'); return; }
      const replies = body.messages.slice(user + 1).filter(message => message.role === 'tool');
      let tool;
      if (replies.length === 0) tool = { name: 'search_mcp_tools', args: { names: [toolName] } };
      if (replies.length === 1 || replies.length === 3) {
        latestJob = randomUUID();
        tool = { name: toolName, args: { operation: 'generate', ...(kind === 'video' ? { mode: 'text_to_video' } : {}), request_id: latestJob,
          prompt: `Fixture subject ${submissions.length}`, width: replies.length === 1 ? 512 : 768,
          height: 512, seed: submissions.length, wait_seconds: 0 } };
      }
      if (replies.length === 2) tool = { name: toolName, args: { operation: 'status', job_id: latestJob, wait_seconds: 0 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (tool) emit({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }, 'tool_calls');
      else emit({ role: 'assistant', content: 'Isolated permission fixture complete.' }, 'stop');
      res.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error.message); res.writeHead(500).end(); }
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(async () => { remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${remote.address().port}`;
  const seed = await openStore(dataDir);
  await seed.update(state => { state.preferences.comfyuiBaseUrl = baseUrl; });
  const secret = 'isolated-image-session-approval-fixture';
  const app = await createCompatServer({ dataDir, secret });
  t.after(() => app.close());
  const url = await app.listen();
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`);
  t.after(() => ws.close());
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map();
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data)), item = pending.get(message.id);
    if (item) { pending.delete(message.id); message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result); return; }
    if (message.method === 'session/request_permission') {
      questions.push(message.params);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: modern ? 'allow_business_session' : 'allow_always' } } }));
    }
    if (message.method === 'session/update' && message.params.update?.sessionUpdate === 'tool_call_update') results.push(message.params.update);
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  const ext = name => `_goose/unstable/${name}`;
  await request('initialize', { protocolVersion: 1, clientCapabilities: modern ? { _meta: { goose: { businessSessionApproval: 1 } } } : {} });
  await request(ext('config/extensions/set-enabled'), { configKey: 'commonqueries', enabled: false });
  const { providerId } = await request(ext('providers/custom/create'), { engine: 'openai_compatible', displayName: 'Isolated fixture', apiUrl: `${baseUrl}/v1`, requiresAuth: false, models: ['fixture'], headers: {}, supportsStreaming: true });
  await request(ext('defaults/save'), { providerId, modelId: 'fixture' });
  const lease = await request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd) });
  const { sessionId } = await request('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId } });
  for (const text of ['Run image permission fixture.', 'Run another subject and size.']) {
    assert.equal((await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })).stopReason, 'end_turn');
  }
  assert.deepEqual(failures, []);
  assert.equal(submissions.length, 4, 'Changed prompts, sizes, seeds and job IDs execute across turns');
  assert.equal(questions.length, 1, 'The actual transport asks only for the first explicit session grant');
  assert.equal(questions[0]._meta.codepro.authorizationScope, 'session');
  assert.ok(questions[0].options.some(option => option.kind === 'allow_always'));
  if (modern) {
    const business = questions[0]._meta.codepro.businessApproval;
    assert.equal(business.id, kind === 'video' ? 'video-generation' : 'image-generation');
    assert.equal(business.service, baseUrl);
    assert.equal(business.workspace, cwd);
    assert.equal(business.outputDirectory, join(cwd, kind === 'video' ? 'generated-videos' : 'generated-images'));
  } else assert.equal(questions[0]._meta.codepro.businessApproval, undefined);
  assert.equal(results.filter(result => result.status === 'completed').length, 6,
    'Six image calls complete; internal discovery is not published as a user operation');
});

}
