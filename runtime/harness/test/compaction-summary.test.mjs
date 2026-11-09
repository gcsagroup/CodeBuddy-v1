import test from 'node:test';
import assert from 'node:assert/strict';
import CompactionEngine, { checkpointFileReferences, includeFileReferences, installCompactionRequestCompatibility } from '../compaction.mjs';

test('file references survive repeated checkpoints, using paired successful filesystem receipts from the selected span only', () => {
  const events = [];
  function read(path, extra = {}) {
    const seq = events.length;
    events.push({ type: 'tool/call', data: { name: 'read', callId: String(seq), ...extra.call } },
      { type: 'tool/result', sourceEventSeqs: [seq], data: {
        message: { toolCallId: String(seq), isError: false, ...extra.message },
        meta: { path, lines: [{ number: 37, text: 'private row' }, { number: 45 }] },
      } });
    return seq + 1;
  }
  const first = read('data/input.tsv');
  const failed = read('failed', { message: { isError: true } });
  const foreign = read('mcp-output', { call: { name: 'mcp__external__read' } });
  const mismatch = read('unpaired', { message: { toolCallId: 'different' } });
  read('outside-selection');
  events.push({ type: 'user/message', data: { source: { kind: 'compact-checkpoint' } },
    sourceEventSeqs: [first, failed, foreign, mismatch] });
  const checkpoint = events.length - 1;
  const recent = Array.from({ length: 12 }, (_, n) => read('file-' + n));
  const session = { eventAt: seq => events[seq] };
  const seqs = [checkpoint, ...recent];
  const refs = checkpointFileReferences(session, seqs);
  assert.deepEqual(refs, [ 'data/input.tsv', ...recent.slice(-7).map((_, n) => 'file-' + (5 + n)) ]
    .map(path => ({ path, lines: [37, 45] })));
  const base = { role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'Original summary' }] };
  const meter = { estimateMessage: m => m.content.reduce((n, block) => n + block.text.length, 0) };
  assert.strictEqual(includeFileReferences(base, session, seqs, 100, meter), base);
  const enriched = includeFileReferences(base, session, seqs, 220, meter);
  assert.ok(meter.estimateMessage(enriched) < 220);
  assert.match(enriched.content.at(-1).text, /data\/input\.tsv/);
  assert.doesNotMatch(enriched.content.at(-1).text, /private row/);
});

function fixture(reason = { kind: 'stop' }) {
  let request;
  const owner = {
    pressureAttempts: new WeakMap(),
    config: { modelPolicies: [], summarizationProvider: '', summarizationModel: '', maxTokens: 4096 },
    ctx: { llm: { async *stream(options) {
      request = options;
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Keep API A. Rate 750 bps supersedes 500. Do not publish. Remaining: verify.' } };
      yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 25 } };
      yield { type: 'finish', reason };
    } } },
  };
  const route = { provider: 'fixture', model: 'same-model' };
  const history = new Map();
  const agent = { options: route, session: { id: 'fixture-session', requestHeader: () => ({ config: route }), toolHistory: () => history } };
  const input = Object.freeze({
    tools: Object.freeze([{ name: 'read', parameters: { type: 'object' } }]),
    messages: Object.freeze([
      Object.freeze({ role: 'system', content: [{ type: 'text', text: 'System contract.' }] }),
      Object.freeze({ role: 'user', content: [{ type: 'text', text: 'Keep API A. Rate 500 bps. Do not publish.' }] }),
      Object.freeze({ role: 'user', content: [{ type: 'text', text: 'Correction: 750 bps supersedes 500. Verify before completion.' }] }),
    ]),
  });
  return { input, agent, history, request: () => request, summarize: signal => CompactionEngine.prototype.summarize.call(owner, input, agent, signal) };
}

test('native summary keeps the complete replay prefix, tools, route and full output budget', async () => {
  const f = fixture(), signal = new AbortController().signal;
  const before = structuredClone(f.input);
  const result = await f.summarize(signal), request = f.request();
  assert.deepEqual(f.input, before);
  assert.deepEqual(request.messages.slice(0, f.input.messages.length), f.input.messages);
  for (let i = 0; i < f.input.messages.length; i++) assert.strictEqual(request.messages[i], f.input.messages[i]);
  assert.equal(request.messages.length, f.input.messages.length + 1, 'only the native summarization directive follows the unchanged replay prefix');
  assert.deepEqual(request.tools, f.input.tools);
  assert.strictEqual(request.toolHistory, f.history);
  assert.strictEqual(request.signal, signal);
  assert.equal(request.model, 'same-model');
  assert.equal(request.maxTokens, 4096);
  assert.equal(request.purpose, 'compaction');
  assert.equal(result.llmStreamCall, true);
  assert.deepEqual(result.summary, result.rawOutput);
  assert.equal(result.usage.outputTokens, 25);
});

test('native summary validation still rejects truncated and cancelled output', async () => {
  for (const [reason, code] of [
    [{ kind: 'max-tokens' }, 'MAX_TOKENS'],
    [{ kind: 'aborted', failure: { code: 'ABORTED', message: 'Cancelled' } }, 'ABORTED'],
    [{ kind: 'error', failure: { code: 'RATE_LIMIT', message: 'Wait' } }, 'RATE_LIMIT'],
  ]) await assert.rejects(fixture(reason).summarize(), { code });
});

test('compaction inherits only the matching current route and dispatches once without mutating input', () => {
  const route = { provider: 'p', model: 'm', reasoningEffort: 'high' };
  const agent = { options: { ...route }, session: { requestHeader: () => ({ config: route }) } };
  const sent = []; let handler, effort, pending = null;
  const ctx = {
    agents: { get: id => id === 's' ? agent : undefined },
    sessionProjections: { stateOf: () => ({ pending }) },
    on: (_name, callback) => { handler = callback; return () => {}; },
    llm: { stream: options => handler(options, () => { sent.push(options); return options; }) },
  };
  installCompactionRequestCompatibility(ctx, () => effort);
  const original = Object.freeze({ purpose: 'compaction', sessionId: 's', provider: 'p', model: 'm', maxTokens: 4096, messages: [] });
  const inherited = ctx.llm.stream(original);
  assert.equal(sent.length, 1);
  assert.equal(inherited.reasoningEffort, 'high');
  assert.equal(original.reasoningEffort, undefined);
  assert.strictEqual(inherited.messages, original.messages);
  assert.equal(inherited.maxTokens, original.maxTokens);
  for (const request of [
    { ...original, purpose: undefined },
    { ...original, sessionId: 'missing' },
    { ...original, model: 'different-summary-model' },
    { ...original, reasoningEffort: 'low' },
  ]) assert.strictEqual(ctx.llm.stream(request), request);
  effort = 'low';
  assert.strictEqual(ctx.llm.stream(original), original, 'new session control must not inherit a stale header');
  effort = undefined; agent.options.model = 'creation-time-model';
  assert.equal(ctx.llm.stream(original).reasoningEffort, 'high', 'creation-time defaults do not override the routed selection');
  pending = { ...route, model: 'new-model' };
  assert.strictEqual(ctx.llm.stream(original), original, 'model switch must not revive a stale route');
  pending = { provider: route.provider, model: route.model };
  assert.strictEqual(ctx.llm.stream(original), original, 'pending provider-default reset must not inherit old reasoning');
  effort = 'high';
  assert.equal(ctx.llm.stream(original).reasoningEffort, 'high', 'current host request override also applies over a pending provider default');
});
