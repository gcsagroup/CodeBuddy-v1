import test from 'node:test';
import assert from 'node:assert/strict';
import '../harness/sdk-budget-contract.mjs';
const { Session } = await import('../harness/node_modules/@deepseek-ai/dsh-session/lib/index.js');
const { createUserMessage, createAssistantMessage, createSystemMessage } = await import('../harness/node_modules/@deepseek-ai/dsh-llm/lib/index.js');
const { default: CompactionEngine, SUMMARY_RETRY_POLICY } = await import('../harness/compaction.mjs');
const { TokenMeter } = await import('../harness/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js');

const snapshot = (session, text, source = { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'policy', text }] }) =>
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source }), { surfaceOp: 'append' });

function failingSummaryFixture(code = 'COMPACTION_EMPTY_SUMMARY') {
  const session = Session.create('summary-recovery'), prices = new Map();
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'fixture', maxTokens: 256 } } });
  session.append('system/message', { message: createSystemMessage('Keep policy.') }, { surfaceOp: 'append' });
  session.append('turn/start', { turn: 1 });
  snapshot(session, 'Keep original task.', { kind: 'user' });
  const addEvidence = tokens => {
    const event = session.append('assistant/message', { turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [{ type: 'text', text: 'Recorded work.' }], source: { provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' });
    prices.set(event.seq, tokens);
  };
  addEvidence(15000);
  snapshot(session, 'Current tool catalog.', { kind: 'skill-catalog' });
  const agent = { session, options: { provider: 'fixture', model: 'fixture' },
    runMaintenance: callback => callback(new AbortController().signal) };
  const logs = [], handlers = new Map();
  const ctx = { reflect: { provide() {} },
    tokenMeter: { estimateMessage: () => 10, measure: () => {
      const nodes = session.surface.nodes.map(seq => ({ seq, tokens: prices.get(seq) ?? 10 }));
      return { nodes, totalTokens: nodes.reduce((n, node) => n + node.tokens, 0) };
    } },
    on(name, callback) { handlers.set(name, callback); return () => {}; },
    get() {}, waterfall: (_name, _event, next) => next(),
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 20000 }, defaultMaxTokens: 256 }),
      prepareCall: async () => ({ measure: async () => ({ estimate: { tokens: 15000 },
        available: 5000, effectiveMaxTokens: 256, minimumMaxTokens: 256 }) }) },
    sessionProjections: { stateOf: () => ({ pending: null }) },
    logger: { info: value => logs.push(value), warn: value => logs.push(value) },
    sessions: { flush: async () => {} }, tools: { schemas: () => [] } };
  const engine = new CompactionEngine(ctx, { auto: false, maxTokens: 256, headroomTokens: 0,
    thresholdRatio: 0.5, retainTokens: 0, compactionRetries: 0 });
  let calls = 0;
  engine.summarize = async () => { calls++; throw Object.assign(new Error('Synthetic summary failure'), { code }); };
  return { engine, agent, addEvidence, logs, handlers, calls: () => calls,
    attempt: (signal = new AbortController().signal) => engine.compactIfNeeded(agent, 'pressure', signal) };
}

test('summary retries require both history growth and cooldown and stop at the per-turn allowance', async t => {
  let now = 1_000_000;
  t.mock.method(performance, 'now', () => now);
  const f = failingSummaryFixture();
  await assert.rejects(f.attempt(), { code: 'COMPACTION_EMPTY_SUMMARY' });
  assert.equal(f.calls(), 1);
  now += SUMMARY_RETRY_POLICY.delayMs;
  for (let step = 0; step < 20; step++) assert.equal(await f.attempt(), null, 'time alone is not progress');
  assert.equal(f.calls(), 1);
  for (let retry = 0; retry < SUMMARY_RETRY_POLICY.maxAutomaticRetries; retry++) {
    f.addEvidence(SUMMARY_RETRY_POLICY.minGrowthTokens);
    if (retry) {
      assert.equal(await f.attempt(), null, 'growth alone is not cooldown');
      now += SUMMARY_RETRY_POLICY.delayMs;
    }
    await assert.rejects(f.attempt(), { code: 'COMPACTION_EMPTY_SUMMARY' });
  }
  f.addEvidence(100_000); now += 60_000;
  for (let step = 0; step < 100; step++) assert.equal(await f.attempt(), null);
  assert.equal(f.calls(), 1 + SUMMARY_RETRY_POLICY.maxAutomaticRetries);
  assert.equal(f.logs.filter(line => line.startsWith('compaction summary recovery:')).length, 2);
  f.handlers.get('agent/status')({ agent: f.agent, status: 'idle' });
  await assert.rejects(f.attempt(), { code: 'COMPACTION_EMPTY_SUMMARY' });
  assert.equal(f.calls(), 4, 'native idle admits a fresh user turn');
});

test('timed out summaries stop at the automatic retry cap', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const f = failingSummaryFixture('TIMEOUT');
  for (let attempt = 0; attempt <= SUMMARY_RETRY_POLICY.maxAutomaticRetries; attempt++) {
    await assert.rejects(f.attempt(), { code: 'TIMEOUT' });
    f.addEvidence(SUMMARY_RETRY_POLICY.minGrowthTokens);
    assert.equal(await f.attempt(), null);
    now += SUMMARY_RETRY_POLICY.delayMs;
  }
  assert.equal(await f.attempt(), null);
  assert.equal(f.calls(), 1 + SUMMARY_RETRY_POLICY.maxAutomaticRetries);
});

test('configuration repair and explicit manual compaction can recover, while cancellation never consumes an attempt', async () => {
  const f = failingSummaryFixture();
  await assert.rejects(f.attempt(), { code: 'COMPACTION_EMPTY_SUMMARY' });
  f.engine.config = { ...f.engine.config, maxTokens: 512 };
  await assert.rejects(f.attempt(), { code: 'COMPACTION_EMPTY_SUMMARY' });
  assert.equal(f.calls(), 2);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.attempt(abort.signal), { name: 'AbortError' });
  assert.equal(f.calls(), 2);
  f.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await assert.rejects(f.engine.compactNow(f.agent, new AbortController().signal));
  assert.equal(f.calls(), 3);
  assert.equal(f.engine.summaryRetryCounts.get(f.agent), undefined, 'manual action resets automatic recovery allowance');
});

test('a busy manual request cannot clear active summary failure, fallback or retry allowance', async () => {
  const f = failingSummaryFixture();
  await assert.rejects(f.attempt());
  const failure = f.engine.summaryFailures.get(f.agent), fallback = { provider: 'fixture-backup', model: 'fixture' };
  f.engine.summaryRetryCounts.set(f.agent, 2);
  f.engine.fallbackTargets.set(f.agent, fallback);
  f.agent.runMaintenance = () => { throw new Error('synthetic busy agent'); };
  await assert.rejects(f.engine.compactNow(f.agent, new AbortController().signal));
  assert.strictEqual(f.engine.summaryFailures.get(f.agent), failure);
  assert.strictEqual(f.engine.fallbackTargets.get(f.agent), fallback);
  assert.equal(f.engine.summaryRetryCounts.get(f.agent), 2);
});

test('a checkpoint plus hidden snapshots is a pressure no-op before the transaction, while forced/manual compaction still works', async () => {
  for (const trigger of ['pressure', 'local-budget', 'manual']) {
    const session = Session.create('checkpoint-null-' + trigger);
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'fixture', maxTokens: 256 },
      tools: [{ name: 'fixture', description: 'Large tool schema. '.repeat(4000), parameters: { type: 'object' } }] } });
    session.append('system/message', { message: createSystemMessage('System policy.') }, { surfaceOp: 'append' });
    const checkpoint = snapshot(session, 'Previously committed checkpoint. '.repeat(300), { kind: 'compact-checkpoint', compactionId: 'prior' });
    snapshot(session, 'Older runtime.'); snapshot(session, 'Old runtime.');
    if (trigger !== 'manual') session.append('turn/start', { turn: 1 });
    const user = snapshot(session, 'Protected latest user task.', { kind: 'user' });
    snapshot(session, 'Current runtime.');
    const meter = Object.assign(Object.create(TokenMeter.prototype), { states: new WeakMap(), ctx: { get() {} } });
    const agent = { session, options: { provider: 'fixture', model: 'fixture' }, runMaintenance: callback => callback(new AbortController().signal) };
    const ctx = { reflect: { provide() {} }, tokenMeter: meter, on() { return () => {}; }, get() {},
      waterfall: (_name, _event, next) => next(), logger: { info() {}, warn() {} },
      llm: { resolveModelInfo: async () => ({ context: { contextWindow: 32768 }, defaultMaxTokens: 256 }),
        prepareCall: async () => ({ measure: async () => ({ estimate: { tokens: meter.measure(session).totalTokens },
          available: 10000, effectiveMaxTokens: 256, minimumMaxTokens: 256 }) }) },
      sessionProjections: { stateOf: () => ({ pending: null }) }, tools: { schemas: () => [] }, sessions: { flush: async () => {} } };
    const engine = new CompactionEngine(ctx, { auto: false, thresholdRatio: 0.1, retainTokens: 0, headroomTokens: 0, maxTokens: 256 });
    let summaries = 0;
    engine.summarize = async () => { summaries++; return { summary: [{ type: 'text', text: 'Condensed checkpoint.' }], provider: 'fixture', model: 'fixture' }; };
    const before = session.snapshotEvents();
    if (trigger === 'pressure') {
      for (let step = 0; step < 20; step++) assert.equal(await engine.compactIfNeeded(agent, trigger, new AbortController().signal), null);
      assert.equal(summaries, 0);
      assert.deepEqual(session.snapshotEvents(), before, 'no start, failure card, summary or altered history for a no-op');
    } else {
      const result = trigger === 'manual' ? await engine.compactNow(agent, new AbortController().signal)
        : await engine.compactIfNeeded(agent, trigger, new AbortController().signal);
      assert.ok(result.shadowedSeqs.includes(checkpoint.seq));
      assert.equal(summaries, 1);
      assert.ok(session.snapshotEvents().some(event => event.type === 'compaction/summary'));
    }
    assert.deepEqual(session.deriveMessages().find(message => message.id === user.data.id), user.data);
  }
});
