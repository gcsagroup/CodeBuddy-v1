import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHarnessDriver } from '../harness/index.mjs';

// A controlled local model keeps both real native loops in flight. This checks
// delivery/cancellation contracts, not model quality or a public agent benchmark.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-steering-children-'));
  const file = join(root, 'checkpoint.txt');
  await writeFile(file, 'original child work preserved');
  const parentReady = Promise.withResolvers(), childReady = Promise.withResolvers();
  const parentReceived = Promise.withResolvers(), childReceived = Promise.withResolvers();
  const relayDelivered = Promise.withResolvers();
  const requests = [], failures = [];
  let parentCalls = 0, childCalls = 0, childId, parentPending, childPending, driver;
  let relaySent = false;
  const textOf = message => typeof message.content === 'string' ? message.content
    : (message.content ?? []).map(part => part.text ?? '').join('\n');
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
    if (replyToNoActionReview(body, res)) return;
      requests.push(body);
      const child = body.messages.some(message => message.role === 'user' && textOf(message).includes('Your parent agent id is'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
        id: randomUUID(), model: body.model, choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      const end = () => res.end('data: [DONE]\n\n');
      const call = (name, args) => {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
        emit({}, 'tool_calls'); end();
      };
      const finish = text => { emit({ role: 'assistant', content: text }); emit({}, 'stop'); end(); };
      if (child && ++childCalls === 1) {
        emit({ role: 'assistant', content: 'Working on the original child task.' });
        childPending = { res, release: () => call('read', { file_path: file }) };
        childReady.resolve();
      } else if (child) {
        finish('CHILD_FINISHED');
      } else if (++parentCalls === 1) {
        call('subagent', { description: 'Child continuity fixture', prompt: 'Read the checkpoint and report.' });
      } else if (parentCalls === 2) {
        emit({ role: 'assistant', content: 'Continuing while the child runs.' });
        parentPending = { res, release: () => call('read', { file_path: file }) };
        parentReady.resolve();
      } else if (!relaySent && body.messages.some(message => message.role === 'user' && textOf(message).includes('REMINDER_AT_NEXT_STEP'))) {
        relaySent = true;
        call('send_message', { agent_id: childId, message: 'RELAY_TO_CHILD: include the checkpoint in your report.' });
      } else {
        finish('PARENT_FINISHED');
        if (relaySent) relayDelivered.resolve();
      }
    } catch (error) { failures.push(error); res.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    parentPending?.res.destroy(); childPending?.res.destroy();
    await driver?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  const { sessionId } = await driver.createSession({
    provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture-only', contextWindow: 32768 },
    model: 'fixture',
  });
  let settled = false;
  const running = driver.prompt(sessionId, 'Start the original task.', {
    onPermission: () => true,
    onEvent: event => {
      if (event.type === 'text_delta') {
        (event.sessionId === sessionId ? parentReceived : childReceived).resolve();
      }
    },
  });
  running.then(() => { settled = true; }, () => { settled = true; });
  await Promise.all([parentReady.promise, childReady.promise]);
  // Server writes alone do not establish that either native loop received text.
  await Promise.all([parentReceived.promise, childReceived.promise]);
  [ { id: childId } ] = await driver.listSubagentChildren(sessionId);
  return { driver, sessionId, childId, running, requests, failures, relayDelivered,
    isSettled: () => settled,
    parentPending, childPending,
  };
}

test('request preemption lets the parent respond while its original child keeps running', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.driver.steer(f.sessionId, 'REMINDER_AT_NEXT_STEP', { requestId: 'preempt-parent', preempt: true });
  await f.relayDelivered.promise;
  assert.equal(f.childPending.res.destroyed, false);
  assert.equal(f.isSettled(), false);
  const parent = await f.driver.history(f.sessionId);
  assert.equal(parent.events.filter(event => event.type === 'user/message' && event.data.source?.rpcId === 'preempt-parent').length, 1);
  assert.equal(parent.events.some(event => event.type === 'assistant/message' && JSON.stringify(event.data.message).includes('Continuing while the child runs.')), false);
  f.childPending.release();
  assert.equal((await f.running).stopReason, 'end_turn');
  const child = await f.driver.history(f.childId);
  assert.equal(child.events.filter(event => event.type === 'turn/start').length, 1);
  assert.ok(child.events.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('original child work preserved')));
  assert.ok(child.events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'));
  assert.deepEqual(f.failures, []);
});

test('native steering keeps parent and child work alive, relays at a step boundary, then admits the next turn', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.driver.steer(f.sessionId, 'REMINDER_AT_NEXT_STEP', { queuedWhileBusy: true });
  assert.equal(f.parentPending.res.destroyed, false, 'steering must not abort the current parent model request');
  assert.equal(f.childPending.res.destroyed, false, 'steering must not abort the child model request');
  const queued = await f.driver.history(f.sessionId);
  assert.ok(queued.events.some(event => event.type === 'agent/inbox/spliced' && event.data.target === 'next-step' && JSON.stringify(event.data).includes('REMINDER_AT_NEXT_STEP')));
  f.parentPending.release();
  await f.relayDelivered.promise;
  const childWaiting = await f.driver.history(f.childId);
  assert.ok(childWaiting.events.some(event => event.type === 'agent/inbox/spliced' && event.data.target === 'next-step' && JSON.stringify(event.data).includes('RELAY_TO_CHILD')));
  assert.equal(f.childPending.res.destroyed, false, 'relaying is not interruption');
  assert.equal(f.isSettled(), false, 'a parent response alone must not finish the owning request while the child works');
  await assert.rejects(f.driver.prompt(f.sessionId, 'Next task.'), /already has an active prompt/);
  f.childPending.release();
  assert.equal((await f.running).stopReason, 'end_turn');
  const child = await f.driver.history(f.childId);
  assert.equal(child.events.filter(event => event.type === 'turn/start').length, 1);
  assert.deepEqual(child.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind), ['completed']);
  assert.ok(child.events.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('original child work preserved')));
  assert.ok(child.events.some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('RELAY_TO_CHILD')));
  const parent = await f.driver.history(f.sessionId);
  assert.ok(parent.events.some(event => event.type === 'system/message' &&
    JSON.stringify(event.data).includes('\\"inputOrigin\\":\\"queued-while-busy\\"')),
    'accepted queued steering exposes its origin in the next native request');
  assert.ok(parent.events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'));
  const turnsBefore = parent.events.filter(event => event.type === 'turn/start').length;
  assert.equal((await f.driver.prompt(f.sessionId, 'Next task.')).stopReason, 'end_turn');
  assert.equal((await f.driver.history(f.sessionId)).events.filter(event => event.type === 'turn/start').length, turnsBefore + 1);
  assert.equal((await f.driver.history(f.childId)).events.filter(event => event.type === 'turn/start').length, 1, 'the next parent task must not restart finished children');
  assert.deepEqual(f.failures, []);
});

test('explicit parent cancellation stops its active child and retains both native histories', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.driver.cancel(f.sessionId);
  assert.equal((await f.running).stopReason, 'cancelled');
  for (const id of [f.sessionId, f.childId]) {
    const history = await f.driver.history(id);
    assert.ok(history.events.some(event => event.type === 'assistant/message'), 'delivered partial work must survive');
    assert.ok(history.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'));
  }
  assert.equal((await f.driver.listSubagentChildren(f.sessionId)).length, 1, 'stopping must not delete the child');
  assert.deepEqual(f.failures, []);
});

test('replacement cancels the running model and admits an ordered batch with independent native identities', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.driver.cancel(f.sessionId);
  assert.equal((await f.running).stopReason, 'cancelled');
  const ids = [randomUUID(), randomUUID()];
  const before = f.requests.length;
  const result = await f.driver.prompt(f.sessionId, 'replacement batch', {
    requestId: ids[0], inputBatch: ids.map((requestId, index) => ({ requestId,
      content: [{ type: 'text', text: `REPLACEMENT_${index}` }] })), onPermission: () => true,
  });
  assert.equal(result.stopReason, 'end_turn');
  const request = f.requests.slice(before).find(row => row.messages.some(message => JSON.stringify(message).includes('REPLACEMENT_0')));
  assert.ok(request);
  const texts = request.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content));
  assert.ok(texts.findIndex(text => text.includes('REPLACEMENT_0')) < texts.findIndex(text => text.includes('REPLACEMENT_1')));
  assert.ok(texts.some(text => text.includes('REPLACEMENT_1')), 'both messages must reach the same first replacement call');
  const accepted = await f.driver.agentInputIds(f.sessionId, { committedOnly: true });
  assert.ok(ids.every(id => accepted.includes(id)));
});

test('failed native batch admission rolls back its own pending inputs and permits explicit retry', {timeout:20000}, async t=>{
 const f=await fixture(t);await f.driver.cancel(f.sessionId);await f.running;
 const ids=[randomUUID(),randomUUID()];
 await assert.rejects(f.driver.prompt(f.sessionId,'invalid batch',{requestId:ids[0],inputBatch:[{requestId:ids[0],content:[{type:'text',text:'REPLACEMENT_0'}]},{requestId:ids[1],content:[]}]}));
 const admitted=await f.driver.agentInputIds(f.sessionId,{currentOnly:true});
 assert.ok(ids.every(id=>!admitted.includes(id)), 'failed batch must not remain queued or consumed');
 const result=await f.driver.prompt(f.sessionId,'retry',{requestId:ids[0],inputBatch:ids.map((requestId,index)=>({requestId,content:[{type:'text',text:`REPLACEMENT_${index}`}]}))});
 assert.equal(result.stopReason,'end_turn');
 const consumed=await f.driver.agentInputIds(f.sessionId,{committedOnly:true});assert.ok(ids.every(id=>consumed.includes(id)));
});
