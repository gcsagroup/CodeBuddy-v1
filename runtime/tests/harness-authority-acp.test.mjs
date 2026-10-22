import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Compat } from '../compat.mjs';
import { permissionDriver } from './fixtures/permission-driver.mjs';
import { openStore } from '../store.mjs';
import { workspaceIdentity } from '../workspaces.mjs';
import { driverProvider } from '../providers.mjs';
import { isDeepStrictEqual } from 'node:util';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'harness-authority-acp-')));
  const store = await openStore(path.join(root, 'data'));
  await store.update(state => {
    state.providers = [{ id: 'fixture', engine: 'openai_compatible', apiUrl: 'http://127.0.0.1:1', models: ['fixture'], requiresAuth: false }];
    state.defaults = { providerId: 'fixture', modelId: 'fixture' };
    state.preferences.gooseMode = 'auto';
  });
  const notices = [], sessions = [], scripts = [];
  let initialize = async input => { sessions.push(input); };
  const driver = {
    permissions: permissionDriver(),
    createSession: input => initialize(input), listTools: async () => [], cancel: async () => {}, close: async () => {},
    prompt: async (id, content, callbacks) => scripts.shift()({ ...callbacks, onPermission: async call => {
      const accepted = await callbacks.onPermission(call);
      if (accepted) await callbacks.onToolStart?.(call);
      return accepted;
    } }),
  };
  const compat = new Compat(store, driver);
  await compat.initialize();
  const connection = { sessionIds: new Set(), notify: (method, params) => notices.push({ method, params }), ask: async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }) };
  compat.connections.add(connection);
  t.after(() => compat.close());
  const request = (method, params) => compat.request(method, params, connection);
  const cwd = path.join(root, 'project');
  const lease = await request('_goose/unstable/workspace/lease/acquire', { requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd) });
  const created = await request('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId } });
  const sessionId = created.sessionId;
  const prompt = text => request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  return { compat, store, notices, sessions, scripts, sessionId, prompt, request, setInitializer(fn) { initialize = fn; } };
}

test('saved connection cards read locally without waiting for model metadata; the model picker filters live capabilities', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  await f.store.update(state => {
    state.providers[0].engine = 'ollama_compatible';
    state.providers[0].models = ['fixture', 'decision'];
  });
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    fetches++;
    assert.equal(new URL(url).pathname, '/api/tags');
    return Response.json({ models: [
      { name: 'fixture', capabilities: ['completion'] },
      { name: 'decision', capabilities: ['decision'] },
    ] });
  });
  const first = await f.request('_goose/unstable/providers/list', {});
  assert.equal(first.entries[0].providerId, 'fixture');
  assert.equal(first.entries[0].configured, true);
  assert.equal(fetches, 0, 'A saved connection must appear without a network metadata request');
  const picker = await f.request('_goose/unstable/providers/supported-models/list', { providerId: 'fixture' });
  assert.deepEqual(picker.models, ['fixture']);
  const again = await f.request('_goose/unstable/providers/list', {});
  assert.deepEqual(again.entries[0].models.map(model => model.id), ['fixture']);
  assert.equal(fetches, 1, 'The connection card must not fetch per-model details during refresh');
});

test('model thinking migration restores historical child routes despite a stale effort preference', async t => {
  const f = await fixture(t);
  await f.store.update(state => {
    state.providers[0].models.push('gpt-6.1-sol');
    state.providers[0].catalogProviderId = 'openai';
  });
  f.scripts.push(async () => ({stopReason:'end_turn',reason:{kind:'completed'}}));
  await f.prompt('Prepare the existing session.');
  const provider = f.store.read(['providers']).providers[0];
  const historical = await driverProvider(provider, 'gpt-6.1-sol', {legacyThinking:true});
  await f.store.update(state => { state.providers[0].thinkingEfforts = {'gpt-6.1-sol':'none'}; });
  const restore = f.sessions[0].options.restoreSubagentProvider;
  assert.deepEqual(await restore('gpt-6.1-sol', candidate => isDeepStrictEqual(candidate,historical)), historical);
  assert.equal(await restore('gpt-6.1-sol', candidate => candidate.baseUrl === 'https://unrelated.invalid/v1'), undefined,
    'Only the exact recorded native connection can be restored');
});

test('model thinking changes preserve session authorization and the active turn, then apply to the next turn', async t => {
  const f = await fixture(t);
  await f.store.update(state => { state.providers[0].models.push('gemma4:31b'); });
  await f.request('session/set_config_option', {sessionId:f.sessionId,configId:'model',value:'gemma4:31b'});
  const started=Promise.withResolvers(), finish=Promise.withResolvers();
  f.scripts.push(async ({onEvent})=>{started.resolve();await finish.promise;await onEvent({type:'text_delta',text:'First'});return{stopReason:'end_turn',reason:{kind:'completed'}};});
  const active=f.prompt('First turn');await started.promise;
  assert.equal(f.sessions[0].options.thinkingEffort,'medium');
  const approvals=f.compat.sessionToolApprovals;
  await f.request('_goose/unstable/providers/config/save',{providerId:'fixture',fields:[{key:'thinkingEffort:gemma4:31b',value:'none'}]});
  assert.equal(f.compat.sessionToolApprovals,approvals,'Changing model effort does not revoke unrelated session approvals');
  assert.equal(f.sessions[0].options.thinkingEffort,'medium','The active native request keeps its prepared snapshot');
  finish.resolve();await active;
  f.scripts.push(async({onEvent})=>{await onEvent({type:'text_delta',text:'Second'});return{stopReason:'end_turn',reason:{kind:'completed'}};});
  await f.prompt('Second turn');
  assert.equal(f.sessions.at(-1).options.thinkingEffort,'off');
});

test('interruption presentation metadata persists in the transcript without entering native execution', async t => {
  const f = await fixture(t);
  const nativeInputs = [];
  const prompt = f.compat.driver.prompt;
  f.compat.driver.prompt = (...args) => { nativeInputs.push(args[1]); return prompt(...args); };
  f.scripts.push(async ({ onEvent }) => {
    await onEvent({ type: 'text_delta', text: 'Stopped.' });
    return { stopReason: 'end_turn', reason: { kind: 'completed' } };
  });
  const presentation = { afterMessageId: 'prior-output' };
  await f.request('session/prompt', { sessionId: f.sessionId,
    prompt: [{ type: 'text', text: 'Stop' }],
    _meta: { 'codeagentpro/source-message-id': 'queued-stop', 'codebuddy/message-presentation': presentation },
  });
  const echo = f.notices.find(notice => notice.params.update?.sessionUpdate === 'user_message_chunk')?.params.update;
  assert.deepEqual(echo._meta.goose.presentation, presentation);
  assert.deepEqual(nativeInputs, [[{ type: 'text', text: 'Stop' }]]);
  const stored = (await openStore(f.store.directory)).readSession(f.sessionId);
  assert.deepEqual(stored.updates.find(update => update.messageId === 'queued-stop')._meta.goose.presentation, presentation);
});

test('new conversation is durable before any model or MCP startup; first message acknowledges before readiness', async t => {
  const f = await fixture(t);
  assert.equal(f.sessions.length, 0, 'new-chat navigation must not await remote services');
  assert.ok(f.store.read().sessions.some(s => s.id === f.sessionId));
  const ready = Promise.withResolvers(), started = Promise.withResolvers();
  let creations = 0;
  f.setInitializer(async () => { creations++; started.resolve(); await ready.promise; });
  f.scripts.push(async ({ onEvent }) => { await onEvent({ type: 'text_delta', text: '你好' }); return { stopReason: 'end_turn', reason: { kind: 'completed' } }; });
  const pending = f.prompt('你好');
  await started.promise;
  assert.ok(f.notices.some(n => n.params.update?.sessionUpdate === 'user_message_chunk'));
  const concurrentReadiness = f.compat.ensureSession(f.compat.session(f.sessionId));
  ready.resolve();
  await Promise.all([pending, concurrentReadiness]);
  assert.equal(creations, 1, 'tool listing and prompt share one initialization');
});

test('ordinary Harness answer completes without an extra CodeBuddy task tool or invented tool activity', async t => {
  const f = await fixture(t);
  f.scripts.push(async ({ onEvent }) => { await onEvent({ type: 'text_delta', text: '你好，很高兴见到你。' }); return { stopReason: 'end_turn', reason: { kind: 'completed' } }; });
  assert.equal((await f.prompt('你好')).stopReason, 'end_turn');
  assert.ok(!f.sessions[0].options.tools.some(tool => tool.name === 'codebuddy_task'));
  const run = f.compat.runs.latest(f.sessionId);
  const context = f.compat.runs.context({ sessionId: f.sessionId, runId: run.runId });
  assert.equal(context.state, 'completed');
  assert.equal(context.completionKind, 'harness_turn');
  assert.deepEqual(context.receipts, []);
  assert.deepEqual(context.tasks, []);
  const terminal = f.notices.map(n => n.params.update?.status?.data).find(d => d?.terminal_message_id);
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.report, undefined, 'ordinary answers do not manufacture project verification cards');
});

test('final native response observation stays separate from progress, child messages and completion authority', async t => {
  const f = await fixture(t);
  for (const finalHasText of [false, true]) {
    f.scripts.push(async ({ onEvent }) => {
      await onEvent({ type: 'text_delta', text: 'Earlier progress.' });
      await onEvent({ type: 'assistant_committed', hasText: true, sessionId: f.sessionId });
      await onEvent({ type: 'thinking_delta', text: 'Private reasoning.' });
      if (finalHasText) await onEvent({ type: 'text_delta', text: 'Final answer.' });
      await onEvent({ type: 'assistant_committed', hasText: finalHasText, sessionId: f.sessionId });
      await onEvent({ type: 'assistant_committed', hasText: !finalHasText, sessionId: 'child-session' });
      return { stopReason: 'end_turn', reason: { kind: 'completed' } };
    });
    const noticeStart = f.notices.length;
    assert.equal((await f.prompt('Continue the work.')).stopReason, 'end_turn');
    const terminal = f.notices.slice(noticeStart).map(n => n.params.update?.status?.data).find(d => d?.terminal_message_id);
    assert.equal(terminal.status, 'completed', 'presentation must not override the native terminal state');
    assert.equal(terminal.visible_text_available, true, 'earlier progress is still visible');
    assert.equal(terminal.last_response_text_available, finalHasText);
    assert.equal(f.scripts.length, 0, 'one user prompt consumes one native attempt without automatic repair');
  }
});

test('only explicit cancel adds a stop display marker after native settlement; steer preserves execution', async t => {
  const f = await fixture(t);
  f.compat.driver.steer = async () => {};
  for (const action of ['stop', 'steer', 'native']) {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    f.scripts.push(async () => {
      entered.resolve(); await release.promise;
      return action === 'steer'
        ? { stopReason: 'end_turn', reason: { kind: 'completed' } }
        : { stopReason: 'cancelled', reason: { kind: 'aborted' } };
    });
    const firstNotice = f.notices.length;
    const pending = f.prompt('Continue the existing task.');
    await entered.promise;
    if (action === 'stop') await f.request('session/cancel', { sessionId: f.sessionId });
    if (action === 'steer') await f.request('_goose/unstable/session/steer', {
      sessionId: f.sessionId, expectedRunId: f.compat.runs.latest(f.sessionId).runId,
      prompt: [{ type: 'text', text: 'Keep the answer brief.' }],
    });
    assert.equal(f.notices.slice(firstNotice).some(n => n.params.update?.status?.data?.terminal_message_id), false);
    release.resolve(); await pending;
    const terminal = f.notices.slice(firstNotice).map(n => n.params.update?.status?.data).find(d => d?.terminal_message_id);
    assert.equal(terminal.status, action === 'steer' ? 'completed' : 'interrupted', 'stop display must not change native recovery state');
    assert.equal(terminal.user_requested_stop, action === 'stop' ? true : undefined);
    const saved = f.store.read(['sessions']).sessions.find(s => s.id === f.sessionId).usageUpdates;
    assert.equal(saved.at(-1).status.data.user_requested_stop, terminal.user_requested_stop);
  }
});

test('transport failure preserves actual failure and does not become a successful Harness answer', async t => {
  const f = await fixture(t);
  f.scripts.push(async () => { throw Object.assign(Error('Isolated connection failure'), { code: 'TRANSPORT' }); });
  await assert.rejects(f.prompt('你好'), /Isolated connection failure/);
  assert.equal(f.compat.runs.latest(f.sessionId).state, 'failed');
  const terminal = f.notices.map(n => n.params.update?.status?.data).find(d => d?.terminal_message_id);
  assert.notEqual(terminal.status, 'completed');
});

test('native tool receipts remain factual when a turn ends after a failing command', async t => {
  const f = await fixture(t);
  f.scripts.push(async ({ onPermission, onEvent }) => {
    assert.equal(await onPermission({ id: 'command-1', name: 'pwsh', arguments: { command: 'node --test' } }), true);
    await onEvent({ type: 'tool_result', id: 'command-1', result: 'failed', structuredContent: { exitCode: 1 } });
    return { stopReason: 'end_turn', reason: { kind: 'completed' } };
  });
  await f.prompt('运行测试并报告结果');
  const run = f.compat.runs.latest(f.sessionId);
  const context = f.compat.runs.context({ sessionId: f.sessionId, runId: run.runId });
  assert.equal(context.completionKind, 'harness_turn');
  assert.equal(context.receipts[0].outcome, 'failed');
  assert.equal(context.receipts[0].exitCode, 1);
  assert.notEqual(context.completionKind, 'verified_task');
  const terminal = f.notices.map(n => n.params.update?.status?.data).find(d => d?.terminal_message_id);
  assert.equal(terminal.status, 'completed', 'the native turn owns completion');
  assert.equal(terminal.report.classification_counts.unverified, 1, 'turn completion does not prove acceptance');
  assert.equal(terminal.report.verification_summary.length, 0);
});

test('native file receipts preserve the actual before/after content through ACP', async t => {
  const f = await fixture(t);
  const raw = { path: '/fixture/example.py', operation: 'update', before: 'old\n', after: 'new\n' };
  f.scripts.push(async ({ onPermission, onEvent }) => {
    const tool = { id: 'write-1', name: 'write', arguments: { file_path: raw.path, content: raw.after } };
    assert.equal(await onPermission(tool), true);
    await onEvent({ type: 'tool_call', ...tool });
    await onEvent({ type: 'tool_result', id: tool.id, result: [{ type: 'text', text: 'File updated' }], structuredContent: raw });
    return { stopReason: 'end_turn', reason: { kind: 'completed' } };
  });
  await f.prompt('修改示例文件');
  const update = f.notices.map(notice => notice.params.update).find(update => update?.sessionUpdate === 'tool_call_update' && update.toolCallId === 'write-1');
  assert.equal(update.status, 'completed');
  assert.deepEqual(update.rawOutput, raw);
  assert.equal(update.content[0].content.text, 'File updated');
  const activities = f.notices.map(notice => notice.params.update?.status?.data).filter(data => data?.tool_call_id === 'write-1');
  assert.equal(activities.length, 2);
  assert.notEqual(activities[0].event_id, activities[1].event_id, 'journal event identity stays independent of the native tool call');
});

test('first desktop prompt prepares again after concurrent bundled settings registration without repeating model execution', async t => {
  const f = await fixture(t);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let preparations = 0, prompts = 0;
  f.setInitializer(async () => {
    if (++preparations === 1) { started.resolve(); await release.promise; }
  });
  f.scripts.push(async () => { prompts++; return { stopReason: 'end_turn', reason: { kind: 'completed' } }; });
  const pending = f.prompt('你好');
  await started.promise;
  await f.compat.settings.request('config/extensions/add', { extension: { type: 'builtin', name: 'developer' }, enabled: true });
  release.resolve();
  await pending;
  assert.equal(preparations, 2);
  assert.equal(prompts, 1);
  assert.equal(f.compat.runs.latest(f.sessionId).state, 'completed');
  assert.equal(f.notices.filter(n => n.params.update?.sessionUpdate === 'user_message_chunk').length, 1);
});

test('readonly extension listing refreshes a snapshot changed during desktop bootstrap', async t => {
  const f = await fixture(t);
  const snapshot = f.compat.settings.extensionSnapshot.bind(f.compat.settings);
  let changed = false;
  f.compat.settings.extensionSnapshot = async () => {
    const result = await snapshot();
    if (!changed) {
      changed = true;
      await f.compat.settings.request('config/extensions/add', { extension: { type: 'builtin', name: 'developer' }, enabled: true });
    }
    return result;
  };
  const listed = await f.request('_goose/unstable/session/extensions/list', { sessionId: f.sessionId });
  assert.ok(listed.extensions.some(e => e.name === 'developer'));
});

test('readiness errors other than changed snapshots are surfaced without model execution or retry', async t => {
  const f = await fixture(t);
  let preparations = 0;
  f.setInitializer(async () => { preparations++; throw Error('Invalid fixture credentials'); });
  await assert.rejects(f.prompt('你好'), /Invalid fixture credentials/);
  assert.equal(preparations, 1);
  assert.equal(f.compat.runs.latest(f.sessionId), null, 'a rejected preparation never starts a Harness run');
});

test('historical verification receipts do not certify later native work in a resumed run', async t => {
  const f = await fixture(t);
  const run = await f.compat.runs.create({ sessionId: f.sessionId, goal: 'Continue existing work', sourceMessageId: 'old-message', executionOwner: 'harness' });
  const binding = { sessionId: f.sessionId, runId: run.runId };
  const { attemptId } = await f.compat.runs.beginAttempt({ ...binding, sourceMessageId: 'old-message' });
  await f.compat.runs.recordToolStart({ ...binding, attemptId, callId: 'old-check', name: 'pwsh' });
  await f.compat.runs.recordToolResult({ ...binding, attemptId, callId: 'old-check', kind: 'verification', command: 'node --test', exitCode: 0, outcome: 'succeeded' });
  await f.compat.runs.finishHarnessAttempt({ ...binding, attemptId, aborted: true });
  f.scripts.push(async ({ onPermission, onEvent }) => {
    assert.equal(await onPermission({ id: 'new-write', name: 'write_file', arguments: { path: 'new-module.mjs', content: 'export const value = 1;' } }), true);
    await onEvent({ type: 'tool_result', id: 'new-write', result: 'written' });
    return { stopReason: 'end_turn', reason: { kind: 'completed' } };
  });
  await f.prompt('继续开发');
  const terminal = f.notices.map(n => n.params.update?.status?.data).find(d => d?.terminal_message_id);
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.report.verification_summary.length, 1, 'history remains visible');
  assert.equal(terminal.report.classification_counts.unverified, 1, 'old checks do not certify new work');
  assert.ok(terminal.report.limitations.length > 0);
});
