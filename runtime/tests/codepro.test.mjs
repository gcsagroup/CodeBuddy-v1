import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from '../../ui/node_modules/esbuild/lib/main.js';
import { CodeProRuns } from '../codepro.mjs';
import { openStore } from '../store.mjs';
import { zCodeProRunSnapshot, zCodeProRunControlResponse_unstable, zGooseSessionNotification_unstable } from '../../ui/sdk/dist/generated/zod.gen.js';

async function fixture(callbacks = {}, policy) {
  const directory = await mkdtemp(path.join(tmpdir(), 'codebuddy-codepro-'));
  const store = await openStore(directory);
  const notifications = [];
  const runs = new CodeProRuns(store, { onUpdate: (update) => notifications.push(update), ...callbacks });
  await runs.initialize();
  const created = await runs.create({ sessionId: 'session-1', runId: 'run-1', sourceMessageId: 'message-1', goal: 'Build and verify a two module calculator', policy });
  const params = { sessionId: created.sessionId, runId: created.runId };
  const { attemptId } = await runs.beginAttempt({ ...params, sourceMessageId: 'message-1' });
  return { directory, store, runs, params: { ...params, attemptId }, notifications };
}
const rpc = (params) => ({ schemaVersion: 1, sessionId: params.sessionId, runId: params.runId });
async function plan(f, tasks = [{ taskId: 'implementation', name: 'Implement modules', kind: 'implementation' }, { taskId: 'test', name: 'Verify module integration', kind: 'verification', dependsOn: ['implementation'] }]) {
  await f.runs.submitPlan({ ...f.params, expectedPlanRevision: 0, tasks });
}
async function receipt(f, taskId, callId, kind = 'write') {
  await f.runs.recordToolStart({ ...f.params, taskId, callId, name: kind });
  return f.runs.recordToolResult({ ...f.params, callId, kind, outcome: 'succeeded', ...(kind === 'verification' ? { command: 'node --test calculator.test.mjs', exitCode: 0 } : {}) });
}
async function finishTask(f, taskId, evidenceId) {
  return f.runs.proposeTaskResult({ ...f.params, taskId, outcome: 'succeeded', summary: 'Host receipt confirms execution', evidenceIds: [evidenceId] });
}

test('real SDK accepts run snapshots and original UI activity contract notifications', async () => {
  const f = await fixture(); await plan(f);
  for (const update of f.notifications) {
    zCodeProRunSnapshot.parse(update.snapshot);
    for (const notification of update.notifications) {
      zGooseSessionNotification_unstable.parse(notification);
      assert.equal(notification.update.status.data.session_id, 'session-1');
      assert.equal(notification.update.status.data.run_id, 'run-1');
      assert.ok(notification.update.status.data.event_id);
    }
  }
  const projection = f.runs.get(rpc(f.params)).snapshot;
  assert.equal(projection.coordinator.effectiveMode, 'off');
  assert.equal(projection.agents.length, 0, 'no fabricated planner/coder/tester processes');
  assert.equal(projection.planRevision, 1);
  assert.ok(f.runs.planContext(f.params).plan.content.includes('[ ] Implement modules'));
});

test('unchanged renderer consumes active run metadata, activity and bound plan', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../../ui/desktop/src/acp/sessionNotificationAdapter.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  const original = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const adapter = original.createAcpSessionNotificationAdapter();
  const f = await fixture(); await plan(f);
  const changes = adapter.apply({ sessionId: 'session-1', update: { sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: 'run-1' } } } });
  assert.deepEqual(changes, [{ type: 'sessionInfo', activeRunId: 'run-1' }]);
  for (const update of f.notifications) for (const notification of update.notifications) adapter.applyGoose(notification);
  const context = f.runs.planContext(f.params);
  adapter.applyGoose({ sessionId: 'session-1', update: { sessionUpdate: 'status_message', status: { type: 'progress', message: 'Plan', data: context } } });
  const contents = adapter.getMessages().flatMap((message) => message.content);
  assert.ok(contents.some((content) => content.notificationType === 'codeProActivity' && content.data.run_id === 'run-1'));
  assert.ok(contents.some((content) => content.data?.type === 'codepro_plan_context' && content.data.plan.content === context.plan.content));
});

test('end_turn and prose do not complete a task or run', async () => {
  const f = await fixture(); await plan(f);
  await f.runs.endAttempt({ ...f.params, reason: 'end_turn: all done, tests passed!' });
  const state = f.runs.context(f.params);
  assert.equal(state.state, 'paused');
  assert.equal(state.tasks[0].state, 'ready');
  assert.equal(state.activeAttempt, null);
  await assert.rejects(f.runs.proposeFinish({ ...f.params, summary: 'Done' }), /inactive Harness attempt/);
});

test('explicit pure answer completes a response without fabricating project verification', async () => {
  const f = await fixture();
  const result = await f.runs.proposeAnswer({ ...f.params, answer: '你好，我可以协助你。' });
  assert.equal(result.snapshot.state, 'completed');
  assert.equal(f.runs.context(f.params).completionKind, 'response_only');
  assert.deepEqual(result.snapshot.tasks, []);
  assert.deepEqual(f.runs.context(f.params).receipts, []);
});

test('answer proposal never removes an existing plan or tool obligation', async () => {
  const f = await fixture(); await plan(f);
  await assert.rejects(f.runs.proposeAnswer({ ...f.params, answer: 'Answering a follow-up' }), /cannot replace/);
  const g = await fixture(); await receipt(g, null, 'observed-read', 'read');
  await assert.rejects(g.runs.proposeAnswer({ ...g.params, answer: 'No further action needed' }), /cannot replace/);
});

test('plan revisions validate dependency graph and preserve committed obligations', async () => {
  const f = await fixture();
  await assert.rejects(plan(f, [{ taskId: 'a', name: 'A', dependsOn: ['b'] }, { taskId: 'b', name: 'B', dependsOn: ['a'] }]), /Cyclic/);
  await plan(f);
  await assert.rejects(f.runs.startTask({ ...f.params, taskId: 'test' }), /dependencies/);
  await assert.rejects(f.runs.submitPlan({ ...f.params, expectedPlanRevision: 0, tasks: [{ taskId: 'x', name: 'X' }] }), /Stale plan/);
  await assert.rejects(f.runs.submitPlan({ ...f.params, expectedPlanRevision: 1, tasks: [{ taskId: 'test', name: 'Test' }] }), /retain existing/);
  await f.runs.startTask({ ...f.params, taskId: 'implementation' });
  assert.equal(f.runs.context(f.params).planRevision, 1, 'execution transitions never change topology revision');
});

test('task result rejects invented, cross-task, failed, and stale execution evidence', async () => {
  const f = await fixture(); await plan(f); await f.runs.startTask({ ...f.params, taskId: 'implementation' });
  await assert.rejects(finishTask(f, 'implementation', 'model-says-pass'), /Evidence must belong/);
  await f.runs.recordToolStart({ ...f.params, taskId: 'implementation', callId: 'failed', name: 'shell' });
  await assert.rejects(f.runs.recordToolResult({ ...f.params, callId: 'failed', kind: 'verification', command: 'node --test', outcome: 'succeeded', exitCode: 1 }), /nonzero/);
  const failed = await f.runs.recordToolResult({ ...f.params, callId: 'failed', outcome: 'failed', exitCode: 1 });
  await assert.rejects(finishTask(f, 'implementation', failed.evidenceId), /successful host/);
  const write = await receipt(f, 'implementation', 'write');
  await finishTask(f, 'implementation', write.evidenceId);
  await f.runs.startTask({ ...f.params, taskId: 'test' });
  await assert.rejects(finishTask(f, 'test', write.evidenceId), /Evidence must belong/);
  const read = await receipt(f, 'test', 'read', 'read');
  await assert.rejects(finishTask(f, 'test', read.evidenceId), /verification receipt/);
});

test('multi-module files and real test execution support host-gated completion and restart replay', async () => {
  const f = await fixture(); await plan(f);
  await f.runs.startTask({ ...f.params, taskId: 'implementation' });
  await f.runs.recordToolStart({ ...f.params, taskId: 'implementation', callId: 'files', name: 'write_files' });
  const projectDir = path.join(f.directory, 'project'); await mkdir(projectDir);
  await writeFile(path.join(projectDir, 'arithmetic.mjs'), 'export const sum = (a, b) => a + b;\n');
  await writeFile(path.join(projectDir, 'invoice.mjs'), "import {sum} from './arithmetic.mjs'; export const total = xs => xs.reduce(sum, 0);\n");
  await writeFile(path.join(projectDir, 'calculator.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {total} from './invoice.mjs'; test('cross-module total', () => {assert.equal(total([2, -3, 7]), 6); assert.equal(total([]), 0)});\n");
  const written = await f.runs.recordToolResult({ ...f.params, callId: 'files', outcome: 'succeeded', kind: 'write', artifactRef: projectDir });
  await finishTask(f, 'implementation', written.evidenceId);
  await f.runs.startTask({ ...f.params, taskId: 'test' });
  await f.runs.recordToolStart({ ...f.params, taskId: 'test', callId: 'tests', name: 'shell' });
  const executed = spawnSync(process.execPath, ['--test', 'calculator.test.mjs'], { cwd: projectDir, encoding: 'utf8' });
  assert.equal(executed.status, 0, executed.stdout + executed.stderr);
  const verified = await f.runs.recordToolResult({ ...f.params, callId: 'tests', outcome: 'succeeded', kind: 'verification', command: 'node --test calculator.test.mjs', exitCode: executed.status, artifactRef: path.join(projectDir, 'calculator.test.mjs') });
  await finishTask(f, 'test', verified.evidenceId);
  const finished = await f.runs.proposeFinish({ ...f.params, summary: 'Both modules are implemented and the independent test passed' });
  assert.equal(finished.snapshot.state, 'completed');
  await f.runs.endAttempt({ ...f.params, reason: 'end_turn' });
  assert.equal(f.notifications.at(-1).notifications.at(-1).update.status.data.event_type, 'run_completed', 'prompt cleanup must not project a completed run as stopped');
  const beforeRestart = f.runs.get(rpc(f.params));
  const restored = new CodeProRuns(await openStore(f.directory));
  assert.equal(await restored.initialize(), 0);
  assert.deepEqual(restored.get(rpc(f.params)), beforeRestart);
  assert.equal(restored.context(f.params).receipts.length, 2);
  const saved = JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8'));
  assert.ok(saved.codeproRuns[0].events.every((entry, index) => entry.sequence === index + 1));
  assert.equal(saved.codeproRuns[0].snapshot, undefined, 'no persisted mutable shadow projection');
});

test('finish requires fresh verification after the latest observed write', async () => {
  const f = await fixture({}, { requirePlan: false });
  await receipt(f, null, 'verify', 'verification');
  await receipt(f, null, 'later-write', 'write');
  await assert.rejects(f.runs.proposeFinish({ ...f.params, summary: 'Completed' }), /latest file change/);
  await receipt(f, null, 'verify-again', 'verification');
  assert.equal((await f.runs.proposeFinish({ ...f.params, summary: 'Completed' })).snapshot.state, 'completed');
});

test('later failing verification is not hidden by an earlier passing command', async () => {
  const f = await fixture({}, { requirePlan: false });
  await receipt(f, null, 'unit-tests', 'verification');
  await f.runs.recordToolStart({ ...f.params, callId: 'integration', name: 'test' });
  await f.runs.recordToolResult({ ...f.params, callId: 'integration', outcome: 'failed', kind: 'verification', command: 'node --test integration.test.mjs', exitCode: 1 });
  await assert.rejects(f.runs.proposeFinish({ ...f.params, summary: 'Unit tests passed' }), /failed or uncertain latest/);
});

test('changed-file activity requires a successful observed write receipt', async () => {
  const f = await fixture();
  await f.runs.recordToolStart({ ...f.params, callId: 'uncertain-file', name: 'write' });
  await f.runs.recordToolResult({ ...f.params, callId: 'uncertain-file', outcome: 'unknown', kind: 'write', path: path.join(f.directory, 'unknown.txt') });
  assert.equal(f.notifications.at(-1).notifications.at(-1).update.status.data.event_type, 'tool_completed');
  const g = await fixture();
  await g.runs.recordToolStart({ ...g.params, callId: 'written-file', name: 'write' });
  await g.runs.recordToolResult({ ...g.params, callId: 'written-file', outcome: 'succeeded', kind: 'write', path: path.join(g.directory, 'written.txt') });
  assert.equal(g.notifications.at(-1).notifications.at(-1).update.status.data.event_type, 'file_changed');
});

test('process restart pauses the same run and never replays uncertain tool effects', async () => {
  const f = await fixture(); await plan(f); await f.runs.startTask({ ...f.params, taskId: 'implementation' });
  await f.runs.recordToolStart({ ...f.params, taskId: 'implementation', callId: 'pending-write', name: 'write' });
  let resumeCount = 0;
  const restored = new CodeProRuns(await openStore(f.directory), { onResume: () => { resumeCount += 1; } });
  assert.equal(await restored.initialize(), 1);
  const recovered = restored.get(rpc(f.params)).snapshot;
  assert.equal(recovered.state, 'paused');
  assert.equal(recovered.effects[0].state, 'uncertain');
  assert.equal(recovered.recovery.uncertainEffects, 1);
  assert.equal(resumeCount, 0);
  await assert.rejects(restored.beginAttempt({ ...f.params, sourceMessageId: 'resume' }), /uncertain/);
  await restored.resolveEffect({ ...rpc(f.params), effectId: 'pending-write', resolution: 'confirmed_applied' });
  assert.equal(restored.context(f.params).receipts.length, 0, 'human effect resolution is not fabricated verification');
  const next = await restored.beginAttempt({ ...f.params, sourceMessageId: 'resume' });
  assert.notEqual(next.attemptId, f.params.attemptId);
  await assert.rejects(restored.recordToolResult({ ...f.params, callId: 'pending-write', outcome: 'succeeded' }), /Stale/);
});

test('pause waits for real cancellation acknowledgement and duplicate command is idempotent', async () => {
  const f = await fixture(); let calls = 0;
  f.runs.onCancel = async () => { calls += 1; await f.runs.endAttempt({ ...f.params, reason: 'cancelled by user' }); };
  const sequence = f.runs.get(rpc(f.params)).snapshot.lastSequence;
  const request = { ...rpc(f.params), commandId: 'pause-1', expectedSequence: sequence, action: { type: 'pause_run', reason: 'User pause' } };
  const response = await f.runs.control(request);
  zCodeProRunControlResponse_unstable.parse(response);
  assert.equal(response.snapshot.state, 'paused');
  assert.equal(f.runs.context(f.params).activeAttempt, null);
  assert.deepEqual(await f.runs.control(request), response);
  assert.equal(calls, 1);
  await assert.rejects(f.runs.control({ ...request, action: { type: 'emergency_stop', reason: 'Stop' } }), /different action/);
  await assert.rejects(f.runs.control({ ...request, commandId: 'stale' }), /Stale run sequence/);
});

test('stop request prevents new actions before cancellation callback resolves', async () => {
  const f = await fixture(); let acknowledge;
  f.runs.onCancel = () => new Promise((resolve) => { acknowledge = resolve; });
  const pending = f.runs.control({ ...rpc(f.params), commandId: 'pause', expectedSequence: f.runs.context(f.params).lastSequence, action: { type: 'pause_run', reason: 'Pause now' } });
  while (!acknowledge) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.runs.recordToolStart({ ...f.params, callId: 'too-late', name: 'write' }), /suspended/);
  acknowledge();
  assert.equal((await pending).snapshot.state, 'paused');
});

test('resume calls Harness once with persisted host context rather than replaying tools', async () => {
  const f = await fixture(); await f.runs.endAttempt({ ...f.params, reason: 'User paused' });
  const calls = [];
  f.runs.onResume = async (input) => { calls.push(input); };
  const request = { ...rpc(f.params), commandId: 'resume-1', expectedSequence: f.runs.context(f.params).lastSequence, action: { type: 'resume_run' } };
  await f.runs.control(request); await f.runs.control(request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, f.params.runId);
  assert.equal(calls[0].context.goal, 'Build and verify a two module calculator');
  assert.match(calls[0].context.recoveryInstruction, /Do not replay/);
});

test('emergency stop and branch cancellation preserve unfinished obligations', async () => {
  const f = await fixture({ onCancel: async () => {} }); await plan(f);
  await f.runs.control({ ...rpc(f.params), commandId: 'branch', action: { type: 'cancel_branch', rootTaskId: 'implementation', reason: 'Cancel dependent branch' } });
  assert.deepEqual(f.runs.context(f.params).tasks.map((task) => task.state), ['cancelled', 'cancelled']);
  const next = await f.runs.beginAttempt({ ...f.params, sourceMessageId: 'new-turn' });
  await assert.rejects(f.runs.proposeFinish({ ...f.params, attemptId: next.attemptId, summary: 'Done' }), /unfinished or cancelled/);
  const result = await f.runs.control({ ...rpc(f.params), commandId: 'stop', action: { type: 'emergency_stop', reason: 'User stopped run' } });
  assert.equal(result.snapshot.state, 'cancelled');
  await assert.rejects(f.runs.beginAttempt({ ...f.params, sourceMessageId: 'resume' }), /terminal/);
});

test('blocker preserves progress, restart does not claim completion, missing callbacks reject controls', async () => {
  const f = await fixture();
  await assert.rejects(f.runs.control({ ...rpc(f.params), commandId: 'pause', action: { type: 'pause_run', reason: 'Pause' } }), /callback is not connected/);
  await f.runs.reportBlocked({ ...f.params, kind: 'environment', reason: 'Required compiler is absent' });
  assert.equal(f.runs.context(f.params).state, 'waiting_for_environment');
  await f.runs.endAttempt({ ...f.params, reason: 'blocked' });
  assert.equal(f.runs.context(f.params).state, 'waiting_for_environment');
  const restored = new CodeProRuns(await openStore(f.directory));
  assert.equal(await restored.initialize(), 0);
  assert.equal(restored.context(f.params).state, 'waiting_for_environment');
});
