import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { sessionLogDiagnostics } from '../session-log-diagnostics.mjs';
import { publicRpcError } from '../error-presentation.mjs';

test('diagnostic download uses mapped history without modifying the complete native journal', { timeout: 30000 }, async t => {
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
  assert.equal(rows[0].type, 'log-export');
  assert.equal(rows[0].restorable, false);
  assert.doesNotMatch(response.data, /日志导出|DO_NOT_EXPORT/);
  assert.equal(rows[0].session.id, 'native-current');
  assert.equal(response.data.includes(root), false);
  const files = await readdir(path.join(dataDir, 'sessions'), { recursive: true });
  const journal = files.find(file => file.includes('native-current') && file.endsWith('session.v4.jsonl'));
  const original = await readFile(path.join(dataDir, 'sessions', journal), 'utf8');
  assert.ok(original.includes('日志导出 🙂'));
  assert.deepEqual(JSON.parse((await native.exportSessionLog('native-current')).split('\n')[0]).id, 'native-current');
  const events = original.trimEnd().split('\n').map(JSON.parse).slice(1);
  assert.equal(rows[0].eventCount, events.length);
  assert.deepEqual(rows.slice(1).map(e=>e.seq), events.map(e=>e.seq));
  assert.equal(await readFile(path.join(dataDir, 'sessions', journal), 'utf8'), original);
  const detailed = await request().request('_goose/unstable/session/log/export', { sessionId: 'product-id', detail: 'detailed' });
  assert.equal(JSON.parse(detailed.data.split('\n')[0]).detail, 'detailed');
  assert.equal(await readFile(path.join(dataDir, 'sessions', journal), 'utf8'), original);
  await assert.rejects(request().request('_goose/unstable/session/log/export', { sessionId: 'product-id', detail: 'raw' }), error => error.code === -32602);
  const beforeImport = store.read().sessions.length;
  await assert.rejects(request().request('_goose/unstable/session/import', { source: 'json', input: response.data }),
    error => error.code === -32602);
  assert.equal(store.read().sessions.length, beforeImport, 'diagnostics cannot create a resumable conversation');
  await native.close();
  native = await createHarnessDriver({ dataDir, cwd: root });
  assert.equal((await request().request('_goose/unstable/session/log/export', { sessionId: 'product-id' })).data, response.data);
  await assert.rejects(request().request('_goose/unstable/session/log/export', { sessionId: 'legacy' }), /没有 Harness 日志/);
  await assert.rejects(request().request('_goose/unstable/session/log/export', { sessionId: 'empty' }), /无法导出会话日志/);
  await assert.rejects(request().request('_goose/unstable/session/log/export', { sessionId: '../native-current' }), /Session not found|Unknown session/i);
  for (const mode of ['read', 'parse']) {
    t.mock.method(native, 'exportSessionLog', async () => {
      if(mode==='read')throw Error('ENOENT C:/PRIVATE_CANARY/key.txt');
      return '{"PRIVATE_CANARY":';
    });
    const error=await request().request('_goose/unstable/session/log/export', { sessionId:'product-id' }).catch(e=>e);
    assert.equal(error.code,-32603);
    assert.match(error.message,/完整历史已保留/);
    assert.doesNotMatch(JSON.stringify(publicRpcError(error,'_goose/unstable/session/log/export')),/PRIVATE_CANARY|ENOENT/);
    t.mock.restoreAll();
  }
});

test('diagnostics retain event correlation and safe failure facts without arbitrary text or metadata', () => {
  const secret='PRIVATE_CANARY', message={id:secret,source:{replayState:{token:secret}},content:[{type:'text',text:secret}]};
  const input=[{type:'session',id:secret,cwd:secret,createdAt:secret},
    {type:'tool/call',seq:0,time:1000,data:{turn:1,callId:secret,name:secret,arguments:secret,headers:{authorization:secret}}},
    {type:'tool/result',seq:1,time:1010,data:{turn:1,message:{...message,toolCallId:secret,isError:true},error:{code:'AUTH',status:401,message:secret,cause:{url:secret}}}},
    {type:'llm/retry',seq:2,time:1020,data:{maxRetries:5,failure:{code:'TIMEOUT',message:secret},unknown:{token:secret}}},
    {type:'turn/end',seq:3,time:1030,data:{turn:1,reason:{kind:'error',error:{code:'SERVER',status:504,message:secret}}}},
    {type:secret,seq:4,time:1040,data:{reason:{kind:secret},id:secret,model:secret,status:secret}},
    {type:'compaction/end',seq:5,time:1050,data:{error:secret}},
    {type:'tool/result',seq:6,time:1060,data:{message:{...message,isError:true},error:{code:'TOOL_OUTCOME_UNKNOWN',message:secret}}},
    {type:'turn/end',seq:7,time:1070,data:{reason:{kind:'interrupted'}}},
  ];
  const original=JSON.stringify(input), text=sessionLogDiagnostics(input.map(r=>JSON.stringify(r)).join('\n'));
  assert.doesNotMatch(text,/PRIVATE_CANARY|authorization|replayState/);
  const rows=text.trim().split('\n').map(JSON.parse);
  assert.equal(rows[1].data.callId,rows[2].data.callId);
  assert.equal(rows[2].data.diagnostic.code,'AUTH');assert.equal(rows[2].data.diagnostic.httpStatus,401);
  assert.equal(rows[3].data.diagnostic.code,'TIMEOUT');assert.equal(rows[4].data.diagnostic.httpStatus,504);
  assert.notEqual(rows[5].type,secret);assert.equal(rows[5].data.reason,undefined);
  assert.equal(rows[6].data.diagnostic.code,'UNKNOWN_FAILURE');
  assert.equal(rows[7].data.diagnostic.code,'TOOL_OUTCOME_UNKNOWN');
  assert.equal(rows[8].data.reason,'interrupted');
  assert.equal(rows[2].elapsedMs,10);assert.equal(JSON.stringify(input),original);
});
