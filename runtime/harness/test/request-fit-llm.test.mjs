import test from 'node:test';
import assert from 'node:assert/strict';
await import('../sdk-budget-contract.mjs');
const { Context } = await import('@deepseek-ai/cordis');
const { default: Llm, LlmAdapter, LlmError } = await import('@deepseek-ai/dsh-llm');

const messages = text => [{ role: 'user', content: [{ type: 'text', text }] }];
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const failureOf = chunks => chunks.findLast(chunk => chunk.type === 'finish')?.reason.failure;

async function fixture(t, { prepared = true, code = 'OUTPUT_TRUNCATED', throws = false, fitFor, success = false, reasoning = false } = {}) {
  const observed = [], dispatched = [];
  let serial = 0;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { ...await super.resolveModel(provider, model), ...(reasoning ? { reasoning: { efforts: [{ id: 'medium', name: 'Medium' }], defaultEffort: 'medium' } } : {}) };
    }
    async prepareCall(provider, model) {
      const call = await super.prepareCall(provider, model);
      return prepared ? { ...call, prepareRequest: async options => {
        observed.push(options);
        const requestId = `fit-${++serial}`;
        const fit = Object.freeze({ requestId, provider, model, estimate: { tokens: options.messages[0].content[0].text.length }, ...fitFor?.(options) });
        return { fit, stream: async function* () {
          dispatched.push(options);
          if (success) { yield { type: 'finish', reason: { kind: 'stop' } }; return; }
          if (throws) throw new LlmError('Fixture failure', code, { requestId });
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Fixture failure', code, requestId } } };
        } };
      } } : call;
    }
    async *stream(options) { observed.push(options); yield { type: 'finish', reason: { kind: 'stop' } }; }
  }
  const ctx = new Context();
  const plugin = ctx.plugin(Llm); await plugin;
  const adapter = new Adapter();
  const registration = ctx.llm.registerAdapter(['fixture'], adapter);
  t.after(() => plugin.dispose());
  const options = extra => ({ provider: 'fixture', model: 'old-model', sessionId: 'test-session', maxTokens: 128, messages: messages('Original envelope'), tools: [{ name: 'receipt', description: 'original tools', parameters: { type: 'object' } }], ...extra });
  return { ctx, adapter, registration, options, observed, dispatched };
}

test('adapters without prepared fit retain the existing streaming contract', async t => {
  const f = await fixture(t, { prepared: false });
  const options = f.options();
  const prepared = await f.ctx.llm.prepareCall(options);
  const chunks = await collect(prepared.stream(options));
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.strictEqual(f.observed[0].messages, options.messages);
  assert.deepEqual(f.observed[0].tools, options.tools);
  assert.equal(f.ctx.llm.requestFitRecovery({ code: 'OUTPUT_TRUNCATED', requestId: 'unknown' }), undefined);
});

test('persistable failure correlates to a one-use fit and remeasures the original routed envelope', async t => {
  const f = await fixture(t);
  const options = f.options();
  const prepared = await f.ctx.llm.prepareCall(options);
  const failure = structuredClone(failureOf(await collect(prepared.stream(options))));
  const recovery = f.ctx.llm.requestFitRecovery(failure);
  assert.ok(recovery);
  assert.equal(f.ctx.llm.requestFitRecovery(failure), undefined);
  assert.deepEqual(Object.keys(failure).sort(), ['code', 'message', 'requestId']);
  f.registration();
  const replacement = new LlmAdapter();
  f.ctx.llm.registerAdapter(['fixture'], replacement);
  const reduced = messages('Short'), toolHistory = new Map();
  const after = await recovery.measure({ messages: reduced, toolHistory, signal: new AbortController().signal });
  assert.ok(after.estimate.tokens < recovery.fit.estimate.tokens);
  assert.equal(f.observed.length, 2);
  const measured = f.observed[1];
  assert.equal(measured.provider, options.provider);
  assert.equal(measured.model, options.model);
  assert.equal(measured.maxTokens, 128);
  assert.strictEqual(measured.messages, reduced);
  assert.strictEqual(measured.tools, options.tools);
  assert.strictEqual(measured.toolHistory, toolHistory);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(recovery.measure({ messages: reduced, toolHistory, signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(f.observed.length, 2, 'cancelled recovery must not even prepare another adapter request');
});

test('thrown local errors retain fit, while auxiliary calls and unrelated failures do not', async t => {
  const thrown = await fixture(t, { code: 'LOCAL_OUTPUT_BUDGET_EXHAUSTED', throws: true });
  const failure = failureOf(await collect(thrown.ctx.llm.stream(thrown.options())));
  assert.equal(failure.code, 'LOCAL_OUTPUT_BUDGET_EXHAUSTED');
  assert.ok(thrown.ctx.llm.requestFitRecovery(structuredClone(failure)));
  const auxiliary = failureOf(await collect(thrown.ctx.llm.stream(thrown.options({ purpose: 'compaction' }))));
  assert.equal(thrown.ctx.llm.requestFitRecovery(auxiliary), undefined);
  const other = await fixture(t, { code: 'RATE_LIMIT', throws: true });
  const transportFailure = failureOf(await collect(other.ctx.llm.stream(other.options())));
  assert.equal(other.ctx.llm.requestFitRecovery(transportFailure), undefined);
});

test('the next request for a session releases an unconsumed old failure envelope', async t => {
  const f = await fixture(t);
  const oldFailure = failureOf(await collect(f.ctx.llm.stream(f.options())));
  const current = failureOf(await collect(f.ctx.llm.stream(f.options({ messages: messages('Next request') }))));
  assert.equal(f.ctx.llm.requestFitRecovery(oldFailure), undefined);
  assert.ok(f.ctx.llm.requestFitRecovery(current));
});

test('summary full-fit preflight is scoped, consumes no stream and resumes the same adapter and reasoning envelope', async t => {
  const f = await fixture(t, { success: true, reasoning: true, fitFor: options => ({
    desiredMaxTokens: 4096, effectiveMaxTokens: options.messages[0].content[0].text.length > 5 ? 548 : 4096,
  }) });
  let reasoningReentries = 0;
  f.ctx.on('llm/stream', (options, next) => {
    if (options.purpose !== 'compaction' || options.reasoningEffort !== undefined) return next();
    reasoningReentries++;
    return f.ctx.llm.stream({ ...options, reasoningEffort: 'medium' });
  });
  const failure = failureOf(await collect(f.ctx.llm.stream(f.options({ purpose: 'compaction', maxTokens: 4096 }))));
  assert.equal(failure.code, 'COMPACTION_OUTPUT_BUDGET_EXHAUSTED');
  assert.deepEqual(Object.keys(failure).sort(), ['code', 'message', 'requestId']);
  assert.equal(f.dispatched.length, 0, 'a clamped summary must not consume its prepared stream');
  assert.equal(f.ctx.llm.requestFitRecovery(failure), undefined, 'main recovery cannot consume an auxiliary fit');
  assert.equal(f.ctx.llm.requestFitRecovery(failure, { purpose: 'compaction', sessionId: 'other-session' }), undefined);
  const scope = { purpose: 'compaction', sessionId: 'test-session' };
  const recovery = f.ctx.llm.requestFitRecovery(failure, scope);
  assert.ok(recovery);
  assert.equal(f.ctx.llm.requestFitRecovery(failure, scope), undefined);
  f.registration();
  f.ctx.llm.registerAdapter(['fixture'], new LlmAdapter());
  const reduced = messages('Small');
  const next = f.options({ purpose: 'compaction', maxTokens: 4096, messages: reduced, toolHistory: new Map(), signal: new AbortController().signal });
  const chunks = await collect(recovery.stream(next));
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.observed.length, 2, 'the captured adapter prepares both candidates even after registry replacement');
  assert.equal(f.observed[1].model, 'old-model');
  assert.equal(f.observed[1].maxTokens, 4096);
  assert.equal(f.observed[1].reasoningEffort, 'medium');
  assert.equal(reasoningReentries, 1, 'resolved reasoning prevents the compatibility shim from losing the bound continuation');
  assert.throws(() => recovery.stream(next), { code: 'INVALID_PREPARED_CALL' });
  const cancelled = new AbortController(); cancelled.abort();
  assert.throws(() => recovery.stream({ ...next, signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(f.observed.length, 2);
});

test('summary continuation rejects native control and schema drift before another preparation', async t => {
  const f = await fixture(t, { success: true, reasoning: true, fitFor: options => ({
    desiredMaxTokens: 4096, effectiveMaxTokens: options.messages[0].content[0].text.length > 5 ? 548 : 4096,
  }) });
  const options = f.options({ purpose: 'compaction', maxTokens: 4096, reasoningEffort: 'medium', stop: ['DONE'] });
  const failure = failureOf(await collect(f.ctx.llm.stream(options)));
  const recovery = f.ctx.llm.requestFitRecovery(failure, { purpose: options.purpose, sessionId: options.sessionId });
  const next = { ...options, messages: messages('Small'), tools: structuredClone(options.tools), stop: [...options.stop] };
  options.provider = 'mutated-after-preparation';
  options.stop[0] = 'MUTATED';
  options.tools[0].parameters.properties = { laterMutation: { type: 'string' } };
  for (const mutation of [
    { provider: 'other-provider' }, { model: 'other-model' }, { maxTokens: 2048 },
    { reasoningEffort: 'high' }, { temperature: 0.5 }, { stop: ['changed'] },
    { sessionId: 'other-session' }, { purpose: 'title' },
    { tools: [{ ...next.tools[0], parameters: { type: 'object', properties: { changed: { type: 'string' } } } }] },
    { tools: undefined },
  ]) assert.throws(() => recovery.stream({ ...next, ...mutation }), { code: 'INVALID_PREPARED_CALL' });
  assert.equal(f.observed.length, 1);
  assert.equal(f.dispatched.length, 0, 'no changed envelope may prepare or consume a request');
  const accepted = await collect(recovery.stream({ ...next, reasoningEffort: undefined }));
  assert.equal(accepted.at(-1).reason.kind, 'stop');
  assert.equal(f.observed[1].reasoningEffort, 'medium');
  assert.equal(f.observed[1].provider, 'fixture');
  assert.deepEqual(f.observed[1].stop, ['DONE']);
  assert.deepEqual(f.observed[1].tools, next.tools, 'a structurally equal cloned tools array remains valid');
  assert.equal(f.dispatched.length, 1);
});

test('a dispatched summary truncation never acquires the local full-fit selection continuation', async t => {
  const f = await fixture(t, { code: 'OUTPUT_TRUNCATED', fitFor: () => ({ desiredMaxTokens: 4096, effectiveMaxTokens: 4096 }) });
  const failure = failureOf(await collect(f.ctx.llm.stream(f.options({ purpose: 'compaction', maxTokens: 4096 }))));
  assert.equal(f.dispatched.length, 1);
  assert.equal(failure.code, 'OUTPUT_TRUNCATED');
  assert.equal(f.ctx.llm.requestFitRecovery(failure, { purpose: 'compaction', sessionId: 'test-session' }), undefined);
});
