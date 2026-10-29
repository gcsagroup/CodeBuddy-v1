import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../harness/index.mjs';
import { registerMcpSessionApproval, mcpSessionApprovalScope } from '../tool-session-approval.mjs';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { SafetyPolicy } from '../safety-policy.mjs';

const names = ['click', 'drag', 'get_app_state', 'list_apps', 'perform_secondary_action', 'press_key', 'scroll', 'set_value', 'type_text'];
async function fixture(t, { modern = true, trusted = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-business-approval-'));
  const script = join(root, 'server.mjs'), control = join(root, 'control.json'), effects = join(root, 'effects.log');
  await writeFile(control, JSON.stringify({ revision: 1 }));
  await writeFile(effects, '');
  await writeFile(script, `import{createInterface}from'node:readline';import{readFileSync,appendFileSync,watchFile}from'node:fs';
const names=${JSON.stringify([...names, 'future_tool'])};const control=process.argv[2],effects=process.argv[3];
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
watchFile(control,{interval:40,persistent:false},()=>send({jsonrpc:'2.0',method:'notifications/tools/list_changed'}));
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!('id'in m))return;
let result;if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:true}},serverInfo:{name:'isolated-computer-fixture',version:'1'}};
else if(m.method==='tools/list')result={tools:names.map(name=>({name,description:'Fixture revision '+JSON.parse(readFileSync(control)).revision,inputSchema:{type:'object',properties:{}},annotations:{destructiveHint:false}}))};
else if(m.method==='tools/call'){appendFileSync(effects,m.params.name+'\\n');result={content:[{type:'text',text:'Isolated fixture action'}]};}else result={};send({jsonrpc:'2.0',id:m.id,result});});`);
  const driver = await createHarnessDriver({ cwd: root, dataDir: join(root, 'native') });
  t.after(() => driver.close());
  const store = await openStore(join(root, 'host'));
  const questions = [], calls = [];
  const connection = { async ask(_method, request) {
    questions.push(request);
    return f.answer ? f.answer(request) : { outcome: { outcome: 'selected', optionId: f.choice } };
  } };
  const host = Object.assign(Object.create(Compat.prototype), { store, settings: { extensions: async () => [] },
    active: new Map(), safety: new SafetyPolicy(store), businessApprovalClients: new WeakSet(modern ? [connection] : []) });
  const provider = { id: 'offline', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' };
  const f = { root, driver, store, host, connection, questions, calls, control, effects, choice: 'allow_business_session',
    async configure(s, { trustedScope = trusted, revision = '1', mismatch = false } = {}) {
      const server = { serverName: 'qwen_computer', transport: 'stdio', command: process.execPath,
        args: [script, control, effects], env: { FIXTURE_REVISION: revision } };
      if (trustedScope) registerMcpSessionApproval(server, { tools: names, business: { id: 'computer-use' } });
      const options = { mcpServers: [mismatch ? { ...server, env: { FIXTURE_REVISION: 'mismatch' } } : server],
        mcpApprovalScopes: trustedScope ? [mcpSessionApprovalScope(server)] : [] };
      if (!s.created) { await driver.createSession({ sessionId: s.id, cwd: root, provider, model: 'fixture', options }); s.created = true; }
      else await driver.configureSession(s.id, options);
    },
    async session() {
      const s = { id: randomUUID(), cwd: root, mcpServers: [{ name: 'qwen_computer', command: process.execPath, args: [script, control, effects] }] };
      await store.update(state => state.sessions.push(s)); await f.configure(s); return s;
    },
    invoke(s, name, signal) {
      return driver.callTool(s.id, `mcp__qwen_computer__${name}`, {}, {
        ...(signal ? { signal } : {}),
        onToolPolicy: call => { calls.push(call); return host.toolPolicy(s, call, call.signal); },
        onPermission: call => host.approveTool(s, call, connection, call.signal),
      });
    },
  };
  return f;
}

test('one explicit business choice covers known CU tools across turns, not future tools or another chat', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.session();
  const first = await f.invoke(s, 'list_apps');
  assert.equal(first.isError, false, JSON.stringify({ result: first, questions: f.questions }));
  assert.equal(f.questions[0]._meta.codepro.businessApproval.id, 'computer-use');
  assert.deepEqual(f.questions[0]._meta.codepro.businessApproval.tools, names);
  assert.ok(f.questions[0].options.some(option => option.optionId === 'allow_business_session'));
  for (const name of ['get_app_state', 'click', 'type_text']) assert.equal((await f.invoke(s, name)).isError, false);
  await f.configure(s);
  assert.equal((await f.invoke(s, 'scroll')).isError, false);
  assert.equal(f.questions.length, 1);
  f.choice = 'reject_once';
  assert.equal((await f.invoke(s, 'future_tool')).isError, true);
  assert.equal(f.questions.at(-1)._meta.codepro.businessApproval, undefined);
  const other = await f.session();
  assert.equal((await f.invoke(other, 'click')).isError, true);
  assert.equal(f.store.read(['toolPermissions']).toolPermissions, undefined);
});

test('legacy clients and unregistered same-name servers retain per-tool authorization', { timeout: 30000 }, async t => {
  for (const options of [{ modern: false }, { trusted: false }]) {
    const f = await fixture(t, options), s = await f.session(); f.choice = 'allow_always';
    assert.equal((await f.invoke(s, 'list_apps')).isError, false);
    assert.equal((await f.invoke(s, 'click')).isError, false);
    assert.equal(f.questions.length, 2);
    for (const question of f.questions) {
      assert.equal(question._meta.codepro.businessApproval, undefined);
      assert.equal(question.options.some(option => option.optionId === 'allow_business_session'), false);
    }
  }
});

test('business choice cannot bypass a changed connection, changed definition or mismatched factory config', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.session(); await f.invoke(s, 'list_apps');
  f.choice = 'reject_once';
  await f.configure(s, { revision: '2' });
  assert.equal((await f.invoke(s, 'click')).isError, true);
  f.choice = 'allow_business_session'; await f.invoke(s, 'click');
  await writeFile(f.control, JSON.stringify({ revision: 2 }));
  for (let i = 0; i < 100; i++) {
    if ((await f.driver.listTools(s.id)).some(tool => tool.description === 'Fixture revision 2')) break;
    await delay(30);
  }
  assert.ok((await f.driver.listTools(s.id)).some(tool => tool.description === 'Fixture revision 2'));
  f.choice = 'reject_once';
  assert.equal((await f.invoke(s, 'type_text')).isError, true);
  await f.configure(s, { mismatch: true });
  f.choice = 'allow_business_session';
  assert.equal((await f.invoke(s, 'click')).isError, true);
  assert.equal(f.questions.at(-1)._meta.codepro.businessApproval, undefined);
});

test('explicit rules and safety escalation still take priority over a business grant', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.session(); await f.invoke(s, 'list_apps');
  f.choice = 'reject_once';
  await f.store.update(state => { state.toolPermissions = { qwen_computer__click: 'never_allow', qwen_computer__press_key: 'ask_before' }; });
  assert.equal((await f.invoke(s, 'click')).isError, true);
  assert.equal(f.questions.length, 1);
  assert.equal((await f.invoke(s, 'press_key')).isError, true);
  assert.equal(f.questions.at(-1).options.some(option => option.kind === 'allow_always'), false);
  f.host.safety = { async inspect() { return { requiresApproval: true, explanation: 'Fixture safety escalation' }; } };
  assert.equal((await f.invoke(s, 'type_text')).isError, true);
  assert.equal(f.questions.at(-1)._meta.codepro?.businessApproval, undefined);
});

test('cancellation while a business question is pending grants nothing and dispatches nothing', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.session();
  const ready = Promise.withResolvers(), reply = Promise.withResolvers(), controller = new AbortController();
  f.answer = async () => { ready.resolve(); await reply.promise; return { outcome: { outcome: 'selected', optionId: 'allow_business_session' } }; };
  const pending = f.invoke(s, 'click', controller.signal); await ready.promise;
  controller.abort(new Error('Fixture stop')); reply.resolve(); await pending;
  assert.equal(await readFile(f.effects, 'utf8'), '');
  f.answer = undefined; f.choice = 'reject_once';
  assert.equal((await f.invoke(s, 'type_text')).isError, true);
  assert.equal(f.questions.length, 2);
});

test('simultaneous tools share one business question, while allow-once remains one call', async () => {
  for (const choice of ['allow_business_session', 'allow_once']) {
    const owner = {}, identity = {}, businessIdentity = {}, ready = Promise.withResolvers(), release = Promise.withResolvers();
    const host = Object.assign(Object.create(Compat.prototype), { sessionToolApprovals: new WeakMap(),
      store: { read: () => ({}), readSession: () => ({}) }, toolAvailable: async () => true });
    const questions = [];
    const connection = { async ask(_method, request) {
      questions.push(request); if (questions.length === 1) { ready.resolve(); await release.promise; }
      return { outcome: { outcome: 'selected', optionId: questions.length === 1 ? choice : 'reject_once' } };
    } };
    host.businessApprovalClients = new WeakSet([connection]);
    const call = name => ({ id: name, name, arguments: {}, sessionApproval: { owner, tool: name === 'click' ? identity : {},
      isCurrent: () => true, business: { identity: businessIdentity, isCurrent: () => true,
        presentation: { id: 'computer-use', tools: ['click', 'type_text'] } } } });
    const first = host.approveTool({ id: 'fixture' }, call('click'), connection); await ready.promise;
    const second = host.approveTool({ id: 'fixture' }, call('type_text'), connection);
    await delay(5); release.resolve();
    assert.deepEqual(await Promise.all([first, second]), choice === 'allow_once' ? [true, false] : [true, true]);
    assert.equal(questions.length, choice === 'allow_once' ? 2 : 1);
  }
});
