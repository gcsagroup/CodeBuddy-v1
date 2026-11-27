import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';
import { answerTitleRequest } from './fixtures/title-request.mjs';
import { savedFixtureResponse } from './comfyui-catalog-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { comfyuiTool } from '../comfyui-tool.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import { VisionRouting } from '../vision-routing.mjs';
import { createCompatServer } from '../server.mjs';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const png = await require('sharp')({ create: { width: 32, height: 32, channels: 3, background: 'blue' } }).png().toBuffer();
const jobId = 'cc4b7110-bdfe-41ce-878e-cd6b402b6a4b';

async function fixture(t, inputModalities = ['text', 'image'], { onRequest, finalText } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-generated-check-'));
  const cwd = path.join(root, 'workspace'); await mkdir(cwd);
  const requests = [], submissions = [];
  const server = createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'main', input_modalities: inputModalities }] })); return; }
    // Optional model metadata probes have no body; this fixture only serves
    // model inventory and chat completions.
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    if (replyToNoActionReview(request, res)) return;
    if (!request.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); return; }
    if (answerTitleRequest(request, res)) return;
    requests.push(request);
    onRequest?.(request);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'image-check', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const user = request.messages.findLastIndex(message => message.role === 'user' && message.content === '检查已生成的图片，再简短交付。');
    if (request.model === 'observer') {
      emit({ role: 'assistant', content: 'The generated image is a blue square. VISUAL_BLUE_SQUARE' }); emit({}, 'stop');
    } else if (!request.messages.slice(user + 1).some(message => message.role === 'tool') && !JSON.stringify(request.messages).includes('image_url')) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'inspect-result', type: 'function', function: { name: 'generate_image', arguments: JSON.stringify({ operation: 'status', job_id: jobId }) } }] }); emit({}, 'tool_calls');
    } else { emit({ role: 'assistant', content: finalText ?? '画好了，蓝色方块。' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fetchImpl = async (url, options) => {
    const catalogResponse = savedFixtureResponse(url); if (catalogResponse) return catalogResponse;
    if (url.endsWith('/prompt')) { submissions.push(options.body); return Response.json({ prompt_id: jobId }); }
    if (url.includes('/history/')) {
      // ComfyUI keys history by the output node in the graph actually submitted.
      const graph = JSON.parse(submissions.at(-1)).prompt;
      const output = Object.keys(graph).filter(id => ['SaveImage', 'SaveImageAdvanced'].includes(graph[id].class_type));
      assert.equal(output.length, 1);
      return Response.json({ [jobId]: { status: { completed: true }, outputs: { [output[0]]: { images: [{ filename: 'result.png', type: 'output' }] } } } });
    }
    if (url.includes('/view?')) return new Response(png);
    throw Error(`Unexpected fixture URL: ${url}`);
  };
  const tool = comfyuiTool({ cwd, dataDir: root, sessionId: 'fixture', baseUrl: 'http://image.fixture', fetchImpl });
  const dataDir = path.join(root, 'harness');
  const provider = { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, inputModalities };
  let driver = await createHarnessDriver({ dataDir, cwd });
  const options = { tools: [tool] };
  const { sessionId } = await driver.createSession({ cwd, provider, model: 'main', options });
  await driver.callTool(sessionId, 'search_mcp_tools', { names: ['generate_image'] }, { onPermission: () => true });
  // Seed the saved image that this observation and replay fixture inspects.
  await tool.execute({ operation: 'generate', prompt: 'A blue square', request_id: jobId });
  t.after(async () => {
    await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), tmpdir()); assert.ok(path.basename(root).startsWith('codebuddy-generated-check-'));
    await rm(root, { recursive: true, force: true });
  });
  return { cwd, root, tool, provider, requests, submissions, sessionId, options,
    get driver() { return driver; },
    async restart() {
      await driver.close(); driver = await createHarnessDriver({ dataDir, cwd });
      await driver.createSession({ sessionId, cwd, provider, model: 'main', options });
    },
  };
}

test('completed generated image reaches the main model as pixels and survives native restart', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const events = [];
  await f.driver.prompt(f.sessionId, '检查已生成的图片，再简短交付。', { onPermission: () => true, onEvent: event => events.push(event) });
  assert.match(JSON.stringify(f.requests.at(-1).messages), /image_url/, 'a file path alone is not a visual observation');
  const receipt = events.find(event => event.type === 'tool_result' && event.name === 'generate_image');
  assert.equal(receipt.isError, false);
  assert.equal(receipt.structuredContent.status, 'completed');
  assert.ok(receipt.result.some(block => block.type === 'image' && block.attachment));
  assert.equal(receipt.presentationContent.find(block => block.type === 'image').data, png.toString('base64'));
  assert.deepEqual(await readFile(receipt.structuredContent.images[0].path), png);
  assert.equal(f.submissions.length, 1);
  await f.restart();
  await f.driver.prompt(f.sessionId, '沿用刚才的成图，不重新生成。', { onPermission: () => true });
  assert.match(JSON.stringify(f.requests.at(-1).messages), /image_url/);
  assert.equal(f.submissions.length, 1);
});

test('ACP publishes original generated image bytes while the model uses native durable references', { timeout: 30_000 }, async t => {
  const f = await fixture(t), secret = 'generated-image-controlled-fixture';
  const native = f.driver;
  const driver = { ...native,
    createSession: input => native.createSession({ ...input, options: { ...input.options, tools: [f.tool] } }),
    configureSession: (id, options) => native.configureSession(id, { ...options, tools: [f.tool] }),
  };
  const app = await createCompatServer({ dataDir: path.join(f.root, 'acp'), secret, driver });
  const url = await app.listen(), notices = [], pending = new Map(); let sequence = 0;
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data)), item = pending.get(message.id);
    if (item) { pending.delete(message.id); message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result); }
    else {
      notices.push(message);
      if (message.method === 'session/request_permission') ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }));
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  try {
  const ext = name => `_goose/unstable/${name}`;
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const { providerId } = await request(ext('providers/custom/create'), { engine: 'openai_compatible', displayName: 'Image fixture', apiUrl: f.provider.baseUrl, requiresAuth: false, models: ['main'], headers: {}, supportsStreaming: true });
  await request(ext('defaults/save'), { providerId, modelId: 'main' });
  const { sessionId } = await request('session/new', { cwd: f.cwd, mcpServers: [], _meta: { enabledExtensions: ['developer'] } });
  assert.equal((await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '检查已生成的图片，再简短交付。' }] })).stopReason, 'end_turn');
  const images = notices.filter(notice => notice.method === 'session/update').flatMap(notice => notice.params.update?.content ?? [])
    .filter(block => block.type === 'content' && block.content?.type === 'image').map(block => block.content);
  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, 'image/png');
  assert.equal(images[0].data, png.toString('base64'));
  assert.equal(images[0].attachment, undefined, 'native image references are not ACP image blocks');
  assert.match(JSON.stringify(f.requests.at(-1).messages), /image_url/);
  assert.equal(f.submissions.length, 1);
  } finally { ws.close(); await app.close(); }
});

test('text-only main receives the existing backup observation of the actual generated pixels', { timeout: 30_000 }, async t => {
  const f = await fixture(t, ['text']);
  const vision = new VisionRouting(f.driver, {
    resolveCapability: async () => ({ imageInput: 'supported' }),
    resolveProvider: async () => ({ ...f.provider, inputModalities: ['text', 'image'] }),
  });
  t.after(() => vision.close());
  await f.driver.configureSession(f.sessionId, { ...f.options, mcpImageFallback: (content, { signal, toolName }) => vision.prepareToolContent({
    sessionId: f.sessionId, cwd: f.cwd, signal, toolName, content,
    providers: [{ id: 'fixture', requiresAuth: false }],
    routing: { visionRoute: { enabled: true, mode: 'auto', providerId: 'fixture', modelId: 'observer' } },
  }) });
  await f.driver.prompt(f.sessionId, '检查已生成的图片，再简短交付。', { onPermission: () => true });
  const observer = f.requests.find(request => request.model === 'observer');
  assert.ok(observer, 'the backup image route must be used for a text-only main');
  assert.match(JSON.stringify(observer.messages), /image_url/);
  assert.equal(observer.tools?.length ?? 0, 0);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /VISUAL_BLUE_SQUARE/);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).messages), /image_url/);
  assert.equal(f.submissions.length, 1);
});

test('inspection outage preserves the saved generation receipt and cancellation does not replay generation', { timeout: 30_000 }, async t => {
  const f = await fixture(t, ['text']);
  await f.driver.configureSession(f.sessionId, { ...f.options, mcpImageFallback: async () => { throw Error('private observer connection'); } });
  const status = { operation: 'status', job_id: jobId };
  const result = await f.driver.callTool(f.sessionId, 'generate_image', status, { onPermission: () => true });
  assert.equal(result.isError, false);
  assert.equal(result.value.status, 'completed');
  assert.match(JSON.stringify(result.content), /inspection.*unavailable/i);
  assert.doesNotMatch(JSON.stringify(result.content), /private observer connection/);
  assert.deepEqual(await readFile(result.value.images[0].path), png);
  const entered = Promise.withResolvers(), controller = new AbortController();
  await f.driver.configureSession(f.sessionId, { ...f.options, mcpImageFallback: async (_content, { signal }) => {
    entered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw signal.reason;
  } });
  const pending = f.driver.callTool(f.sessionId, 'generate_image', status, { onPermission: () => true, signal: controller.signal });
  pending.catch(() => {}); await entered.promise; controller.abort();
  try { assert.equal((await pending).isError, true); } catch (error) { assert.match(error.message, /abort|cancel/i); }
  assert.equal((await f.tool.jobs())[0].status, 'completed');
  const cancelled = await f.tool.execute({ operation: 'cancel', job_id: jobId });
  assert.equal(cancelled.status, 'completed');
  assert.equal(cancelled.content, undefined, 'cancelling a completed job must not initiate a visual check');
  assert.equal(f.submissions.length, 1);
});


test('steering during completed media status aborts only its optional image observation and preserves the real receipt', { timeout: 15_000 }, async t => {
  const original = '检查已生成的图片，再简短交付。';
  const correction = '另外保留这次完成的图片，随后按补充要求继续，不要重新生成。';
  const textOf = message => typeof message.content === 'string' ? message.content
    : (message.content ?? []).map(part => part.text ?? '').join('\n');
  const entered = Promise.withResolvers(), nextRequest = Promise.withResolvers();
  const f = await fixture(t, ['text'], {
    // This is a controlled Provider response, not a host-synthesized reply or
    // evidence of what an uncontrolled model would choose to say.
    finalText: '继续处理补充要求。',
    onRequest: request => {
      if (request.model === 'main' && request.messages.some(message => message.role === 'user' && textOf(message) === correction))
        nextRequest.resolve(request);
    },
  });
  let observerSignal, observerCalls = 0;
  await f.driver.configureSession(f.sessionId, { ...f.options, mcpImageFallback: async (content, { signal }) => {
    observerCalls++;
    observerSignal = signal;
    assert.equal(content.find(block => block.type === 'image').data, png.toString('base64'));
    signal.throwIfAborted();
    entered.resolve();
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    assert.fail('the held read-only observation must not fabricate a visual result');
  } });
  const controller = new AbortController(), events = [];
  const running = f.driver.prompt(f.sessionId, original, {
    signal: controller.signal, onPermission: () => true, onEvent: event => events.push(event),
  });
  running.catch(() => {});
  try {
    await entered.promise;
    const saved = (await f.tool.jobs())[0];
    assert.equal(saved.status, 'completed', 'the optional observation must start after the real generation receipt is saved');
    assert.deepEqual(await readFile(saved.images[0].path), png);
    await f.driver.steer(f.sessionId, correction, { requestId: 'completed-media-observation-steer', preempt: true });
    const next = await Promise.race([nextRequest.promise, delay(1500).then(() => null)]);
    t.diagnostic(JSON.stringify({ nextRequestReceived: Boolean(next), observerAbortedBeforeCleanup: observerSignal.aborted,
      turnAbortedBeforeCleanup: controller.signal.aborted }));
    assert.ok(next, 'steering must reach the next real Provider request without waiting for optional image inspection');
    assert.equal(observerSignal.aborted, true, 'only the read-only observation should receive cancellation');
    assert.equal(controller.signal.aborted, false, 'steering must preserve the original native turn');
    assert.equal((await running).stopReason, 'end_turn');
    const users = next.messages.filter(message => message.role === 'user').map(textOf);
    assert.ok(users.includes(original));
    assert.equal(users.filter(text => text === correction).length, 1);
    const calls = next.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? [])
      .map(call => ({ call, input: JSON.parse(call.function.arguments) }))
      .filter(({ input }) => input.operation === 'status' && input.job_id === jobId);
    assert.equal(calls.length, 1);
    const results = next.messages.filter(message => message.role === 'tool' && message.tool_call_id === calls[0].call.id);
    assert.equal(results.length, 1);
    const rendered = textOf(results[0]);
    let status;
    // The Provider concatenates the JSON receipt and any inspection note.
    for (let end = rendered.indexOf('}'); end !== -1; end = rendered.indexOf('}', end + 1)) {
      try { const value = JSON.parse(rendered.slice(0, end + 1)); if (value?.job_id === jobId) { status = value; break; } }
      catch { /* A nested closing brace is not the complete JSON receipt. */ }
    }
    assert.equal(status?.status, 'completed');
    assert.equal(status.error, null);
    assert.equal(status.images[0].path, saved.images[0].path);
    assert.deepEqual(await readFile(status.images[0].path), png);
    const receipt = events.find(event => event.type === 'tool_result' && event.id === calls[0].call.id);
    assert.ok(receipt && !receipt.isError);
    assert.equal(receipt.structuredContent.status, 'completed');
    assert.equal(receipt.presentationContent.find(block => block.type === 'image').data, png.toString('base64'),
      'UI presentation must retain the actual image when canonical observation is deferred');
    assert.doesNotMatch(rendered, /VISUAL_BLUE_SQUARE/, 'unfinished observation text must not be fabricated');
    assert.equal(observerCalls, 1);
    assert.equal(f.submissions.length, 1, 'inspection cancellation must never resubmit the already completed generation');
    const history = await f.driver.history(f.sessionId);
    assert.equal(history.events.filter(event => event.type === 'turn/start').length, 1);
  } finally {
    // Red runs must also release the actual held fallback before fixture cleanup.
    controller.abort();
    await running.catch(() => {});
  }
});


test('media steering releases an actual VisionRouting capability wait and rejects its late observer launch', { timeout: 15_000 }, async t => {
  const original = '检查已生成的图片，再简短交付。';
  const correction = '保留已完成的这张图片，先处理补充要求，暂不需要识图。';
  const textOf = message => typeof message.content === 'string' ? message.content
    : (message.content ?? []).map(part => part.text ?? '').join('\n');
  const entered = Promise.withResolvers(), capability = Promise.withResolvers(), observerDone = Promise.withResolvers();
  const nextRequest = Promise.withResolvers();
  const f = await fixture(t, ['text'], {
    finalText: '继续处理补充要求。',
    onRequest: request => {
      if (request.model === 'main' && request.messages.some(message => message.role === 'user' && textOf(message) === correction))
        nextRequest.resolve(request);
    },
  });
  const observerSessions = [], observerPrompts = [];
  const observerDriver = { ...f.driver,
    createSession: input => { observerSessions.push(input); return f.driver.createSession(input); },
    prompt: (...args) => { observerPrompts.push(args[0]); return f.driver.prompt(...args); },
  };
  const vision = new VisionRouting(observerDriver, {
    resolveCapability: async reference => {
      assert.equal(reference.modelId, 'observer');
      entered.resolve();
      await capability.promise;
      return { imageInput: 'supported' };
    },
    resolveProvider: async () => ({ ...f.provider, inputModalities: ['text', 'image'] }),
  });
  let observerSignal;
  await f.driver.configureSession(f.sessionId, { ...f.options, mcpImageFallback: (content, { signal, toolName }) => {
    observerSignal = signal;
    return vision.prepareToolContent({ sessionId: f.sessionId, cwd: f.cwd, signal, toolName, content,
      providers: [{ id: 'fixture', requiresAuth: false }],
      routing: { visionRoute: { enabled: true, mode: 'auto', providerId: 'fixture', modelId: 'observer' } },
    }).finally(() => observerDone.resolve());
  } });
  const controller = new AbortController(), events = [];
  const running = f.driver.prompt(f.sessionId, original, { signal: controller.signal,
    onPermission: () => true, onEvent: event => events.push(event) });
  running.catch(() => {});
  try {
    await entered.promise;
    const saved = (await f.tool.jobs())[0];
    assert.equal(saved.status, 'completed');
    await f.driver.steer(f.sessionId, correction, { requestId: 'media-capability-wait-steer', preempt: true });
    const next = await Promise.race([nextRequest.promise, delay(1500).then(() => null)]);
    t.diagnostic(JSON.stringify({ nextRequestReceived: Boolean(next), observerSignalAborted: observerSignal.aborted,
      turnSignalAborted: controller.signal.aborted, capabilityStillHeld: observerSessions.length === 0 }));
    assert.ok(next, 'media steering must not wait for the optional observer capability resolver to settle');
    assert.equal(observerSignal.aborted, true);
    assert.equal(controller.signal.aborted, false);
    assert.equal((await running).stopReason, 'end_turn');
    const users = next.messages.filter(message => message.role === 'user').map(textOf);
    assert.ok(users.includes(original));
    assert.equal(users.filter(text => text === correction).length, 1);
    const statusCall = next.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? [])
      .find(call => { const input = JSON.parse(call.function.arguments); return input.operation === 'status' && input.job_id === jobId; });
    assert.ok(statusCall);
    const toolResult = events.find(event => event.type === 'tool_result' && event.id === statusCall.id);
    assert.ok(toolResult && !toolResult.isError);
    assert.equal(toolResult.structuredContent.status, 'completed');
    assert.equal(toolResult.structuredContent.images[0].path, saved.images[0].path);
    assert.ok(next.messages.some(message => message.role === 'tool' && message.tool_call_id === statusCall.id));
    assert.equal(toolResult.presentationContent.find(block => block.type === 'image').data, png.toString('base64'));
    // The caller has already continued. The resolver may finish later, but its
    // original VisionRouting cancellation checks must fence all observer I/O.
    capability.resolve();
    await observerDone.promise;
    assert.equal(observerSessions.length, 0);
    assert.equal(observerPrompts.length, 0);
    assert.equal(f.requests.filter(request => request.model === 'observer').length, 0);
    const after = (await f.tool.jobs())[0];
    assert.equal(after.status, 'completed');
    assert.deepEqual(await readFile(after.images[0].path), png);
    assert.equal(f.submissions.length, 1);
  } finally {
    // close() intentionally awaits its active producer; release the resolver
    // explicitly rather than claiming observer abort stopped that async work.
    controller.abort(); capability.resolve();
    await running.catch(() => {});
    await observerDone.promise;
    await vision.close();
  }
});
