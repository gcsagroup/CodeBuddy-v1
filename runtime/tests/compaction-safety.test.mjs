import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHarnessDriver } from '../harness/index.mjs';
import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';

const { default: CompactionEngine } = await import('../harness/compaction.mjs');
const harnessRequire = createRequire(new URL('../harness/package.json', import.meta.url));
const { Session } = await import(pathToFileURL(harnessRequire.resolve('@deepseek-ai/dsh-session')).href);
const facts = 'Known immutable fixture facts; validated write receipt. '.repeat(400);
const count = body => Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
function reply(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [delta, finish_reason] of [[{ content: text }, null], [{}, 'stop']])
    res.write('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
async function fixture(t, handler, tokenizer = false) {
  const root = await mkdtemp(join(tmpdir(), 'compaction-safety-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url.endsWith('/tokenize')) {
      res.end(JSON.stringify({ count: count(body), max_model_len: 262144 })); return;
    }
    if (replyToNoActionReview(body, res)) return;
    const last = body.messages.at(-1)?.content;
    const text = typeof last === 'string' ? last : (last ?? []).map(block => block.text ?? '').join('\n');
    const request = { body, summary: text.startsWith('You are now acting as a compaction engine for this AI coding assistant.') };
    requests.push(request);
    handler(request, res);
  });
  let driver;
  t.after(async () => { await driver?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  const provider = { id: 'source', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic-only',
    protocol: 'openai-completions', contextWindow: 262144, retryPolicy: { mode: 'normal', maxRetries: 0 },
    ...(tokenizer ? { countBackend: 'vllm' } : {}) };
  const options = { maxTokens: 256, autoCompact: false };
  const { sessionId } = await driver.createSession({ cwd: root, provider, model: 'source', options });
  return { driver, sessionId, provider, options, requests, root };
}

test('native account quota advances summary fallback once and leaves the chat route and history intact', { timeout: 30000 }, async t => {
  const f = await fixture(t, ({ body, summary }, res) => {
    if (summary && body.model === 'source') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'Synthetic account quota exhausted' } })); return;
    }
    reply(res, summary ? 'Preserve CORAL-851; verify before completion.' : facts);
  });
  await f.driver.prompt(f.sessionId, 'Record CORAL-851.');
  await f.driver.prompt(f.sessionId, 'Latest task: preserve CORAL-851 and verify.');
  await f.driver.configureSession(f.sessionId, { ...f.options, compactionFallbacks: [
    { source: { provider: f.provider, model: 'source' }, fallback: { provider: { ...f.provider, id: 'backup' }, model: 'backup' } },
  ] });
  const before = await f.driver.history(f.sessionId);
  assert.ok(await f.driver.compact(f.sessionId));
  const after = await f.driver.history(f.sessionId);
  assert.deepEqual(f.requests.filter(r => r.summary).map(r => r.body.model), ['source', 'backup']);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  await f.driver.prompt(f.sessionId, 'Continue verifying CORAL-851.');
  assert.equal(f.requests.at(-1).body.model, 'source', 'summary fallback must not switch the chat model');
});

for (const unrelated of [false, true]) test(`manual compaction verifies a small destination without a matching backup rule (${unrelated})`, { timeout: 30000 }, async t => {
  const f = await fixture(t, ({ summary }, res) => reply(res, summary ? 'Preserve CORAL-851, completed receipts and task; verify next.' : facts), true);
  for (let i = 0; i < 6; i++) await f.driver.prompt(f.sessionId, 'Historical record ' + i + ' ' + facts);
  const latest = 'Latest canonical task: preserve CORAL-851 and verify, do not publish.';
  await f.driver.prompt(f.sessionId, latest);
  const destination = { ...f.provider, id: 'destination', contextWindow: 32768 };
  await f.driver.createSession({ sessionId: f.sessionId, cwd: f.root, provider: destination, model: 'destination', options: {
    ...f.options, compactionFallbacks: unrelated ? [{ source: { provider: f.provider, model: 'unrelated' },
      fallback: { provider: f.provider, model: 'unused-backup' } }] : [],
  } });
  assert.ok(await f.driver.compact(f.sessionId));
  const history = await f.driver.history(f.sessionId);
  const session = new Session(history.meta.id, history.events, history.meta, 'snapshot', history.inheritedEventCount);
  assert.ok(count({ messages: session.deriveMessages() }) < 32768);
  assert.ok(history.events.filter(e => e.type === 'compaction/summary').length > 1, 'one local segment is insufficient for this history');
  assert.ok(session.deriveMessages().some(m => m.content.some(b => b.type === 'text' && b.text === latest)), 'latest user input stays verbatim');
  assert.ok(f.requests.filter(r => r.summary).every(r => r.body.model === 'destination'));
  await f.driver.prompt(f.sessionId, 'Continue verification.');
  assert.equal(f.requests.at(-1).body.model, 'destination');
  const continued = f.requests.at(-1).body;
  const output = continued.max_tokens ?? continued.max_completion_tokens;
  assert.ok(count(continued) + output < 32768, `continued request must fit: ${JSON.stringify({ input: count(continued), output, fields: Object.keys(continued) })}`);
});

test('valid segments keep the successful summary model and stop if protected context cannot shrink', async () => {
  for (const noProgress of [false, true]) {
    const source = { provider: 'primary', model: 'primary' };
    const measures = [1000, noProgress ? 1000 : 700, 100];
    const agent = { options: { ...source, maxTokens: 256 }, session: {
      id: 'contract', requestHeader: () => ({ config: source }), deriveMessages: () => [], toolHistory: () => new Map(),
    } };
    const owner = { config: { modelPolicies: [] }, fallbackTargets: new WeakMap(), summaryFailures: new WeakMap(), summaryRetryCounts: new WeakMap(),
      fallbackPolicies: [{ source, requestConfig: {}, fallbacks: [async () => { throw Error('Unneeded backup must not be loaded'); }] }],
      ctx: { sessionProjections: { stateOf: () => ({ pending: null }) }, tools: { schemas: () => [] }, logger: { info() {} },
        llm: { prepareCall: async () => ({ measure: async () => {
          const tokens = measures.shift();
          return { estimate: { tokens }, available: 500 - tokens, effectiveMaxTokens: tokens < 500 ? 256 : 0, minimumMaxTokens: 128 };
        } }) } },
    };
    let segments = 0;
    const result = CompactionEngine.prototype.finishManualCompaction.call(owner, agent, async () => { segments++; return { checkpoint: true }; }, new AbortController().signal);
    if (noProgress) {
      await assert.rejects(result, { code: 'COMPACTION_TARGET_WINDOW_EXCEEDED' });
      assert.equal(segments, 1);
    } else {
      assert.ok(await result);
      assert.equal(segments, 2);
    }
  }
});

test('a public model switch during final measurement invalidates old fit while keeping the committed checkpoint', { timeout: 30000 }, async t => {
  const { PiAiAdapter } = await import(pathToFileURL(harnessRequire.resolve('@deepseek-ai/dsh-llm-pi-ai')).href);
  const original = PiAiAdapter.prototype.prepareRequestWithSnapshot;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  let armed = false, measurements = 0;
  t.mock.method(PiAiAdapter.prototype, 'prepareRequestWithSnapshot', async function(options, snapshot) {
    const prepared = await original.call(this, options, snapshot);
    if (armed && options.model === 'source' && options.purpose === undefined && ++measurements === 2) {
      entered.resolve(); await release.promise;
    }
    return prepared;
  });
  const f = await fixture(t, ({ summary }, res) => reply(res, summary ? 'Preserve CORAL-851; verify next.' : facts));
  await f.driver.prompt(f.sessionId, 'Record CORAL-851.');
  await f.driver.prompt(f.sessionId, 'Latest task: verify CORAL-851.');
  armed = true;
  const running = f.driver.compact(f.sessionId).then(result => ({ result }), error => ({ error }));
  await Promise.race([entered.promise, running.then(() => { throw Error('Compaction settled before the final-fit gate'); })]);
  const beforeSwitch = await f.driver.history(f.sessionId);
  assert.equal(beforeSwitch.events.filter(e => e.type === 'compaction/summary').length, 1);
  await f.driver.createSession({ sessionId: f.sessionId, cwd: f.root, provider: { ...f.provider, id: 'tiny', contextWindow: 2048 }, model: 'tiny', options: f.options });
  release.resolve();
  const { error, result } = await running;
  assert.equal(result, undefined);
  assert.match(error?.message ?? '', /Model selection changed during compaction/);
  const after = await f.driver.history(f.sessionId);
  assert.equal(after.events.findLast(e => e.type === 'model/selection').data.model, 'tiny');
  assert.equal(after.events.filter(e => e.type === 'compaction/summary').length, 1, 'accepted earlier work is preserved');
});
