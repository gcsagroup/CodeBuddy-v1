import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCompatServer } from '../server.mjs';
import { workspaceIdentity } from '../workspaces.mjs';
import { zUpdateWorkingDirRequest_unstable } from '../../ui/sdk/src/generated/zod.gen.ts';

const secret = 'directory-controlled-acp', ext = name => `_goose/unstable/${name}`;
async function connect(url) {
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`), pending = new Map(); let seq = 0;
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data)), item = pending.get(message.id);
    if (!item) { if (message.method === 'session/request_permission') ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } })); return; }
    pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result);
  });
  return { close: () => ws.close(), request(method, params = {}) { return new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error(`RPC timeout ${method}`)); }, 20_000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }); } };
}

// Allow cumulative native Keychain latency across directory changes and restart;
// individual ACP request deadlines remain unchanged.
test('ordinary ACP directory switch rebinds tools, project memory and stdio MCP, preserves history after restart and rejects CodePro/read-only/active changes', { timeout: process.platform === 'darwin' ? 180_000 : 60_000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy-directory-acp-'))), dirA = path.join(root, 'a'), dirB = path.join(root, 'b');
  await mkdir(dirA); await mkdir(dirB);
  const script = path.join(root, 'mcp.mjs');
  await writeFile(script, String.raw`import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; import {createInterface} from 'node:readline';
writeFileSync(join(process.cwd(),'mcp-pid.json'),JSON.stringify({pid:process.pid,cwd:process.cwd()}));
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!('id'in m))return;let result;
if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'cwd-fixture',version:'1'}};
else if(m.method==='tools/list')result={tools:[{name:'where',description:'Report actual process directory',inputSchema:{type:'object',properties:{}}}]};
else if(m.method==='tools/call')result={content:[{type:'text',text:process.cwd()}],structuredContent:{cwd:process.cwd(),pid:process.pid}};
else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unknown method'}})+'\n');return;}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');});`);
  const requests = [], slow = Promise.withResolvers();
  const model = createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
    let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw);
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })); return; }
    requests.push(body); res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'cwd-acp', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (JSON.stringify(body.messages).includes('SLOW_DIRECTORY_TURN')) { emit({ role: 'assistant', content: 'waiting' }); slow.resolve(); return; }
    emit({ role: 'assistant', content: 'Directory fixture answer' }); emit({}, 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  let app = await createCompatServer({ dataDir: path.join(root, 'data'), secret }), client = await connect(await app.listen());
  t.after(async () => { client.close(); await app.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); });
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const { providerId } = await client.request(ext('providers/custom/create'), { engine: 'openai_compatible', displayName: 'Directory fixture', apiUrl: `http://127.0.0.1:${model.address().port}`, requiresAuth: false, models: ['fixture'], headers: {}, supportsStreaming: true });
  await client.request(ext('defaults/save'), { providerId, modelId: 'fixture' });
  const { sessionId } = await client.request('session/new', { cwd: dirA, mcpServers: [{ name: 'probe', command: process.execPath, args: [script], env: [] }], _meta: { enabledExtensions: ['developer', 'projectmemory', 'probe'] } });
  const tool = async (name, args) => client.request(ext('tools/call'), { sessionId, name, arguments: args });
  const move = async workingDir => client.request(ext('session/working-dir/update'), zUpdateWorkingDirRequest_unstable.parse({ sessionId, workingDir }));
  await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'ORIGINAL_DIRECTORY_HISTORY' }] });
  const first = JSON.parse(await readFile(path.join(dirA, 'mcp-pid.json'), 'utf8'));
  const retained = await tool('projectmemory__project_memory', { action: 'retain', subject: 'A only', content: 'A_PRIVATE_PROJECT_MEMORY' }); assert.equal(retained.isError, false);
  const record = retained.structuredContent.record;
  await client.request(ext('codepro/memory/status'), { schemaVersion: 1, workingDir: dirA, id: record.id, actionId: 'approve-a', targetStatus: 'active', expectedStatus: record.status, expectedUpdatedAt: record.updatedAt, reviewFingerprint: record.reviewFingerprint });
  assert.equal((await tool('projectmemory__project_memory', { action: 'recall' })).structuredContent.records.length, 1);
  await move(dirB); assert.throws(() => process.kill(first.pid, 0), /ESRCH/, 'retired native MCP process must stop');
  assert.equal((await tool('developer__write', { file_path: 'new.txt', content: 'B workspace' })).isError, false);
  assert.equal(await readFile(path.join(dirB, 'new.txt'), 'utf8'), 'B workspace'); await assert.rejects(access(path.join(dirA, 'new.txt')));
  assert.equal((await tool('projectmemory__project_memory', { action: 'recall' })).structuredContent.records.length, 0, 'new directory must not recall A project memory');
  const where = await tool('probe__where', {}); assert.equal(where.isError, false); assert.equal(where.structuredContent.cwd, dirB);
  assert.notEqual(where.structuredContent.pid, first.pid);
  await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'AFTER_DIRECTORY_CHANGE' }] });
  assert.match(JSON.stringify(requests.at(-1).messages), /ORIGINAL_DIRECTORY_HISTORY/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages.filter(message => message.role === 'system')), /A_PRIVATE_PROJECT_MEMORY/);
  client.close(); await app.close(); app = await createCompatServer({ dataDir: path.join(root, 'data'), secret }); client = await connect(await app.listen());
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal((await tool('developer__write', { file_path: 'restart.txt', content: 'B after restart' })).isError, false);
  assert.equal(await readFile(path.join(dirB, 'restart.txt'), 'utf8'), 'B after restart');
  const exported = JSON.parse((await client.request(ext('session/export'), { sessionId })).data); assert.equal(exported.working_dir, dirB); assert.match(JSON.stringify(exported.conversation), /ORIGINAL_DIRECTORY_HISTORY/);
  const missing = path.join(root, 'does-not-exist'); await assert.rejects(move(missing), /existing directory/); await assert.rejects(access(missing));
  const imported = await client.request(ext('session/import'), { source: 'json', input: JSON.stringify({ name: 'Read only', conversation: [], working_dir: dirA }) });
  await assert.rejects(client.request(ext('session/working-dir/update'), { sessionId: imported.sessionId, workingDir: dirB }), /read-only/);
  const codeDir = path.join(root, 'codepro'); const lease = await client.request(ext('workspace/lease/acquire'), { requestedPath: codeDir, expectedState: 'missing', expectedIdentity: workspaceIdentity(codeDir) });
  const code = await client.request('session/new', { cwd: codeDir, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId } });
  await assert.rejects(client.request(ext('session/working-dir/update'), { sessionId: code.sessionId, workingDir: dirB }), /CodePro workspaces remain bound/);
  const running = client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'SLOW_DIRECTORY_TURN' }] }); await slow.promise;
  await assert.rejects(move(dirA), /Stop the current turn/); await client.request('session/cancel', { sessionId }); assert.equal((await running).stopReason, 'cancelled');
});
