import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCompatServer } from '../server.mjs';
import { workspaceIdentity } from '../workspaces.mjs';

const ext = name => `_goose/unstable/${name}`;
const secret = 'conversation-editing-isolated-acp-fixture';
async function connect(url) {
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let next = 0; const pending = new Map(), notifications = [];
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data)), request = pending.get(message.id);
    if (request) { pending.delete(message.id); clearTimeout(request.timeout); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); return; }
    notifications.push(message);
    if (message.method === 'session/request_permission') ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }));
  });
  return { notifications, close: () => ws.close(), request(method, params = {}) { return new Promise((resolve, reject) => { const id = ++next; const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out ${method}`)); }, 20_000); pending.set(id, { resolve, reject, timeout }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }); } };
}

test('real ACP CodePro edit cancels the old run, keeps file effects and logs, and starts a fresh run on the same UI identity', { timeout: 40_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codebuddy-acp-edit-')));
  const cwd = join(directory, 'project'), dataDir = join(directory, 'data'), output = join(cwd, 'retained-effect.txt');
  const requests = [], counts = { original: 0, replaced: 0 }, failures = [], titleRequests = [];
  const model = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'edit-model' }] })); return; }
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      if (request.stream !== true) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'fixture-test', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })); return; }
      if (request.messages.some(message => message.role === 'system' && JSON.stringify(message.content).includes('Summarize the supplied first conversation turn'))) {
        titleRequests.push(request);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'title-fixture', object: 'chat.completion.chunk', model: 'edit-model', choices: [{ index: 0, delta: { role: 'assistant', content: '文件修改与恢复' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      requests.push(request);
      const text = [...request.messages].reverse().find(m => m.role === 'user' && /ACP_EDIT_(ORIGINAL|REPLACED)/.test(JSON.stringify(m.content)));
      const mode = JSON.stringify(text?.content).includes('ACP_EDIT_REPLACED') ? 'replaced' : 'original';
      const step = counts[mode]++;
      let tool;
      if (step === 0) tool = mode === 'original'
        ? { name: 'create_goal', arguments: { objective: 'Retain file effects until the user edits this task' } }
        : { name: 'todo_write', arguments: { todos: [{ content: 'replaced task', status: 'pending' }] } };
      else if (mode === 'original' && step === 1) tool = { name: 'write', arguments: { file_path: output, content: 'Existing file effects survive conversation edits.\n' } };
      else if (mode === 'original' && step === 2) {
        const goal = request.messages.filter(m => m.role === 'tool').flatMap(m => {
          try { const value = JSON.parse(typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join('')); return value.goal ? [value.goal] : []; } catch { return []; }
        }).at(-1);
        assert.ok(goal, 'The fixture consumes the actual official goal identity');
        tool = { name: 'update_goal', arguments: { action: 'pause', goal_id: goal.id, revision: goal.revision } };
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: 'edit-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (tool) { emit({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }); emit({}, 'tool_calls'); }
      else { emit({ role: 'assistant', content: `${mode} fixture left its task open for user control.` }); emit({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const app = await createCompatServer({ dataDir, secret });
  const client = await connect(await app.listen());
  t.after(async () => { client.close(); await app.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); });
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  // This fixture exercises native execution, not the optional bundled MCP binary.
  await client.request(ext('config/extensions/set-enabled'), { configKey: 'commonqueries', enabled: false });
  const provider = await client.request(ext('providers/custom/create'), { engine: 'openai_compatible', displayName: 'Conversation fixture', apiUrl: `http://127.0.0.1:${model.address().port}`, requiresAuth: false, models: ['edit-model'], supportsStreaming: true, headers: {} });
  await client.request(ext('defaults/save'), { providerId: provider.providerId, modelId: 'edit-model' });
  // A brand-new main conversation has no native session yet. Clearing it must
  // initialize safely and keep the singleton identity through the ACP route.
  const main = await client.request('_codebuddy/main-conversation/ensure');
  await client.request('_codebuddy/main-conversation/clear', { sessionId: main.sessionId });
  assert.equal((await client.request('_codebuddy/main-conversation/ensure')).sessionId, main.sessionId);
  const lease = await client.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd) });
  const session = await client.request('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId } });
  const id = session.sessionId, userId = randomUUID();
  assert.equal((JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'))).sessions.find(s => s.id === id).title, '新对话');
  const prompt = (text, sourceId) => client.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text }], _meta: { 'codeagentpro/source-message-id': sourceId } });
  assert.equal((await prompt('ACP_EDIT_ORIGINAL develop a temporary file', userId)).stopReason, 'end_turn');
  const stored = () => readFile(join(dataDir, 'state.json'), 'utf8').then(JSON.parse);
  const before = await stored(), oldRun = before.codeproRuns.at(-1), source = before.sessions.find(s => s.id === id);
  assert.equal(source.title, '文件修改与恢复');
  assert.equal(titleRequests.length, 1);
  assert.match(JSON.stringify(titleRequests[0].messages), /original fixture left its task open/);
  const oldSnapshot = client.notifications.filter(m => m.method === ext('codepro/run/update')).at(-1).params.snapshot;
  assert.equal(oldSnapshot.state, 'paused');
  assert.ok(oldRun.events.some(e => e.eventType === 'harness_event' && e.payload.event.type === 'goal/change'));
  assert.ok(oldRun.events.some(e => e.eventType === 'tool_result' && e.payload.outcome === 'succeeded'));
  assert.equal(await readFile(output, 'utf8'), 'Existing file effects survive conversation edits.\n');
  await client.request(ext('session/conversation/truncate'), { sessionId: id, truncateFrom: source.updates.find(u => u.messageId === userId)._meta.goose.created });
  const edited = await stored(), newSource = edited.sessions.find(s => s.id === id), cancelled = edited.codeproRuns.find(r => r.runId === oldRun.runId);
  assert.notEqual(newSource.nativeSessionId, id); assert.equal(newSource.updates.length, 0);
  assert.deepEqual(cancelled.events.slice(0, oldRun.events.length), oldRun.events);
  assert.equal(cancelled.events.at(-1).eventType, 'run_cancelled');
  assert.equal(await readFile(output, 'utf8'), 'Existing file effects survive conversation edits.\n');
  assert.equal((await prompt('ACP_EDIT_REPLACED inspect retained files before a different task', randomUUID())).stopReason, 'end_turn');
  const after = await stored(), newRun = after.codeproRuns.at(-1);
  assert.notEqual(newRun.runId, oldRun.runId); assert.equal(newRun.sessionId, id);
  const latest = client.notifications.filter(m => m.method === ext('codepro/run/update')).at(-1).params.snapshot;
  assert.equal(latest.runId, newRun.runId); assert.equal(latest.tasks[0].name, 'replaced task');
  assert.equal(after.sessions.filter(s => s.id === id).length, 1);
  assert.match(JSON.stringify(requests.at(-1).messages), /ACP_EDIT_REPLACED/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /ACP_EDIT_ORIGINAL/);
  const activity = client.notifications
    .filter(notification => notification.method === ext('session/update'))
    .map(notification => notification.params.update.status?.data)
    .filter(data => data?.event === 'execution_activity');
  assert.ok(activity.length > 0);
  assert.ok(activity.every(data => data.child_count === 0), 'Neither original nor edited turn delegated any child work');
  assert.deepEqual(failures, []); assert.deepEqual(counts, { original: 4, replaced: 2 });
});
