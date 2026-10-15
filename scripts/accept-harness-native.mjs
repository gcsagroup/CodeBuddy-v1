// Real configured model, isolated project/profile, official Harness goal lifecycle.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openStore } from '../runtime/store.mjs';
import { createCompatServer } from '../runtime/server.mjs';
import { workspaceIdentity } from '../runtime/workspaces.mjs';
import { CodeProRuns } from '../runtime/codepro.mjs';

const root = path.resolve(import.meta.dirname, '..');
const mode = process.argv[2] ?? 'chat';
const source = JSON.parse(await readFile(path.join(root, '.preview-data/backend/state.json'), 'utf8'));
const provider = source.providers.find(p => p.id === source.defaults.providerId);
assert.ok(provider, 'Configure the preview default model first');
const profile = await mkdtemp(path.join(root, `.preview-evidence/native-${mode}-`));
const dataDir = path.join(profile, 'backend'), cwd = path.join(profile, 'project');
const store = await openStore(dataDir);
await store.update(s => {
  s.providers = [provider]; s.defaults = source.defaults;
  s.preferences = { ...source.preferences, gooseMode: 'approve', gooseMaxTurns: 100 };
  if (mode === 'chat') s.extensions = source.extensions;
});
const receipt = { status: 'running', startedAt: new Date().toISOString(), mode, profile, cwd, model: source.defaults.modelId, transport: 'real model / ACP / official Harness', timings: [], permissions: [] };
const save = () => writeFile(path.join(profile, 'receipt.json'), JSON.stringify(receipt, null, 2));
await save(); console.log(JSON.stringify({ profile, mode, model: receipt.model }));
const ext = n => `_goose/unstable/${n}`;
let app, ws, client, stopped = false, phase = 'initial', pauseStarted = false, pausePromise;
let checkpointResolve;
const checkpoint = new Promise(resolve => { checkpointResolve = resolve; });
const modules = ['money', 'catalog', 'cart', 'discount', 'inventory', 'order'];
const command = `& '${process.execPath.replaceAll("'", "''")}' --test tests/acceptance.test.mjs`;
const commandPosix = `'${process.execPath.replaceAll("'", "'\\''")}' --test tests/acceptance.test.mjs`;
const local = target => typeof target === 'string' && !path.relative(cwd, path.resolve(cwd, target)).split(path.sep).includes('..') && !path.isAbsolute(path.relative(cwd, path.resolve(cwd, target)));
async function connect() {
  const secret = randomUUID();
  app = await createCompatServer({ dataDir, secret });
  const url = await app.listen();
  ws = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const pending = new Map(), toolNames = new Map(); let sequence = 0;
  client = { request(method, params = {}) { const id = ++sequence; return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Acceptance timed out: ${method}`)); }, 12 * 60_000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }); } };
  ws.addEventListener('message', ({ data }) => {
    const m = JSON.parse(String(data)); const p = pending.get(m.id);
    if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Object.assign(Error(m.error.message), m.error)) : p.resolve(m.result); return; }
    const update = m.params?.update;
    if (update?.sessionUpdate === 'tool_call') toolNames.set(update.toolCallId, update.title);
    if (update?.sessionUpdate === 'agent_message_chunk') {
      const timing = receipt.timings.at(-1);
      if (timing) { timing.firstTextMs ??= Date.now() - timing.started; timing.lastTextMs = Date.now() - timing.started; timing.chunks = (timing.chunks ?? 0) + 1; }
    }
    if (m.method === ext('codepro/run/update')) { receipt.lastRun = m.params.snapshot; }
    if (m.method === 'session/request_permission') {
      const tool = m.params.toolCall, args = tool.rawInput ?? {};
      const nativeState = ['create_goal', 'get_goal', 'update_goal', 'todo_write'].includes(tool.title);
      const target = args.file_path ?? args.path ?? '.';
      const read = ['read', 'ls', 'glob', 'grep'].includes(tool.title) && local(target);
      const write = ['write', 'edit'].includes(tool.title) && local(target) && modules.some(name => path.resolve(cwd, target) === path.join(cwd, 'packages', name, 'index.mjs'));
      const shell = ['pwsh', 'bash'].includes(tool.title) && [command, commandPosix].includes(args.command) && (!args.workdir || path.resolve(cwd, args.workdir) === cwd) && !args.run_in_background;
      const approved = mode === 'project' && !pauseStarted && (nativeState || read || write || shell);
      receipt.permissions.push({ tool: tool.title, approved, phase });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: approved ? 'allow_once' : 'reject_once' } } }));
    }
    if (mode === 'project' && phase === 'initial' && !pauseStarted && update?.sessionUpdate === 'tool_call_update' && update.status === 'completed') {
      // A real persisted write is the checkpoint; goal/todo metadata alone is not.
      if (['write', 'edit'].includes(toolNames.get(update.toolCallId))) {
        pauseStarted = true;
        pausePromise = client.request('session/cancel', { sessionId: receipt.sessionId });
        pausePromise.then(checkpointResolve, checkpointResolve);
      }
    }
  });
  ws.addEventListener('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Acceptance connection closed')); } pending.clear(); });
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
}
async function prompt(text) {
  const timing = { started: Date.now(), phase }; receipt.timings.push(timing);
  const result = await client.request('session/prompt', { sessionId: receipt.sessionId, prompt: [{ type: 'text', text }] });
  timing.totalMs = Date.now() - timing.started; timing.stopReason = result.stopReason;
  await save(); return result;
}
async function facts() {
  const state = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const row = state.codeproRuns.findLast(r => r.sessionId === receipt.sessionId);
  return { row, context: new CodeProRuns({ read: () => state }).context({ sessionId: receipt.sessionId, runId: row.runId }) };
}
try {
  await mkdir(cwd, { recursive: true });
  if (mode === 'project') {
    for (const name of modules) { await mkdir(path.join(cwd, 'packages', name), { recursive: true }); await writeFile(path.join(cwd, 'packages', name, 'index.mjs'), '// Implement the specified public API.\n'); }
    await mkdir(path.join(cwd, 'tests'));
    const tests = `import test from 'node:test'; import assert from 'node:assert/strict';
import {assertCents,sumCents} from '../packages/money/index.mjs';
import {createCatalog,priceOf} from '../packages/catalog/index.mjs';
import {normalizeCart} from '../packages/cart/index.mjs';
import {discountedTotal} from '../packages/discount/index.mjs';
import {reserve} from '../packages/inventory/index.mjs';
import {checkout} from '../packages/order/index.mjs';
for(const n of [0,1,99,12345,Number.MAX_SAFE_INTEGER]) test('valid cents '+n,()=>assert.equal(assertCents(n),n));
for(const n of [-1,1.2,NaN,Infinity,'2',null,Number.MAX_SAFE_INTEGER+1]) test('invalid cents '+String(n),()=>assert.throws(()=>assertCents(n)));
test('sum and overflow',()=>{assert.equal(sumCents([]),0);assert.equal(sumCents([100,25]),125);assert.throws(()=>sumCents([Number.MAX_SAFE_INTEGER,1]));});
test('catalog',()=>{const c=createCatalog([{id:'a',price:101},{id:'b',price:250}]);assert.equal(priceOf(c,'a'),101);assert.throws(()=>priceOf(c,'x'));assert.throws(()=>createCatalog([{id:'a',price:1},{id:'a',price:2}]));assert.throws(()=>createCatalog([{id:'',price:1}]));});
test('cart normalization',()=>{assert.deepEqual(normalizeCart([{id:'a',quantity:2},{id:'b',quantity:1},{id:'a',quantity:3}]),[{id:'a',quantity:5},{id:'b',quantity:1}]);assert.deepEqual(normalizeCart([]),[]);});
for(const q of [0,-1,1.5,NaN,'2']) test('invalid quantity '+q,()=>assert.throws(()=>normalizeCart([{id:'a',quantity:q}])));
for(const p of [0,1,10,33,50,99,100]) test('discount '+p,()=>assert.equal(discountedTotal(101,p),Math.floor(101*(100-p)/100)));
for(const p of [-1,101,1.5,NaN]) test('invalid discount '+p,()=>assert.throws(()=>discountedTotal(100,p)));
test('reserve pure and all or nothing',()=>{const s={a:5,b:2};assert.deepEqual(reserve(s,[{id:'a',quantity:3}]),{a:2,b:2});assert.deepEqual(s,{a:5,b:2});assert.throws(()=>reserve(s,[{id:'a',quantity:1},{id:'b',quantity:3}]));assert.deepEqual(s,{a:5,b:2});});
test('checkout integrates six modules',()=>{const catalog=createCatalog([{id:'a',price:101},{id:'b',price:250}]);const stock={a:10,b:5};const out=checkout(catalog,stock,[{id:'a',quantity:1},{id:'a',quantity:2},{id:'b',quantity:1}],10);assert.deepEqual(out,{subtotal:553,total:497,stock:{a:7,b:4}});assert.deepEqual(stock,{a:10,b:5});assert.deepEqual(checkout(catalog,stock,[],0),{subtotal:0,total:0,stock});assert.throws(()=>checkout(catalog,stock,[{id:'unknown',quantity:1}],0));assert.throws(()=>checkout(catalog,stock,[{id:'b',quantity:6}],0));});
`;
    await writeFile(path.join(cwd, 'tests/acceptance.test.mjs'), tests);
    receipt.testHash = createHash('sha256').update(tests).digest('hex');
  }
  await connect();
  const lease = await client.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: mode === 'project' ? 'non-empty-directory' : 'empty-directory', expectedIdentity: workspaceIdentity(cwd) });
  const start = Date.now();
  const created = await client.request('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId, ...(mode === 'project' ? { enabledExtensions: ['developer'] } : {}) } });
  receipt.newSessionMs = Date.now() - start; receipt.sessionId = created.sessionId;
  if (mode === 'chat') {
    for (const text of ['你好', '请用三句话介绍你可以怎样帮我开发项目，不调用工具。']) {
      await prompt(text);
      const { context } = await facts(); assert.equal(context.state, 'completed'); assert.equal(context.completionKind, 'harness_turn'); assert.equal(context.receipts.length, 0);
    }
  } else {
    const requirements = `在当前隔离项目完成六模块开发和实际测试，创建一个Harness原生goal持续做到完成，用todo记录进度。只改packages/*/index.mjs，其他文件只读，不访问网络、不装依赖、不提交git。先读取tests/acceptance.test.mjs，它是验收合同，不得修改。实现money assertCents(n)非负安全整数否则throw且返回n，sumCents防溢出；catalog createCatalog数组{id,price}拒绝空id/重复id/非法金额，priceOf查询未知throw；cart normalizeCart([{id,quantity}])按首次出现顺序合并重复商品，quantity必须正安全整数；discount discountedTotal(total,percent)整数0..100百分比折扣，Math.floor金额；inventory reserve(stock,items)纯函数库存扣减，未知/不足throw原库存不变；order checkout(catalog,stock,lines,percent=0)调用其余模块返回{subtotal,total,stock}。执行测试只能使用如下准确命令：${process.platform === 'win32' ? command : commandPosix}。真实测试通过后再将goal complete并报告结果。若被用户停止，等待用户继续，从已写文件和原生goal恢复，不重复已完成效果。`;
    await writeFile(path.join(profile, 'prompt.txt'), requirements);
    const first = await prompt(requirements); assert.equal(first.stopReason, 'cancelled'); await checkpoint; await pausePromise;
    const before = await facts(); receipt.runId = before.row.runId;
    assert.equal(before.context.state, 'paused'); assert.equal(before.context.recovery.pendingEffects, 0);
    receipt.checkpointWrites = await Promise.all(before.context.receipts.filter(r => r.kind === 'write').map(async r => ({ path: r.path, sha256: createHash('sha256').update(await readFile(r.path)).digest('hex'), mtimeMs: (await stat(r.path)).mtimeMs })));
    ws.close(); await app.close();
    phase = 'resumed'; pauseStarted = false;
    await connect();
    const rebound = await client.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'non-empty-directory', expectedIdentity: workspaceIdentity(cwd) });
    await client.request('session/load', { sessionId: receipt.sessionId, cwd, mcpServers: [], _meta: { workspaceLeaseId: rebound.leaseId } });
    await prompt('继续刚才的原生Harness目标，读取现有文件和待办，完成剩余模块并运行原验收测试。保留已完成且正确的实现，实际测试通过才complete goal。');
    const after = await facts(); assert.equal(after.row.runId, before.row.runId);
    assert.deepEqual(after.row.events.slice(0,before.row.events.length), before.row.events);
    assert.equal(after.context.state, 'completed'); assert.equal(after.context.completionKind, 'harness_goal');
    const actualTestHash = createHash('sha256').update(await readFile(path.join(cwd, 'tests/acceptance.test.mjs'))).digest('hex'); assert.equal(actualTestHash, receipt.testHash);
    const result = spawnSync(process.execPath, ['--test','tests/acceptance.test.mjs'], { cwd, encoding:'utf8', windowsHide:true, timeout:30_000 });
    await writeFile(path.join(profile,'independent-tests.log'), (result.stdout??'')+(result.stderr??''));
    receipt.independentTestsExit = result.status; assert.equal(result.status, 0, result.stdout+result.stderr);
    receipt.goal = after.context.nativeGoal; receipt.receipts = after.context.receipts.map(r => ({kind:r.kind,outcome:r.outcome,exitCode:r.exitCode,path:r.path}));
  }
  receipt.status = 'passed';
} catch(error) { receipt.status='failed'; receipt.error=error.message; process.exitCode=1; }
finally { stopped=true; ws?.close(); if(app) await app.close(); receipt.finishedAt=new Date().toISOString(); await save(); console.log(JSON.stringify({status:receipt.status,profile,error:receipt.error,timings:receipt.timings,newSessionMs:receipt.newSessionMs})); }
