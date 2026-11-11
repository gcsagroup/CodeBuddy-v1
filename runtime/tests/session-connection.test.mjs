import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionConnection, clientDisconnectedError } from '../session-connection.mjs';

const client = (id, ask = async () => ({ allowed: true })) => ({ sessionIds: new Set([id]), received: [],
  notify(method, params) { this.received.push({ method, params }); }, ask });

test('delivery fans out once only to observers of this session and survives loss of its origin', async () => {
  const a = client('pet'), b = client('pet'), other = client('other');
  const observers = new Set([a, b, other]), controller = new AbortController();
  const connection = createSessionConnection({ sessionId: 'pet', initial: a, observers: () => observers, signal: controller.signal });
  observers.delete(a); connection.detach(a); connection.attach(b);
  connection.notify('session/update', { sessionId: 'pet' });
  assert.equal(b.received.length, 1); assert.equal(a.received.length, 0); assert.equal(other.received.length, 0);
  assert.equal(controller.signal.aborted, false);
  connection.dispose();
});

test('a disconnected approval waits and is presented on the loaded replacement without executing twice', async () => {
  const gone = Promise.withResolvers(), requested = Promise.withResolvers();
  const a = client('pet', async () => { requested.resolve(); return gone.promise; });
  let decisions = 0;
  const b = client('pet', async (method, params) => { decisions++; assert.equal(params.callId, 'original'); return { allowed: true }; });
  const observers = new Set([a]);
  const connection = createSessionConnection({ sessionId: 'pet', initial: a, observers: () => observers });
  let finished = false;
  const pending = connection.ask('session/request_permission', { callId: 'original' }).then(reply => { finished = true; return reply; });
  await requested.promise;
  observers.delete(a); connection.detach(a); gone.reject(clientDisconnectedError());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'disconnect is neither consent nor denial');
  observers.add(b); connection.attach(b);
  assert.deepEqual(await pending, { allowed: true }); assert.equal(decisions, 1);
  connection.dispose();
});

test('native question deadlines and explicit task stop abort detached waits', async () => {
  for (const stopTask of [false, true]) {
    const a = client('pet'), observers = new Set(), task = new AbortController(), question = new AbortController();
    const connection = createSessionConnection({ sessionId: 'pet', initial: a, observers: () => observers, signal: task.signal });
    const pending = connection.ask('elicitation/create', {}, question.signal);
    const reason = new Error(stopTask ? 'explicit stop' : 'native question expired');
    (stopTask ? task : question).abort(reason);
    await assert.rejects(pending, error => error === reason);
    connection.dispose();
  }
});

test('an uncertain browser action is never resent to a new connection', async () => {
  const a = client('pet', async () => { throw clientDisconnectedError(); });
  const observers = new Set([a]);
  const connection = createSessionConnection({ sessionId: 'pet', initial: a, observers: () => observers });
  await assert.rejects(connection.ask('_codebuddy/browser/control', { action: 'click' }), { code: 'ACP_CLIENT_DISCONNECTED' });
  connection.dispose();
});
