import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHarnessDriver } from '../harness/index.mjs';
import { normalizeGemmaResponse } from '../harness/gemma-response.mjs';

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
