import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionReceiptContext } from '../harness/command-evidence.mjs';
import { createHarnessDriver } from '../harness/index.mjs';

const turn = (n, type = 'turn/start') => ({ type, data: { turn: n, ...(type === 'turn/end' ? { reason: { kind: 'completed' } } : {}) } });
const call = (id, args) => ({ type: 'tool/call', data: { callId: id, name: 'pwsh', arguments: JSON.stringify(args) } });
const result = (id, isError = false) => ({ type: 'tool/result', data: { message: { toolCallId: id, isError, content: [{ type: 'text', text: isError ? 'aborted' : 'observed output' }] } } });
const facts = text => JSON.parse(text.slice(text.indexOf('\n') + 1));

test('receipt context scopes current work, preserves prior returns, and never promotes proposals or prose', () => {
  const log = [turn(1), call('old', { command: 'increment-once' }), result('old'), turn(1, 'turn/end'), turn(2),
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'All tests passed' }] } } },
    call('pending', { command: 'not returned yet' }), call('error', { command: 'interrupted' }), result('error', true)];
  // The same input is used after reload: no ephemeral cache is needed.
  const context = executionReceiptContext({ log: structuredClone(log) });
  const value = facts(context);
  assert.equal(value.currentTurn.turn, 2);
  assert.deepEqual(value.currentTurn.tools.recent.map(r => [r.callId, r.state, r.isError]), [['pending', 'pending', undefined], ['error', 'returned', true]]);
  assert.equal(value.previousTurn.tools.recent[0].callId, 'old');
  assert.equal(value.previousTurn.tools.recent[0].state, 'returned');
  assert.equal(value.previousTurn.terminalReason, 'completed');
  assert(!context.includes('All tests passed'));
  assert(!('exit' in value.previousTurn.tools.recent[0]));
  assert.equal(facts(executionReceiptContext({ log: [turn(1)] })).currentTurn.tools.total, 0);
  assert.equal(facts(executionReceiptContext({ log: [turn(1)] })).previousTurn, undefined);
});

test('receipt index does not duplicate large tool arguments or outputs', () => {
  const log = [turn(1)];
  for (let n = 0; n < 100; n += 1) {
    log.push(call(String(n), { command: 'LARGE_COMMAND_MARKER' + 'x'.repeat(200000) }));
    const returned = result(String(n));
    returned.data.message.content[0].text = 'LARGE_OUTPUT_MARKER' + 'y'.repeat(200000);
    log.push(returned);
  }
  const text = executionReceiptContext({ log }, [{ id: '99', tool: 'pwsh', exit: 0,
    command: 'LARGE_COMMAND_MARKER', output: 'LARGE_OUTPUT_MARKER' }]);
  assert(text.length < 8000);
  assert(!text.includes('LARGE_COMMAND_MARKER'));
  assert(!text.includes('LARGE_OUTPUT_MARKER'));
  assert.equal(facts(text).currentTurn.tools.total, 100);
  assert.equal(facts(text).currentTurn.structuredResults[0].exit, 0);
});

test('native requests see empty current receipts before work and real receipts after tools and on follow-up', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-receipt-context-'));
  const source = join(root, 'source.txt'), target = join(root, 'target.txt');
  await writeFile(source, 'existing work');
  const requests = [], errors = [];
  let driver;
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'receipt-context', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      const n = requests.length;
      if (n === 1 || n === 3) {
        const name = n === 1 ? 'read' : 'write';
        const args = n === 1 ? { file_path: source } : { file_path: target, content: 'follow-up only' };
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: `tool-${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); emit({}, 'tool_calls');
      } else { emit({ role: 'assistant', content: n === 5 ? 'An explanation only.' : 'Observed result.' }); emit({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    } catch (e) { errors.push(e); res.destroy(e); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await driver?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  const { sessionId } = await driver.createSession({ provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture', contextWindow: 65536 }, model: 'fixture' });
  await driver.prompt(sessionId, 'Read the existing file once.', { onPermission: () => true });
  await driver.prompt(sessionId, 'Add the new file, retaining existing work.', { onPermission: () => true, queuedWhileBusy: true });
  await driver.prompt(sessionId, 'Explain the result only; no edits.', { onPermission: () => true });
  assert.deepEqual(errors, []);
  assert.equal(requests.length, 5);
  const context = request => {
    const texts = request.messages.flatMap(m => typeof m.content === 'string' ? [m.content] : (m.content ?? []).filter(c => c.type === 'text').map(c => c.text));
    const text = texts.findLast(text => text.includes('Execution receipts for this session'));
    assert(text, 'receipt context reached the real native request');
    assert.equal(texts.filter(text => text.includes('Execution receipts for this session')).length, 1,
      'each request has one current receipt index, not a history of receipt snapshots');
    assert(request.messages.some(message => message.role === 'system' &&
      JSON.stringify(message.content).includes('Execution receipts for this session')));
    return JSON.parse(text.match(/\{(?:"inputOrigin"|"currentTurn"):.*\}/s)[0]);
  };
  assert.equal(context(requests[0]).currentTurn.tools.total, 0);
  assert.equal(context(requests[1]).currentTurn.tools.recent[0].tool, 'read');
  assert.equal(context(requests[2]).currentTurn.tools.total, 0);
  assert.equal(context(requests[2]).inputOrigin, 'queued-while-busy');
  assert.equal(context(requests[2]).previousTurn.tools.recent[0].tool, 'read');
  assert.equal(context(requests[3]).currentTurn.tools.recent[0].tool, 'write');
  assert.equal(context(requests[4]).currentTurn.tools.total, 0);
  assert.equal(context(requests[4]).inputOrigin, undefined, 'queue origin cannot leak into later direct input');
  assert.equal(context(requests[4]).previousTurn.tools.recent[0].tool, 'write');
  assert.equal(await readFile(target, 'utf8'), 'follow-up only');
});
