import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../harness/index.mjs';
import { openStore } from '../store.mjs';
import { WorkspaceService } from '../workspaces.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';
import { ConversationEditing } from '../conversation-editing.mjs';
import { createServer } from 'node:http';
import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';

test('edited and copied chats keep reference protection in real foreground and background tools after template changes and restart', {
  skip: process.platform !== 'win32', timeout: 120000,
}, async t => {
  await mkdir(join(process.cwd(), '.local'), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '.local', 'project-permission-review-'));
  const cwd = join(root, 'main'), reference = join(root, 'reference');
  await Promise.all([cwd, reference].map(path => mkdir(path)));
  const target = join(reference, 'keep.txt');
  await writeFile(target, 'ORIGINAL');
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    if (replyToNoActionReview(data, res)) return;
    const lastUser = data.messages.findLastIndex(message => message.role === 'user' && /PARENT_DELEGATE|CHILD_WRITE_REFERENCE|Fixture completed turn/.test(JSON.stringify(message.content)));
    const input = JSON.stringify(data.messages[lastUser]?.content);
    const completed = data.messages.slice(lastUser + 1).some(message => message.role === 'tool');
    let call;
    if (!completed && input?.includes('CHILD_WRITE_REFERENCE')) call = { name: 'write', arguments: JSON.stringify({ file_path: target, content: 'BAD_CHILD' }) };
    else if (!completed && input?.includes('PARENT_DELEGATE')) call = { name: 'subagent', arguments: JSON.stringify({ description: 'Reference permission test', prompt: 'CHILD_WRITE_REFERENCE' }) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ id: 'permission-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit(call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: call }] } : { role: 'assistant', content: 'DONE' }, null);
    emit({}, call ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(async () => { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); });
  let store = await openStore(join(root, 'product'));
  let service = new WorkspaceService(store), driver;
  const setup = async () => {
    const native = await createHarnessDriver({ dataDir: join(root, 'native'), cwd,
      projectFolders: {
        executionFolders: (dir, id) => service.executionFolders(dir, driver.productSessionId(id)),
        writeAccess: (dir, target, id) => service.linkedWriteAccess(dir, target, driver.productSessionId(id)),
      } });
    driver = createConversationDriver(native, store);
  };
  await setup();
  t.after(async () => { await driver.close(); await rm(root, { recursive: true, force: true }); });
  const config = await service.saveProjectFolders({ cwd, version: '', folders: [{ path: reference, access: 'reference' }] });
  await store.update(state => state.sessions.push({ id: 'original', cwd, title: 'Original', type: 'user', globalConversation: true, updates: [], usageUpdates: [] }));
  const input = { cwd, initialPermissionPreset: 'workspace-write', model: 'fixture', provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture' } };
  await driver.createSession({ ...input, sessionId: 'original' });
  await driver.prompt('original', 'Fixture completed turn', { requestId: 'first' });
  await store.updateSession('original', row => { row.updates = [{ sessionUpdate: 'user_message_chunk', messageId: 'first', content: { type: 'text', text: 'Fixture completed turn' } }]; });
  const editing = new ConversationEditing(store, driver, { folderSnapshot: (dir, id) => service.sessionFolderConfig(dir, id) });
  const copy = await editing.request('session/fork', { sessionId: 'original' });
  assert.deepEqual(store.readSession(copy.sessionId).projectFoldersSnapshot, store.readSession('original').projectFoldersSnapshot);
  await service.saveProjectFolders({ cwd, version: config.version, folders: [{ path: reference, access: 'write' }] });
  await editing.request('_codebuddy/main-conversation/clear', { sessionId: 'original' });
  assert.notEqual(driver.nativeSessionId('original'), 'original');
  await driver.close();
  store = await openStore(join(root, 'product')); service = new WorkspaceService(store);
  await setup();
  for (const id of ['original', copy.sessionId]) {
    await driver.createSession({ ...input, sessionId: id });
    const file = await driver.callTool(id, 'write', { file_path: target, content: 'BAD' }, { onPermission: () => true });
    assert.equal(file.isError, true, JSON.stringify(file));
    for (const background of [false, true]) {
      const marker = join(cwd, `${id}-${background}.txt`);
      const command = `$ErrorActionPreference='Stop'; try { Set-Content -LiteralPath '${target}' -Value BAD; Set-Content -LiteralPath '${marker}' -Value LEAKED } catch { Set-Content -LiteralPath '${marker}' -Value DENIED }`;
      const result = await driver.callTool(id, 'pwsh', { command, description: 'Verify frozen reference access', run_in_background: background }, { onPermission: () => true });
      assert.equal(result.isError, false, JSON.stringify(result));
      let text;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try { text = await readFile(marker, 'utf8'); if (text.trim()) break; } catch {}
        await delay(100);
      }
      assert.equal(text?.trim(), 'DENIED');
      assert.equal(await readFile(target, 'utf8'), 'ORIGINAL');
    }
  }
  const events = [];
  await driver.prompt('original', 'PARENT_DELEGATE', { requestId: 'delegate', onPermission: () => true, onEvent: event => events.push(event) });
  assert.ok(events.some(event => event.type === 'subagent_start'), 'A real native child must run');
  assert.ok(events.some(event => event.type === 'tool_result' && event.name === 'write'), 'The child must attempt its write');
  assert.equal(await readFile(target, 'utf8'), 'ORIGINAL');
});

test('real Windows terminal writes only primary and linked writable folders, never reference folders', {
  skip: process.platform !== 'win32', timeout: 120000,
}, async t => {
  // Repository-drive inheritance differs from the user's TEMP ACL. Exercise
  // the actual D: project boundary that exposed the grant preparation failure.
  await mkdir(join(process.cwd(), '.local'), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '.local', 'codebuddy-multi-project-'));
  const primary = join(root, 'main'), linked = join(root, 'linked'), reference = join(root, 'reference');
  await Promise.all([primary, linked, reference].map(path => mkdir(path)));
  await writeFile(join(reference, 'keep.txt'), 'original');
  let writable = [linked];
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: primary,
    projectFolders: { executionFolders: async () => ({ writable, reference: [reference] }) } });
  t.after(async () => { await driver.close(); await rm(root, { recursive: true, force: true }); });
  const { sessionId } = await driver.createSession({ cwd: primary, initialPermissionPreset: 'workspace-write', model: 'fixture',
    provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only' } });
  const result = await driver.callTool(sessionId, 'pwsh', {
    command: `Set-Content -LiteralPath '${join(primary, 'proof.txt')}' -Value MAIN; Set-Content -LiteralPath '${join(linked, 'proof.txt')}' -Value LINKED; Get-Content -LiteralPath '${join(reference, 'keep.txt')}'`,
    description: 'Verify multi-project sandbox',
  }, { onPermission: () => true });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.exitCode, 0, JSON.stringify(result));
  assert.equal((await readFile(join(linked, 'proof.txt'), 'utf8')).trim(), 'LINKED');
  assert.equal((await readFile(join(primary, 'proof.txt'), 'utf8')).trim(), 'MAIN');
  const denied = await driver.callTool(sessionId, 'pwsh', {
    command: `Set-Content -LiteralPath '${join(reference, 'keep.txt')}' -Value CHANGED`, description: 'Verify reference protection',
  }, { onPermission: () => true });
  assert.notEqual(denied.value?.exitCode, 0, JSON.stringify(denied));
  assert.equal(await readFile(join(reference, 'keep.txt'), 'utf8'), 'original');
  const background = await driver.callTool(sessionId, 'pwsh', {
    command: `Set-Content -LiteralPath '${join(linked, 'background.txt')}' -Value BACKGROUND_OK`,
    description: 'Verify linked folder background permissions', run_in_background: true,
  }, { onPermission: () => true });
  assert.equal(background.isError, false, JSON.stringify(background));
  let backgroundText;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { backgroundText = await readFile(join(linked, 'background.txt'), 'utf8'); break; } catch { await delay(100); }
  }
  assert.equal(backgroundText?.trim(), 'BACKGROUND_OK');
  await driver.permissions(sessionId, { cwd: primary, preset: 'danger-full-access' });
  const full = await driver.callTool(sessionId, 'pwsh', {
    command: `Set-Content -LiteralPath '${join(reference, 'keep.txt')}' -Value CHANGED`, description: 'Verify full access cannot bypass reference protection',
  }, { onPermission: () => true });
  assert.equal(full.isError, true, JSON.stringify(full));
  assert.equal(await readFile(join(reference, 'keep.txt'), 'utf8'), 'original');
  writable = [];
  await driver.permissions(sessionId, { cwd: primary, preset: 'workspace-write' });
  const removed = await driver.callTool(sessionId, 'pwsh', {
    command: `Set-Content -LiteralPath '${join(linked, 'proof.txt')}' -Value LEAKED`, description: 'Verify removed membership cannot reuse standing grants',
  }, { onPermission: () => true });
  assert.notEqual(removed.value?.exitCode, 0, JSON.stringify(removed));
  assert.equal((await readFile(join(linked, 'proof.txt'), 'utf8')).trim(), 'LINKED');
});
