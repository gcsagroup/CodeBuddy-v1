import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationDriver } from '../conversation-driver.mjs';

test('role recovery queries resolve the native identity after a conversation fork', async () => {
  const calls = [];
  const driver = createConversationDriver({
    mainAgentProfile(id) { calls.push(id); return { name: 'Original role' }; },
    agentInputIds(id) { calls.push(id); return ['original-input']; },
  }, { readSession: () => ({ nativeSessionId: 'native-fork' }) });
  assert.equal(driver.mainAgentProfile('visible-chat').name, 'Original role');
  assert.deepEqual(driver.agentInputIds('visible-chat'), ['original-input']);
  assert.deepEqual(calls, ['native-fork', 'native-fork']);
});

function fixture() {
  const tool = Promise.withResolvers(), started = Promise.withResolvers();
  const calls = [];
  const driver = createConversationDriver({
    async callTool() { started.resolve(); await tool.promise; calls.push('tool'); },
    async prompt() { calls.push('prompt'); return { stopReason: 'end_turn' }; },
  }, { read: () => ({ sessions: [{ id: 's' }] }) });
  return { driver, tool, started, calls };
}

test('first send waits for the already running sidebar tool and reserves admission against more polling', async () => {
  const f = fixture(), polling = f.driver.callTool('s', 'git_status', {});
  await f.started.promise;
  const sending = f.driver.prompt('s', 'hello', {});
  const settled = sending.then(value => ({ value }), error => ({ error }));
  await assert.rejects(f.driver.callTool('s', 'git_status', {}), /active/);
  await assert.rejects(f.driver.withConversationLock('s', () => {}), /active/);
  f.tool.resolve(); await polling;
  const result = await settled;
  assert.equal(result.error, undefined);
  assert.equal(result.value.stopReason, 'end_turn');
  assert.deepEqual(f.calls, ['tool', 'prompt']);
  assert.equal(f.driver.isConversationBusy('s'), false);
});

test('cancel while waiting never submits a model request and keeps the running tool protected', async () => {
  const f = fixture(), polling = f.driver.callTool('s', 'git_status', {});
  await f.started.promise;
  const controller = new AbortController();
  const sending = f.driver.prompt('s', 'hello', { signal: controller.signal });
  controller.abort();
  await assert.rejects(sending, { name: 'AbortError' });
  assert.equal(f.driver.isConversationBusy('s'), true);
  await assert.rejects(f.driver.withConversationLock('s', () => {}), /active/);
  f.tool.resolve(); await polling;
  assert.deepEqual(f.calls, ['tool']);
  assert.equal(f.driver.isConversationBusy('s'), false);
});

test('plan controls resolve the current native fork while a prompt is active', async () => {
  const done = Promise.withResolvers(), calls = [];
  const driver = createConversationDriver({
    prompt: () => done.promise,
    getPlanMode: async id => { calls.push(['get', id]); return { active: true }; },
    setPlanMode: async (id, active) => { calls.push(['set', id, active]); return { active }; },
  }, { readSession: () => ({ nativeSessionId: 'native-fork' }) });
  const running = driver.prompt('product', 'review');
  assert.deepEqual(await driver.getPlanMode('product'), { active: true });
  assert.deepEqual(await driver.setPlanMode('product', false), { active: false });
  assert.deepEqual(calls, [['get', 'native-fork'], ['set', 'native-fork', false]]);
  done.resolve();
  await running;
});
