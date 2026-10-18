import test from 'node:test';
import assert from 'node:assert/strict';
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { installModelResponseValidation } from '../model-response-validation.mjs';

function fixture() {
  let handler;
  const dispose = installModelResponseValidation({ on(name, callback) {
    assert.equal(name, 'llm/stream'); handler = callback; return () => {};
  } });
  return { stream: (chunks, agent = true) => handler(agent ? markAgentLoopRequest({}) : {}, async function* () { yield* chunks; }), handler, dispose };
}
const reasoning = { type: 'reasoning-delta', text: 'Private reasoning and protocol-looking <|close|>response<|sep|> text.' };
const stop = { type: 'finish', reason: { kind: 'stop' }, usage: { outputTokens: 3 } };
const tool = { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' } };

test('only agent-loop stops without text or structured tool progress enter native empty-response recovery', async t => {
  const f = fixture(); t.after(f.dispose);
  for (const scenario of [
    { name: 'reasoning-only', chunks: [reasoning, stop], empty: true },
    { name: 'whitespace-only', chunks: [reasoning, { type: 'text-delta', text: ' \n' }, stop], empty: true },
    { name: 'real-answer', chunks: [reasoning, { type: 'text-delta', text: 'A real answer.' }, stop] },
    { name: 'text-block-completed', chunks: [reasoning, { type: 'block-end', index: 1, block: { type: 'text', text: 'A real answer.' } }, stop] },
    { name: 'structured-tool', chunks: [reasoning, tool, stop] },
    { name: 'provider-tool-update', chunks: [reasoning, { type: 'block-end', index: 1, block: { type: 'tool-removal', toolName: 'old-tool' } }, stop] },
    { name: 'future-output-block', chunks: [reasoning, { type: 'block-end', index: 1, block: { type: 'future-media', value: 'provider-owned' } }, stop] },
    { name: 'token-budget', chunks: [reasoning, { ...stop, reason: { kind: 'max-tokens' } }] },
    { name: 'cancel', chunks: [reasoning, { ...stop, reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Cancelled' } } }] },
    { name: 'provider-error', chunks: [reasoning, { ...stop, reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'Slow down' } } }] },
    { name: 'auxiliary-stream', chunks: [reasoning, stop], agent: false },
  ]) await t.test(scenario.name, async () => {
    const received = []; for await (const chunk of f.stream(scenario.chunks, scenario.agent)) received.push(chunk);
    assert.strictEqual(received[0], reasoning);
    if (scenario.empty) {
      assert.equal(received.at(-1).reason.kind, 'error');
      assert.equal(received.at(-1).reason.failure.code, 'EMPTY_RESPONSE');
      assert.strictEqual(received.at(-1).usage, stop.usage);
      assert.deepEqual(received.slice(0, -1), scenario.chunks.slice(0, -1));
    } else assert.deepEqual(received, scenario.chunks);
  });
});

test('validation forwards reasoning immediately and keeps concurrent response state isolated', async () => {
  const f = fixture();
  const gate = Promise.withResolvers();
  const iterator = f.handler(markAgentLoopRequest({}), async function* () {
    yield reasoning; await gate.promise; yield stop;
  })[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    assert.strictEqual(first.value, reasoning, 'do not buffer the stream while waiting for its finish');
    const other = [];
    for await (const chunk of f.stream([{ type: 'text-delta', text: 'Another response.' }, stop])) other.push(chunk);
    assert.strictEqual(other.at(-1), stop);
    gate.resolve();
    assert.equal((await iterator.next()).value.reason.failure.code, 'EMPTY_RESPONSE');
  } finally { gate.resolve(); await iterator.return(); f.dispose(); }
});
