import { replyToNoActionReview } from './review-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessDriver } from '../index.mjs';

test('native retry owns recovery, exhaustion, cancellation and later turns for empty completions', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-empty-recovery-'));
  await writeFile(path.join(root, 'AGENTS.md'), 'Use concise replies and follow the current user request.');
  const counts = new Map(), lengthRequests = [];
  const childEnded = Promise.withResolvers();
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    if (replyToNoActionReview(request, res)) return;
    // Match the fixture input, not a quoted tool argument in receipt context.
    const fixtureInput = request.messages.filter(message => message.role === 'user').flatMap(message =>
      typeof message.content === 'string' ? [message.content] : (message.content ?? []).map(part => part.text ?? '')
    ).findLast(text => /(?:^|\n)empty_fixture_(recover|exhaust|cancel|length|normal|parent|child)/.test(text));
    const marker = /empty_fixture_(recover|exhaust|cancel|length|normal|parent|child)/.exec(fixtureInput)?.[1];
    assert.ok(marker, 'Expected a fixture input outside quoted receipt data');
    const count = (counts.get(marker) ?? 0) + 1; counts.set(marker, count);
    if (marker === 'length') lengthRequests.push(request);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'fixture', model: request.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
    send({ reasoning: 'Reasoning stays private; a written tool proposal is not an invocation.' });
    if (marker === 'parent') {
      let call;
      if (!request.tools.some(tool => tool.function.name === 'subagent'))
        call = { id: 'discover-child', name: 'search_mcp_tools', args: { names: ['subagent'] } };
      else if (!request.messages.some(message => message.role === 'tool' && message.tool_call_id === 'spawn-child'))
        call = { id: 'spawn-child', name: 'subagent', args: { description: 'Empty-response recovery fixture', prompt: 'empty_fixture_child' } };
      else { await childEnded.promise; send({ content: 'Parent received the recovered child.' }); }
      if (call) send({ tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
      send({}, call ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n'); return;
    }
    if (marker === 'normal' || (['recover', 'child'].includes(marker) && count > 1)) send({ content: 'Actual answer after the provider response.' });
    send({}, marker === 'length' ? 'length' : 'stop', marker === 'length'
      ? { prompt_tokens: 100, completion_tokens: 128, total_tokens: 228 } : undefined);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function session(delay = 1, options = {}) {
    return driver.createSession({ cwd: root, provider: {
      id: 'empty-response-fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key',
      // Short waits are isolated test policy; the product's provider policy is unchanged.
      retryPolicy: { mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: delay, maxDelayMs: delay, jitterRatio: 0 } },
    }, model: 'fixture', options: { mcpServers: [], ...options } });
  }
  await t.test('one empty response recovers through one durable native retry', async () => {
    const s = await session(); const events = [];
    assert.equal((await driver.prompt(s.sessionId, 'empty_fixture_recover', { onEvent: event => events.push(event) })).stopReason, 'end_turn');
    assert.equal(counts.get('recover'), 2);
    assert.equal(events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), 'Actual answer after the provider response.');
    assert.deepEqual(events.filter(e => e.type === 'assistant_committed').map(e => e.hasText), [true], 'only the recovered successful response is committed');
    const history = await driver.history(s.sessionId);
    assert.deepEqual(history.events.filter(e => e.type === 'llm/retry').map(e => e.data.failure.code), ['EMPTY_RESPONSE']);
    assert.equal(history.events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'completed');
    assert.equal((await driver.prompt(s.sessionId, 'empty_fixture_normal')).stopReason, 'end_turn');
    assert.equal(counts.get('normal'), 1, 'the next normal turn has no stale retry state');
  });
  await t.test('persistent emptiness obeys the provider retry cap and fails honestly', async () => {
    const s = await session();
    await assert.rejects(driver.prompt(s.sessionId, 'empty_fixture_exhaust'), { code: 'EMPTY_RESPONSE' });
    assert.equal(counts.get('exhaust'), 3, 'one initial request plus exactly two native retries');
    const history = await driver.history(s.sessionId);
    assert.equal(history.events.filter(e => e.type === 'llm/retry').length, 2);
    assert.equal(history.events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'error');
    assert.equal((await driver.prompt(s.sessionId, 'empty_fixture_normal')).stopReason, 'end_turn', 'a new user turn is usable after retry exhaustion');
  });
  await t.test('cancelling native backoff sends no second request', async () => {
    const s = await session(5000); const controller = new AbortController();
    const result = await driver.prompt(s.sessionId, 'empty_fixture_cancel', { signal: controller.signal, onEvent(event) {
      if (event.type === 'harness_event' && event.event.type === 'llm/retry') controller.abort();
    } });
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(counts.get('cancel'), 1);
    assert.equal((await driver.prompt(s.sessionId, 'empty_fixture_normal')).stopReason, 'end_turn', 'a cancelled backoff must not poison the next turn');
  });
  await t.test('reasoning cut short by a token limit uses bounded output recovery, not empty-response retries', async () => {
    const s = await session(1, { maxTokens: 128 });
    const result = await driver.prompt(s.sessionId, 'empty_fixture_length');
    assert.equal(result.stopReason, 'max_tokens');
    assert.equal(counts.get('length'), 2, 'one initial request and one recovery for the same native step');
    assert.deepEqual(lengthRequests.map(request => request.max_completion_tokens ?? request.max_tokens), [128, 128], 'recovery preserves the selected request cap');
    assert.deepEqual([result.outputLimit.automaticAttempts, result.outputLimit.maxAutomaticAttempts], [1, 2]);
    const history = await driver.history(s.sessionId);
    const attempts = history.events.filter(event => event.type === 'assistant/attempt');
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every(event => event.data.stream.findLast(record => record.type === 'chunk' && record.chunk.type === 'finish').chunk.reason.failure.code === 'OUTPUT_LIMIT_REACHED'), 'both failed generations retain the specific length reason');
    assert.equal(history.events.filter(event => event.type === 'assistant/message').length, 0, 'truncated reasoning is never committed as an answer');
    assert.equal(history.events.filter(event => event.type === 'plugin:codebuddy/output-recovery').length, 1, 'the recovery allowance is committed once');
    assert.equal(history.events.filter(event => event.type === 'llm/retry').length, 0, 'length recovery does not consume or borrow native network retries');
  });
  await t.test('a native child keeps upstream reasoning-only completion semantics and its parent can finish', async () => {
    const s = await session(); const events = [];
    const result = await driver.prompt(s.sessionId, 'empty_fixture_parent', { onPermission: async () => true, onEvent(event) {
      events.push(event); if (event.type === 'subagent_end') childEnded.resolve();
    } });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(counts.get('child'), 1, 'Child completion belongs to DSH, not the direct-user answer compatibility check');
    const retries = events.filter(e => e.type === 'harness_event' && e.event.type === 'llm/retry');
    assert.equal(retries.length, 0);
    const child = events.find(event => event.type === 'subagent_end');
    assert.equal(child.stopReason, 'completed');
    assert.equal(child.lastAssistantMessage.some(block => block.type === 'text'), false, 'Do not manufacture a child closing message from reasoning');
  });
});
