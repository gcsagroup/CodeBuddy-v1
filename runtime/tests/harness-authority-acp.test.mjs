import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Compat } from '../compat.mjs';
import { openStore } from '../store.mjs';
import { workspaceIdentity } from '../workspaces.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-authority-acp-'));
  const store = await openStore(path.join(root, 'data'));
  await store.update(state => {
    state.providers = [{ id: 'fixture', engine: 'openai_compatible', apiUrl: 'http://127.0.0.1:1', models: ['fixture'], requiresAuth: false }];
    state.defaults = { providerId: 'fixture', modelId: 'fixture' };
    state.preferences.gooseMode = 'auto';
  });
  const notices = [], sessions = [], scripts = [];
  let initialize = async input => { sessions.push(input); };
  const driver = {
    createSession: input => initialize(input), listTools: async () => [], cancel: async () => {}, close: async () => {},
    prompt: async (id, content, callbacks) => scripts.shift()(callbacks),
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
