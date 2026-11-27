import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { DesktopCoordinator } from '../desktop-coordinator.mjs';
import { workspaceIdentity } from '../workspaces.mjs';
import { permissionDriver } from './fixtures/permission-driver.mjs';

for (const mode of ['steer', 'next-step']) test(`${mode} carries one original message identity through Compat and native consumption without cancelling the run`, { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-steering-delivery-'));
  const store = await openStore(join(root, 'state'));
  await store.update(state => {
    state.providers = [{ id: 'fixture', engine: 'openai_compatible', apiUrl: 'http://127.0.0.1:1', models: ['fixture'], requiresAuth: false }];
    state.defaults = { providerId: 'fixture', modelId: 'fixture' }; state.preferences.gooseMode = 'auto';
  });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), steered = Promise.withResolvers();
  const committed = new Set(), admissions = [], notices = [];
  let callbacks, cancellations = 0;
  const driver = {
    permissions: permissionDriver(), createSession: async () => {}, listTools: async () => [], close: async () => {},
    cancel: async () => { cancellations++; release.resolve(); }, agentInputIds: async () => [...committed],
    prompt: async (id, _content, options) => {
      callbacks = options; committed.add(options.requestId);
      await options.onEvent({ type: 'agent_input', sessionId: id, requestId: options.requestId, seq: 1 });
      entered.resolve(); await release.promise; return { stopReason: 'end_turn', reason: { kind: 'completed' } };
    },
    steer: async (id, content, options) => {
      content = options.prepareContent ? await options.prepareContent(content) : content;
      admissions.push({ id, content, ...options }); committed.add(options.requestId);
      // Exercise a consumption callback before steer resolves: no serial-lock cycle.
      await callbacks.onEvent({ type: 'agent_input', sessionId: id, requestId: options.requestId, seq: 2 });
      steered.resolve();
    },
  };
  const host = new Compat(store, driver);
  host.desktop = new DesktopCoordinator({ directory: join(root, 'desktop-control') });
  await host.initialize();
  t.after(async () => { release.resolve(); await host.close(); });
  const connection = { sessionIds: new Set(), notify: (method, params) => notices.push({ method, params }) };
  const cwd = join(root, 'workspace');
  const lease = await host.request('_goose/unstable/workspace/lease/acquire', {
    requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd),
  }, connection);
  const created = await host.request('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId } }, connection);
  const sessionId = created.sessionId;
  const enqueue = command => host.request('_codebuddy/session/input-queue', { sessionId, ...command }, connection);
  await enqueue({ action: 'enqueue', commandId: 'start-command', revision: 0, items: [{ id: 'initial', content: 'Start task', images: [] }] });
  await entered.promise;
  const snapshot = host.inputQueue.snapshot(sessionId);
  const input = { action: 'enqueue', commandId: 'steer-command', revision: snapshot.revision, expectedRunId: snapshot.activeRunId,
    items: [{ id: 'original-steer-id', content: 'Keep the existing work and answer this correction.', images: [], ...(mode === 'steer' ? { mode: 'steer' } : {}) }] };
  await enqueue(input);
  const command = mode === 'steer' ? input : { action: 'next-step', ids: ['original-steer-id'],
    expectedRunId: snapshot.activeRunId, commandId: 'native-step-command', revision: host.inputQueue.snapshot(sessionId).revision };
  if (mode === 'next-step') await enqueue(command);
  await steered.promise;
  await enqueue(command);
  release.resolve();
  while (host.inputQueue.workers.size) await Promise.all([...host.inputQueue.workers.values()]);
  assert.equal(cancellations, 0);
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0].requestId, 'original-steer-id');
  assert.equal(admissions[0].preempt, mode === 'steer');
  assert.deepEqual(host.inputQueue.snapshot(sessionId).items, []);
  assert.equal(notices.filter(n => n.params?.update?.sessionUpdate === 'user_message_chunk' && n.params.update.messageId === 'original-steer-id').length, 1);
});
