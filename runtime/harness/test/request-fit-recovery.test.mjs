import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { Session } from '@deepseek-ai/dsh-session';
import { createUserMessage, createAssistantMessage, createSystemMessage, createToolResultMessage, LlmError } from '@deepseek-ai/dsh-llm';
import { compactionPatch } from '../sdk-budget/compaction-patch.mjs';

const nativeUrl = import.meta.resolve(compactionPatch.name);
const nativeSource = readFileSync(new URL(nativeUrl), 'utf8');
assert.equal(createHash('sha256').update(nativeSource).digest('hex'), compactionPatch.hash);
const hook = registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (url !== nativeUrl) return loaded;
  assert.equal(Buffer.from(loaded.source).toString('utf8'), nativeSource);
  return { ...loaded, source: compactionPatch.transform(nativeSource) };
} });
let BasicCompactionEngine;
try { ({ BasicCompactionEngine } = await import(compactionPatch.name)); }
finally { hook.deregister(); }
const { default: CompactionEngine } = await import('../compaction.mjs');

const exhaustedFit = Object.freeze({
  provider: 'fixture', model: 'same-model', contextWindow: 10000, safetyTokens: 100,
  desiredMaxTokens: 4096, effectiveMaxTokens: 1, available: -20,
  estimate: { tokens: 9920 },
});
const improvedFit = Object.freeze({
  ...exhaustedFit, effectiveMaxTokens: 4096, available: 4900, estimate: { tokens: 5000 },
});

function fixture({ before = exhaustedFit, after = improvedFit, shrink = true, compactError, measureError } = {}) {
  const handlers = new Map(), failures = new WeakMap(), warnings = [], measurements = [], compactions = [];
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Current reduced surface' }] }];
  const history = new Map();
  const session = {
    surface: { replaceGeneration: 0 },
    deriveMessages: () => messages,
    toolHistory: () => history,
  };
  const agent = { session };
  const ctx = {
    reflect: { provide() {} },
    sessionProjections: { stateOf() {} },
    emit() {},
    bail(name, ...args) { return handlers.get(name)?.[0]?.(...args); },
    on(name, listener) { const list = handlers.get(name) ?? []; list.push(listener); handlers.set(name, list); return () => {}; },
    logger: { info() {}, warn: text => warnings.push(text) },
    llm: { requestFitRecovery: failure => failures.get(failure) },
  };
  const engine = new BasicCompactionEngine(ctx);
  engine.compactIfNeeded = async (owner, trigger, signal) => {
    compactions.push({ owner, trigger, signal });
    if (shrink) session.surface.replaceGeneration++;
    if (compactError) throw compactError;
    return { shadowedSeqs: [1, 2], shadowedRange: { start: 1, end: 2 }, shadowedTokenCount: 5000 };
  };
  const budgetListener = handlers.get('agent/request-error')[0];
  function failure(code = 'LOCAL_OUTPUT_BUDGET_EXHAUSTED') {
    const value = { code, message: 'Fixture request cannot continue', requestId: 'fixture-request' };
    failures.set(value, { fit: before, async measure(options) {
      measurements.push(options);
      if (measureError) throw measureError;
      return Array.isArray(after) ? after[Math.min(measurements.length - 1, after.length - 1)] : after;
    } });
    return value;
  }
  const next = Symbol('unhandled-request-error');
  return {
    engine, agent, session, messages, history, warnings, measurements, compactions, handlers, failure, next,
    recover: (value = failure(), turn = 'turn-1', signal = new AbortController().signal, step = 1) => budgetListener({ agent, turn, step, failure: value, signal }, () => next),
  };
}

test('local exhaustion and truncated output use the native request-error retry with a reduced, improved projection', async () => {
  for (const [code, trigger] of [['LOCAL_OUTPUT_BUDGET_EXHAUSTED', 'local-budget'], ['OUTPUT_TRUNCATED', 'output-truncation']]) {
    const f = fixture(), failure = f.failure(code), before = structuredClone(failure);
    assert.deepEqual(await f.recover(failure), { kind: 'retry' });
    assert.equal(f.compactions[0].trigger, trigger);
    assert.strictEqual(f.compactions[0].owner, f.agent);
    assert.strictEqual(f.measurements[0].messages, f.messages);
    assert.strictEqual(f.measurements[0].toolHistory, f.history);
    assert.deepEqual(failure, before, 'fit and callbacks must not enter the persisted failure object');
  }
});

test('local compaction attempts are shared by both codes within a step and survive an assistant message', async () => {
  const f = fixture();
  assert.deepEqual(await f.recover(f.failure('LOCAL_OUTPUT_BUDGET_EXHAUSTED')), { kind: 'retry' });
  for (const handler of f.handlers.get('session/event')) handler(f.session, { type: 'assistant/message' });
  assert.strictEqual(await f.recover(f.failure('OUTPUT_TRUNCATED')), f.next);
  assert.equal(f.compactions.length, 1);
  assert.deepEqual(await f.recover(f.failure('OUTPUT_TRUNCATED'), 'turn-1', new AbortController().signal, 2), { kind: 'retry' });
  assert.deepEqual(await f.recover(f.failure('OUTPUT_TRUNCATED'), 'turn-2'), { kind: 'retry' });
  for (const handler of f.handlers.get('agent/status')) handler({ agent: f.agent, status: 'idle' });
  assert.deepEqual(await f.recover(f.failure(), 'turn-2'), { kind: 'retry' });
});

test('the shared host allowance can deny compaction before summarization or retry admission', async () => {
  const denied = fixture();
  denied.handlers.set('codebuddy/output-recovery-available', [() => ({ allowed: false })]);
  assert.strictEqual(await denied.recover(), denied.next);
  assert.equal(denied.compactions.length, 0);
  const changed = fixture();
  changed.handlers.set('codebuddy/output-recovery-started', [() => ({ allowed: false })]);
  assert.strictEqual(await changed.recover(), changed.next);
  assert.equal(changed.compactions.length, 1);
});

test('no surface replacement, insufficient fit, and summary failures cannot authorize retry', async () => {
  for (const options of [
    { shrink: false },
    { after: { ...improvedFit, estimate: exhaustedFit.estimate } },
    { after: { ...improvedFit, available: -1, effectiveMaxTokens: 1 } },
    { after: { ...improvedFit, available: exhaustedFit.available } },
    { after: { ...improvedFit, effectiveMaxTokens: 0 } },
    { after: { ...improvedFit, model: 'different-model' } },
    { after: { ...improvedFit, desiredMaxTokens: 128 } },
    { compactError: new Error('summary itself does not fit') },
    { measureError: new Error('cannot prepare replacement') },
  ]) {
    const f = fixture(options);
    assert.strictEqual(await f.recover(), f.next);
    assert.strictEqual(await f.recover(), f.next, 'a failed/no-op attempt cannot repeatedly summarize within the turn');
    const improvedButInsufficient = options.after?.estimate?.tokens < exhaustedFit.estimate.tokens && options.after?.available > exhaustedFit.available && (options.after.available < 1 || options.after.effectiveMaxTokens < 1);
    assert.equal(f.compactions.length, improvedButInsufficient ? 2 : 1, 'an improving segment may continue once, but unchanged fit stops the next segment');
  }
});

test('recovery satisfies the same adapter minimum output policy before retrying', async () => {
  const before = { ...exhaustedFit, minimumMaxTokens: 16 };
  const after = { ...improvedFit, minimumMaxTokens: 16, available: 16, effectiveMaxTokens: 16, estimate: { tokens: 9884 } };
  for (const insufficient of [
    { ...after, available: 15, effectiveMaxTokens: 15, estimate: { tokens: 9885 } },
    { ...after, available: 15, effectiveMaxTokens: 16, estimate: { tokens: 9885 } },
    { ...after, available: 16, effectiveMaxTokens: 15 },
    { ...after, minimumMaxTokens: 1 },
  ]) {
    const f = fixture({ before, after: insufficient });
    assert.strictEqual(await f.recover(), f.next);
  }
  const legal = fixture({ before, after });
  assert.deepEqual(await legal.recover(), { kind: 'retry' });
  const changedPolicy = fixture({ before: exhaustedFit, after });
  assert.strictEqual(await changedPolicy.recover(), changedPolicy.next, 'a new minimum is a different request policy');
  for (const [beforeMinimum, afterMinimum] of [[undefined, 1], [1, undefined]]) {
    const compatible = fixture({
      before: { ...exhaustedFit, minimumMaxTokens: beforeMinimum },
      after: { ...improvedFit, minimumMaxTokens: afterMinimum },
    });
    assert.deepEqual(await compatible.recover(), { kind: 'retry' }, 'old adapters keep the one-token default');
  }
});

test('cancellation before compaction or after replacement prevents retry', async () => {
  const cancelled = new AbortController(); cancelled.abort();
  const before = fixture();
  assert.strictEqual(await before.recover(before.failure(), 'turn-1', cancelled.signal), before.next);
  assert.equal(before.compactions.length, 0);
  const during = fixture(), controller = new AbortController();
  during.engine.compactIfNeeded = async () => { during.session.surface.replaceGeneration++; controller.abort(); return null; };
  assert.strictEqual(await during.recover(during.failure(), 'turn-1', controller.signal), during.next);
  assert.equal(during.measurements.length, 0);
});

test('unrelated failures and adapters without a fit contract retain their existing owner', async () => {
  const f = fixture();
  for (const code of ['CONTEXT_WINDOW_EXCEEDED', 'RATE_LIMIT', 'ABORTED'])
    assert.strictEqual(await f.recover(f.failure(code)), f.next);
  assert.strictEqual(await f.recover({ code: 'OUTPUT_TRUNCATED', message: 'No optional adapter fit' }), f.next);
  assert.equal(f.compactions.length, 0);
});

test('forced local triggers reuse the native safe range and do not split tool calls from results', async () => {
  const events = [
    { seq: 0, type: 'system/message' },
    { seq: 1, type: 'user/message', data: {} },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
    { seq: 3, type: 'tool/result' },
  ];
  const session = {
    surface: { nodes: [0, 1, 2, 3], replaceGeneration: 0 },
    requestHeader: () => ({ config: { provider: 'fixture', model: 'same-model' } }),
    eventAt: seq => events[seq],
  };
  const calls = [];
  const engine = new BasicCompactionEngine({
    reflect: { provide() {} },
    tokenMeter: { measure: () => ({ totalTokens: 100, nodes: events.map(event => ({ seq: event.seq, tokens: 25 })) }) },
    get: () => undefined,
  }, { auto: false });
  engine.compactRegion = async (start, end) => { calls.push([start, end]); return 'native-selected-range'; };
  for (const trigger of ['local-budget', 'output-truncation'])
    assert.equal(await engine.compactIfNeeded({ session }, trigger), 'native-selected-range');
  assert.deepEqual(calls, [[1, 1], [1, 1]], 'the retained final tool receipt retains its matching assistant call');
});

function nativeSurface({ idle = false, retainTokens = 0, contextWindow = 20000, Engine = BasicCompactionEngine, requestFitRecovery } = {}) {
  const session = new Session('native-request-fit-boundary');
  const prices = new Map(), inputs = [], flushes = [];
  const add = (type, data, tokens = 50, options = {}) => {
    const event = session.append(type, data, { ...options, surfaceOp: 'append' });
    prices.set(event.seq, tokens);
    return event;
  };
  const user = (text, source = { kind: 'user' }, tokens = 50, options) =>
    add('user/message', createUserMessage({ content: [{ type: 'text', text }], source }), tokens, options);
  const assistant = (content, tokens = 50) => add('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: createAssistantMessage({ content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, source: { provider: 'fixture', model: 'same-model' } }),
  }, tokens);
  const tool = (callId, tokens = 50) => add('tool/result', {
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Completed receipt.' }], isError: false }),
  }, tokens);
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'same-model', maxTokens: 256 } } });
  const system = add('system/message', { message: createSystemMessage('Native compaction fixture.') });
  if (!idle) session.append('turn/start', { turn: 1 });
  const meter = {
    measure: owner => {
      const nodes = owner.surface.nodes.map(seq => ({ seq, tokens: prices.get(seq) ?? 50, heuristicTokens: prices.get(seq) ?? 50 }));
      return { nodes, totalTokens: nodes.reduce((total, node) => total + node.tokens, 0) };
    },
    estimateMessage: () => 10,
  };
  const agent = { session, options: { provider: 'fixture', model: 'same-model' }, runMaintenance: operation => operation(new AbortController().signal) };
  const ctx = {
    reflect: { provide() {} }, tokenMeter: meter, get: () => undefined,
    sessionProjections: { stateOf: () => ({ pending: null }) },
    on() { return () => {}; },
    waterfall: (_name, _payload, next) => next(),
    llm: { resolveModelInfo: async () => ({ context: { contextWindow }, defaultMaxTokens: 256 }), requestFitRecovery },
    sessions: { flush: async value => flushes.push(value) },
  };
  const engine = new Engine(ctx, { auto: false, headroomTokens: 0, maxTokens: 256, thresholdRatio: 0.5, retainTokens, compactionRetries: 0 });
  engine.summarize = async input => {
    inputs.push(input);
    // Deliberately omit the current instruction: it must survive independently.
    return { summary: [{ type: 'text', text: 'Earlier recorded facts.' }], provider: 'fixture', model: 'same-model' };
  };
  return { session, system, add, user, assistant, tool, engine, agent, inputs, flushes, ctx };
}

test('native forced, pressure and manual compaction retain canonical user identity behind generated context', async () => {
  for (const trigger of ['local-budget', 'output-truncation', 'context-overflow', 'pressure', 'manual']) {
    const f = nativeSurface({ idle: trigger === 'manual' });
    f.user('Earlier task.');
    const old = f.assistant('Long recorded receipt history.', 14000);
    const inbox = f.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] });
    const current = f.user('Keep this exact request. Do not invoke tools.', { kind: 'user', rpcId: 'new-human-input' }, 50, { sourceEventSeqs: [inbox.seq] });
    const runtime = f.user('Generated current policy.', { kind: 'runtime-context' });
    const catalog = f.user('Generated skill catalog.', { kind: 'skill-catalog' });
    const signal = new AbortController().signal;
    const result = trigger === 'manual'
      ? await f.engine.compactNow(f.agent, signal, 'manual-fixture')
      : await f.engine.compactIfNeeded(f.agent, trigger, signal);
    assert.ok(result.shadowedSeqs.includes(old.seq), trigger);
    assert.ok(!result.shadowedSeqs.includes(current.seq), trigger);
    assert.ok(!result.shadowedSeqs.includes(f.system.seq), trigger);
    assert.strictEqual(f.session.eventAt(current.seq), current, 'the original event is retained without rewriting');
    assert.deepEqual(current.sourceEventSeqs, [inbox.seq]);
    const beforeRestore = f.session.deriveMessages();
    assert.strictEqual(beforeRestore.find(message => message.id === current.data.id), current.data);
    assert.ok(beforeRestore.findIndex(message => message.id === current.data.id) < beforeRestore.findIndex(message => message.id === runtime.data.id));
    assert.ok(beforeRestore.findIndex(message => message.id === runtime.data.id) < beforeRestore.findIndex(message => message.id === catalog.data.id));
    assert.ok(!f.inputs[0].messages.some(message => message.id === current.data.id), 'summary quality cannot replace the current human instruction');
    const checkpoint = beforeRestore.find(message => message.source?.kind === 'compact-checkpoint');
    assert.ok(checkpoint);
    assert.equal(f.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === current.data.id).length, 1);
    const restored = new Session(f.session.id, f.session.snapshotEvents(), f.session.header);
    assert.deepEqual(restored.surface.nodes, f.session.surface.nodes);
    assert.deepEqual(restored.deriveMessages(), beforeRestore, 'cold replay keeps exact human content, identity and message order');
    assert.deepEqual(restored.eventAt(current.seq), current);
    assert.equal(f.flushes.length, trigger === 'manual' ? 1 : 0);
  }
});

test('a long single turn can compact tool history after the user instead of an unchanged checkpoint', async () => {
  const f = nativeSurface();
  const checkpoint = f.user('Prior checkpoint.', { kind: 'compact-checkpoint', compactionId: 'prior' }, 500);
  const current = f.user('Continue this exact long task.');
  f.user('Generated policy.', { kind: 'runtime-context' });
  const call = f.assistant([{ type: 'tool-call', id: 'long-turn-call', name: 'fixture', arguments: {} }], 5000);
  const receipt = f.tool('long-turn-call', 7000);
  const tail = f.user('Generated catalog.', { kind: 'skill-catalog' });
  const result = await f.engine.compactIfNeeded(f.agent, 'pressure');
  assert.deepEqual(result.shadowedSeqs.filter(seq => [call.seq, receipt.seq].includes(seq)), [call.seq, receipt.seq]);
  assert.ok(!result.shadowedSeqs.includes(current.seq));
  assert.ok(!result.shadowedSeqs.includes(checkpoint.seq));
  assert.ok(!result.shadowedSeqs.includes(tail.seq));
  assert.ok(f.session.surface.nodes.includes(current.seq));
  assert.equal(f.inputs[0].messages[0].role, 'system');
  assert.ok(f.inputs[0].messages.some(message => message.id === receipt.data.message.id));
});

test('steering inside a pending tool unit keeps both sides of that unit outside the summary', async () => {
  const f = nativeSurface();
  f.user('Original goal.');
  const old = f.assistant('Earlier facts.', 500);
  const crossingCall = f.assistant([{ type: 'tool-call', id: 'crossing-call', name: 'fixture', arguments: {} }]);
  const steer = f.user('New human steering overrides the original goal.');
  const crossingReceipt = f.tool('crossing-call');
  const later = f.assistant('Large completed work after steering.', 12000);
  f.user('Generated catalog.', { kind: 'skill-catalog' });
  const result = await f.engine.compactIfNeeded(f.agent, 'local-budget');
  assert.deepEqual(result.shadowedSeqs, [later.seq], 'the larger balanced segment after steering can still shrink');
  for (const event of [old, crossingCall, steer, crossingReceipt]) assert.ok(f.session.surface.nodes.includes(event.seq));
  assert.ok(f.session.deriveMessages().some(message => message.id === steer.data.id));
});

test('tool units crossing the human boundary stop without a safe summary range', async () => {
  const f = nativeSurface();
  f.assistant([{ type: 'tool-call', id: 'uncuttable-call', name: 'fixture', arguments: {} }], 12000);
  f.user('The latest human must remain exact.');
  f.tool('uncuttable-call');
  f.user('Generated catalog.', { kind: 'skill-catalog' });
  const events = f.session.snapshotEvents(), nodes = f.session.surface.nodes;
  assert.equal(await f.engine.compactIfNeeded(f.agent, 'local-budget'), null);
  assert.equal(f.inputs.length, 0);
  assert.deepEqual(f.session.snapshotEvents(), events);
  assert.deepEqual(f.session.surface.nodes, nodes);
});

test('a sole checkpoint remains available to forced/manual recovery while pressure preserves its existing guard', async () => {
  for (const trigger of ['local-budget', 'output-truncation', 'context-overflow', 'manual', 'pressure']) {
    const f = nativeSurface({ idle: trigger === 'manual', Engine: CompactionEngine });
    const checkpoint = f.user('Large prior checkpoint.', { kind: 'compact-checkpoint', compactionId: 'prior' }, 12000);
    const current = f.user('Current exact human request.');
    f.user('Generated catalog.', { kind: 'skill-catalog' });
    const result = trigger === 'manual'
      ? await f.engine.compactNow(f.agent, new AbortController().signal)
      : await f.engine.compactIfNeeded(f.agent, trigger);
    if (trigger === 'pressure') {
      assert.equal(result, null);
      assert.equal(f.inputs.length, 0);
      assert.ok(f.session.surface.nodes.includes(checkpoint.seq));
    } else {
      assert.deepEqual(result.shadowedSeqs, [checkpoint.seq]);
      assert.equal(f.inputs.length, 1);
    }
    assert.ok(f.session.surface.nodes.includes(current.seq));
  }
});

test('priced retained tail still keeps its whole final tool unit outside either candidate', async () => {
  const f = nativeSurface({ retainTokens: 11, contextWindow: 40000 });
  f.user('Earlier task.');
  const old = f.assistant('Older completed work.', 12000);
  const current = f.user('The latest exact human instruction.');
  const call = f.assistant([{ type: 'tool-call', id: 'retained-call', name: 'fixture', arguments: {} }], 6000);
  const receipt = f.tool('retained-call', 6000);
  const catalog = f.user('Generated catalog.', { kind: 'skill-catalog' }, 10);
  const result = await f.engine.compactIfNeeded(f.agent, 'pressure');
  assert.ok(result.shadowedSeqs.includes(old.seq));
  for (const event of [current, call, receipt, catalog]) {
    assert.ok(!result.shadowedSeqs.includes(event.seq));
    assert.ok(f.session.surface.nodes.includes(event.seq));
  }
});

test('summary preflight shrinks the native selected span and leaves every omitted original node in order', async () => {
  const scopes = [], inputs = [], stream = () => { throw Error('The custom native summarizer does not dispatch HTTP'); };
  const f = nativeSurface({ requestFitRecovery: (failure, scope) => { scopes.push({ failure, scope }); return { stream }; } });
  f.user('Earlier task.');
  f.assistant('Old completed facts.', 12000);
  const call = f.assistant([{ type: 'tool-call', id: 'tail-call', name: 'fixture', arguments: {} }], 200);
  const receipt = f.tool('tail-call', 200);
  const giantTail = f.assistant('A long model answer remains outside the smaller summary.', 6000);
  const current = f.user('Exact current human input.');
  f.user('Generated catalog.', { kind: 'skill-catalog' });
  const originalNodes = [...f.session.surface.nodes];
  f.engine.summarize = async input => {
    inputs.push(input);
    if (inputs.length === 1) throw new LlmError('Needs full summary reservation', 'COMPACTION_OUTPUT_BUDGET_EXHAUSTED', { requestId: 'summary-preflight' });
    return { summary: [{ type: 'text', text: 'Earlier facts remain valid.' }], provider: 'fixture', model: 'same-model' };
  };
  const result = await f.engine.compactIfNeeded(f.agent, 'local-budget');
  assert.equal(inputs.length, 2);
  assert.strictEqual(inputs[1].requestFitStream, stream);
  assert.deepEqual(scopes, [{ failure: { message: 'Needs full summary reservation', code: 'COMPACTION_OUTPUT_BUDGET_EXHAUSTED', requestId: 'summary-preflight' }, scope: { purpose: 'compaction', sessionId: f.session.id } }]);
  const coveredIds = inputs[1].messages.slice(1).map(message => message.id);
  assert.deepEqual(result.shadowedSeqs.map(seq => f.session.deriveEventMessage(f.session.eventAt(seq)).id), coveredIds, 'input and durable shadowed membership must shrink together');
  assert.ok(inputs[1].messages.length < inputs[0].messages.length);
  assert.ok(!result.shadowedSeqs.includes(current.seq));
  for (const event of [call, receipt, giantTail, current]) assert.ok(f.session.surface.nodes.includes(event.seq));
  const retained = originalNodes.filter(seq => !result.shadowedSeqs.includes(seq));
  assert.deepEqual(f.session.surface.nodes.filter(seq => originalNodes.includes(seq)), retained, 'omitted originals stay in their original surface order');
  const restored = new Session(f.session.id, f.session.snapshotEvents(), f.session.header);
  assert.deepEqual(restored.surface.nodes, f.session.surface.nodes);
  assert.deepEqual(restored.deriveMessages().find(message => message.id === current.data.id), current.data);
});

test('local summary preparation is finite and never drops an oversized indivisible node', async () => {
  for (const count of [1, 12]) {
    let attempts = 0;
    const f = nativeSurface({ requestFitRecovery: () => ({ stream() {} }) });
    f.user('An old checkpoint.', { kind: 'compact-checkpoint', compactionId: 'prior' }, 12000);
    for (let index = 1; index < count; index++) f.assistant(`Original fact ${index}.`, 12000);
    const current = f.user('The latest user stays exact.');
    f.user('Catalog.', { kind: 'skill-catalog' });
    const originalNodes = [...f.session.surface.nodes];
    f.engine.summarize = async () => {
      attempts++;
      throw new LlmError('No candidate has a full output reservation', 'COMPACTION_OUTPUT_BUDGET_EXHAUSTED', { requestId: `fit-${attempts}` });
    };
    await assert.rejects(f.engine.compactIfNeeded(f.agent, 'local-budget'), { code: 'COMPACTION_OUTPUT_BUDGET_EXHAUSTED' });
    assert.ok(attempts <= Math.ceil(Math.log2(count)) + 1, 'each failed local preparation removes at least half the smaller legal endpoints');
    assert.deepEqual(f.session.surface.nodes, originalNodes);
    assert.ok(f.session.surface.nodes.includes(current.seq));
    assert.equal(f.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 0);
  }
});

test('cancellation, surface mutation and a dispatched truncation cannot enter local summary selection', async () => {
  for (const reason of ['cancelled', 'changed', 'truncated']) {
    let consumed = 0, attempts = 0;
    const controller = new AbortController();
    const f = nativeSurface({ requestFitRecovery: () => { consumed++; return { stream() {} }; } });
    f.user('Old input.'); f.assistant('Old facts.', 12000);
    const current = f.user('Latest user.'); f.user('Catalog.', { kind: 'skill-catalog' });
    f.engine.summarize = async () => {
      attempts++;
      if (reason === 'cancelled') controller.abort();
      if (reason === 'changed') f.user('New human steering.');
      throw new LlmError('Fixture summary failure', reason === 'truncated' ? 'OUTPUT_TRUNCATED' : 'COMPACTION_OUTPUT_BUDGET_EXHAUSTED', { requestId: 'summary-failure' });
    };
    await assert.rejects(f.engine.compactIfNeeded(f.agent, 'local-budget', controller.signal));
    assert.equal(attempts, 1);
    assert.equal(consumed, 0);
    assert.equal(f.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 0);
    assert.ok(f.session.surface.nodes.includes(current.seq));
  }
});

test('pressure refuses an inner checkpoint-only shrink while forced and manual compaction retain it', async () => {
  for (const trigger of ['pressure', 'local-budget', 'manual']) {
    let preparations = 0, dispatched = 0;
    async function* stream(options) {
      preparations++;
      const region = options.messages.slice(1, -1);
      if (region.length > 1) throw new LlmError('The tool unit leaves no full output reserve', 'COMPACTION_OUTPUT_BUDGET_EXHAUSTED', { requestId: 'pressure-shrink' });
      dispatched++;
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Earlier checkpoint facts.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
    const f = nativeSurface({ idle: trigger === 'manual', Engine: CompactionEngine, requestFitRecovery: () => ({ stream }) });
    f.ctx.llm.stream = stream;
    f.engine.summarize = CompactionEngine.prototype.summarize.bind(f.engine);
    const checkpoint = f.user('Earlier checkpoint.', { kind: 'compact-checkpoint', compactionId: 'prior' }, 5000);
    const call = f.assistant([{ type: 'tool-call', id: 'large-unit', name: 'fixture', arguments: {} }], 6000);
    const receipt = f.tool('large-unit', 6000);
    const current = f.user('Keep this exact human instruction.');
    f.user('Catalog.', { kind: 'skill-catalog' });
    const originalNodes = [...f.session.surface.nodes];
    const result = trigger === 'manual'
      ? await f.engine.compactNow(f.agent, new AbortController().signal)
      : await f.engine.compactIfNeeded(f.agent, trigger);
    if (trigger === 'pressure') {
      assert.equal(result, null);
      assert.equal(preparations, 1, 'the inner final input is checked before another LLM preparation');
      assert.equal(dispatched, 0);
      assert.deepEqual(f.session.surface.nodes, originalNodes);
      assert.equal(f.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 0);
      assert.ok(f.session.snapshotEvents().some(event => event.type === 'compaction/end' && event.data.error), 'native transaction closes before the existing pressure guard settles');
    } else {
      assert.deepEqual(result.shadowedSeqs, [checkpoint.seq]);
      assert.equal(preparations, 2);
      assert.equal(dispatched, 1);
    }
    for (const event of [call, receipt, current]) assert.ok(f.session.surface.nodes.includes(event.seq));
  }
});

test('patch fails closed when a native anchor drifts', () => {
  assert.throws(() => compactionPatch.transform(nativeSource.replace('overflowAgents =', 'changedOverflowAgents =')), /Review the native compaction/);
  assert.throws(() => compactionPatch.transform(nativeSource.replace('end: surfaceNodes[keepFromIdx - 1]', 'end: changedSelectorTail')), /Review the native compaction/);
});

test('a measured downshift continues only while the same route gains room, stopping on a plateau', async () => {
  const before = { ...exhaustedFit, source: 'vllm-tokenizer', available: -5000 };
  const partial = { ...before, estimate: { tokens: 9800 }, available: -500 };
  const ready = { ...improvedFit, source: before.source };
  const f = fixture({ before, after: [partial, ready] });
  assert.deepEqual(await f.recover(), { kind: 'retry' });
  assert.equal(f.compactions.length, 2);
  const stalled = fixture({ before, after: [partial, partial] });
  assert.equal(await stalled.recover(), stalled.next);
  assert.equal(stalled.compactions.length, 2);
});
