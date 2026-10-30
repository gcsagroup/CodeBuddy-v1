import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';

test('export uses the mapped native journal, preserves events and works after restart', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-log-export-'));
  const dataDir = path.join(root, 'harness');
  let native = await createHarnessDriver({ dataDir, cwd: root });
  t.after(() => native.close());
  await native.permissions('native-current', { cwd: root });
  await native.rename('native-current', '日志导出 🙂');
  await native.permissions('unrelated', { cwd: root });
  await native.rename('unrelated', 'DO_NOT_EXPORT');
  const store = await openStore(path.join(root, 'store'));
  await store.update(state => { state.sessions.push(
    { id: 'product-id', nativeSessionId: 'native-current', cwd: root },
    { id: 'legacy', readonlyHistory: true, cwd: root },
    { id: 'empty', cwd: root },
  ); });
  const request = () => new Compat(store, createConversationDriver(native, store));
  const response = await request().request('_goose/unstable/session/log/export', { sessionId: 'product-id' });
  const rows = response.data.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(rows[0].type, 'session');
  assert.equal(rows[0].id, 'native-current');
  assert.ok(response.data.includes('日志导出 🙂'));
  assert.ok(!response.data.includes('DO_NOT_EXPORT'));
  const files = await readdir(path.join(dataDir, 'sessions'), { recursive: true });
  const journal = files.find(file => file.includes('native-current') && file.endsWith('session.v4.jsonl'));
  assert.deepEqual(rows, (await readFile(path.join(dataDir, 'sessions', journal), 'utf8')).trimEnd().split('\n').map(JSON.parse));
  await native.close();
  native = await createHarnessDriver({ dataDir, cwd: root });
  assert.equal((await request().request('_goose/unstable/session/log/export', { sessionId: 'product-id' })).data, response.data);
  await assert.rejects(request().request('_goose/unstable/session/log/export', { sessionId: 'legacy' }), /没有 Harness 日志/);
  await assert.rejects(request().request('_goose/unstable/session/log/export', { sessionId: 'empty' }), /尚无 Harness 日志/);
  await assert.rejects(request().request('_goose/unstable/session/log/export', { sessionId: '../native-current' }), /Session not found|Unknown session/i);
});
