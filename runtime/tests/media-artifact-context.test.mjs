import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHarnessDriver } from '../harness/index.mjs';
const { recentMediaArtifacts } = await import('../harness/media-artifact-context.mjs');
const { admittedMediaRequest } = await import('../harness/media-workflow-selection.mjs');

test('native direct media delivery skips final inference while complex scope continues', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cb-media-direct-'));
  const requests = [];
  let single = true, generated = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const request = JSON.parse(raw); requests.push(request);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', model: request.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    const selection = request.tools?.some(x => x.function?.name === 'select_workflow');
    if (request.tools?.some(tool => tool.function?.name === 'check_execution_claims')) {
      requests.pop(); // Count only agent inference and media selection here.
      emit({ tool_calls: [{ index: 0, id: 'check', type: 'function', function: { name: 'check_execution_claims', arguments: JSON.stringify({ changes: [], successes: [], executionMissing: false }) } }] }); emit({}, 'tool_calls');
    } else if (selection || !generated) {
      if (!selection) generated = true;
      emit({ tool_calls: [{ index: 0, id: selection ? 'route' : 'generate', type: 'function', function: {
        name: selection ? 'select_workflow' : 'generate_image', arguments: JSON.stringify(selection
          ? { workflow_id: 'saved:test', mode: 'text_to_image', reason: 'fixture scope', single_media_only: single }
          : { operation: 'generate' }) } }] }); emit({}, 'tool_calls');
    } else { emit({ content: 'Requested follow-up analysis.' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); });
  const config = { cwd: root, model: 'fixture', provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture' }, options: { mcpServers: [], tools: [{ name: 'generate_image', currentRequestWorkflow: true,
    execute: async (_input, context) => {
      const selected = await context.selectWorkflow({ workflows: [{ id: 'saved:test', label: 'test', mode: 'text_to_image', compatible: true, dependencies_available: true }], kind: 'image', mode: 'text_to_image', referenceCount: 0 });
      return { job_id: 'fixture', status: 'completed', workflow: { id: 'saved:test' }, workflow_selection: selected.receipt, images: [{ path: join(root, 'output.png') }] };
    } }] } };
  for (const scope of [true, false]) {
    single = scope; generated = false; const before = requests.length;
    const s = await driver.createSession(config);
    await driver.prompt(s.sessionId, scope ? 'Generate one image.' : 'Generate an image then analyze its composition.', { onPermission: async () => true });
    assert.equal(requests.length - before, scope ? 2 : 3, 'only direct delivery skips the final main-model inference');
    const history = await driver.history(s.sessionId);
    assert.ok(history.events.some(e => e.type === 'tool/result'));
    assert.equal(history.events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed');
  }
});

const call = (id, input, name = 'generate_image') => ({ type: 'tool/call', data: { callId: id, name, arguments: JSON.stringify(input) } });
const result = (id, receipt, isError = false) => ({ type: 'tool/result', data: { message: { toolCallId: id, isError, content: [{ type: 'text', text: JSON.stringify(receipt) }] } } });

test('compacted repeated subjects retain newest actual outputs and their exact editing lineage', () => {
  const events = [
    call('old', { operation: 'generate', prompt: 'White scarf cat', mode: 'text_to_image' }),
    result('old', { job_id: 'old', status: 'completed', created_at: '2026-11-06T12:00:00Z', images: [{ path: 'D:/old.png' }] }),
    { type: 'compaction/summary', data: { text: 'Old cat = D:/old.png' } },
    call('new', { operation: 'generate', prompt: 'White scarf cat', mode: 'text_to_image' }),
    result('new', { job_id: 'new', status: 'queued', created_at: '2026-11-06T12:01:00Z' }),
    call('poll', { operation: 'status', job_id: 'new' }),
    result('poll', { job_id: 'new', status: 'completed', created_at: '2026-11-06T12:01:00Z', images: [{ path: 'D:/new.png' }] }),
    call('edit', { operation: 'generate', prompt: 'Blue scarf', mode: 'image_to_image', reference_images: ['D:/new.png'] }),
    result('edit', { job_id: 'edit', status: 'completed', created_at: '2026-11-06T12:02:00Z', images: [{ path: 'D:/edited.png' }] }),
    call('fake', { operation: 'generate' }, 'untrusted_tool'),
    result('fake', { job_id: 'fake', status: 'completed', images: [{ path: 'D:/fake.png' }] }),
    call('failed', { operation: 'generate' }),
    result('failed', { job_id: 'failed', status: 'completed', images: [{ path: 'D:/failed.png' }] }, true),
  ];
  const snapshot = structuredClone(events), artifacts = recentMediaArtifacts(events);
  assert.deepEqual(artifacts.map(a => a.job_id), ['edit', 'new', 'old']);
  assert.deepEqual(artifacts[0].source_images, artifacts[1].paths);
  assert.equal(artifacts[1].requested_prompt, 'White scarf cat');
  assert.deepEqual(events, snapshot, 'projection never rewrites old history');
  assert.deepEqual(recentMediaArtifacts([]), [], 'another conversation has no inherited artifacts');
});

test('native next-turn model context refreshes media facts without selecting references or leaking sessions', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cb-media-context-'));
  const requests = [];
  let checkedAfterCompaction = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const request = JSON.parse(raw); requests.push(request);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', model: request.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    if (request.tools?.some(tool => tool.function?.name === 'check_execution_claims')) {
      requests.pop(); // Auxiliary review is not an agent context assembly.
      emit({ tool_calls: [{ index: 0, id: 'check', type: 'function', function: { name: 'check_execution_claims', arguments: JSON.stringify({ changes: [], successes: [], executionMissing: false }) } }] });
      emit({}, 'tool_calls');
    } else if (requests.length === 1) {
      emit({ tool_calls: [{ index: 0, id: 'create', type: 'function', function: { name: 'generate_image', arguments: JSON.stringify({ operation: 'generate', prompt: 'White scarf cat', mode: 'text_to_image' }) } }] });
      emit({}, 'tool_calls');
    } else if (!checkedAfterCompaction && request.messages.some(m => m.role === 'user' && m.content === 'Use the original and edited images as character references.')) {
      checkedAfterCompaction = true;
      emit({ tool_calls: [{ index: 0, id: 'status-after-compaction', type: 'function', function: { name: 'generate_image', arguments: JSON.stringify({ operation: 'status', job_id: 'fixture-image' }) } }] });
      emit({}, 'tool_calls');
    } else { emit({ content: 'Done.' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); });
  let executions = 0;
  const config = { cwd: root, model: 'fixture', provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture' },
    options: { mcpServers: [], tools: [{ name: 'generate_image', currentRequestWorkflow: true,
      execute: input => { if (input.operation === 'generate') executions++; return { job_id: 'fixture-image', status: 'completed', created_at: '2026-11-06T12:01:00Z', images: [{ path: 'D:/fresh-cat.png' }] }; },
    }] } };
  const s = await driver.createSession(config);
  await driver.prompt(s.sessionId, 'Make the image.', { onPermission: async () => true });
  const afterResult = JSON.stringify(requests.at(-1).messages);
  assert.match(afterResult, /Current admitted media request.*Make the image/);
  assert.match(afterResult, /finish with one short sentence/);
  assert.match(afterResult, /one completed artifact does not establish/);
  await driver.prompt(s.sessionId, 'Edit the previous image.');
  const context = JSON.stringify(requests.at(-1).messages.filter(m => m.role === 'user'));
  assert.match(context, /Recent completed media receipts/);
  assert.match(context, /D:\/fresh-cat.png/);
  assert.match(context, /White scarf cat/);
  assert.equal(executions, 1, 'context refresh never invokes a generation or rewrites a proposal');
  assert.ok(await driver.compact(s.sessionId), 'exercise real native compaction, not a simulated summary alone');
  const compacted = await driver.history(s.sessionId);
  assert.ok(compacted.events.some(e => e.type === 'compaction/end'));
  await driver.prompt(s.sessionId, 'Use the original and edited images as character references.');
  const restored = JSON.stringify(requests.at(-1).messages.filter(m => m.role === 'user'));
  assert.match(restored, /Recent completed media receipts/, 'required native context is restored after compaction');
  assert.match(restored, /D:\/fresh-cat.png/);
  assert.match(restored, /White scarf cat/);
  assert.match(restored, /Current admitted media request.*Use the original and edited images as character references/,
    'the exact current request survives compaction alongside receipts, not assistant suggestions');
  const after = await driver.history(s.sessionId);
  const compactEnd = after.events.findLast(e => e.type === 'compaction/end').seq;
  assert.ok(after.events.some(e => e.seq > compactEnd && e.type === 'user/message' &&
    e.data.source?.form === 'snapshot' && e.data.content.some(c => c.text?.includes('Recent completed media receipts'))),
  'the receipt context must be re-admitted after compaction, not merely retained in an old request');
  const other = await driver.createSession(config);
  await driver.prompt(other.sessionId, 'Hello.');
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /fresh-cat/);
  const greeting = requests.findLast(r => !r.tools?.some(tool => tool.function?.name === 'check_execution_claims'));
  assert.doesNotMatch(JSON.stringify(greeting.messages), /media-delivery-instructions|Current admitted media request/);
});

test('current media request keeps admitted steering, excludes assistant suggestions and survives compacted snapshots', () => {
  const user = (id, text, kind = 'user') => ({ type: 'user/message', seq: id, data: { id, source: { kind }, content: [{ type: 'text', text }] } });
  const events = [{ type: 'turn/start' }, user('old', 'Make a teapot.'),
    { type: 'turn/start' }, user('current', 'Make two cat images, then compare them.'),
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Next we could make a tea party.' }] } } },
    user('steer', 'Use blue scarves.'), user('snapshot', 'Current runtime context', 'runtime'),
    user('summary', 'Continue with tea party integration.', 'compact-checkpoint'), { type: 'compaction/end' }];
  assert.deepEqual(admittedMediaRequest(events).map(m => m.text), ['Make two cat images, then compare them.', 'Use blue scarves.']);
  events.push({ type: 'turn/start' }, user('new', 'Explain the differences without generating anything.'));
  assert.deepEqual(admittedMediaRequest(events).map(m => m.text), ['Explain the differences without generating anything.']);
  events.push({ type: 'turn/start' });
  assert.deepEqual(admittedMediaRequest(events), [], 'before new input admission, do not label the previous turn as the current request');
});
