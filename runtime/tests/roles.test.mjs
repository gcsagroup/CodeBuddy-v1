import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodeProRoleRuntime, CODEPRO_ROLES, resolveRoleRouting } from '../roles.mjs';
import { CodeProRuns } from '../codepro.mjs';
import { openStore } from '../store.mjs';
import { zCodeProRunSnapshot } from '../../ui/sdk/dist/generated/zod.gen.js';

const providers = [{ id: 'local', models: ['small', 'large'], requiresAuth: false }, { id: 'other', models: ['review'], requiresAuth: false }];
const session = { providerId: 'local', modelId: 'small' };
const convert = async provider => ({ id: provider.id, baseUrl: `http://fixture/${provider.id}` });
const routeConfig = () => ({ version: 2, advancedRoutingEnabled: true, maxParallelCoders: 2, visionRoute: { enabled: false, mode: 'disabled' }, routes: CODEPRO_ROLES.map(role => ({ role, providerId: role === 'reviewer' ? 'other' : 'local', modelId: role === 'reviewer' ? 'review' : 'large' })) });

test('renderer version 2 routes select actual main and role driver options', async () => {
  const calls = [];
  const routing = await resolveRoleRouting({ config: routeConfig(), session, providers, thinkingEffort: 'high', resolveProvider: async provider => { calls.push(provider.id); return convert(provider); } });
  assert.equal(routing.main.model, 'large');
  assert.equal(routing.main.provider.id, 'local');
  assert.equal(routing.roleModels.reviewer.provider.id, 'other');
  assert.equal(routing.roleModels.reviewer.model, 'review');
  assert.equal(routing.roleModels.coder.thinkingEffort, 'high');
  assert.equal(routing.maxParallelCoders, 2);
  assert.deepEqual(calls, ['local', 'other']);
});

test('disabled routing inherits active session model and ignores obsolete auxiliary routes', async () => {
  const config = { ...routeConfig(), advancedRoutingEnabled: false, routes: [{ role: 'obsolete', providerId: 'removed', modelId: 'gone' }] };
  const routing = await resolveRoleRouting({ config, session, providers, resolveProvider: convert });
  for (const selection of [routing.main, ...Object.values(routing.roleModels)]) assert.equal(selection.model, 'small');
  assert.equal((await resolveRoleRouting({ session, providers, resolveProvider: convert })).maxParallelCoders, 1);
});

test('different models on one provider retain their own context budgets', async () => {
  const config = routeConfig();
  config.routes = config.routes.map(route => ({ ...route, providerId: 'local', modelId: route.role === 'main' ? 'small' : 'large' }));
  const routing = await resolveRoleRouting({ config, session, providers,
    resolveProvider: async (provider, model) => ({ id: provider.id, contextWindow: model === 'small' ? 32768 : 65536 }) });
  assert.equal(routing.main.provider.contextWindow, 32768);
  assert.equal(routing.roleModels.coder.provider.contextWindow, 65536);
});

test('routing rejects unavailable selections, duplicate roles and invalid concurrency without fallbacks', async () => {
  const check = config => resolveRoleRouting({ config, session, providers, resolveProvider: convert });
  await assert.rejects(check({ ...routeConfig(), routes: routeConfig().routes.slice(1) }), /all five/);
  await assert.rejects(check({ ...routeConfig(), routes: [...routeConfig().routes, routeConfig().routes[0]] }), /duplicate/);
  await assert.rejects(check({ ...routeConfig(), routes: routeConfig().routes.map(route => ({ ...route, modelId: 'missing' })) }), /Configure/);
  for (const maxParallelCoders of [0, 33, 1.5, '2']) await assert.rejects(check({ ...routeConfig(), maxParallelCoders }), /parallel coders/);
  await assert.rejects(resolveRoleRouting({ config: routeConfig(), session, providers: providers.map(provider => ({ ...provider, requiresAuth: true })), resolveProvider: convert }), /Configure/);
  assert.equal((await check({ ...routeConfig(), version: 1 })).main.model, 'large');
});

async function fixture(maxParallelCoders = 1) {
  const directory = await mkdtemp(path.join(tmpdir(), 'codebuddy-role-'));
  const store = await openStore(directory);
  const runs = new CodeProRuns(store);
  await runs.initialize();
  await runs.create({ sessionId: 'main', runId: 'project', sourceMessageId: 'request', goal: 'Independent modules with exclusive worker ownership' });
  const { attemptId } = await runs.beginAttempt({ sessionId: 'main', runId: 'project', sourceMessageId: 'request' });
  const binding = { sessionId: 'main', runId: 'project', attemptId };
  await runs.submitPlan({ ...binding, expectedPlanRevision: 0, tasks: ['first', 'second'].map(taskId => ({ taskId, name: `Implement ${taskId}`, kind: 'implementation' })) });
  const taskIds = new Map();
  const roles = new CodeProRoleRuntime({ binding, runs, taskIds, maxParallelCoders });
  const start = (actor, taskId) => roles.taskAction(actor, { action: 'start_task', taskId }, () => runs.startTask({ ...binding, taskId }));
  const spawn = async (role, childId, activation = `activation-${childId}`, parentId = 'main', callId = `spawn-${activation}`) => {
    roles.reserveSpawn({ name: `subagent_${role}`, sessionId: parentId, id: callId });
    await roles.workerStarted({ runId: activation, childSessionId: childId, sessionId: parentId, local: true });
    roles.settleSpawn({ sessionId: parentId, callId, subagentId: childId });
    return activation;
  };
  return { store, directory, runs, binding, roles, taskIds, start, spawn };
}

test('coder admission counts pending and live workers and releases only actual terminal lifecycle', async () => {
  const f = await fixture();
  f.roles.reserveSpawn({ name: 'subagent_coder', sessionId: 'main', id: 'first-spawn' });
  assert.throws(() => f.roles.reserveSpawn({ name: 'subagent_reviewer', sessionId: 'main', id: 'second-spawn' }), /preceding/);
  await f.roles.workerStarted({ runId: 'coder-activation', childSessionId: 'coder', sessionId: 'main', local: true });
  f.roles.settleSpawn({ callId: 'first-spawn', subagentId: 'coder' });
  assert.throws(() => f.roles.reserveSpawn({ name: 'subagent_coder', sessionId: 'main', id: 'second-spawn' }), /parallel coders/);
  await f.spawn('reviewer', 'reviewer');
  assert.throws(() => f.roles.reserveSpawn({ name: 'subagent_coder', sessionId: 'reviewer', id: 'nested-spawn' }), /parallel coders/);
  f.roles.settleSpawn({ callId: 'first-spawn', failed: true });
  assert.throws(() => f.roles.reserveSpawn({ name: 'subagent_coder', sessionId: 'main', id: 'after-tool-error' }), /parallel coders/);
  await f.roles.workerStopped({ runId: 'coder-activation', childSessionId: 'coder', stopReason: 'aborted' });
  assert.equal(f.roles.childSessionFor('coder-activation'), null);
  await f.spawn('coder', 'second-coder');
  const snapshot = f.runs.get({ schemaVersion: 1, ...f.binding }).snapshot;
  zCodeProRunSnapshot.parse(snapshot);
  assert.deepEqual(snapshot.agents.map(agent => agent.state), ['stopped', 'running', 'running']);
});

test('unstarted failures release reservation, reused IDs and unrelated lifecycle are rejected', async () => {
  const f = await fixture();
  assert.throws(() => f.roles.reserveSpawn({ name: 'subagent', id: 'generic' }), /configured CodePro/);
  assert.throws(() => f.roles.reserveSpawn({ name: 'send_message', id: 'resume-child', arguments: { agent_id: 'old-child', message: 'continue' } }), /continuation is not configured/);
  assert.equal(f.roles.reserveSpawn({ name: 'read', id: 'read' }), null);
  f.roles.reserveSpawn({ name: 'subagent_coder', id: 'failure' });
  assert.throws(() => f.roles.settleSpawn({ callId: 'failure', subagentId: 'invented' }), /actual worker/);
  f.roles.settleSpawn({ callId: 'failure', failed: true });
  assert.throws(() => f.roles.reserveSpawn({ name: 'subagent_coder', id: 'failure' }), /replayed/);
  await assert.rejects(f.roles.workerStarted({ runId: 'fake', childSessionId: 'fake', sessionId: 'main', local: true }), /no admitted/);
  await f.spawn('coder', 'real');
  assert.throws(() => f.roles.settleSpawn({ callId: 'spawn-activation-real', subagentId: 'fake' }), /identity differs/);
  await assert.rejects(f.roles.workerStopped({ runId: 'activation-real', childSessionId: 'fake', stopReason: 'completed' }), /does not match/);
  await assert.rejects(f.roles.workerStarted({ runId: 'activation-real', childSessionId: 'real', sessionId: 'main', local: true }), /already observed/);
});

test('real planned task ownership isolates simultaneous workers and rejects child global actions', async () => {
  const f = await fixture(2);
  await f.spawn('coder', 'child-a'); await f.spawn('coder', 'child-b');
  assert.throws(() => f.roles.assertToolActor('child-a'), /start an existing/);
  assert.throws(() => f.roles.assertToolActor('invented'), /Unknown/);
  assert.equal(f.roles.assertToolActor('main'), undefined);
  for (const action of ['submit_plan', 'propose_finish', 'answer', 'report_blocked']) {
    let invoked = false;
    await assert.rejects(f.roles.taskAction('child-a', { action }, () => { invoked = true; }), /main agent/);
    assert.equal(invoked, false);
  }
  await assert.rejects(f.start('child-a', 'unplanned'), /already exist/);
  const attempts = await Promise.allSettled([f.start('child-a', 'first'), f.start('child-b', 'first')]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  await f.start('child-b', 'second');
  assert.deepEqual([...f.taskIds], [['child-a', 'first'], ['child-b', 'second']]);
  const owned = f.runs.get({ schemaVersion: 1, ...f.binding }).snapshot;
  zCodeProRunSnapshot.parse(owned);
  assert.deepEqual(owned.agents.map(agent => agent.taskId), ['first', 'second']);
  await assert.rejects(f.runs.workerTaskAssigned({ ...f.binding, agentId: 'activation-child-b', taskId: 'first' }), /live worker owner/);
  assert.equal(f.roles.assertToolActor('child-a'), 'first');
  await assert.rejects(f.start('main', 'first'), /another active/);
  await assert.rejects(f.roles.taskAction('child-a', { action: 'task_result', taskId: 'second' }, async () => {}), /another active/);
  await assert.rejects(f.roles.taskAction('main', { action: 'task_result', taskId: 'first' }, async () => {}), /another active/);
  await f.roles.workerStopped({ runId: 'activation-child-a', childSessionId: 'child-a', stopReason: 'error' });
  assert.throws(() => f.roles.assertToolActor('child-a'), /inactive/);
  assert.equal(f.runs.context(f.binding).tasks.find(task => task.taskId === 'first').state, 'running', 'worker exit must not fabricate task success');
  await f.start('main', 'first');
  assert.equal(f.taskIds.get('main'), 'first');
});

test('rejected task results retain ownership and only real receipt completion releases it', async () => {
  const f = await fixture(); await f.spawn('coder', 'child'); await f.start('child', 'first');
  const resultArgs = { action: 'task_result', taskId: 'first', outcome: 'succeeded', summary: 'Actual host receipt', evidenceIds: [] };
  await assert.rejects(f.roles.taskAction('child', resultArgs, () => f.runs.proposeTaskResult({ ...f.binding, ...resultArgs })), /evidence/);
  assert.equal(f.taskIds.get('child'), 'first');
  await f.runs.recordToolStart({ ...f.binding, taskId: 'first', callId: 'child:write', name: 'write' });
  const { evidenceId } = await f.runs.recordToolResult({ ...f.binding, callId: 'child:write', outcome: 'succeeded', kind: 'write', path: 'fixture.mjs' });
  resultArgs.evidenceIds = [evidenceId];
  await f.roles.taskAction('child', resultArgs, () => f.runs.proposeTaskResult({ ...f.binding, ...resultArgs }));
  assert.equal(f.taskIds.has('child'), false);
  assert.equal(f.runs.context(f.binding).tasks[0].state, 'succeeded');
  assert.equal(f.runs.context(f.binding).agents[0].taskId, null);
  await f.roles.workerStopped({ runId: 'activation-child', childSessionId: 'child', stopReason: 'completed' });
  const restarted = new CodeProRuns(await openStore(f.directory)); await restarted.initialize();
  assert.equal(restarted.context(f.binding).state, 'paused');
  assert.equal(restarted.context(f.binding).tasks[0].state, 'succeeded');
  assert.equal(restarted.context(f.binding).agents[0].state, 'stopped');
});
