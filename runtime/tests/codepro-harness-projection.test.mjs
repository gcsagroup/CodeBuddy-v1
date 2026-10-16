import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeProRuns } from '../codepro.mjs';
import { zCodeProRunSnapshot, zGooseSessionNotification_unstable } from '../../ui/sdk/dist/generated/zod.gen.js';

async function fixture(executionOwner = 'harness', options = {}) {
  let state = { codeproRuns: [] };
  const store = {
    read: () => structuredClone(state),
    async update(operation) {
      const draft = structuredClone(state);
      const result = operation(draft);
      state = draft;
      return result;
    },
  };
  const updates = [];
  const runs = new CodeProRuns(store, { ...options, onUpdate: (update) => updates.push(update) });
  await runs.create({ sessionId: 'session', runId: 'run', goal: 'A human request', sourceMessageId: 'message', executionOwner });
  const binding = { sessionId: 'session', runId: 'run' };
  const { attemptId } = await runs.beginAttempt({ ...binding, sourceMessageId: 'message' });
  return { store, runs, updates, binding: { ...binding, attemptId } };
}

const goal = (phase = 'active') => ({ id: 'native-goal', revision: 1, objective: 'Implement multiple modules', phase, maxGoalRounds: 12, activation: phase === 'active' ? 'armed' : 'disarmed' });
const native = (binding, type, seq, data) => ({ ...binding, nativeSessionId: 'native-session', event: { type, seq, time: 1000 + seq, data } });

test('normal Harness response completes without a project plan, receipts or special answer call', async () => {
  const f = await fixture();
  assert.ok(f.updates.every(update => update.notifications.length === 0), 'new chat is not a fabricated tool operation');
  const result = await f.runs.finishHarnessAttempt({ ...f.binding, result: { stopReason: 'end_turn', reason: { kind: 'completed' } } });
  const context = f.runs.context(f.binding);
  assert.equal(result.snapshot.state, 'completed');
  assert.equal(context.completionKind, 'harness_turn');
  assert.equal(context.activeAttempt, null);
  assert.equal(context.executionOwner, 'harness');
  assert.deepEqual(context.receipts, []);
  assert.deepEqual(context.tasks, []);
  assert.deepEqual(context.completionPolicy, { requirePlan: false, requireEvidence: false, requireVerification: false });
  assert.ok(f.updates.every(update => update.notifications.length === 0), 'an ordinary answer is not a recorded tool operation');
  assert.equal(f.updates.at(-1).snapshot.state, 'completed', 'completion still reaches the run projection');
  assert.equal(f.store.read().codeproRuns[0].events.at(-1).eventType, 'harness_attempt_finished', 'the durable terminal event remains present');
  for (const update of f.updates) {
    zCodeProRunSnapshot.parse(update.snapshot);
    for (const notification of update.notifications) zGooseSessionNotification_unstable.parse(notification);
  }
});

test('whole-list native todos are presentation only and never prove the goal is complete', async () => {
  const f = await fixture();
  const todo = native(f.binding, 'todo/write', 5, { todos: [{ content: 'Module A', status: 'completed' }, { content: 'Verify modules', status: 'in_progress' }] });
  await f.runs.recordHarnessEvent(todo);
  await f.runs.recordHarnessEvent(todo);
  assert.equal(f.runs.context(f.binding).planRevision, 1, 'same source event is projected exactly once');
  assert.deepEqual(f.runs.context(f.binding).tasks.map((task) => task.state), ['succeeded', 'running']);
  assert.match(f.runs.planContext(f.binding).plan.content, /\[x\] Module A/);
  await f.runs.recordHarnessEvent(native(f.binding, 'todo/write', 6, { todos: [{ content: 'Verify modules', status: 'completed' }] }));
  await f.runs.recordHarnessEvent(native(f.binding, 'goal/change', 7, { kind: 'goal/change', version: 1, operation: 'create', goal: goal(), roundsStarted: 0 }));
  await f.runs.finishHarnessAttempt({ ...f.binding, result: { reason: { kind: 'completed' } } });
  const context = f.runs.context(f.binding);
  assert.equal(context.state, 'paused', 'goal remains unfinished even when this turn ended');
  assert.equal(context.completionKind, null);
  assert.equal(context.nativeGoal.phase, 'active');
  assert.equal(context.tasks.length, 1, 'official replacement semantics do not invent retained DAG obligations');
  assert.deepEqual(context.receipts, []);
});

test('only a native goal completion projects goal completion and does not fabricate verified_task', async () => {
  const f = await fixture();
  await f.runs.recordHarnessEvent(native(f.binding, 'goal/change', 8, { kind: 'goal/change', version: 1, operation: 'complete', goal: goal('complete'), roundsStarted: 3 }));
  assert.equal(f.runs.context(f.binding).state, 'running', 'closing assistant response still owns the stream');
  await f.runs.finishHarnessAttempt({ ...f.binding, result: { reason: { kind: 'completed' }, goal: goal('complete') } });
  assert.equal(f.runs.context(f.binding).completionKind, 'harness_goal');
  assert.deepEqual(f.runs.context(f.binding).receipts, []);
});

test('a later ordinary response does not claim completion of the session previous goal', async () => {
  const f = await fixture();
  await f.runs.finishHarnessAttempt({ ...f.binding, result: { reason: { kind: 'completed' }, goal: goal('complete') } });
  const context = f.runs.context(f.binding);
  assert.equal(context.state, 'completed');
  assert.equal(context.completionKind, 'harness_turn');
  assert.equal(context.lastReason, 'CodeBuddy turn completed');
});

test('native turn boundaries clear current todos without rewriting their historical snapshots', async () => {
  const f = await fixture();
  await f.runs.recordHarnessEvent(native(f.binding, 'todo/write', 4, { todos: [{ content: 'Earlier round item', status: 'completed' }] }));
  const before = f.store.read().codeproRuns[0].events;
  await f.runs.recordHarnessEvent(native(f.binding, 'turn/start', 5, { turn: 2 }));
  assert.deepEqual(f.runs.context(f.binding).tasks, []);
  assert.equal(f.runs.planContext(f.binding).plan, null);
  assert.deepEqual(f.store.read().codeproRuns[0].events.slice(0, before.length), before);
});

test('transport failure, cancellation and action limits keep distinct native outcomes', async () => {
  for (const [input, expected] of [
    [{ error: Object.assign(new Error('Connection error.'), { code: 'TRANSPORT' }) }, 'failed'],
    [{ result: { reason: { kind: 'error', error: { message: 'Connection error.', code: 'TRANSPORT' } } } }, 'failed'],
    [{ aborted: true, result: { reason: { kind: 'completed' }, goal: goal('complete') } }, 'paused'],
    [{ result: { stopReason: 'max_turns', reason: { kind: 'completed' } } }, 'paused'],
    [{ result: { reason: { kind: 'max-tokens' } } }, 'paused'],
  ]) {
    const f = await fixture();
    await f.runs.finishHarnessAttempt({ ...f.binding, ...input });
    const context = f.runs.context(f.binding);
    assert.equal(context.state, expected);
    assert.equal(context.completionKind, null);
    if (expected === 'failed') assert.deepEqual(context.terminalError, { message: 'Connection error.', code: 'TRANSPORT' });
    for (const notification of f.updates.at(-1).notifications) zGooseSessionNotification_unstable.parse(notification);
  }
});

test('restart preserves uncertain receipts but allows Harness to inspect before continuing', async () => {
  const f = await fixture();
  await f.runs.recordToolStart({ ...f.binding, callId: 'old-write', name: 'write_file' });
  const restarted = new CodeProRuns(f.store);
  await restarted.initialize();
  assert.equal(restarted.context(f.binding).recovery.uncertainEffects, 1);
  const attempt = await restarted.beginAttempt({ ...f.binding, sourceMessageId: 'continue' });
  const resumed = { ...f.binding, attemptId: attempt.attemptId };
  await restarted.recordToolStart({ ...resumed, callId: 'inspect', name: 'read_file' });
  await restarted.recordToolResult({ ...resumed, callId: 'inspect', outcome: 'succeeded', kind: 'read' });
  assert.equal(restarted.context(resumed).recovery.uncertainEffects, 1);
  assert.match(restarted.context(resumed).recoveryInstruction, /Do not replay/);
  await assert.rejects(restarted.recordToolStart({ ...resumed, callId: 'old-write', name: 'write_file' }), /not repeatable/);
  assert.equal(restarted.context(resumed).receipts.length, 1);
});

test('legacy run adoption preserves historical events and no longer requires its task gate', async () => {
  const f = await fixture('legacy');
  await f.runs.recordToolStart({ ...f.binding, callId: 'uncertain-write', name: 'write_file' });
  await f.runs.endAttempt({ ...f.binding, reason: 'Old preview stopped' });
  const before = f.store.read().codeproRuns[0].events;
  const attempt = await f.runs.beginAttempt({ ...f.binding, sourceMessageId: 'new-message', executionOwner: 'harness' });
  assert.deepEqual(f.store.read().codeproRuns[0].events.slice(0, before.length), before);
  assert.equal(f.runs.context(f.binding).executionOwner, 'harness');
  await f.runs.recordToolStart({ ...f.binding, attemptId: attempt.attemptId, taskId: 'not-an-old-plan-id', callId: 'native-observed-tool', name: 'read_file' });
  assert.equal(f.runs.context(f.binding).recovery.uncertainEffects, 1);
});

test('subagent lifecycle records native identities without inventing a coder or task assignment', async () => {
  const f = await fixture();
  const child = { id: 'child-session', runId: 'child-run', provider: 'spawn', local: true };
  await f.runs.recordHarnessEvent(native(f.binding, 'subagent/start', undefined, child));
  await f.runs.recordHarnessEvent(native(f.binding, 'subagent/end', undefined, { ...child, stopReason: 'completed' }));
  assert.equal(f.runs.context(f.binding).nativeWorkers.length, 1);
  assert.equal(f.runs.context(f.binding).nativeWorkers[0].state, 'stopped');
  assert.deepEqual(f.runs.context(f.binding).agents, []);
  assert.deepEqual(f.runs.context(f.binding).tasks, []);
});

test('legacy task and worker controls never mutate native facts or stop the root run', async () => {
  let rootCancellations = 0;
  const f = await fixture('harness', { onCancel: async () => { rootCancellations++; } });
  await f.runs.recordHarnessEvent(native(f.binding, 'todo/write', 4, { todos: [{ content: 'Native work item', status: 'in_progress' }] }));
  await f.runs.recordHarnessEvent(native(f.binding, 'subagent/start', undefined, { id: 'child-session', runId: 'child-run', provider: 'spawn', local: true, role: 'coder' }));
  const before = f.store.read();
  const taskId = f.runs.context(f.binding).tasks[0].taskId;
  for (const action of [
    { type: 'cancel_task', taskId, reason: 'User requested cancellation' },
    { type: 'cancel_branch', rootTaskId: taskId, reason: 'User requested cancellation' },
    { type: 'stop_worker', agentId: 'child-session', reason: 'User requested cancellation' },
  ]) {
    await assert.rejects(f.runs.control({ ...f.binding, schemaVersion: 1, commandId: `control-${action.type}`, action }), /Harness/);
    assert.deepEqual(f.store.read(), before, 'unsupported controls leave the command journal and native projection intact');
  }
  assert.equal(rootCancellations, 0);
  assert.equal(f.runs.context(f.binding).state, 'running');
  assert.equal(f.runs.context(f.binding).nativeWorkers[0].state, 'running');
});

test('completion activity remains for native goals, actual tools, workers and uncertain effects', async () => {
  for (const prepare of [
    async f => f.runs.recordHarnessEvent(native(f.binding, 'goal/change', 8, { kind: 'goal/change', version: 1, operation: 'complete', goal: goal('complete'), roundsStarted: 3 })),
    async f => {
      await f.runs.recordToolStart({ ...f.binding, callId: 'read', name: 'read_file' });
      await f.runs.recordToolResult({ ...f.binding, callId: 'read', outcome: 'succeeded', kind: 'read' });
    },
    async f => {
      const child = { id: 'child-session', runId: 'child-run', provider: 'spawn', local: true };
      await f.runs.recordHarnessEvent(native(f.binding, 'subagent/start', undefined, child));
      await f.runs.recordHarnessEvent(native(f.binding, 'subagent/end', undefined, { ...child, stopReason: 'completed' }));
    },
    async f => f.runs.recordToolStart({ ...f.binding, callId: 'uncertain', name: 'write_file' }),
  ]) {
    const f = await fixture();
    await prepare(f);
    await f.runs.finishHarnessAttempt({ ...f.binding, result: { reason: { kind: 'completed' } } });
    assert.equal(f.updates.at(-1).snapshot.state, 'completed');
    assert.ok(f.updates.at(-1).notifications.some(notification => notification.update.status.data.event_type === 'run_completed'));
  }
});
