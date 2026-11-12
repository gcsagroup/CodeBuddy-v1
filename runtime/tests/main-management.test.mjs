import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { inspectMainWorkspace, managementTools } from '../main-management.mjs';
import { permissionDriver } from './fixtures/permission-driver.mjs';

test('progress returns JSON-safe native receipts with original time and command output', async () => {
  const result = { type: 'tool/result', seq: 16, time: 1794412694980, data: { message: {
    toolCallId: 'git-log', isError: false, content: [{ type: 'text', text: '49d83910f latest commit' }],
  } } };
  const host = {
    store: { readSession: () => ({ id: 'repo-chat', cwd: '/repo' }) },
    driver: { history: async () => ({ events: [
      { type: 'tool/call', data: { callId: 'git-log', name: 'pwsh' } }, result,
      { ...result, seq: 17, data: { message: { ...result.data.message, toolCallId: 'unpaired' } } },
    ] }) },
  };
  const page = await inspectMainWorkspace(host, {}, { operation: 'receipts', sessionId: 'repo-chat' });
  assert.deepEqual(JSON.parse(JSON.stringify(page)), page);
  assert.deepEqual(page.receipts.map(r => r.tool), [null, 'pwsh']);
  assert.equal(page.receipts[1].time, result.time);
  assert.equal(page.receipts[1].excerpt, '49d83910f latest commit');
});

test('a current lookup question is not prior history after clearing the main chat', async () => {
  const row = { id: 'main', nativeSessionId: 'fresh', conversationEdits: [{ cleared: true }] };
  const host = { store: { readSession: () => row },
    active: new Map([['main', { replay: { users: [{ messageId: 'question' }] } }]]),
    driver: { history: async () => ({ events: [{ type: 'user/message', seq: 1,
      data: { source: { kind: 'user', rpcId: 'question' }, content: [{ type: 'text', text: 'What was the password?' }] } }] }) } };
  const page = await inspectMainWorkspace(host, row, { operation: 'history', query: 'password' });
  assert.deepEqual(page.messages, []);
  assert.equal(page.status, 'empty_after_clear');
  assert.equal(page.priorUserMessages, 0);
});

test('main chat changes only the approved project and conversation, including across restart', async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'main-management-')));
  const store = await openStore(dir);
  await store.update(state => {
    state.providers = [{ id: 'local', models: ['local'], displayName: 'Local', engine: 'openai_compatible', apiUrl: 'http://127.0.0.1:1', requiresAuth: false }];
    state.defaults = { providerId: 'local', modelId: 'local' };
  });
  const driver = {
    permissions: permissionDriver(),
    withConversationLock: async (_id, callback) => callback(),
    close: async () => {},
  };
  const host = new Compat(store, driver);
  host.managedWorkspaceRoot = path.join(dir, 'workspaces');
  await mkdir(host.managedWorkspaceRoot);
  const main = host.session((await host.request('_codebuddy/main-conversation/ensure', {}, { notify() {} })).sessionId);
  let allow = true;
  const connection = { ask: async (_method, params) => ({ outcome: { outcome: 'selected',
    optionId: allow ? params.options.find(o => o.kind === 'allow_once').optionId : 'reject_once' } }) };
  host.active.set(main.id, { connection });
  const [inspect, manage] = managementTools(host, main);
  const context = { sessionId: main.id, signal: new AbortController().signal, callId: 'test' };
  const change = (operation, args) => manage.execute({ operation, ...args }, context);
  const create = folder => change('create_project', { folder, title: '官网' });
  const a = await create('east'), b = await create('west');
  assert.notEqual(a.projectId, b.projectId);
  assert.equal((await create('east')).projectId, a.projectId);
  await assert.rejects(create('../outside'));
  const chat = (projectId, requestId) => change('create_chat', { projectId, requestId, title: '开发' });
  const ca = await chat(a.projectId, 'east-chat'), cb = await chat(b.projectId, 'west-chat');
  assert.equal(store.readSession(ca.sessionId).workspaceOrigin, 'selected');
  await store.updateSession(ca.sessionId, row => { delete row.workspaceOrigin; });
  const listed = await host.request('session/list', {}, { notify() {} });
  assert.equal(listed.sessions.find(row => row.sessionId === ca.sessionId)._meta.workspaceOrigin, 'selected');
  const ambiguous = { sessionId: cb.sessionId, mode: 'read-only' };
  assert.equal((await change('set_chat_permission', ambiguous)).changed, false);
  assert.equal((await change('set_chat_permission', { sessionId: cb.sessionId, projectId: b.projectId })).changed, false);
  assert.equal(store.readSession(cb.sessionId).permissionOverride, undefined);
  host.active.get(main.id).userMessages = ['Use the west project'];
  assert.equal((await change('set_chat_permission', { ...ambiguous, projectId: b.projectId })).selected, 'read-only');
  await change('set_chat_permission', { ...ambiguous, projectId: b.projectId, mode: 'inherit' });
  assert.equal((await chat(a.projectId, 'east-chat')).sessionId, ca.sessionId);
  await assert.rejects(chat(b.projectId, 'east-chat'));
  await assert.rejects(change('rename_chat', { projectId: a.projectId, sessionId: cb.sessionId, title: '错' }));
  const inspectProgress = query => inspect.execute({ operation: 'progress', query }, context);
  assert.equal((await inspectProgress('官网')).needsSelection, true);
  const nativeEvents = [];
  driver.history = async id => {
    return { events: nativeEvents.filter(e => e.chat === id) };
  };
  const dispatch = () => change('dispatch_chat', { sessionId: cb.sessionId, requestId: 'milestone-1', task: '完成里程碑' });
  let starts = 0;
  const finish = Promise.withResolvers();
  const reported = Promise.withResolvers();
  host.connections.add({ notify(method, params) {
    if (params.update?.status?.data?.event === 'managed_turn_result') reported.resolve({ method, params });
  } });
  host.prompt = async (params, delivery) => {
    starts++;
    const rpcId = params._meta['codeagentpro/source-message-id'];
    nativeEvents.push({ chat: params.sessionId, type: 'user/message', seq: 1, time: 123, data: { content: params.prompt, source: { kind: 'user', rpcId } } });
    await store.updateSession(params.sessionId, row => { row.messageCount = 1; });
    delivery.notify('session/update', { sessionId: params.sessionId, update: { _meta: { 'codebuddy/agent-input': { requestId: rpcId } } } });
    if (params.sessionId === cb.sessionId) {
      await finish.promise;
      delivery.notify('_goose/unstable/session/update', { sessionId: cb.sessionId, update: {
        sessionUpdate: 'status_message', status: { type: 'progress', data: {
          terminal_message_id: 'terminal:1', source_user_message_id: rpcId, session_id: cb.sessionId,
          status: 'completed', finished_at: new Date().toISOString(),
        } } } });
    }
    return { stopReason: 'end_turn' };
  };
  assert.equal((await dispatch()).status, 'accepted');
  assert.equal((await dispatch()).sessionId, cb.sessionId);
  assert.equal(starts, 1);
  assert.equal(store.readSession(main.id).usageUpdates?.length ?? 0, 0);
  const append = (type, data) => nativeEvents.push({ chat: cb.sessionId, type, data });
  append('tool/call', { name: 'write', callId: 'write' });
  append('tool/result', { message: { toolCallId: 'write', isError: false, content: [] }, meta: { path: path.join(b.directories[0], 'first.txt') } });
  append('assistant/message', { message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: '第一轮的交付结果' }] } });
  append('turn/end', {});
  finish.resolve();
  assert.equal((await reported.promise).params.sessionId, main.id);
  assert.equal(store.readSession(main.id).usageUpdates.filter(u => u.status?.data?.event === 'managed_turn_result').length, 1);
  const briefNotice = (await reported.promise).params.update.status;
  assert.equal(briefNotice.data.title, '开发');
  assert.doesNotMatch(briefNotice.message, /本轮任务已完成/);
  const rpc = (detailSessionId, requestId) => host.request('_codebuddy/main-conversation/overview',
    { sessionId: main.id, detailSessionId, requestId }, { notify() {} });
  assert.equal(briefNotice.data.brief.result, '第一轮的交付结果');
  assert.deepEqual(store.readSession(main.id).usageUpdates.find(u => u.status?.data?.requestId === briefNotice.data.requestId).status.data.brief,
    briefNotice.data.brief);
  append('assistant/message', { message: { content: [{ type: 'text', text: '下一轮的交付结果' }] } });
  assert.deepEqual(await rpc(cb.sessionId, briefNotice.data.requestId), {
    title: '开发', task: '完成里程碑', result: '第一轮的交付结果', files: ['first.txt'], fileCount: 1,
  });
  await assert.rejects(rpc(ca.sessionId, briefNotice.data.requestId), /does not belong/);
  await assert.rejects(rpc(cb.sessionId, 'other-assignment'), /does not belong/);
  const details = await inspectProgress('west');
  assert.equal(details.chats[0].recentRequests[0].text, '完成里程碑');
  assert.equal(details.chats[0].sessionId, cb.sessionId);
  const summary = await inspect.execute({ operation: 'progress', sessionId: cb.sessionId, delivery: 'summary' }, context);
  assert.equal(summary.deliverProgress, true);
  assert.equal(host.active.get(main.id).progressReports.get(context.callId).sessionId, cb.sessionId);
  assert.equal(details.deliverProgress, undefined);
  const start = (replyOnAcceptance = false) => change('start_project', { folder: 'drive', title: '云盘', chatTitle: '开发', task: '完成第一步', requestId: 'drive-init', replyOnAcceptance });
  allow = false;
  await assert.rejects(start(), /approved/);
  await assert.rejects(stat(path.join(host.managedWorkspaceRoot, 'drive')), { code: 'ENOENT' });
  allow = true;
  const started = await start();
  assert.equal(started.status, 'accepted');
  assert.equal(started.finishOnAcceptance, false);
  const write = { name: 'write', arguments: { file_path: 'drive/MILESTONE.md' }, nativeCapability: true };
  assert.equal((await host.toolPolicy(main, write)).kind, 'deny');
  const fast = await start(true);
  assert.equal(fast.sessionId, started.sessionId);
  assert.equal(fast.finishOnAcceptance, true);
  assert.equal(starts, 2);
  const defaultDispatch = await change('start_project', { folder: 'drive', title: '云盘', task: '完成第一步', requestId: 'drive-init' });
  assert.equal(defaultDispatch.finishOnAcceptance, true);
  assert.equal(defaultDispatch.sessionId, started.sessionId);
  host.active.get(main.id).userMessages.push('A new user instruction');
  assert.equal((await host.toolPolicy(main, write)).kind, 'deny');
  assert.equal((await host.toolPolicy(main, { ...write, arguments: { file_path: 'local-note.txt' } })).kind, 'deny');
  await change('work_here', { task: 'Write a standalone local note' });
  assert.notEqual((await host.toolPolicy(main, { ...write, arguments: { file_path: 'local-note.txt' } })).kind, 'deny');
  allow = false;
  await assert.rejects(change('rename_chat', { sessionId: cb.sessionId, title: '错' }));
  allow = true;
  await change('rename_chat', { sessionId: cb.sessionId, title: '修订' });
  await change('rename_project', { projectId: b.projectId, title: '官网西区' });
  await change('archive_chat', { sessionId: cb.sessionId });
  assert.ok(store.readSession(cb.sessionId).archivedAt);
  await change('restore_chat', { sessionId: cb.sessionId });
  assert.equal(store.readSession(cb.sessionId).archivedAt, null);
  const mode = (host, id) => host.permissionModes(host.session(id)).then(r => r.currentModeId);
  const preset = (id, mode) => change('set_chat_permission', { sessionId: id, mode });
  const original = await mode(host, ca.sessionId);
  host.active.set(cb.sessionId, { permissionOverride: undefined });
  assert.equal((await preset(cb.sessionId, 'read-only')).applies, 'next turn');
  assert.equal(await mode(host, cb.sessionId), original);
  host.active.delete(cb.sessionId);
  assert.equal(await mode(host, cb.sessionId), 'read-only');
  assert.equal(await mode(host, ca.sessionId), original);
  assert.equal(store.readSession(ca.sessionId).title, '开发');
  await host.request('session/set_mode', {sessionId: ca.sessionId, modeId: 'danger-full-access'}, {});
  allow = false;
  const direct = await create('full-access');
  const directChat = await chat(direct.projectId, 'explicit-chat');
  await change('rename_chat', { sessionId: directChat.sessionId, title: '改名' });
  await assert.rejects(preset(directChat.sessionId, 'read-only'), /approved/);
  await change('delete_chat', { sessionId: directChat.sessionId });
  await change('remove_project', { projectId: direct.projectId });
  assert.ok((await stat(direct.directories[0])).isDirectory());
  assert.equal((await start()).status, 'accepted');
  assert.equal((await dispatch()).status, 'accepted');
  allow = true;
  assert.equal(await mode(host, cb.sessionId), 'read-only');
  const overview = await inspect.execute({ operation: 'overview', projectId: b.projectId }, context);
  assert.deepEqual(overview.chats.map(c => c.title), ['修订']);
  await assert.rejects(manage.execute({ operation: 'create_project' }, { ...context, sessionId: cb.sessionId }));
  const reopened = new Compat(await openStore(dir), { ...driver, permissions: permissionDriver() });
  assert.equal(await mode(reopened, cb.sessionId), 'read-only');
  assert.equal(await mode(reopened, ca.sessionId), 'danger-full-access');
  await preset(cb.sessionId, 'inherit');
  assert.equal(await mode(host, cb.sessionId), 'danger-full-access');
  host.active.set(cb.sessionId, {});
  await assert.rejects(change('delete_chat', { sessionId: cb.sessionId }), /Stop the session/);
  host.active.delete(cb.sessionId);
  await change('delete_chat', { sessionId: cb.sessionId });
  assert.equal(store.isSessionDeleted(cb.sessionId), true);
  assert.equal(store.readSession(ca.sessionId).title, '开发');
  const keep = path.join(b.directories[0], 'keep.txt');
  await writeFile(keep, 'user file');
  await change('remove_project', { projectId: b.projectId });
  assert.equal(await readFile(keep, 'utf8'), 'user file');
  assert.ok((await stat(a.directories[0])).isDirectory());
  const originalFolder = path.join(main.cwd, 'resumed-drive');
  await mkdir(originalFolder);
  const existingFile = path.join(originalFolder, 'models.py');
  await writeFile(existingFile, 'original models');
  host.active.get(main.id).resumedRequestId = 'original-request';
  nativeEvents.push(...[
    { type: 'user/message', data: { source: { kind: 'user', rpcId: 'original-request' } } },
    { type: 'tool/call', data: { callId: 'file', name: 'write' } },
    { type: 'tool/result', data: { meta: { path: existingFile }, message: { toolCallId: 'file', isError: false } } },
    { type: 'turn/end' },
  ].map(e => ({ ...e, chat: main.id })));
  const resume = folder => change('start_project', { folder, title: '网盘', requestId: 'resume-drive', task: '继续开发' });
  await assert.rejects(resume('other-drive'), /original project folder/);
  const resumed = await resume('resumed-drive');
  assert.equal(resumed.directory, originalFolder);
  assert.equal((await resume('resumed-drive')).sessionId, resumed.sessionId);
  assert.equal(await readFile(existingFile, 'utf8'), 'original models');
  assert.match(nativeEvents.find(e => e.chat === resumed.sessionId && e.type === 'user/message').data.content[0].text, /models\.py/);
  await assert.rejects(stat(path.join(host.managedWorkspaceRoot, 'resumed-drive')), { code: 'ENOENT' });
  host.active.delete(main.id);
  await host.close();
  await reopened.close();
});
