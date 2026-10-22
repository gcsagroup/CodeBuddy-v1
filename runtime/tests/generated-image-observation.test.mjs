import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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

async function fixture(t, inputModalities = ['text', 'image']) {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-generated-check-'));
  const cwd = path.join(root, 'workspace'); await mkdir(cwd);
  const requests = [], submissions = [];
  const server = createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'main', input_modalities: inputModalities }] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    if (!request.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); return; }
    requests.push(request);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'image-check', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const user = request.messages.findLastIndex(message => message.role === 'user');
    if (request.model === 'observer') {
      emit({ role: 'assistant', content: 'The generated image is a blue square. VISUAL_BLUE_SQUARE' }); emit({}, 'stop');
    } else if (!request.messages.slice(user + 1).some(message => message.role === 'tool') && !JSON.stringify(request.messages).includes('image_url')) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'inspect-result', type: 'function', function: { name: 'generate_image', arguments: JSON.stringify({ operation: 'status', job_id: jobId }) } }] }); emit({}, 'tool_calls');
    } else { emit({ role: 'assistant', content: '画好了，蓝色方块。' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/prompt')) { submissions.push(options.body); return Response.json({ prompt_id: jobId }); }
    if (url.includes('/history/')) return Response.json({ [jobId]: { status: { completed: true }, outputs: { save: { images: [{ filename: 'result.png', type: 'output' }] } } } });
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
  await driver.callTool(sessionId, 'generate_image', { operation: 'generate', prompt: 'A blue square', request_id: jobId }, { onPermission: () => true });
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
