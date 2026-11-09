import test from 'node:test';
import assert from 'node:assert/strict';
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { installModelResponseValidation } from '../model-response-validation.mjs';
import { commandEvidence, groundCommandReport, hasFailedCommand, validateCommandClaims } from '../command-evidence.mjs';

test('execution claims require the corresponding action and process outcome; a diagnostic answer needs no success receipt', async () => {
  const failure = commandEvidence({ name: 'pwsh', callId: 'red', arguments: { command: 'python -m unittest' } },
    { value: { kind: 'foreground', exitCode: 1, stdout: { text: 'exit code: 0' } } });
  const write = commandEvidence({ name: 'write', callId: 'edit' }, { value: { path: 'booking.py' } });
  const interrupted = { ...failure, id: 'stopped', exit: 0, interrupted: true };
  assert.equal(hasFailedCommand([failure]), true);
  assert.equal(commandEvidence({ name: 'pwsh' }, { value: { kind: 'promoted' } }), undefined);
  assert.equal(commandEvidence({ name: 'write' }, { isError: true }), undefined);
  assert.equal(validateCommandClaims({ changes: ['unknown'], successes: ['red'] }, [failure]), false);
  assert.equal(validateCommandClaims({ changes: ['edit'], successes: ['stopped'] }, [write, interrupted]), false);
  assert.equal(validateCommandClaims({ changes: [], successes: [] }, [failure]), true);
  const honest = [{ type: 'text-delta', index: 0, text: 'The test still fails.' },
    { type: 'finish', reason: { kind: 'stop' } }];
  const streamed = [];
  for await (const chunk of groundCommandReport(honest, [failure], async () => true)) streamed.push(chunk);
  assert.deepEqual(streamed, honest);
});

function fixture() {
  let handler;
  const agents = new Map([['root', { session: { header: { origin: 'new' } } }], ['child', { session: { header: { origin: 'subagent' } } }]]);
  const input = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'User request' }] };
  const options = (origin = 'root', source = 'user') => ({ sessionId: origin, messages: [{ ...input, source: { kind: source } },
    { role: 'user', source: { kind: 'agent-instructions', form: 'instructions' }, content: [] },
    { role: 'user', source: { kind: 'runtime-context', form: 'snapshot' }, content: [] },
    { role: 'user', source: { kind: 'skill-catalog', form: 'catalog' }, content: [] },
    { role: 'user', source: { kind: 'model-selection', form: 'notice' }, content: [] }] });
  const dispose = installModelResponseValidation({ agents, on(name, callback) {
    assert.equal(name, 'llm/stream'); handler = callback; return () => {};
  } });
  return { stream: (chunks, agent = true, origin = 'root', source = 'user') => handler(agent ? markAgentLoopRequest(options(origin, source)) : {}, async function* () { yield* chunks; }), handler, options, dispose };
}
const reasoning = { type: 'reasoning-delta', text: 'Private reasoning and protocol-looking <|close|>response<|sep|> text.' };
const stop = { type: 'finish', reason: { kind: 'stop' }, usage: { outputTokens: 3 } };
const tool = { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' } };

test('only direct-user root stops without text or structured tool progress enter native empty-response recovery', async t => {
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
    { name: 'child-native-settlement', chunks: [reasoning, stop], origin: 'child' },
    { name: 'parent-relay', chunks: [reasoning, stop], source: 'agent-message' },
    { name: 'parent-settlement', chunks: [reasoning, stop], source: 'subagent-settled' },
    { name: 'other-native-input', chunks: [reasoning, stop], source: 'goal-round' },
    { name: 'unknown-native-input', chunks: [reasoning, stop], source: 'future-native-producer' },
    { name: 'unowned-auxiliary-session', chunks: [reasoning, stop], origin: 'missing' },
  ]) await t.test(scenario.name, async () => {
    const received = []; for await (const chunk of f.stream(scenario.chunks, scenario.agent, scenario.origin, scenario.source)) received.push(chunk);
    assert.strictEqual(received[0], reasoning);
    if (scenario.empty) {
      assert.equal(received.at(-1).reason.kind, 'error');
      assert.equal(received.at(-1).reason.failure.code, 'EMPTY_RESPONSE');
      assert.strictEqual(received.at(-1).usage, stop.usage);
      assert.deepEqual(received.slice(0, -1), scenario.chunks.slice(0, -1));
    } else assert.deepEqual(received, scenario.chunks);
  });
});

test('other native notices after historical human input retain upstream completion authority', async () => {
  const f = fixture();
  for (const source of [{kind:'agent-message',form:'relay'}, {kind:'subagent-settled',form:'notice'}, {kind:'future-native-producer',form:'notice'}]) {
    const options = f.options();
    options.messages.push({role:'user',source,content:[]});
    const chunks=[];
    for await (const chunk of f.handler(markAgentLoopRequest(options),async function*(){yield reasoning;yield stop;})) chunks.push(chunk);
    assert.strictEqual(chunks.at(-1),stop);
  }
  f.dispose();
});

test('validation forwards reasoning immediately and keeps concurrent response state isolated', async () => {
  const f = fixture();
  const gate = Promise.withResolvers();
  const iterator = f.handler(markAgentLoopRequest(f.options()), async function* () {
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
